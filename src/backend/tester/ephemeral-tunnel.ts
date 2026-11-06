import { spawn, execSync, ChildProcess } from 'child_process';
import fs from 'fs';
import net from 'net';
import path from 'path';
import crypto from 'crypto';
import { XrayConfigBuilder } from '../vpn/xray-config-builder';
import { LatencyTester } from './latency-tester';
import { safeWriteSensitiveFile } from '../security/file-guard';

export interface ProbeRow {
  id: number;
  protocol: string;
  address: string;
  port: number;
  security: string;
  network: string;
  details_json: string;
}

export interface TunnelProbeResult {
  tunnel: boolean;
  egressIp?: string;
  latencyMs: number;
  error?: string;
}

/**
 * Runs a *throwaway* Xray instance on freshly allocated ports to verify that a
 * node can actually carry traffic.
 *
 * Deliberately separate from `VpnEngine`: the engine owns the single serving
 * connection, so probing with it would tear down the live tunnel for every
 * health check. Here we spawn, probe, kill — on ports the engine never uses.
 */
export class EphemeralTunnelTester {
  private static busy = false;
  private static binaryPath: string | null = null;
  private static swept = false;

  public static isBusy(): boolean {
    return this.busy;
  }

  public static resolveBinary(): string {
    if (this.binaryPath) return this.binaryPath;

    const projectRoot = path.resolve(__dirname, '../../../');
    const isWin = process.platform === 'win32';
    const candidates = [
      process.env.XRAY_BIN || '',
      path.join(projectRoot, 'bin', isWin ? 'xray.exe' : 'xray'),
      isWin ? path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Xray', 'xray.exe') : '',
      isWin ? 'C:\\Program Files\\Xray\\xray.exe' : '/usr/local/bin/xray',
      isWin ? '' : '/usr/local/bin/v2ray'
    ].filter(Boolean);

    const found = candidates.find((c) => fs.existsSync(c));
    if (!found) {
      throw new Error('Xray binary not found (set XRAY_BIN or place it in ./bin)');
    }
    this.binaryPath = found;
    return found;
  }

  /**
   * Remove probe configs left behind by a crash. They contain node credentials.
   */
  public static sweepStaleProbeFiles(maxAgeMs = 60 * 60 * 1000): void {
    if (this.swept) return;
    this.swept = true;
    try {
      const dataDir = path.resolve(__dirname, '../../../data');
      if (!fs.existsSync(dataDir)) return;
      const now = Date.now();
      for (const name of fs.readdirSync(dataDir)) {
        if (!name.startsWith('probe-') || !name.endsWith('.json')) continue;
        const full = path.join(dataDir, name);
        try {
          const stat = fs.statSync(full);
          if (now - stat.mtimeMs > maxAgeMs) fs.unlinkSync(full);
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* best effort */
    }
  }

  /**
   * Allocate two free loopback ports. Using ephemeral ports avoids colliding with
   * an orphaned probe from a previous crash or with unrelated software.
   */
  private static async freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        server.close(() => (port ? resolve(port) : reject(new Error('could not allocate a port'))));
      });
    });
  }

  public static async test(row: ProbeRow, timeoutMs: number = 9000): Promise<TunnelProbeResult> {
    if (this.busy) {
      return { tunnel: false, latencyMs: -1, error: 'probe engine busy' };
    }
    this.busy = true;

    const startedAt = Date.now();
    const dataDir = path.resolve(__dirname, '../../../data');
    const cfgPath = path.join(dataDir, `probe-${crypto.randomBytes(6).toString('hex')}.json`);
    let child: ChildProcess | null = null;

    try {
      this.sweepStaleProbeFiles();

      let details: Record<string, any> = {};
      try {
        const parsed = JSON.parse(row.details_json || '{}');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) details = parsed;
      } catch {
        return { tunnel: false, latencyMs: -1, error: 'invalid details_json' };
      }

      const socksPort = await this.freePort();
      const httpPort = await this.freePort();

      const config = XrayConfigBuilder.buildClientConfig(
        {
          protocol: row.protocol,
          address: String(row.address),
          port: Number(row.port),
          security: row.security,
          network: row.network,
          details
        },
        socksPort,
        httpPort
      );

      fs.mkdirSync(dataDir, { recursive: true });
      safeWriteSensitiveFile(cfgPath, JSON.stringify(config));

      const bin = this.resolveBinary();
      child = spawn(bin, ['run', '-c', cfgPath], { stdio: 'ignore', detached: false });

      let spawnError: Error | null = null;
      let exited = false;

      // Without an 'error' listener an async spawn failure (EACCES, EPERM, AV lock)
      // becomes an uncaughtException and kills the whole server.
      child.once('error', (err) => {
        spawnError = err;
        exited = true;
      });
      child.once('exit', () => {
        exited = true;
      });

      const ready = await this.waitForPorts(() => exited, socksPort, httpPort, timeoutMs);
      if (spawnError) {
        return { tunnel: false, latencyMs: -1, error: `spawn failed: ${(spawnError as Error).message}` };
      }
      if (!ready) {
        return {
          tunnel: false,
          latencyMs: -1,
          error: exited ? 'xray exited (invalid config or bind failure)' : 'proxy ports never opened'
        };
      }

      const probe = await LatencyTester.testProxyHttp(httpPort, Math.min(timeoutMs, 5000));
      return {
        tunnel: probe.success,
        egressIp: probe.egressIp,
        latencyMs: probe.success ? probe.latencyMs : -1,
        error: probe.success ? undefined : probe.error
      };
    } catch (err: any) {
      return { tunnel: false, latencyMs: Date.now() - startedAt, error: err?.message || String(err) };
    } finally {
      if (child && child.pid) {
        this.kill(child.pid);
      }
      try {
        if (fs.existsSync(cfgPath)) fs.unlinkSync(cfgPath);
      } catch {
        // ignore
      }
      this.busy = false;
    }
  }

  private static async waitForPorts(
    exitedFlag: () => boolean,
    socksPort: number,
    httpPort: number,
    timeoutMs: number
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (exitedFlag()) return false;
      const socks = await this.portOpen(socksPort);
      const http = await this.portOpen(httpPort);
      if (socks && http) return true;
      await new Promise((r) => setTimeout(r, 120));
    }
    return false;
  }

  private static portOpen(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      let settled = false;
      const done = (v: boolean) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(v);
      };
      socket.setTimeout(250);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
      try {
        socket.connect(port, '127.0.0.1');
      } catch {
        done(false);
      }
    });
  }

  private static kill(pid: number): void {
    try {
      if (process.platform === 'win32') {
        execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
      } else {
        process.kill(pid, 'SIGKILL');
      }
    } catch {
      // already gone
    }
  }
}
