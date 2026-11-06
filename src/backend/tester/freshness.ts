import { db } from '../db/database';

export interface FreshnessSnapshot {
  nodeId: number;
  freshnessScore: number;
  successStreak: number;
  rateLimitHits: number;
  requestsBefore429: number | null;
  last429At: string | null;
}

/**
 * D2 — IP freshness instrumentation.
 *
 * The only honest way to rank egress IPs is by *how many successful requests they
 * deliver before the provider throttles them*. This tracker records exactly that:
 *
 *   success      -> streak grows, score rises
 *   429          -> the streak at that moment is stored as `requests_before_429`,
 *                   hits grow, score falls
 *
 * The score is deterministic and explainable, not a black box:
 *
 *   base    = 100
 *   penalty = min(70, rate_limit_hits * 7)
 *   bonus   = min(20, success_streak * 2)
 *   ratio   = clamp(requests_before_429 / 50, 0.2, 1)   (1 when unknown)
 *   score   = clamp((base - penalty + bonus) * ratio, 0, 100)
 */
export class FreshnessTracker {
  public static readonly TARGET_REQUESTS_BEFORE_429 = 50;

  public static recordSuccess(nodeId: number): void {
    try {
      db.prepare(
        `UPDATE configs
            SET success_streak = COALESCE(success_streak, 0) + 1,
                freshness_score = ?
          WHERE id = ?`
      ).run(this.computeScore(nodeId, 1), nodeId);
    } catch (err: any) {
      console.error('[Freshness] recordSuccess failed:', err?.message || err);
    }
  }

  public static recordRateLimit(nodeId: number): void {
    try {
      const row = db
        .prepare('SELECT success_streak, requests_before_429, rate_limit_hits FROM configs WHERE id = ?')
        .get(nodeId) as
        | { success_streak: number | null; requests_before_429: number | null; rate_limit_hits: number | null }
        | undefined;
      if (!row) return;

      const streak = row.success_streak || 0;
      // Only record the *first* useful measurement; a streak of 0 tells us nothing.
      const observed = row.requests_before_429;
      const nextObserved = streak > 0 ? (observed === null || observed === undefined ? streak : Math.round((observed + streak) / 2)) : observed;

      db.prepare(
        `UPDATE configs
            SET rate_limit_hits = COALESCE(rate_limit_hits, 0) + 1,
                success_streak = 0,
                last_429_at = datetime('now'),
                requests_before_429 = ?,
                freshness_score = ?
          WHERE id = ?`
      ).run(nextObserved, this.computeScore(nodeId, 0), nodeId);
    } catch (err: any) {
      console.error('[Freshness] recordRateLimit failed:', err?.message || err);
    }
  }

  /** Recompute every node's score from its counters (used after bulk imports). */
  public static recomputeAll(): number {
    const rows = db
      .prepare('SELECT id, rate_limit_hits, success_streak, requests_before_429 FROM configs')
      .all() as Array<{
      id: number;
      rate_limit_hits: number | null;
      success_streak: number | null;
      requests_before_429: number | null;
    }>;

    const update = db.prepare('UPDATE configs SET freshness_score = ? WHERE id = ?');
    const tx = db.transaction((items: typeof rows) => {
      for (const row of items) {
        update.run(this.scoreFrom(row.rate_limit_hits, row.success_streak, row.requests_before_429), row.id);
      }
    });
    tx(rows);
    return rows.length;
  }

  public static scoreFrom(
    rateLimitHits: number | null,
    successStreak: number | null,
    requestsBefore429: number | null
  ): number {
    const hits = Math.max(0, rateLimitHits || 0);
    const streak = Math.max(0, successStreak || 0);
    const penalty = Math.min(70, hits * 7);
    const bonus = Math.min(20, streak * 2);
    const ratio =
      requestsBefore429 === null || requestsBefore429 === undefined
        ? 1
        : Math.max(0.2, Math.min(1, requestsBefore429 / this.TARGET_REQUESTS_BEFORE_429));
    const score = (100 - penalty + bonus) * ratio;
    return Math.max(0, Math.min(100, Math.round(score * 100) / 100));
  }

  private static computeScore(nodeId: number, _delta: number): number {
    const row = db
      .prepare('SELECT rate_limit_hits, success_streak, requests_before_429 FROM configs WHERE id = ?')
      .get(nodeId) as
      | { rate_limit_hits: number | null; success_streak: number | null; requests_before_429: number | null }
      | undefined;
    if (!row) return 100;
    return this.scoreFrom(row.rate_limit_hits, row.success_streak, row.requests_before_429);
  }

  public static snapshot(nodeId: number): FreshnessSnapshot | null {
    const row = db
      .prepare(
        `SELECT id, freshness_score, success_streak, rate_limit_hits, requests_before_429, last_429_at
           FROM configs WHERE id = ?`
      )
      .get(nodeId) as any;
    if (!row) return null;
    return {
      nodeId: row.id,
      freshnessScore: row.freshness_score ?? 100,
      successStreak: row.success_streak ?? 0,
      rateLimitHits: row.rate_limit_hits ?? 0,
      requestsBefore429: row.requests_before_429 ?? null,
      last429At: row.last_429_at ?? null
    };
  }

  public static list(limit = 50): FreshnessSnapshot[] {
    const rows = db
      .prepare(
        `SELECT id, freshness_score, success_streak, rate_limit_hits, requests_before_429, last_429_at
           FROM configs
          WHERE freshness_score IS NOT NULL
          ORDER BY freshness_score DESC, id ASC
          LIMIT ?`
      )
      .all(limit) as any[];
    return rows.map((row) => ({
      nodeId: row.id,
      freshnessScore: row.freshness_score ?? 100,
      successStreak: row.success_streak ?? 0,
      rateLimitHits: row.rate_limit_hits ?? 0,
      requestsBefore429: row.requests_before_429 ?? null,
      last429At: row.last_429_at ?? null
    }));
  }

  /**
   * The headline number D2 promises: "this node survives N requests before 429".
   * Returns null until at least one 429 has been observed.
   */
  public static averageRequestsBefore429(): { average: number; samples: number } | null {
    const row = db
      .prepare(
        `SELECT AVG(requests_before_429) AS avg, COUNT(*) AS samples
           FROM configs WHERE requests_before_429 IS NOT NULL AND requests_before_429 > 0`
      )
      .get() as { avg: number | null; samples: number };
    if (!row || !row.samples) return null;
    return { average: Math.round((row.avg || 0) * 10) / 10, samples: row.samples };
  }
}
