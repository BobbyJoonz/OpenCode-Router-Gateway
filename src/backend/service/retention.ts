import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { db, getSetting } from '../db/database';

export interface RetentionOptions {
  usageRetentionDays: number;
  testHistoryRetentionDays: number;
  usageMaxRows: number;
  vacuumThreshold: number;
}

export interface RetentionResult {
  deletedUsage: number;
  deletedHistory: number;
  deletedPrescreenRuns: number;
  vacuumed: boolean;
  durationMs: number;
}

export interface StorageStats {
  dbBytes: number;
  walBytes: number;
  shmBytes: number;
  usageRows: number;
  configs: number;
  testHistoryRows: number;
  prescreenRuns: number;
  oldestUsage: string | null;
  limits: {
    usageRetentionDays: number;
    testHistoryRetentionDays: number;
    usageMaxRows: number;
    dbMaxMb: number;
  };
  healthy: boolean;
  warnings: string[];
}

const DATA_DIR = path.resolve(__dirname, '../../../data');
const DB_PATH = path.join(DATA_DIR, 'opencode-vpn.db');

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * Bounded-growth maintenance.
 *
 * The gateway writes one `usage_log` row per request (~199 bytes measured). At
 * 10k requests/day that is ~57 MB/month with no upper bound, so a long-running
 * deployment would eventually fill the disk. This module enforces retention,
 * a hard row cap, and reclaims space — while never touching user data
 * (configs, providers, model routes, API keys).
 *
 * `applyRetention` takes the database handle so it can be unit-tested against an
 * in-memory database.
 */
export function applyRetention(handle: Database.Database, opts: RetentionOptions): RetentionResult {
  const startedAt = Date.now();
  let deletedUsage = 0;
  let deletedHistory = 0;
  let deletedPrescreenRuns = 0;

  // 1) age-based pruning
  if (opts.usageRetentionDays > 0) {
    deletedUsage += handle
      .prepare(`DELETE FROM usage_log WHERE created_at < datetime('now', ?)`)
      .run(`-${opts.usageRetentionDays} days`).changes;
  }
  if (opts.testHistoryRetentionDays > 0) {
    deletedHistory += handle
      .prepare(`DELETE FROM test_history WHERE timestamp < datetime('now', ?)`)
      .run(`-${opts.testHistoryRetentionDays} days`).changes;
  }

  // 2) hard row cap: drop the oldest rows beyond the limit
  if (opts.usageMaxRows > 0) {
    const count = (handle.prepare('SELECT COUNT(*) AS c FROM usage_log').get() as { c: number }).c;
    const excess = count - opts.usageMaxRows;
    if (excess > 0) {
      deletedUsage += handle
        .prepare(
          `DELETE FROM usage_log WHERE id IN (SELECT id FROM usage_log ORDER BY id ASC LIMIT ?)`
        )
        .run(excess).changes;
    }
  }

  // 3) prescreen history is diagnostic only: keep the last 100 runs
  const runs = (handle.prepare('SELECT COUNT(*) AS c FROM prescreen_runs').get() as { c: number }).c;
  if (runs > 100) {
    deletedPrescreenRuns = handle
      .prepare(
        `DELETE FROM prescreen_runs WHERE id IN (SELECT id FROM prescreen_runs ORDER BY id ASC LIMIT ?)`
      )
      .run(runs - 100).changes;
  }

  // 4) reclaim space, but only when enough was freed to justify the lock
  let vacuumed = false;
  const totalDeleted = deletedUsage + deletedHistory + deletedPrescreenRuns;
  if (totalDeleted >= Math.max(1, opts.vacuumThreshold)) {
    try {
      handle.pragma('wal_checkpoint(TRUNCATE)');
      handle.exec('VACUUM');
      vacuumed = true;
    } catch {
      // VACUUM can fail if another connection holds a lock; the next run retries.
    }
  }

  return { deletedUsage, deletedHistory, deletedPrescreenRuns, vacuumed, durationMs: Date.now() - startedAt };
}

/**
 * Periodic wrapper around `applyRetention`.
 */
