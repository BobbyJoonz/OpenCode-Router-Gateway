import { db, getSetting } from '../db/database';
import { XraySlot, SlotConfigRow, isValidConfigRow } from './xray-slot';
import path from 'path';

/** Loopback / link-local endpoints can never be a real egress. */
export function isRoutableEgressAddress(address: string): boolean {
  const a = String(address || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!a) return false;
  if (a === 'localhost' || a === '::1' || a === '0.0.0.0') return false;
  if (a.startsWith('127.')) return false;
  if (a.startsWith('169.254.')) return false;
  if (a.startsWith('fe80:')) return false;
  return true;
}

export interface PoolEvent {
  at: string;
  slot: number;
  type: 'start' | 'rotate' | 'failover' | 'death' | 'error' | 'drain-timeout';
  message: string;
  nodeId?: number;
}

export interface PoolStatus {
  size: number;
  ready: number;
  slots: Array<{
    index: number;
    state: string;
    socksPort: number;
    httpPort: number;
    pid: number | null;
    node: any;
    inFlight: number;
    totalRequests: number;
    uptimeMs: number | null;
    lastError: string | null;
    failures: number;
  }>;
  metrics: {
    rotations: number;
    failovers: number;
    drainTimeouts: number;
    starts: number;
    startFailures: number;
    churnPerHour: number;
    avgStartMs: number;
  };
  events: PoolEvent[];
  stuck: string[];
}

interface StartResult {
  ok: boolean;
  ms: number;
  error?: string;
}

/**
 * A pool of independent Xray slots.
 *
 * Why a pool instead of the old singleton:
 *   - a dead node is replaced without disturbing the healthy ones (B1),
 *   - a planned rotation drains in-flight streams on the old slot while the new
 *     one already accepts traffic, so no response is cut (B2),
 *   - clients can be pinned to different egress IPs (B3).
 */
export class EgressPool {
  private static instance: EgressPool | null = null;

  private slots: XraySlot[] = [];
  private size = 0;
  private mutex: Promise<any> = Promise.resolve();
  private watchdog: NodeJS.Timeout | null = null;
  private sticky = new Map<number, number>();
  private events: PoolEvent[] = [];
  private rotationTimes: number[] = [];
  private metrics = {
    rotations: 0,
    failovers: 0,
    drainTimeouts: 0,
    starts: 0,
    startFailures: 0,
    totalStartMs: 0
  };
  private dataDir = path.resolve(__dirname, '../../../data');

  public static getInstance(): EgressPool {
    if (!this.instance) this.instance = new EgressPool();
    return this.instance;
  }

  /** Serialize every slot mutation (start/rotate/failover) through one mutex. */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutex.then(fn, fn);
    this.mutex = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  public init(size?: number): void {
    const configured = Math.max(1, Math.min(size ?? (parseInt(getSetting('pool_size', '2'), 10) || 2), 8));
    if (this.size === configured && this.slots.length === configured) return;

    this.stopWatchdog();
    for (const slot of this.slots) {
      void slot.stop();
    }

    this.size = configured;
    const base = Math.max(1024, parseInt(getSetting('pool_base_port', '12000'), 10));
    const bin = this.resolveBinary();
    this.slots = Array.from({ length: configured }, (_, i) => {
      const slot = new XraySlot(i, base + i * 2, base + i * 2 + 1, bin, this.dataDir);
      slot.onExit((dead) => {
        this.recordEvent(dead.index, 'death', `slot ${dead.index} process died`);
        if (dead.state === 'stopped' && dead.node) {
          void this.failoverSlot(dead.index, 'process died');
        }
      });
      return slot;
    });

    this.startWatchdog();
  }

  public getSize(): number {
    return this.size;
  }

  public getSlots(): XraySlot[] {
    return this.slots;
  }

  public findSlotByPorts(socksPort: number, httpPort: number): XraySlot | null {
    return this.slots.find((s) => s.socksPort === socksPort && s.httpPort === httpPort) || null;
  }

  /** Fill every empty slot with the best available node. */
  public async ensureAll(): Promise<number> {
    return this.run(async () => {
      let started = 0;
      for (const slot of this.slots) {
        if (slot.state === 'ready') continue;
        const row = this.pickCandidate();
        if (!row) break;
        const result = await this.startSlot(slot, row);
        if (result.ok) started++;
      }
      return started;
    });
  }

