import { getSetting } from '../db/database';
import { ProviderRegistry, ProviderRow } from '../providers/provider-registry';
import { ProviderSelector } from '../providers/provider-selector';
import { ForwardOptions, ForwardResult, UpstreamClient } from './upstream-client';

export interface ProviderForwardResult {
  forwarded: ForwardResult;
  provider: ProviderRow;
  attempts: number;
}

export interface ProviderSelection {
  /** Provider ids to try, in order. Overrides the global policy. */
  providerIds?: number[];
  /** Per-provider upstream model name (from a model route). */
  modelByProvider?: Record<number, string>;
}

/**
 * D4 — routes a request across independent providers.
 *
 * Division of responsibility (deliberate, to avoid two nested retry loops):
 *   * this layer handles **provider** failover: network errors, timeouts, 5xx
 *   * the caller handles **egress** rotation: HTTP 429
 *
 * A 429 or 401 is therefore returned to the caller untouched, together with the
 * provider that produced it.
 */
export class ProviderRouter {
  public static available(): ProviderRow[] {
    const configured = ProviderRegistry.enabled().filter((provider) => ProviderRegistry.hasKey(provider));
    if (configured.length > 0) return configured;

    const envProvider = ProviderRegistry.envFallback();
    if (envProvider) return [envProvider];

    // Last resort: a single upstream configured through the settings API
    // (`gateway_upstream_base_url`), which is how a 1.x deployment runs.
    const config = UpstreamClient.resolveConfig();
    if (config.baseUrl) {
      return [
        {
          id: 0,
          name: 'settings-fallback',
          kind: 'openai',
          base_url: config.baseUrl,
          key_env: 'GATEWAY_UPSTREAM_API_KEY',
          model: config.model || null,
          priority: 1000,
          cost_per_1m_in: 0,
          cost_per_1m_out: 0,
          rpm_limit: 0,
          daily_usd_cap: 0,
          enabled: 1,
          created_at: new Date().toISOString()
        }
      ];
    }

    return [];
  }

  public static hasProviders(): boolean {
    return this.available().length > 0;
  }

  public static async forward(opts: ForwardOptions, selection?: ProviderSelection): Promise<ProviderForwardResult> {
    const maxAttempts = Math.max(1, Math.min(parseInt(getSetting('gateway_max_provider_attempts', '3'), 10), 10));
    const tried: number[] = [];
    let lastError: any = null;
    const pinnedOrder = selection?.providerIds && selection.providerIds.length > 0 ? selection.providerIds : null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let provider: ProviderRow | null;

      if (pinnedOrder) {
        // Model-routed request: only the providers that actually host this model,
        // in the operator-defined order.
        const allowed = new Set(pinnedOrder);
        const pool = this.available().filter((p) => allowed.has(p.id) && !tried.includes(p.id));
        pool.sort((a, b) => pinnedOrder.indexOf(a.id) - pinnedOrder.indexOf(b.id));
        provider = pool[0] || null;
      } else {
        const candidates = ProviderSelector.candidates(tried);
        provider = candidates[0] || this.available().find((p) => !tried.includes(p.id)) || null;
      }

      if (!provider) break;
      tried.push(provider.id);

      // Apply the per-provider model name when the request was model-routed.
      const modelOverride = selection?.modelByProvider?.[provider.id];
      const forwardOpts: ForwardOptions =
        modelOverride && opts.body && typeof opts.body === 'object'
          ? { ...opts, body: { ...opts.body, model: modelOverride } }
          : opts;

      try {
        const forwarded = await UpstreamClient.forward({
          ...forwardOpts,
          baseUrl: provider.base_url,
          apiKey: ProviderRegistry.resolveApiKey(provider)
        });

        if (forwarded.statusCode >= 500) {
          // Only fail over if there is actually another provider to try.
          // Otherwise the caller decides (pass-through vs egress rotation).
          const remaining = pinnedOrder
            ? this.available().filter((p) => pinnedOrder.includes(p.id) && !tried.includes(p.id))
            : ProviderSelector.candidates(tried);
          if (remaining.length === 0) {
            ProviderSelector.recordFailure(provider.id, 'server', forwarded.statusCode);
            return { forwarded, provider, attempts: attempt };
          }
          try {
            await UpstreamClient.readAll(forwarded.body);
          } catch {
            /* ignore */
          }
          forwarded.cleanup();
          ProviderSelector.recordFailure(provider.id, 'server', forwarded.statusCode);
          continue;
        }

        // A model-routed request may hit a provider that does not actually host
        // the model (404). That is a routing miss, not a client error: try the
        // next mapped provider.
        if (pinnedOrder && forwarded.statusCode === 404) {
          const remaining = this.available().filter((p) => pinnedOrder.includes(p.id) && !tried.includes(p.id));
          if (remaining.length > 0) {
            try {
              await UpstreamClient.readAll(forwarded.body);
            } catch {
              /* ignore */
            }
            forwarded.cleanup();
            ProviderSelector.recordFailure(provider.id, 'model_missing', 404);
            continue;
          }
        }

        if (forwarded.statusCode === 429) {
          ProviderSelector.recordFailure(provider.id, 'rate_limit', 429);
          return { forwarded, provider, attempts: attempt };
        }

        if (forwarded.statusCode === 401 || forwarded.statusCode === 403) {
          ProviderSelector.recordFailure(provider.id, 'auth', forwarded.statusCode);
          return { forwarded, provider, attempts: attempt };
        }

        ProviderSelector.recordSuccess(provider.id);
        return { forwarded, provider, attempts: attempt };
      } catch (err: any) {
        lastError = err;
        ProviderSelector.recordFailure(provider.id, err?.code === 'UPSTREAM_TIMEOUT' ? 'timeout' : 'failover');
      }
    }

    throw lastError || Object.assign(new Error('No upstream provider is available'), { code: 'NO_PROVIDER' });
  }

  public static status(): Array<{
    id: number;
    name: string;
    priority: number;
    cost_per_1m_in: number;
    cost_per_1m_out: number;
    has_key: boolean;
    cooling: boolean;
    failures: number;
  }> {
    const snapshot = new Map<number, { cooling: boolean; failures: number }>(
      ProviderSelector.snapshot().map((item) => [item.id, item] as const)
    );
    return this.available().map((provider) => {
      const state = snapshot.get(provider.id);
      return {
        id: provider.id,
        name: provider.name,
        priority: provider.priority,
        cost_per_1m_in: provider.cost_per_1m_in,
        cost_per_1m_out: provider.cost_per_1m_out,
        has_key: ProviderRegistry.hasKey(provider),
        cooling: state?.cooling || false,
        failures: state?.failures || 0
      };
    });
  }
}
