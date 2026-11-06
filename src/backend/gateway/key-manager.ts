import crypto from 'crypto';
import { db } from '../db/database';

export interface ApiKeyRow {
  id: number;
  key_prefix: string;
  name: string;
  rpm_limit: number;
  daily_token_limit: number;
  enabled: number;
  created_at: string;
  last_used_at: string | null;
  total_requests: number;
  total_tokens: number;
}

export interface CreatedKey {
  id: number;
  key: string;
  key_prefix: string;
  name: string;
}

export type VerifyResult =
  | { ok: true; key: ApiKeyRow }
  | { ok: false; reason: 'missing' | 'invalid' | 'disabled' };

/**
 * API-key issuance and verification for the OpenAI-compatible gateway.
 *
 * Secrets are never stored: only a SHA-256 hash and a short display prefix.
 * The plaintext key is returned exactly once, at creation time.
 */
export class KeyManager {
  /** key_id -> timestamps (ms) of requests inside the current 60 s window */
  private static windows = new Map<number, number[]>();

  public static hash(secret: string): string {
    return crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
  }

  public static create(opts: {
    name: string;
    rpmLimit?: number;
    dailyTokenLimit?: number;
  }): CreatedKey {
    const name = (opts.name || '').trim();
    if (!name) throw new Error('name is required');
    if (name.length > 100) throw new Error('name is too long (max 100 chars)');

    const rpmRaw = Number(opts.rpmLimit ?? 60);
    const dailyRaw = Number(opts.dailyTokenLimit ?? 0);
    const rpm = Math.max(1, Math.min(Number.isFinite(rpmRaw) ? Math.trunc(rpmRaw) : 60, 100000));
    const daily = Math.max(0, Math.min(Number.isFinite(dailyRaw) ? Math.trunc(dailyRaw) : 0, 1_000_000_000));

    // 24 random bytes -> 32 base64url chars
    const secret = `sk-or-${crypto.randomBytes(24).toString('base64url')}`;
    const keyHash = this.hash(secret);
    const keyPrefix = secret.slice(0, 12);

    const info = db
      .prepare(
        `INSERT INTO api_keys (key_hash, key_prefix, name, rpm_limit, daily_token_limit, enabled)
         VALUES (?, ?, ?, ?, ?, 1)`
      )
      .run(keyHash, keyPrefix, name, rpm, daily);

    return { id: Number(info.lastInsertRowid), key: secret, key_prefix: keyPrefix, name };
  }

  public static list(): ApiKeyRow[] {
    return db
      .prepare(
        `SELECT id, key_prefix, name, rpm_limit, daily_token_limit, enabled,
                created_at, last_used_at, total_requests, total_tokens
           FROM api_keys ORDER BY id ASC`
      )
      .all() as ApiKeyRow[];
  }

  public static revoke(id: number): boolean {
    const info = db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
    this.windows.delete(id);
    return info.changes > 0;
  }

  public static setEnabled(id: number, enabled: boolean): boolean {
    const info = db.prepare('UPDATE api_keys SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    return info.changes > 0;
  }

  public static verify(authorizationHeader: string | undefined): VerifyResult {
    if (!authorizationHeader) return { ok: false, reason: 'missing' };

    const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
    if (!match) return { ok: false, reason: 'invalid' };

    const secret = match[1].trim();
    if (!secret.startsWith('sk-or-')) return { ok: false, reason: 'invalid' };

    const row = db
      .prepare(
        `SELECT id, key_prefix, name, rpm_limit, daily_token_limit, enabled,
                created_at, last_used_at, total_requests, total_tokens
           FROM api_keys WHERE key_hash = ?`
      )
      .get(this.hash(secret)) as ApiKeyRow | undefined;

    if (!row) return { ok: false, reason: 'invalid' };
    if (!row.enabled) return { ok: false, reason: 'disabled' };
    return { ok: true, key: row };
  }

  /**
   * Sliding-window requests-per-minute limiter (in-process).
   */
  public static checkRateLimit(keyId: number, rpmLimit: number): { ok: boolean; retryAfterMs: number } {
    if (!rpmLimit || rpmLimit <= 0) return { ok: true, retryAfterMs: 0 };

    const now = Date.now();
    const windowStart = now - 60_000;
    const hits = (this.windows.get(keyId) || []).filter((t) => t > windowStart);

    if (hits.length >= rpmLimit) {
      const oldest = hits[0];
      this.windows.set(keyId, hits);
      return { ok: false, retryAfterMs: Math.max(250, oldest + 60_000 - now) };
    }

    hits.push(now);
    this.windows.set(keyId, hits);
    return { ok: true, retryAfterMs: 0 };
  }

  public static tokensUsedToday(keyId: number): number {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(total_tokens), 0) AS used
           FROM usage_log
          WHERE key_id = ? AND created_at >= datetime('now', 'start of day')`
      )
      .get(keyId) as { used: number } | undefined;
    return row?.used || 0;
  }

  /**
   * In-flight token reservations.
   *
   * The daily quota is a check-then-act: without reserving, N concurrent
   * requests all read the same "used" value and can blow through the limit.
   */
  private static pendingTokens = new Map<number, number>();

  public static reserveTokens(keyId: number, amount: number): void {
    const safe = Number.isFinite(amount) ? Math.max(0, Math.trunc(amount)) : 0;
    this.pendingTokens.set(keyId, (this.pendingTokens.get(keyId) || 0) + safe);
  }

  public static releaseTokens(keyId: number, amount: number): void {
    const safe = Number.isFinite(amount) ? Math.max(0, Math.trunc(amount)) : 0;
    const next = (this.pendingTokens.get(keyId) || 0) - safe;
    if (next > 0) this.pendingTokens.set(keyId, next);
    else this.pendingTokens.delete(keyId);
  }

  public static pendingFor(keyId: number): number {
    return this.pendingTokens.get(keyId) || 0;
  }

  public static recordUsage(params: {
    keyId: number;
    model: string | null;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    statusCode: number;
    latencyMs: number;
    upstream: string;
    egressNodeId: number | null;
    error?: string | null;
  }): void {
    try {
      db.prepare(
        `INSERT INTO usage_log
           (key_id, model, prompt_tokens, completion_tokens, total_tokens,
            status_code, latency_ms, upstream, egress_node_id, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        params.keyId,
        params.model,
        params.promptTokens,
        params.completionTokens,
        params.totalTokens,
        params.statusCode,
        params.latencyMs,
        params.upstream,
        params.egressNodeId,
        params.error || null
      );

      db.prepare(
        `UPDATE api_keys
            SET total_requests = total_requests + 1,
                total_tokens = total_tokens + ?,
                last_used_at = datetime('now')
          WHERE id = ?`
      ).run(params.totalTokens, params.keyId);
    } catch (err: any) {
      console.error('[Gateway] failed to record usage:', err?.message || err);
    }
  }

  public static usageSummary(keyId?: number): any {
    if (keyId) {
      return db
        .prepare(
          `SELECT COUNT(*) AS requests,
                  COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                  COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
                  COALESCE(SUM(total_tokens), 0) AS total_tokens
             FROM usage_log WHERE key_id = ?`
        )
        .get(keyId);
    }
    return db
      .prepare(
        `SELECT COUNT(*) AS requests,
                COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
                COALESCE(SUM(total_tokens), 0) AS total_tokens
           FROM usage_log`
      )
      .get();
  }
}