  /**
   * Get a ready slot for a client, preferring its previously assigned one.
   */
  public async acquire(keyId: number | null): Promise<XraySlot | null> {
    const ready = this.slots.filter((s) => s.state === 'ready');
    if (ready.length === 0) {
      await this.ensureAll();
      const retry = this.slots.filter((s) => s.state === 'ready');
      if (retry.length === 0) return null;
      return this.choose(retry, keyId);
    }
    const chosen = this.choose(ready, keyId);
    if (chosen && keyId !== null) this.sticky.set(keyId, chosen.index);
    return chosen;
  }

  private choose(candidates: XraySlot[], keyId: number | null): XraySlot {
    if (keyId !== null) {
      const pinned = this.sticky.get(keyId);
      if (pinned !== undefined) {
        const slot = candidates.find((s) => s.index === pinned);
        if (slot) return slot;
      }
    }
    // least loaded, then oldest (most stable)
    return candidates
      .slice()
      .sort((a, b) => a.inFlight - b.inFlight || (a.startedAt || 0) - (b.startedAt || 0))[0];
  }

  public release(slot: XraySlot): void {
    slot.inFlight = Math.max(0, slot.inFlight - 1);
  }

  public track(slot: XraySlot): void {
    slot.inFlight++;
    slot.totalRequests++;
  }

  /**
   * Planned rotation: drain in-flight work, then replace the node.
   * Other slots keep serving during the drain.
   */
  public async rotateSlot(slotIndex: number, reason = 'manual'): Promise<boolean> {
    return this.run(async () => {
      const slot = this.slots.find((s) => s.index === slotIndex);
      if (!slot) return false;

      const currentId = slot.node?.id ?? null;
      const drainMs = Math.max(1000, parseInt(getSetting('pool_drain_timeout_ms', '15000'), 10));
      const leftover = await slot.drain(drainMs);
      if (leftover > 0) {
        this.metrics.drainTimeouts++;
        this.recordEvent(slot.index, 'drain-timeout', `${leftover} request(s) still in flight after ${drainMs}ms`);
      }

      await slot.stop();
      const row = this.pickCandidate(currentId);
      if (!row) {
        slot.state = 'stopped';
        this.recordEvent(slot.index, 'error', 'no candidate available for rotation');
        return false;
      }

      const result = await this.startSlot(slot, row);
      if (result.ok) {
        this.metrics.rotations++;
        this.rotationTimes.push(Date.now());
        this.recordEvent(slot.index, 'rotate', `rotated to #${row.id} ${row.address}:${row.port} (${reason})`, row.id);
      }
      return result.ok;
    });
  }

  /**
   * Emergency rotation: the node is already dead, so do not wait for a drain.
   */
  public async failoverSlot(slotIndex: number, reason = 'unhealthy'): Promise<boolean> {
    return this.run(async () => {
      const slot = this.slots.find((s) => s.index === slotIndex);
      if (!slot) return false;
      if (slot.state === 'ready') return true; // someone already fixed it

      const currentId = slot.node?.id ?? null;
      await slot.stop();
      if (currentId !== null) {
        db.prepare(
          `UPDATE configs SET last_status = 'failed', consecutive_failures = consecutive_failures + 1, last_error = ? WHERE id = ?`
        ).run(`slot ${slotIndex} died: ${reason}`, currentId);
      }

      const row = this.pickCandidate(currentId);
      if (!row) {
        this.recordEvent(slot.index, 'error', 'no candidate available for failover');
        return false;
      }

      const result = await this.startSlot(slot, row);
      if (result.ok) {
        this.metrics.failovers++;
        this.recordEvent(slot.index, 'failover', `failed over to #${row.id} ${row.address}:${row.port} (${reason})`, row.id);
      }
      return result.ok;
    });
  }

  /** Mark the node serving this slot as degraded and rotate away from it. */
  public async penalize(slot: XraySlot, reason: string): Promise<boolean> {
    if (slot.node) {
      db.prepare(
        `UPDATE configs SET consecutive_failures = consecutive_failures + 1, last_error = ?,
                            last_status = CASE WHEN consecutive_failures + 1 >= 2 THEN 'failed' ELSE last_status END
          WHERE id = ?`
      ).run(reason, slot.node.id);
    }
    return this.rotateSlot(slot.index, reason);
  }

  private async startSlot(slot: XraySlot, row: SlotConfigRow): Promise<StartResult> {
    const t0 = Date.now();
    this.metrics.starts++;
    const ok = await slot.start(row);
    const ms = Date.now() - t0;
    this.metrics.totalStartMs += ms;
    if (!ok) {
      this.metrics.startFailures++;
      this.recordEvent(slot.index, 'error', slot.lastError || 'start failed', row.id);
      return { ok: false, ms, error: slot.lastError || 'start failed' };
    }
    this.recordEvent(slot.index, 'start', `slot ${slot.index} serving #${row.id} ${row.address}:${row.port}`, row.id);
    return { ok: true, ms };
  }

