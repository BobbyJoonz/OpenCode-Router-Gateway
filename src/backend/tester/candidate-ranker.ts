import { db } from '../db/database';

export interface RankedConfigRow {
  id: number;
  protocol: string;
  address: string;
  port: number;
  remark: string;
  security: string;
  network: string;
  details_json: string;
  last_status: string;
  last_latency_ms: number | null;
  consecutive_failures: number;
  success_count: number;
  score: number;
}

export class CandidateRanker {
  /**
   * Get sorted candidate configurations ready for testing
   */
  public static getRankedCandidates(limit: number = 30): RankedConfigRow[] {
    const rows = db
      .prepare(`
      SELECT
        id, protocol, address, port, remark, security, network, details_json,
        last_status, last_latency_ms, consecutive_failures, success_count
      FROM configs
      WHERE consecutive_failures < 4
      ORDER BY
        CASE
          WHEN last_status = 'working' THEN 1
          WHEN last_status = 'untested' THEN 2
          ELSE 3
        END,
        consecutive_failures ASC,
        CASE WHEN last_latency_ms IS NOT NULL AND last_latency_ms > 0 THEN last_latency_ms ELSE 9999 END ASC,
        id ASC
      LIMIT ?
    `)
      .all(limit * 2) as any[];

    // Calculate smart score
    const scored: RankedConfigRow[] = rows.map((r) => {
      let score = 100;

      // Bonus for currently verified working status
      if (r.last_status === 'working') score += 50;

      // Bonus for past success
      score += r.success_count * 50;

      // Penalty for consecutive failures
      score -= r.consecutive_failures * 30;

      // Bonus for VLESS Reality/TLS
      if (r.protocol === 'vless') score += 20;
      if (r.security === 'reality') score += 15;
      if (r.protocol === 'trojan') score += 10;

      // Latency factor
      if (r.last_latency_ms && r.last_latency_ms > 0) {
        if (r.last_latency_ms < 150) score += 25;
        else if (r.last_latency_ms < 300) score += 10;
        else if (r.last_latency_ms > 800) score -= 20;
      }

      return {
        ...r,
        score
      };
    });

    // Sort descending by score
    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, limit);
  }
}
