import { db, getSetting } from '../db/database';
import { ProviderRegistry, ProviderRow } from '../providers/provider-registry';

export interface ModelRoute {
  id: number;
  alias: string;
  provider_id: number;
  upstream_model: string;
  priority: number;
  enabled: number;
  created_at: string;
}

export interface ModelPlan {
  alias: string;
  /** provider ids in the order they should be tried */
  providerIds: number[];
  /** provider id -> the model name that provider expects */
  modelByProvider: Record<number, string>;
}

/**
 * Model routing: turns a client-facing model name into an ordered list of
 * (provider, upstream model) pairs.
 *
 * Why it exists:
 *   - Different providers name the same model differently
 *     (`gpt-4o-mini` vs `openai/gpt-4o-mini` vs a versioned id).
 *   - Some models only exist on one provider; without a mapping the request is
 *     forwarded to whichever provider the policy picked and fails with a 4xx.
 *   - It lets clients use stable aliases ("fast", "smart") while the operator
 *     changes the underlying provider without touching client config.
 */
export class ModelRouter {
  public static list(): ModelRoute[] {
    return db
      .prepare('SELECT * FROM model_routes ORDER BY alias ASC, priority ASC, id ASC')
      .all() as ModelRoute[];
  }

  public static create(input: {
    alias: string;
    providerId: number;
    upstreamModel: string;
    priority?: number;
    enabled?: boolean;
  }): ModelRoute {
    const alias = String(input.alias || '').trim();
    const upstreamModel = String(input.upstreamModel || '').trim();
    if (!alias) throw new Error('alias is required');
    if (alias.length > 120) throw new Error('alias is too long (max 120)');
    if (!upstreamModel) throw new Error('upstreamModel is required');
    if (upstreamModel.length > 200) throw new Error('upstreamModel is too long (max 200)');
    if (!ProviderRegistry.get(input.providerId)) throw new Error('provider not found');

    const priority = Number.isFinite(Number(input.priority)) ? Math.trunc(Number(input.priority)) : 100;

    db.prepare(
      `INSERT INTO model_routes (alias, provider_id, upstream_model, priority, enabled)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(alias, provider_id) DO UPDATE SET
         upstream_model = excluded.upstream_model,
         priority = excluded.priority,
         enabled = excluded.enabled`
    ).run(alias, input.providerId, upstreamModel, priority, input.enabled === false ? 0 : 1);

    return db
      .prepare('SELECT * FROM model_routes WHERE alias = ? AND provider_id = ?')
      .get(alias, input.providerId) as ModelRoute;
  }

  public static remove(id: number): boolean {
    return db.prepare('DELETE FROM model_routes WHERE id = ?').run(id).changes > 0;
  }

  public static removeAlias(alias: string): number {
    return db.prepare('DELETE FROM model_routes WHERE alias = ?').run(alias).changes;
  }

  /**
   * Resolve a model alias into a plan. Returns null when the alias is not mapped,
   * which lets the caller decide between passthrough and a 404.
   */
  public static plan(alias: string): ModelPlan | null {
    const name = String(alias || '').trim();
    if (!name) return null;

    const rows = db
      .prepare(
        `SELECT r.*, p.enabled AS provider_enabled
           FROM model_routes r
           JOIN providers p ON p.id = r.provider_id
          WHERE r.alias = ? AND r.enabled = 1 AND p.enabled = 1
          ORDER BY r.priority ASC, r.id ASC`
      )
      .all(name) as Array<ModelRoute & { provider_enabled: number }>;

    if (rows.length === 0) return null;

    // Only keep providers that actually have a usable key configured.
    const available = new Map<number, ProviderRow>(
      ProviderRegistry.enabled()
        .filter((p) => ProviderRegistry.hasKey(p))
        .map((p) => [p.id, p] as const)
    );

    const usable = rows.filter((r) => available.has(r.provider_id));
    if (usable.length === 0) return null;

    const modelByProvider: Record<number, string> = {};
    for (const row of usable) {
      modelByProvider[row.provider_id] = row.upstream_model;
    }

    return {
      alias: name,
      providerIds: usable.map((r) => r.provider_id),
      modelByProvider
    };
  }

  /** Distinct aliases, used to build the public /v1/models list. */
  public static aliases(): string[] {
    return (
      db
        .prepare('SELECT DISTINCT alias FROM model_routes WHERE enabled = 1 ORDER BY alias ASC')
        .all() as Array<{ alias: string }>
    ).map((r) => r.alias);
  }

  /** Aliases grouped with their targets, for the admin API. */
  public static describe(): Array<{ alias: string; targets: Array<{ provider: string; upstream_model: string; priority: number }> }> {
    const rows = db
      .prepare(
        `SELECT r.alias, r.upstream_model, r.priority, r.enabled, p.name AS provider_name
           FROM model_routes r
           JOIN providers p ON p.id = r.provider_id
          ORDER BY r.alias ASC, r.priority ASC, r.id ASC`
      )
      .all() as Array<{ alias: string; upstream_model: string; priority: number; enabled: number; provider_name: string }>;

    const byAlias = new Map<string, Array<{ provider: string; upstream_model: string; priority: number }>>();
    for (const row of rows) {
      if (!row.enabled) continue;
      const list = byAlias.get(row.alias) || [];
      list.push({ provider: row.provider_name, upstream_model: row.upstream_model, priority: row.priority });
      byAlias.set(row.alias, list);
    }

    return [...byAlias.entries()].map(([alias, targets]) => ({ alias, targets }));
  }

  public static requireRoute(): boolean {
    return getSetting('gateway_require_model_route', 'false') === 'true';
  }
}
