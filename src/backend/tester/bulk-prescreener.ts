import net from 'net';
import { db, getSetting } from '../db/database';

export interface PrescreenOptions {
  /** How many sockets to keep in flight. Clamped to 1..1000. */
  concurrency?: number;
  /** Per-socket timeout in ms. Clamped to 100..30000. */
  timeoutMs?: number;
  /** Only re-check nodes that are unknown or previously dead. */
  onlyUnhealthy?: boolean;
  /** Hard cap on rows, 0/undefined = no cap. */
  limit?: number;
  /** Restrict to one subscription source. */
  sourceId?: number;
}

export interface PrescreenSummary {
  runId: number;
  total: number;
  alive: number;
  dead: number;
  durationMs: number;
  aborted: boolean;
}

export interface PrescreenProgress {
  running: boolean;
  runId: number;
  done: number;
  total: number;
  alive: number;
  startedAt: number | null;
}

interface ProbeResult {
  id: number;
  alive: boolean;
  ms: number;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

/**
 * Bulk TCP pre-screen.
 *
 * The candidate ranker used to feed the state machine blind: with ~15% of public
 * nodes being TCP-reachable, a 25-attempt budget was usually wasted on corpses.
 * This module probes every node with a bounded socket pool (200 in flight by
 * default) so only survivors reach the expensive stages.
 */
export class BulkPrescreener {
  private static running = false;
  private static abortRequested = false;
  private static progress: PrescreenProgress = {
    running: false,
    runId: 0,
    done: 0,
    total: 0,
    alive: 0,
    startedAt: null
  };

  public static isRunning(): boolean {
    return this.running;
  }

  public static getProgress(): PrescreenProgress {
    return { ...this.progress };
  }

  public static requestAbort(): void {
    if (this.running) this.abortRequested = true;
  }

  public static async run(opts: PrescreenOptions = {}): Promise<PrescreenSummary> {
    if (this.running) {
      throw new Error('A pre-screen run is already in progress');
    }

    const concurrency = clamp(
      opts.concurrency ?? parseInt(getSetting('prescreen_concurrency', '200'), 10),
      1,
      1000
    );
    const timeoutMs = clamp(
      opts.timeoutMs ?? parseInt(getSetting('prescreen_timeout_ms', '1500'), 10),
      100,
      30000
    );

    const where: string[] = [];
    const params: any[] = [];
    if (opts.onlyUnhealthy) where.push('(tcp_alive IS NULL OR tcp_alive = 0)');
    if (opts.sourceId) {
      where.push('source_id = ?');
      params.push(opts.sourceId);
    }

    let sql = 'SELECT id, address, port FROM configs';
    if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
    sql += ' ORDER BY id ASC';
    const limit = opts.limit && opts.limit > 0 ? Math.min(Math.trunc(opts.limit), 200000) : 0;
    if (limit) {
      sql += ' LIMIT ?';
      params.push(limit);
    }

    const rows = db.prepare(sql).all(...params) as Array<{ id: number; address: string; port: number }>;

    const runInfo = db
      .prepare(`INSERT INTO prescreen_runs (total, concurrency, timeout_ms, status) VALUES (?, ?, ?, 'running')`)
      .run(rows.length, concurrency, timeoutMs);
    const runId = Number(runInfo.lastInsertRowid);

    this.running = true;
    this.abortRequested = false;
    this.progress = { running: true, runId, done: 0, total: rows.length, alive: 0, startedAt: Date.now() };

    const startedAt = Date.now();
    let alive = 0;
    let completed = 0;
    let cursor = 0;
    let aborted = false;
    let failure: Error | null = null;

    const updateStmt = db.prepare(
      `UPDATE configs SET tcp_alive = ?, tcp_latency_ms = ?, prescreen_at = datetime('now') WHERE id = ?`
    );
    const writeBatch = db.transaction((batch: ProbeResult[]) => {
      for (const r of batch) {
        updateStmt.run(r.alive ? 1 : 0, r.alive ? r.ms : null, r.id);
      }
    });

    const batch: ProbeResult[] = [];

    const worker = async (): Promise<void> => {
      while (true) {
        if (this.abortRequested) {
          aborted = true;
          return;
        }
        const index = cursor++;
        if (index >= rows.length) return;

        const row = rows[index];
        const result = await BulkPrescreener.probeTcp(row.address, row.port, timeoutMs);
        batch.push({ id: row.id, alive: result.ok, ms: result.ms });
        if (result.ok) alive++;

        // `cursor` is shared and therefore not monotonic: track completion
        // with a dedicated counter so progress never regresses.
        completed++;
        this.progress.done = completed;
        this.progress.alive = alive;

        if (batch.length >= 250) {
          writeBatch(batch.splice(0, batch.length));
        }
      }
    };

    try {
      const workers = Array.from({ length: Math.min(concurrency, Math.max(rows.length, 1)) }, () => worker());
      await Promise.all(workers);
      if (batch.length) writeBatch(batch.splice(0, batch.length));
    } catch (err: any) {
      failure = err instanceof Error ? err : new Error(String(err));
    } finally {
      this.running = false;
      this.progress.running = false;

      // Always finalize the run record: a thrown worker used to leave the row
      // stuck at status='running' until the next boot.
      try {
        db.prepare(
          `UPDATE prescreen_runs
              SET finished_at = datetime('now'), alive = ?, status = ?, error = ?
            WHERE id = ?`
        ).run(alive, failure ? 'error' : aborted ? 'aborted' : 'done', failure ? failure.message : null, runId);
      } catch (dbErr: any) {
        console.error('[Prescreen] could not finalize run:', dbErr?.message || dbErr);
      }
    }

    const durationMs = Date.now() - startedAt;
    const dead = Math.max(0, completed - alive);

    if (failure) {
      throw failure;
    }

    return {
      runId,
      total: rows.length,
      alive,
      dead,
      durationMs,
      aborted
    };
  }

  /**
   * Single TCP handshake probe. Never throws: DNS failures, refused ports,
   * timeouts and invalid ports all resolve to `{ ok: false }`.
   */
  public static probeTcp(host: string, port: number, timeoutMs: number): Promise<{ ok: boolean; ms: number }> {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
        resolve({ ok: false, ms: -1 });
        return;
      }

      const socket = new net.Socket();
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve({ ok, ms: ok ? Date.now() - startedAt : -1 });
      };

      socket.setTimeout(timeoutMs);
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false));
      socket.once('error', () => finish(false));

      try {
        socket.connect(port, host);
      } catch {
        finish(false);
      }
    });
  }
}
