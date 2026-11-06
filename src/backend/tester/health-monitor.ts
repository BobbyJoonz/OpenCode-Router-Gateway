import { db, getSetting } from '../db/database';
import { BulkPrescreener } from './bulk-prescreener';
import { EphemeralTunnelTester, type ProbeRow } from './ephemeral-tunnel';

export interface HealthCheckSummary {
  checked: number;
  healthy: number;
  dead: number;
  tunnelFailed: number;
  durationMs: number;
  at: string;
}

export interface HealthMonitorStatus {
  enabled: boolean;
  scheduled: boolean;
  checking: boolean;
  intervalSeconds: number;
  batch: number;
  lastRun: HealthCheckSummary | null;
  nextRunInMs: number | null;
}

const EWMA_ALPHA = 0.3;
const DEAD_THRESHOLD = 2;

/**
 * Background health monitor.
 *
 * Free public nodes rot within minutes: a node that answered in 6 s was timing out
 * 15 minutes later in our measurements. The monitor keeps a decaying health score
 * per node so the gateway can prefer fresh, proven endpoints instead of stale ones.
 *
 * Probes run through `EphemeralTunnelTester` on dedicated ports, so a health check
 * never interrupts the connection that is currently serving clients.
 */
export class HealthMonitor {
  private static timer: NodeJS.Timeout | null = null;
  private static checking = false;
  private static lastRun: HealthCheckSummary | null = null;
  private static nextRunAt: number | null = null;

  public static isScheduled(): boolean {
    return this.timer !== null;
  }

  public static isChecking(): boolean {
    return this.checking;
  }

  public static getStatus(): HealthMonitorStatus {
    return {
      enabled: getSetting('health_check_enabled', 'true') === 'true',
      scheduled: this.isScheduled(),
      checking: this.checking,
      intervalSeconds: parseInt(getSetting('health_check_interval_seconds', '300'), 10),
      batch: parseInt(getSetting('health_check_batch', '8'), 10),
      lastRun: this.lastRun,
      nextRunInMs: this.nextRunAt ? Math.max(0, this.nextRunAt - Date.now()) : null
    };
  }

  public static start(): void {
    if (this.timer) return;
    if (getSetting('health_check_enabled', 'true') !== 'true') return;

    const schedule = () => {
      const intervalMs = Math.max(30, parseInt(getSetting('health_check_interval_seconds', '300'), 10)) * 1000;
      this.nextRunAt = Date.now() + intervalMs;
      this.timer = setTimeout(async () => {
        try {
          await this.checkNow();
        } catch (err: any) {
          console.error('[HealthMonitor] check failed:', err?.message || err);
        } finally {
          if (this.timer) schedule();
        }
      }, intervalMs);
      this.timer.unref?.();
    };

    schedule();
  }

  public static stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      this.nextRunAt = null;
    }
  }

  /**
   * Re-check one batch of nodes right now.
   */
  public static async checkNow(batchOverride?: number): Promise<HealthCheckSummary> {
    if (this.checking) {
      throw new Error('A health check is already running');
    }
    this.checking = true;
    const startedAt = Date.now();

    const batch = Math.max(1, Math.min(batchOverride ?? parseInt(getSetting('health_check_batch', '8'), 10), 50));

    let checked = 0;
    let healthy = 0;
    let dead = 0;
    let tunnelFailed = 0;

    try {
      const rows = db
        .prepare(
          `SELECT id, protocol, address, port, security, network, details_json,
                  health_score, consecutive_failures, last_status
             FROM configs
            WHERE is_active = 0
              AND last_status IN ('working', 'untested')
              AND (tcp_alive IS NULL OR tcp_alive = 1)
            ORDER BY
              CASE WHEN last_status = 'working' THEN 0 ELSE 1 END,
              COALESCE(health_score, 100) DESC,
              last_health_check IS NOT NULL,
              last_health_check ASC
            LIMIT ?`
        )
        .all(batch) as Array<
        ProbeRow & { health_score: number | null; consecutive_failures: number; last_status: string }
      >;

      const updateNode = db.prepare(`
        UPDATE configs
           SET health_score = ?,
               last_health_check = datetime('now'),
               tcp_alive = ?,
               egress_ip = COALESCE(?, egress_ip)
         WHERE id = ?
      `);
      const markFailed = db.prepare(`
        UPDATE configs
           SET last_status = 'failed',
               consecutive_failures = consecutive_failures + 1,
               health_score = ?,
               last_health_check = datetime('now')
         WHERE id = ?
      `);
      const markWorking = db.prepare(`
        UPDATE configs
           SET last_status = 'working',
               consecutive_failures = 0,
               health_score = ?,
               last_health_check = datetime('now')
         WHERE id = ?
      `);

      for (const row of rows) {
        checked++;
        const tcp = await BulkPrescreener.probeTcp(row.address, row.port, 1500);
        if (!tcp.ok) {
          dead++;
          const score = this.ewma(row.health_score, 0);
          updateNode.run(score, 0, null, row.id);
          if (row.consecutive_failures + 1 >= DEAD_THRESHOLD) {
            markFailed.run(score, row.id);
          }
          continue;
        }

        const result = await EphemeralTunnelTester.test(row, 9000);
        const score = this.ewma(row.health_score, result.tunnel ? 100 : 0);

        if (result.tunnel) {
          healthy++;
          markWorking.run(score, row.id);
          updateNode.run(score, 1, result.egressIp || null, row.id);
          if (result.egressIp) {
            this.recordEgress(row.id, result.egressIp);
          }
        } else {
          tunnelFailed++;
          updateNode.run(score, 1, null, row.id);
          if (row.consecutive_failures + 1 >= DEAD_THRESHOLD) {
            markFailed.run(score, row.id);
          }
        }
      }

      this.lastRun = {
        checked,
        healthy,
        dead,
        tunnelFailed,
        durationMs: Date.now() - startedAt,
        at: new Date().toISOString()
      };
      return this.lastRun;
    } finally {
      this.checking = false;
    }
  }

  private static ewma(previous: number | null, sample: number): number {
    const prev = previous === null || previous === undefined ? 100 : previous;
    return Math.round((1 - EWMA_ALPHA) * prev + EWMA_ALPHA * sample);
  }

  private static recordEgress(nodeId: number, egressIp: string): void {
    try {
      db.prepare(
        `INSERT INTO egress_groups (egress_ip, last_seen)
         VALUES (?, datetime('now'))
         ON CONFLICT(egress_ip) DO UPDATE SET last_seen = datetime('now')`
      ).run(egressIp);

      db.prepare(
        `UPDATE egress_groups
            SET node_count = (SELECT COUNT(*) FROM configs WHERE egress_ip = egress_groups.egress_ip)
          WHERE egress_ip = ?`
      ).run(egressIp);
    } catch {
      // grouping is best-effort
    }
  }
}
