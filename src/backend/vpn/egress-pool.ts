import { db, getSetting } from '../db/database';
import { XraySlot, SlotConfigRow, isValidConfigRow } from './xray-slot';
import path from 'path';
import { DATA_DIR, PROJECT_ROOT } from '../paths';
import { request as undiciRequest, ProxyAgent } from 'undici';

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
  /** Human-readable capacity state: full | reduced | none */
  capacity: 'full' | 'reduced' | 'none';
  capacityNote: string;
  /** sticky | round_robin | least_loaded | random */
  policy: string;
  lastEnsure: { at: string; started: number; noCandidate: boolean; ready: number } | null;
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
    /** null = never probed */
    probeOk: boolean | null;
    probeStatus: number | null;
    probeLatencyMs: number | null;
    probeAt: number | null;
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
  private rrCursor = 0;
  private lastEnsure: { at: string; started: number; noCandidate: boolean; ready: number } | null = null;
  private metrics = {
    rotations: 0,
    failovers: 0,
    drainTimeouts: 0,
    starts: 0,
    startFailures: 0,
    totalStartMs: 0
  };
  private dataDir = DATA_DIR;

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
    // Upper bound is configurable (each slot is ~22 MB RSS); hard-capped at 32 so
    // a typo cannot fork-bomb the host.
    const maxSize = Math.max(1, Math.min(parseInt(getSetting('pool_max_size', '16'), 10) || 16, 32));
    const configured = Math.max(1, Math.min(size ?? (parseInt(getSetting('pool_size', '2'), 10) || 2), maxSize));
    if (this.size === configured && this.slots.length === configured) return;

    this.stopWatchdog();
    for (const slot of this.slots) {
      void slot.stop();
    }

    this.size = configured;
    // Cluster workers must not fight over the same loopback ports: each worker
    // gets a 100-port slice (16 slots x 2 ports fits comfortably).
    const workerIndex = Math.max(0, parseInt(process.env.WORKER_INDEX || '0', 10) || 0);
    const base = Math.max(1024, parseInt(getSetting('pool_base_port', '12000'), 10)) + workerIndex * 100;
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
      let noCandidate = false;
      for (const slot of this.slots) {
        if (slot.state === 'ready') continue;
        const row = this.pickCandidate();
        if (!row) {
          // Do not abort the whole pass: other slots may still be startable.
          noCandidate = true;
          continue;
        }
        const result = await this.startSlot(slot, row);
        if (result.ok) started++;
      }
      this.lastEnsure = {
        at: new Date().toISOString(),
        started,
        noCandidate,
        ready: this.slots.filter((s) => s.state === 'ready').length
      };
      return started;
    });
  }

  /**
   * Get a ready slot for a client, preferring its previously assigned one.
   */
  private probeAgents = new Map<number, ProxyAgent>();

  private probeAgentFor(httpPort: number): ProxyAgent {
    const cached = this.probeAgents.get(httpPort);
    if (cached) return cached;
    const agent = new ProxyAgent({ uri: `http://127.0.0.1:${httpPort}`, connections: 4 });
    this.probeAgents.set(httpPort, agent);
    return agent;
  }

  /**
   * Real reachability probe through every ready slot.
   *
   * A live Xray process says nothing about whether the node can actually reach
   * the target (Cloudflare blocks, dead nodes, DPI resets). This issues a real
   * HTTP request through each slot and marks the failures so acquire() stops
   * routing traffic through them.
   */
  public async probeAll(): Promise<
    Array<{ index: number; ok: boolean; status: number | null; latencyMs: number | null; error?: string }>
  > {
    const url = getSetting('egress_probe_url', '').trim();
    if (!url) return [];
    const timeoutMs = Math.max(1000, parseInt(getSetting('egress_probe_timeout_ms', '8000'), 10) || 8000);
    const rotateOnFail = getSetting('egress_probe_rotate_on_fail', 'true') === 'true';
    const out: Array<{ index: number; ok: boolean; status: number | null; latencyMs: number | null; error?: string }> = [];

    for (const slot of this.slots) {
      if (slot.state !== 'ready') {
        slot.probeOk = false;
        out.push({ index: slot.index, ok: false, status: null, latencyMs: null, error: 'not ready' });
        continue;
      }
      const startedAt = Date.now();
      let status: number | null = null;
      let error: string | undefined;
      try {
        const response = await undiciRequest(url, {
          method: 'GET',
          dispatcher: this.probeAgentFor(slot.httpPort),
          headersTimeout: timeoutMs,
          bodyTimeout: timeoutMs,
          signal: AbortSignal.timeout(timeoutMs)
        });
        status = response.statusCode;
        try {
          for await (const _chunk of response.body) {
            /* drain */
          }
        } catch {
          /* ignore */
        }
      } catch (err: any) {
        error = err?.message || 'probe failed';
      }
      const latencyMs = Date.now() - startedAt;
      // 2xx/3xx/4xx (except 403) prove the node reached the target. 5xx, a 403
      // (Cloudflare block) and timeouts mean this IP cannot serve the request.
      const ok = status !== null && status < 500 && status !== 403;
      slot.probeOk = ok;
      slot.probeStatus = status;
      slot.probeLatencyMs = latencyMs;
      slot.probeAt = Date.now();
      out.push({ index: slot.index, ok, status, latencyMs, error });
      this.recordEvent(slot.index, ok ? 'start' : 'error', ok ? `probe ok (${status}, ${latencyMs}ms)` : `probe failed: ${error || 'status ' + status}`);
      if (!ok && rotateOnFail) {
        try {
          await this.rotateSlot(slot.index, `probe failed: ${error || 'status ' + status}`);
        } catch {
          /* ignore */
        }
      }
    }
    return out;
  }

  public async acquire(keyId: number | null, policyOverride?: string): Promise<XraySlot | null> {
    // Bounded admission: a slot may only carry N concurrent requests. Beyond that
    // the caller waits (up to a timeout) instead of piling unbounded work onto a
    // single upstream node — which is what turns a slow node into an OOM.
    const maxPerSlot = Math.max(1, parseInt(getSetting('pool_max_inflight_per_slot', '32'), 10) || 32);
    const timeoutMs = Math.max(0, parseInt(getSetting('pool_acquire_timeout_ms', '10000'), 10));
    const deadline = Date.now() + timeoutMs;

    let ready = this.slots.filter((s) => s.state === 'ready');
    if (ready.length === 0) {
      await this.ensureAll();
      ready = this.slots.filter((s) => s.state === 'ready');
      if (ready.length === 0) return null;
    }

    // Only serve through slots whose last real probe succeeded. If none passed
    // (or none was probed yet) fall back to the full ready set so the pool never
    // dead-ends.
    const probed = ready.filter((s) => s.probeOk !== false);
    if (probed.length > 0) ready = probed;

    for (;;) {
      const available = ready.filter((s) => s.inFlight < maxPerSlot);
      if (available.length > 0) {
        const chosen = this.choose(available, keyId, policyOverride);
        if (chosen && keyId !== null) this.sticky.set(keyId, chosen.index);
        return chosen;
      }

      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, 50));

      ready = this.slots.filter((s) => s.state === 'ready');
      if (ready.length === 0) {
        await this.ensureAll();
        ready = this.slots.filter((s) => s.state === 'ready');
        if (ready.length === 0) return null;
      }
    }
  }

  private choose(candidates: XraySlot[], keyId: number | null, policyOverride?: string): XraySlot {
    const override = String(policyOverride || '').trim();
    const policy = override || getSetting('egress_policy', 'sticky');

    // round_robin: spread clients across slots regardless of stickiness.
    if (policy === 'round_robin') {
      const ordered = candidates.slice().sort((a, b) => a.index - b.index);
      const pick = ordered[this.rrCursor % ordered.length];
      this.rrCursor = (this.rrCursor + 1) % 1_000_000;
      return pick;
    }

    // random: useful to avoid hot-spotting when slots have equal capacity.
    if (policy === 'random') {
      return candidates[Math.floor(Math.random() * candidates.length)];
    }

    // sticky (default): keep a client on its slot, fall back to least-loaded.
    if (policy === 'sticky' && keyId !== null) {
      const pinned = this.sticky.get(keyId);
      if (pinned !== undefined) {
        const slot = candidates.find((s) => s.index === pinned);
        if (slot) return slot;
      }
    }

    // least_loaded (and sticky's first assignment): least loaded, then oldest.
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
    // A rate-limited node is not a broken node: rotate away from it without
    // burning its status, otherwise a burst of 429s marks the whole pool failed.
    const isRateLimit = /rate.?limit|429/i.test(reason);
    if (slot.node && !isRateLimit) {
      try {
        db.prepare(
          `UPDATE configs SET consecutive_failures = consecutive_failures + 1, last_error = ?,
                              last_status = CASE WHEN consecutive_failures + 1 >= 3 THEN 'failed' ELSE last_status END
            WHERE id = ?`
        ).run(reason, slot.node.id);
      } catch {
        // A bookkeeping failure must never break the request path.
      }
    }
    return this.rotateSlot(slot.index, reason);
  }

  private async startSlot(slot: XraySlot, row: SlotConfigRow): Promise<StartResult> {
    const t0 = Date.now();

    // Memory guard: refuse to spawn another Xray child when the process is
    // already near its ceiling, so the pool degrades instead of OOM-killing.
    const maxRssMb = Math.max(64, parseInt(getSetting('pool_max_rss_mb', '512'), 10));
    const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
    if (rssMb > maxRssMb) {
      this.metrics.startFailures++;
      const error = `memory guard: rss ${rssMb}MB > ${maxRssMb}MB`;
      this.recordEvent(slot.index, 'error', error, row.id);
      return { ok: false, ms: Date.now() - t0, error };
    }

    this.metrics.starts++;
    const ok = await slot.start(row);
    const ms = Date.now() - t0;
    this.metrics.totalStartMs += ms;
    if (!ok) {
      this.metrics.startFailures++;
      this.recordEvent(slot.index, 'error', slot.lastError || 'start failed', row.id);
      return { ok: false, ms, error: slot.lastError || 'start failed' };
    }
    // A successful start is proof the node works: clear the failure history so a
    // recovered node is not permanently excluded from ranking.
    try {
      db.prepare(
        `UPDATE configs SET last_status = 'working', consecutive_failures = 0, last_error = NULL WHERE id = ?`
      ).run(row.id);
    } catch {
      /* ignore */
    }

    this.recordEvent(slot.index, 'start', `slot ${slot.index} serving #${row.id} ${row.address}:${row.port}`, row.id);
    return { ok: true, ms };
  }

  /**
   * Best next node, in three tiers so a pool can always reach full capacity when
   * *any* usable node exists:
   *
   *   1. verified working nodes (best),
   *   2. nodes that passed a TCP pre-screen but were never verified,
   *   3. completely untested nodes (last resort).
   *
   * Previously only tier 1 was considered, so a fresh install with a private
   * subscription could end up with a single ready slot — or none.
   */
  public pickCandidate(excludeId: number | null = null): SlotConfigRow | null {
    const busy = new Set<number>(
      this.slots.map((s) => s.node?.id).filter((id): id is number => typeof id === 'number')
    );
    if (excludeId !== null) busy.add(excludeId);

    const order = `ORDER BY COALESCE(health_score, 100) DESC, COALESCE(last_latency_ms, 9999) ASC, id ASC LIMIT 200`;
    const tiers = [
      `SELECT * FROM configs WHERE last_status = 'working' AND (? IS NULL OR id != ?) ${order}`,
      `SELECT * FROM configs WHERE last_status != 'failed' AND tcp_alive = 1 AND (? IS NULL OR id != ?) ${order}`,
      `SELECT * FROM configs WHERE last_status = 'untested' AND tcp_alive IS NULL AND (? IS NULL OR id != ?) ${order}`,
      // Last resort: ignore status entirely. Without this tier the pool can drain
      // itself to zero (every node marked failed) and never recover, because no
      // tier would ever pick a failed node again.
      `SELECT * FROM configs WHERE (? IS NULL OR id != ?) ${order}`
    ];

    for (const sql of tiers) {
      const rows = db.prepare(sql).all(excludeId, excludeId) as any[];
      for (const row of rows) {
        if (!isValidConfigRow(row)) continue;
        if (busy.has(row.id)) continue;
        if (!isRoutableEgressAddress(row.address)) continue;
        return row as SlotConfigRow;
      }
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
      failures: s.failures,
      probeOk: s.probeOk,
      probeStatus: s.probeStatus,
      probeLatencyMs: s.probeLatencyMs,
      probeAt: s.probeAt
    }));

    const stuck: string[] = [];
    for (const s of this.slots) {
      if (s.state === 'ready' && !s.node) stuck.push(`slot ${s.index}: ready without a node`);
      if (s.state === 'ready' && s.pid && !s.isProcessAlive()) stuck.push(`slot ${s.index}: process gone but marked ready`);
    }

    const ready = slots.filter((s) => s.state === 'ready').length;
    const capacity: 'full' | 'reduced' | 'none' = ready === 0 ? 'none' : ready >= this.size ? 'full' : 'reduced';
    const capacityNote =
      capacity === 'full'
        ? `${ready}/${this.size} slots ready`
        : capacity === 'none'
          ? 'No egress slot is ready. Run a pre-screen or add a subscription, then POST /api/egress/ensure.'
          : `Only ${ready}/${this.size} slots ready — not enough distinct routable nodes. Add a subscription or run a pre-screen.`;

    return {
      size: this.size,
      ready,
      capacity,
      capacityNote,
      policy: getSetting('egress_policy', 'sticky'),
      lastEnsure: this.lastEnsure,
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
    const projectRoot = PROJECT_ROOT;
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