export class RetentionService {
  private static timer: NodeJS.Timeout | null = null;
  private static running = false;
  private static lastRun: (RetentionResult & { at: string }) | null = null;

  public static isScheduled(): boolean {
    return this.timer !== null;
  }

  public static isRunning(): boolean {
    return this.running;
  }

  public static getLastRun() {
    return this.lastRun;
  }

  public static options(): RetentionOptions {
    return {
      usageRetentionDays: parseInt(getSetting('usage_retention_days', '90'), 10),
      testHistoryRetentionDays: parseInt(getSetting('test_history_retention_days', '30'), 10),
      usageMaxRows: parseInt(getSetting('usage_max_rows', '500000'), 10),
      vacuumThreshold: parseInt(getSetting('retention_vacuum_threshold', '5000'), 10)
    };
  }

  public static start(): void {
    if (this.timer) return;
    const schedule = () => {
      const seconds = Math.max(60, parseInt(getSetting('retention_interval_seconds', '3600'), 10));
      this.timer = setTimeout(() => {
        try {
          this.runNow();
        } catch (err: any) {
          console.error('[Retention] run failed:', err?.message || err);
        } finally {
          if (this.timer) schedule();
        }
      }, seconds * 1000);
      this.timer.unref?.();
    };
    schedule();
  }

  public static stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  public static runNow(): RetentionResult & { at: string } {
    if (this.running) {
      throw new Error('A retention run is already in progress');
    }
    this.running = true;
    try {
      const result = applyRetention(db, this.options());
      const record = { ...result, at: new Date().toISOString() };
      this.lastRun = record;
      if (result.deletedUsage + result.deletedHistory > 0 || result.vacuumed) {
        console.log(
          `[Retention] deleted usage=${result.deletedUsage} history=${result.deletedHistory} ` +
            `runs=${result.deletedPrescreenRuns} vacuum=${result.vacuumed} in ${result.durationMs}ms`
        );
      }
      return record;
    } finally {
      this.running = false;
    }
  }

  public static stats(): StorageStats {
    const opts = this.options();
    const dbMaxMb = parseInt(getSetting('db_max_mb', '512'), 10);

    const counts = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM usage_log) AS usageRows,
           (SELECT COUNT(*) FROM configs) AS configs,
           (SELECT COUNT(*) FROM test_history) AS testHistoryRows,
           (SELECT COUNT(*) FROM prescreen_runs) AS prescreenRuns,
           (SELECT MIN(created_at) FROM usage_log) AS oldestUsage`
      )
      .get() as any;

    const dbBytes = fileSize(DB_PATH);
    const walBytes = fileSize(`${DB_PATH}-wal`);
    const shmBytes = fileSize(`${DB_PATH}-shm`);
    const totalBytes = dbBytes + walBytes;

    const warnings: string[] = [];
    if (dbMaxMb > 0 && totalBytes > dbMaxMb * 1024 * 1024) {
      warnings.push(`database is ${(totalBytes / 1024 / 1024).toFixed(1)} MB, above the ${dbMaxMb} MB limit`);
    }
    if (opts.usageMaxRows > 0 && counts.usageRows > opts.usageMaxRows * 0.9) {
      warnings.push(`usage_log at ${counts.usageRows}/${opts.usageMaxRows} rows`);
    }
    if (walBytes > 64 * 1024 * 1024) {
      warnings.push(`WAL file is ${(walBytes / 1024 / 1024).toFixed(1)} MB`);
    }

    return {
      dbBytes,
      walBytes,
      shmBytes,
      usageRows: counts.usageRows,
      configs: counts.configs,
      testHistoryRows: counts.testHistoryRows,
      prescreenRuns: counts.prescreenRuns,
      oldestUsage: counts.oldestUsage || null,
      limits: {
        usageRetentionDays: opts.usageRetentionDays,
        testHistoryRetentionDays: opts.testHistoryRetentionDays,
        usageMaxRows: opts.usageMaxRows,
        dbMaxMb
      },
      healthy: warnings.length === 0,
      warnings
    };
  }
}