  /**
   * Best next node: routable, working, highest health, not already used by another slot.
   */
  public pickCandidate(excludeId: number | null = null): SlotConfigRow | null {
    const busy = new Set<number>(
      this.slots.map((s) => s.node?.id).filter((id): id is number => typeof id === 'number')
    );
    if (excludeId !== null) busy.add(excludeId);

    const rows = db
      .prepare(
        `SELECT * FROM configs
          WHERE last_status = 'working'
            AND (? IS NULL OR id != ?)
          ORDER BY COALESCE(health_score, 100) DESC, COALESCE(last_latency_ms, 9999) ASC
          LIMIT 200`
      )
      .all(excludeId, excludeId) as any[];

    for (const row of rows) {
      if (!isValidConfigRow(row)) continue;
      if (busy.has(row.id)) continue;
      if (!isRoutableEgressAddress(row.address)) continue;
      return row as SlotConfigRow;
    }
    return null;
  }

  public status(): PoolStatus {
    const now = Date.now();
    const hourAgo = now - 3600_000;
    this.rotationTimes = this.rotationTimes.filter((t) => t > hourAgo);

    const slots = this.slots.map((s) => ({
      index: s.index,
      state: s.state,
      socksPort: s.socksPort,
      httpPort: s.httpPort,
      pid: s.pid,
      node: s.node,
      inFlight: s.inFlight,
      totalRequests: s.totalRequests,
      uptimeMs: s.startedAt ? now - s.startedAt : null,
      lastError: s.lastError,
      failures: s.failures
    }));

    const stuck: string[] = [];
    for (const s of this.slots) {
      if (s.state === 'ready' && !s.node) stuck.push(`slot ${s.index}: ready without a node`);
      if (s.state === 'ready' && s.pid && !s.isProcessAlive()) stuck.push(`slot ${s.index}: process gone but marked ready`);
    }

    return {
      size: this.size,
      ready: slots.filter((s) => s.state === 'ready').length,
      slots,
      metrics: {
        ...this.metrics,
        churnPerHour: this.rotationTimes.length,
        avgStartMs: this.metrics.starts > 0 ? Math.round(this.metrics.totalStartMs / this.metrics.starts) : 0
      },
      events: this.events.slice(-40),
      stuck
    };
  }

  public startWatchdog(): void {
    if (this.watchdog) return;
    const interval = Math.max(500, parseInt(getSetting('pool_watchdog_interval_ms', '2000'), 10));
    this.watchdog = setInterval(() => {
      void this.checkHealth();
    }, interval);
    this.watchdog.unref?.();
  }

  public stopWatchdog(): void {
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
  }

  /** Watchdog tick: replace every slot whose process or ports vanished. */
  public async checkHealth(): Promise<void> {
    for (const slot of this.slots) {
      if (slot.state !== 'ready') continue;
      const ok = slot.isProcessAlive() && (await slot.portsOpen());
      if (!ok) {
        this.recordEvent(slot.index, 'death', `watchdog detected dead slot ${slot.index}`);
        await this.failoverSlot(slot.index, 'watchdog: process or ports gone');
      }
    }
  }

  public async shutdown(): Promise<void> {
    this.stopWatchdog();
    await this.run(async () => {
      for (const slot of this.slots) {
        await slot.stop();
      }
    });
  }

  private resolveBinary(): string {
    const projectRoot = path.resolve(__dirname, '../../../');
    const isWin = process.platform === 'win32';
    const candidates = [
      process.env.XRAY_BIN || '',
      path.join(projectRoot, 'bin', isWin ? 'xray.exe' : 'xray'),
      isWin ? path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Xray', 'xray.exe') : '',
      isWin ? 'C:\\Program Files\\Xray\\xray.exe' : '/usr/local/bin/xray',
      isWin ? '' : '/usr/local/bin/v2ray'
    ].filter(Boolean) as string[];

    const found = candidates.find((c) => require('fs').existsSync(c));
    if (!found) throw new Error('Xray binary not found (set XRAY_BIN)');
    return found;
  }

  private recordEvent(slot: number, type: PoolEvent['type'], message: string, nodeId?: number): void {
    this.events.push({ at: new Date().toISOString(), slot, type, message, nodeId });
    if (this.events.length > 200) this.events.splice(0, this.events.length - 200);
    if (type === 'failover' || type === 'error' || type === 'death') {
      console.warn(`[EgressPool] ${type} slot=${slot}: ${message}`);
    }
  }
}

export const egressPool = EgressPool.getInstance();
