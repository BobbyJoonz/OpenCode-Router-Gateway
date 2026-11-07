import { spawn, execSync, ChildProcess } from 'child_process';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { XrayConfigBuilder } from './xray-config-builder';
import { safeWriteSensitiveFile } from '../security/file-guard';

export type SlotState = 'stopped' | 'starting' | 'ready' | 'draining';

export interface SlotNodeInfo {
  id: number;
  protocol: string;
  address: string;
  port: number;
  remark: string;
  security: string;
  network: string;
}

export interface SlotConfigRow {
  id: number;
  protocol: string;
  address: string;
  port: number;
  remark: string;
  security: string;
  network: string;
  details_json: string;
}

/**
 * One long-lived Xray process bound to its own loopback port pair.
 *
 * The pool keeps N of these alive so that (a) a dead node can be replaced without
 * touching the others, (b) a planned rotation can drain in-flight streams on the
 * old slot while the new one already serves traffic, and (c) clients can be
 * pinned to different egress IPs.
 */
export class XraySlot {
  public readonly index: number;
  public readonly socksPort: number;
  public readonly httpPort: number;

  public state: SlotState = 'stopped';
  public node: SlotNodeInfo | null = null;
  public pid: number | null = null;
  public startedAt: number | null = null;
  public lastError: string | null = null;
  public failures = 0;
  public inFlight = 0;
  public totalRequests = 0;

  // Result of the last real probe through this slot (EgressPool.probeAll).
  // null = never probed.
  public probeOk: boolean | null = null;
  public probeStatus: number | null = null;
  public probeLatencyMs: number | null = null;
  public probeAt: number | null = null;

  private child: ChildProcess | null = null;
  private configPath: string;
  private binaryPath: string;
  private exitNotified = false;
  private onDeath: ((slot: XraySlot) => void) | null = null;

  constructor(index: number, socksPort: number, httpPort: number, binaryPath: string, dataDir: string) {
    this.index = index;
    this.socksPort = socksPort;
    this.httpPort = httpPort;
    this.binaryPath = binaryPath;
    this.configPath = path.join(dataDir, `slot-${index}.json`);
  }

  public onExit(handler: (slot: XraySlot) => void): void {
    this.onDeath = handler;
  }

  public async start(row: SlotConfigRow): Promise<boolean> {
    await this.stop();

    let details: Record<string, any> = {};
    try {
      const parsed = JSON.parse(row.details_json || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) details = parsed;
    } catch {
      /* ignore */
    }

    let config: Record<string, any>;
    try {
      config = XrayConfigBuilder.buildClientConfig(
        {
          protocol: row.protocol,
          address: row.address,
          port: row.port,
          security: row.security,
          network: row.network,
          details
        },
        this.socksPort,
        this.httpPort
      );
    } catch (err: any) {
      this.lastError = `config build failed: ${err?.message || err}`;
      return false;
    }

    try {
      safeWriteSensitiveFile(this.configPath, JSON.stringify(config, null, 2));
    } catch (err: any) {
      this.lastError = `cannot write slot config: ${err?.message || err}`;
      return false;
    }

    this.state = 'starting';
    this.exitNotified = false;

    const child = spawn(this.binaryPath, ['run', '-c', this.configPath], {
      stdio: 'ignore',
      detached: false
    });
    this.child = child;
    this.pid = child.pid ?? null;

    child.once('error', (err) => {
      this.lastError = `spawn error: ${err.message}`;
      this.handleExit();
    });
    child.once('exit', (code, signal) => {
      if (this.state !== 'stopped') {
        this.lastError = `xray exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
      }
      this.handleExit();
    });

    const ready = await this.waitForPorts(5000);
    if (!ready) {
      this.lastError = this.lastError || 'proxy ports never opened';
      await this.stop();
      return false;
    }

    this.state = 'ready';
    this.node = {
      id: row.id,
      protocol: row.protocol,
      address: row.address,
      port: row.port,
      remark: row.remark,
      security: row.security,
      network: row.network
    };
    this.startedAt = Date.now();
    this.lastError = null;
    return true;
  }

  /** Wait until every in-flight request has finished, or the timeout expires. */
  public async drain(timeoutMs: number = 15000): Promise<number> {
    this.state = 'draining';
    const deadline = Date.now() + timeoutMs;
    while (this.inFlight > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    return this.inFlight;
  }

  public async stop(): Promise<void> {
    if (this.child?.pid) {
      this.killPid(this.child.pid);
    }
    this.child = null;
    this.pid = null;
    this.node = null;
    this.state = 'stopped';
    this.inFlight = 0;
    this.startedAt = null;
    await new Promise((r) => setTimeout(r, 60));
  }

  public isProcessAlive(): boolean {
    if (!this.pid) return false;
    try {
      return process.kill(this.pid, 0);
    } catch {
      return false;
    }
  }

  public async portsOpen(): Promise<boolean> {
    const [a, b] = await Promise.all([probePort(this.socksPort), probePort(this.httpPort)]);
    return a && b;
  }

  /** Cheap liveness check used by the watchdog. */
  public async healthy(): Promise<boolean> {
    if (this.state !== 'ready') return false;
    if (!this.isProcessAlive()) return false;
    return this.portsOpen();
  }

  private handleExit(): void {
    if (this.exitNotified) return;
    this.exitNotified = true;
    const wasServing = this.state === 'ready' || this.state === 'draining';
    this.state = 'stopped';
    this.child = null;
    this.pid = null;
    if (wasServing && this.onDeath) {
      try {
        this.onDeath(this);
      } catch {
        /* ignore */
      }
    }
  }

  private killPid(pid: number): void {
    try {
      if (process.platform === 'win32') {
        execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
      } else {
        process.kill(pid, 'SIGKILL');
      }
    } catch {
      /* already gone */
    }
  }

  private async waitForPorts(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.state === 'stopped') return false;
      const [a, b] = await Promise.all([probePort(this.socksPort), probePort(this.httpPort)]);
      if (a && b) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }
}

export function probePort(port: number): Promise<boolean> {
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

export function isValidConfigRow(row: any): row is SlotConfigRow {
  return (
    row &&
    typeof row === 'object' &&
    Number.isInteger(row.id) &&
    Number.isInteger(row.port) &&
    typeof row.address === 'string' &&
    row.address.length > 0 &&
    row.port > 0 &&
    row.port <= 65535
  );
}

export function readConfigFile(p: string): any {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}
