import { getSetting } from '../db/database';
import { ProviderRegistry, ProviderRow } from '../providers/provider-registry';
import { ProviderSelector } from '../providers/provider-selector';
import { TpmTracker } from '../providers/tpm-tracker';
import { Readable } from 'stream';
import { ForwardOptions, ForwardResult, UpstreamClient } from './upstream-client';
import { classifyUpstream, UpstreamErrorInfo } from './upstream-errors';

export interface ProviderForwardResult {
  forwarded: ForwardResult;
  provider: ProviderRow;
  attempts: number;
  /** classification of a non-2xx answer, when there was one */
  error?: UpstreamErrorInfo;
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
          tpm_limit: 0,
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

    // Pre-flight token estimate drives TPM admission: a provider whose per-minute
    // budget cannot fit this request is skipped, so several accounts add up to an
    // aggregate TPM larger than any single one.
    const estimatedTokens = TpmTracker.estimateFromBody(opts.body);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let provider: ProviderRow | null;

      if (pinnedOrder) {
        // Model-routed request: only the providers that actually host this model,
        // in the operator-defined order, and only if their TPM budget allows it.
        const allowed = new Set(pinnedOrder);
        const pool = this.available().filter(
          (p) =>
            allowed.has(p.id) &&
            !tried.includes(p.id) &&
            TpmTracker.canAccept(p.id, estimatedTokens, p.tpm_limit, p.rpm_limit)
        );
        pool.sort((a, b) => pinnedOrder.indexOf(a.id) - pinnedOrder.indexOf(b.id));
        provider = pool[0] || null;
      } else {
        const candidates = ProviderSelector.candidates(tried, estimatedTokens);
        // Fall back to `available()` (env / settings upstream) so a deployment with
        // no providers table row still works — but only if its TPM budget allows.
        provider =
          candidates[0] ||
          this.available().find(
            (p) => !tried.includes(p.id) && TpmTracker.canAccept(p.id, estimatedTokens, p.tpm_limit, p.rpm_limit)
          ) ||
          null;
      }

      if (!provider) {
        // Distinguish "no providers at all" from "all providers are at their TPM
        // ceiling" — the caller answers 429 + Retry-After for the latter.
        const untried = this.available().filter((p) => !tried.includes(p.id));
        const rateBlocked = untried.filter(
          (p) =>
            (p.tpm_limit > 0 || p.rpm_limit > 0) &&
            !TpmTracker.canAccept(p.id, estimatedTokens, p.tpm_limit, p.rpm_limit)
        );
        if (rateBlocked.length > 0 && rateBlocked.length === untried.length) {
          const onlyRpm = rateBlocked.every((p) => p.rpm_limit > 0 && TpmTracker.usedRequests(p.id) >= p.rpm_limit);
          throw Object.assign(
            new Error(
              onlyRpm
                ? 'All providers are at their requests-per-minute limit'
                : 'All providers are at their token-per-minute limit'
            ),
            { code: 'PROVIDER_TPM_EXHAUSTED', retryAfterMs: 60_000 }
          );
        }
        break;
      }
      tried.push(provider.id);

      // Count the attempt against the provider's RPM window before calling it.
      TpmTracker.recordRequest(provider.id);

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
          apiKey: ProviderRegistry.resolveApiKey(provider),
          kind: provider.kind
        });

        // ---------------------------------------------------------- success
        if (forwarded.statusCode >= 200 && forwarded.statusCode < 300) {
          ProviderSelector.recordSuccess(provider.id);
          return { forwarded, provider, attempts: attempt };
        }

        // ------------------------------------------------- non-2xx: classify
        // The body is needed to tell "model not found" (retry another provider)
        // from "context too long" (retry is pointless) — the status code alone is
        // not enough, because providers disagree on it.
        // Cap the error body: some providers return megabytes of HTML on 5xx.
        const errorText = await UpstreamClient.readAll(forwarded.body, 64 * 1024).catch(() => '');
        const headers = forwarded.headers;
        forwarded.cleanup();
        const info = classifyUpstream(forwarded.statusCode, errorText);

        const remaining = pinnedOrder
          ? this.available().filter((p) => pinnedOrder.includes(p.id) && !tried.includes(p.id))
          : ProviderSelector.candidates(tried);

        if (info.retryProvider && remaining.length > 0) {
          ProviderSelector.recordFailure(provider.id, info.kind, forwarded.statusCode);
          continue;
        }

        ProviderSelector.recordFailure(provider.id, info.kind, forwarded.statusCode);

        // Re-materialise the body so the caller can pass the provider's answer
        // through unchanged.
        return {
          forwarded: {
            statusCode: forwarded.statusCode,
            headers,
            body: Readable.from([Buffer.from(errorText, 'utf8')]),
            cleanup: () => undefined
          },
          provider,
          attempts: attempt,
          error: info
        };
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
