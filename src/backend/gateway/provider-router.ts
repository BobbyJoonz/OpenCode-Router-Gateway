import { getSetting } from '../db/database';
import { ProviderRegistry, ProviderRow } from '../providers/provider-registry';
import { ProviderSelector } from '../providers/provider-selector';
import { ForwardOptions, ForwardResult, UpstreamClient } from './upstream-client';

export interface ProviderForwardResult {
  forwarded: ForwardResult;
  provider: ProviderRow;
  attempts: number;
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
    const fallback = ProviderRegistry.envFallback();
    return fallback ? [fallback] : [];
  }

  public static hasProviders(): boolean {
    return this.available().length > 0;
  }

  public static async forward(opts: ForwardOptions): Promise<ProviderForwardResult> {
    const maxAttempts = Math.max(1, Math.min(parseInt(getSetting('gateway_max_provider_attempts', '3'), 10), 10));
    const tried: number[] = [];
    let lastError: any = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const candidates = ProviderSelector.candidates(tried);
      const provider = candidates[0] || this.available().find((p) => !tried.includes(p.id)) || null;
      if (!provider) break;
      tried.push(provider.id);

      try {
        const forwarded = await UpstreamClient.forward({
          ...opts,
          baseUrl: provider.base_url,
          apiKey: ProviderRegistry.resolveApiKey(provider)
        });

        if (forwarded.statusCode >= 500) {
          // Drain and let another provider try.
          try {
            await UpstreamClient.readAll(forwarded.body);
          } catch {
            /* ignore */
          }
          forwarded.cleanup();
          ProviderSelector.recordFailure(provider.id, 'server', forwarded.statusCode);
          continue;
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
