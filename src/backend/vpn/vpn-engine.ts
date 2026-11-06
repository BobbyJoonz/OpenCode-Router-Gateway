import { spawn, execSync, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import net from 'net';
import { db, getSetting } from '../db/database';
import { XrayConfigBuilder } from './xray-config-builder';
import { safeWriteSensitiveFile, ensureSecureDirectory } from '../security/file-guard';

export interface ActiveConfigInfo {
  id: number;
  protocol: string;
  address: string;
  port: number;
  remark: string;
  security: string;
  network: string;
  latency_ms?: number;
  egress_ip?: string;
  reason?: string;
  connected_at: string;
}

export class VpnEngine {
  private static instance: VpnEngine | null = null;
  private childProcess: ChildProcess | null = null;
  private currentConfig: ActiveConfigInfo | null = null;
  private binPath: string;
  private configFilePath: string;
  private stateFilePath: string;
  private isTestingMode: boolean = false;

  private constructor() {
    const projectRoot = path.resolve(__dirname, '../../../');
    const isWin = process.platform === 'win32';
    const binName = isWin ? 'xray.exe' : 'xray';
    this.binPath = process.env.XRAY_BIN || path.join(projectRoot, 'bin', binName);
    if (!fs.existsSync(this.binPath)) {
      if (isWin) {
        // Windows fallbacks: a user-level or system-wide xray.exe
        const candidates = [
          path.join(projectRoot, 'bin', 'xray.exe'),
          'C:\\Program Files\\Xray\\xray.exe',
          path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Xray', 'xray.exe')
        ];
        for (const c of candidates) {
          if (c && fs.existsSync(c)) { this.binPath = c; break; }
        }
      } else if (fs.existsSync('/usr/local/bin/xray')) {
        this.binPath = '/usr/local/bin/xray';
      } else if (fs.existsSync('/usr/local/bin/v2ray')) {
        this.binPath = '/usr/local/bin/v2ray';
      }
    }

    const dataDir = path.join(projectRoot, 'data');
    ensureSecureDirectory(dataDir);
    this.configFilePath = path.join(dataDir, 'active-xray-config.json');
    this.stateFilePath = path.join(dataDir, 'active-connection.json');

    this.recoverPreviousProcess();
  }

  public static getInstance(): VpnEngine {
    if (!this.instance) {
      this.instance = new VpnEngine();
    }
    return this.instance;
  }

  public getBinaryPath(): string {
    return this.binPath;
  }

  public isRunning(): boolean {
    if (this.childProcess && this.childProcess.pid) {
      try {
        return process.kill(this.childProcess.pid, 0);
      } catch {
        return false;
      }
    }
    if (fs.existsSync(this.stateFilePath)) {
      try {
        const state = JSON.parse(fs.readFileSync(this.stateFilePath, 'utf-8'));
        if (state.pid) {
          return process.kill(state.pid, 0);
        }
      } catch {
        return false;
      }
    }
    return false;
  }

  public getActiveConfig(): ActiveConfigInfo | null {
    if (this.isRunning()) {
      if (!this.currentConfig && fs.existsSync(this.stateFilePath)) {
        try {
          const state = JSON.parse(fs.readFileSync(this.stateFilePath, 'utf-8'));
          this.currentConfig = state.config;
        } catch {
          // ignore
        }
      }
      return this.currentConfig;
    }
    return null;
  }

  public setTestingMode(val: boolean) {
    this.isTestingMode = val;
  }

  /**
   * Start proxy with given configuration
   */
  public async start(configRow: {
    id: number;
    protocol: string;
    address: string;
    port: number;
    remark: string;
    security: string;
    network: string;
    details_json: string;
  }, socksPort: number = 10808, httpPort: number = 10809): Promise<boolean> {
    await this.stop();

    // Guard: a stale/foreign listener on the loopback ports makes xray exit with
    // "bind: Only one usage of each socket address" and the UI only reports a
    // generic engine failure. Surface it clearly instead.
    if (!(await this.waitForPortsFree(socksPort, httpPort, 2500))) {
      console.error(
        `[VPN Engine] Loopback ports ${socksPort}/${httpPort} are still in use by another process ` +
        `(e.g. v2rayN). Change the ports in settings or stop that program.`
      );
      return false;
    }

    let details: Record<string, any> = {};
    try {
      const parsed = JSON.parse(configRow.details_json || '{}');
      // A row can legitimately contain "null" (e.g. legacy/test artefacts);
      // never let that reach the config builder.
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        details = parsed;
      }
    } catch {
      // empty
    }

    const xrayConfig = XrayConfigBuilder.buildClientConfig(
      {
        protocol: configRow.protocol,
        address: configRow.address,
        port: configRow.port,
        security: configRow.security,
        network: configRow.network,
        details
      },
      socksPort,
      httpPort
    );

    safeWriteSensitiveFile(this.configFilePath, JSON.stringify(xrayConfig, null, 2));

    const logFile = path.join(path.dirname(this.configFilePath), 'xray.log');
    const logFd = fs.openSync(logFile, 'a', 0o600);
    try {
      fs.fchmodSync(logFd, 0o600);
    } catch {}

    return new Promise<boolean>((resolve) => {
      const child = spawn(this.binPath, ['run', '-c', this.configFilePath], {
        stdio: ['ignore', logFd, logFd],
        detached: true
      });
      child.unref();

      this.childProcess = child;

      // Persist the PID immediately. If the engine gets orphaned (parent crash,
      // port probe timeout, failed bind on the next attempt) the next run can
      // still find and force-terminate it via the state file.
      this.currentConfig = {
        id: configRow.id,
        protocol: configRow.protocol,
        address: configRow.address,
        port: configRow.port,
        remark: configRow.remark,
        security: configRow.security,
        network: configRow.network,
        connected_at: new Date().toISOString()
      };
      this.saveState();

      let hasExited = false;
      child.on('error', (err) => {
        console.error('[VPN Engine] Spawn error:', err.message);
        hasExited = true;
        try { fs.closeSync(logFd); } catch {}
        this.cleanupState();
        resolve(false);
      });

      child.on('exit', (code, signal) => {
        hasExited = true;
        this.childProcess = null;
        try { fs.closeSync(logFd); } catch {}
        this.cleanupState();
      });

      // Probe proxy ports for up to 2.5 seconds
      const startTime = Date.now();
      const checkPorts = async () => {
        if (hasExited) {
          resolve(false);
          return;
        }

        const httpReady = await this.probePort('127.0.0.1', httpPort, 200);
        const socksReady = await this.probePort('127.0.0.1', socksPort, 200);

        if (httpReady && socksReady) {
          this.currentConfig = {
            id: configRow.id,
            protocol: configRow.protocol,
            address: configRow.address,
            port: configRow.port,
            remark: configRow.remark,
            security: configRow.security,
            network: configRow.network,
            connected_at: new Date().toISOString()
          };

          this.saveState();
          resolve(true);
          return;
        }

        if (Date.now() - startTime > 3000) {
          console.warn('[VPN Engine] Port readiness timed out');
          await this.stop();
          resolve(false);
          return;
        }

        setTimeout(checkPorts, 100);
      };

      setTimeout(checkPorts, 100);
    });
  }

  /**
   * Stop the running VPN engine process
   */
  public async stop(): Promise<void> {
    if (this.childProcess && this.childProcess.pid) {
      const pid = this.childProcess.pid;
      this.terminate(pid, false);

      // Wait up to 1.5s for exit, then force kill
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve();
        };

        const timeout = setTimeout(() => {
          if (this.isProcessAlive(pid)) {
            this.terminate(pid, true);
          }
          finish();
        }, 1500);

        if (!this.isProcessAlive(pid)) {
          finish();
        } else {
          this.childProcess?.once('exit', finish);
        }
      });
    } else if (fs.existsSync(this.stateFilePath)) {
      try {
        const state = JSON.parse(fs.readFileSync(this.stateFilePath, 'utf-8'));
        if (state.pid) {
          this.terminate(state.pid, false);
          await new Promise((r) => setTimeout(r, 400));
          if (this.isProcessAlive(state.pid)) {
            this.terminate(state.pid, true);
          }
        }
      } catch {
        // ignore
      }
    }

    this.childProcess = null;
    this.cleanupState();
  }

  /**
   * Check whether a PID is alive (cross-platform; signal 0 works on Windows too).
   */
  private isProcessAlive(pid: number): boolean {
    try {
      return process.kill(pid, 0);
    } catch {
      return false;
    }
  }

  /**
   * Terminate a process reliably.
   * On Windows `child.kill()` is unreliable for detached processes, so use taskkill.
   */
  private terminate(pid: number, force: boolean): void {
    if (process.platform === 'win32') {
      // A console app like xray has no window message loop, so a graceful
      // `taskkill /PID` always fails with "can only be terminated forcefully".
      // Always force-terminate the process tree.
      try {
        execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
      } catch {
        // already gone
      }
      return;
    }
    try {
      process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
    } catch {
      // already gone
    }
  }

  /**
   * Poll until both loopback proxy ports are free (or the timeout elapses).
   */
  private async waitForPortsFree(socksPort: number, httpPort: number, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const socksBusy = await this.probePort('127.0.0.1', socksPort, 150);
      const httpBusy = await this.probePort('127.0.0.1', httpPort, 150);
      if (!socksBusy && !httpBusy) return true;
      await new Promise((r) => setTimeout(r, 150));
    }
    return false;
  }

  private async probePort(host: string, port: number, timeoutMs: number): Promise<boolean> {    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(timeoutMs);

      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });

      socket.once('timeout', () => {
        socket.destroy();
        resolve(false);
      });

      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });

      socket.connect(port, host);
    });
  }

  private saveState(): void {
    if (!this.currentConfig || !this.childProcess) return;

    const state = {
      pid: this.childProcess.pid,
      config: this.currentConfig
    };
    try {
      safeWriteSensitiveFile(this.stateFilePath, JSON.stringify(state, null, 2));
      db.prepare(`
        INSERT INTO active_connection (id, config_id, pid, egress_ip, latency_ms, reason, connected_at)
        VALUES (1, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          config_id = excluded.config_id,
          pid = excluded.pid,
          egress_ip = excluded.egress_ip,
          latency_ms = excluded.latency_ms,
          reason = excluded.reason,
          connected_at = excluded.connected_at
      `).run(
        this.currentConfig.id,
        this.childProcess.pid,
        this.currentConfig.egress_ip || null,
        this.currentConfig.latency_ms || null,
        this.currentConfig.reason || null,
        this.currentConfig.connected_at
      );
    } catch (e) {
      console.error('Failed to save VPN state:', e);
    }
  }

  private cleanupState(): void {
    this.currentConfig = null;
    try {
      if (fs.existsSync(this.stateFilePath)) {
        fs.unlinkSync(this.stateFilePath);
      }
      db.prepare('DELETE FROM active_connection WHERE id = 1').run();
      db.prepare('UPDATE configs SET is_active = 0').run();
    } catch {
      // ignore
    }
  }

  private recoverPreviousProcess(): void {
    if (!fs.existsSync(this.stateFilePath)) return;

    try {
      const content = fs.readFileSync(this.stateFilePath, 'utf-8');
      const state = JSON.parse(content);
      if (state.pid) {
        try {
          process.kill(state.pid, 0); // Is process alive?
          this.currentConfig = state.config;
          console.log(`[VPN Engine] Re-attached to running Xray instance (PID: ${state.pid})`);
        } catch {
          // Process not alive
          this.cleanupState();
        }
      }
    } catch {
      this.cleanupState();
    }
  }
}
