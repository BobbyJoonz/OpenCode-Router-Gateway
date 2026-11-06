import { db } from '../db/database';

export interface ProviderRow {
  id: number;
  name: string;
  kind: string;
  base_url: string;
  key_env: string;
  model: string | null;
  priority: number;
  cost_per_1m_in: number;
  cost_per_1m_out: number;
  rpm_limit: number;
  /** Tokens per minute ceiling for this provider account. 0 = unlimited. */
  tpm_limit: number;
  daily_usd_cap: number;
  enabled: number;
  created_at: string;
}

export interface ProviderInput {
  name: string;
  base_url: string;
  key_env: string;
  kind?: string;
  model?: string;
  priority?: number;
  cost_per_1m_in?: number;
  cost_per_1m_out?: number;
  rpm_limit?: number;
  tpm_limit?: number;
  daily_usd_cap?: number;
  enabled?: boolean;
}

/**
 * D4 — independent upstream providers.
 *
 * Rotation over IPs is only half the story; if every request ends at the same
 * provider, one outage (or one quota) takes the whole service down. Providers are
 * stored with their *cost* and their *key environment variable name* — never the
 * key itself.
 */
export class ProviderRegistry {
  public static list(): ProviderRow[] {
    return db.prepare('SELECT * FROM providers ORDER BY priority ASC, id ASC').all() as ProviderRow[];
  }

  public static get(id: number): ProviderRow | null {
    return (db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as ProviderRow) || null;
  }

  public static enabled(): ProviderRow[] {
    return db
      .prepare('SELECT * FROM providers WHERE enabled = 1 ORDER BY priority ASC, id ASC')
      .all() as ProviderRow[];
  }

  public static create(input: ProviderInput): ProviderRow {
    const name = String(input.name || '').trim();
    const baseUrl = String(input.base_url || '').trim();
    const keyEnv = String(input.key_env || '').trim();
    if (!name) throw new Error('name is required');
    if (!/^https?:\/\//i.test(baseUrl)) throw new Error('base_url must start with http(s)://');
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(keyEnv)) throw new Error('key_env must be an environment variable name');

    const info = db
      .prepare(
        `INSERT INTO providers
           (name, kind, base_url, key_env, model, priority, cost_per_1m_in, cost_per_1m_out, rpm_limit, tpm_limit, daily_usd_cap, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        name,
        String(input.kind || 'openai'),
        baseUrl.replace(/\/+$/, ''),
        keyEnv,
        input.model ? String(input.model) : null,
        Number.isFinite(input.priority as number) ? Math.trunc(input.priority as number) : 100,
        Math.max(0, Number(input.cost_per_1m_in) || 0),
        Math.max(0, Number(input.cost_per_1m_out) || 0),
        Math.max(0, Math.trunc(Number(input.rpm_limit) || 0)),
        Math.max(0, Math.trunc(Number(input.tpm_limit) || 0)),
        Math.max(0, Number(input.daily_usd_cap) || 0),
        input.enabled === false ? 0 : 1
      );

    return this.get(Number(info.lastInsertRowid))!;
  }

  public static update(id: number, patch: Partial<ProviderInput>): boolean {
    const current = this.get(id);
    if (!current) return false;

    const next = {
      name: patch.name ?? current.name,
      kind: patch.kind ?? current.kind,
      base_url: (patch.base_url ?? current.base_url).replace(/\/+$/, ''),
      key_env: patch.key_env ?? current.key_env,
      model: patch.model ?? current.model,
      priority: patch.priority ?? current.priority,
      cost_per_1m_in: patch.cost_per_1m_in ?? current.cost_per_1m_in,
      cost_per_1m_out: patch.cost_per_1m_out ?? current.cost_per_1m_out,
      rpm_limit: patch.rpm_limit ?? current.rpm_limit,
      tpm_limit: patch.tpm_limit ?? current.tpm_limit,
      daily_usd_cap: patch.daily_usd_cap ?? current.daily_usd_cap,
      enabled: patch.enabled === undefined ? current.enabled : patch.enabled ? 1 : 0
    };

    if (!/^https?:\/\//i.test(next.base_url)) throw new Error('base_url must start with http(s)://');

    db.prepare(
      `UPDATE providers
          SET name = ?, kind = ?, base_url = ?, key_env = ?, model = ?, priority = ?,
              cost_per_1m_in = ?, cost_per_1m_out = ?, rpm_limit = ?, tpm_limit = ?, daily_usd_cap = ?, enabled = ?
        WHERE id = ?`
    ).run(
      next.name,
      next.kind,
      next.base_url,
      next.key_env,
      next.model,
      next.priority,
      next.cost_per_1m_in,
      next.cost_per_1m_out,
      next.rpm_limit,
      next.tpm_limit,
      next.daily_usd_cap,
      next.enabled,
      id
    );
    return true;
  }

  public static remove(id: number): boolean {
    return db.prepare('DELETE FROM providers WHERE id = ?').run(id).changes > 0;
  }

  /** Resolve the actual secret at request time, from the environment only. */
  public static resolveApiKey(provider: ProviderRow): string {
    const value = process.env[provider.key_env];
    return (value || '').trim();
  }

  public static hasKey(provider: ProviderRow): boolean {
    return this.resolveApiKey(provider).length > 0;
  }

  /**
   * A synthetic provider built from the legacy `GATEWAY_UPSTREAM_*` env vars, so
   * an existing single-upstream deployment keeps working unchanged.
   */
  public static envFallback(): ProviderRow | null {
    const baseUrl = (process.env.GATEWAY_UPSTREAM_BASE_URL || '').trim();
    const key = (process.env.GATEWAY_UPSTREAM_API_KEY || '').trim();
    if (!baseUrl) return null;
    return {
      id: 0,
      name: 'env-fallback',
      kind: 'openai',
      base_url: baseUrl.replace(/\/+$/, ''),
      key_env: 'GATEWAY_UPSTREAM_API_KEY',
      model: (process.env.GATEWAY_UPSTREAM_MODEL || '').trim() || null,
      priority: 1000,
      cost_per_1m_in: 0,
      cost_per_1m_out: 0,
      rpm_limit: 0,
      tpm_limit: 0,
      daily_usd_cap: 0,
      enabled: key ? 1 : 0,
      created_at: new Date().toISOString()
    };
  }

  public static recordEvent(providerId: number, event: string, statusCode?: number, latencyMs?: number): void {
    try {
      db.prepare(
        `INSERT INTO provider_events (provider_id, event, status_code, latency_ms) VALUES (?, ?, ?, ?)`
      ).run(providerId, event, statusCode ?? null, latencyMs ?? null);
    } catch {
      // observability is best-effort
    }
  }

  public static health(providerId: number, windowMinutes = 60): { events: number; failures: number; rateLimits: number } {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS events,
                SUM(CASE WHEN event IN ('server','timeout','auth','failover') THEN 1 ELSE 0 END) AS failures,
                SUM(CASE WHEN event = 'rate_limit' THEN 1 ELSE 0 END) AS rateLimits
           FROM provider_events
          WHERE provider_id = ? AND created_at >= datetime('now', ?)`
      )
      .get(providerId, `-${Math.max(1, windowMinutes)} minutes`) as {
      events: number;
      failures: number;
      rateLimits: number;
    } | undefined;
    return {
      events: row?.events || 0,
      failures: row?.failures || 0,
      rateLimits: row?.rateLimits || 0
    };
  }
}