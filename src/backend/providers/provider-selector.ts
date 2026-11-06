import { getSetting } from '../db/database';
import { ProviderRegistry, ProviderRow } from './provider-registry';
import { TpmTracker } from './tpm-tracker';

interface Cooldown {
  failures: number;
  until: number;
}

/**
 * D4 — provider selection with health-based failover.
 *
 * Policy comes from settings:
 *   priority     : lowest `priority` number wins (free/zen first, primary last)
 *   cost         : cheapest input price first, priority as tie-break
 *   round_robin  : rotate through the healthy set
 *
 * A provider that fails enters exponential cooldown (30 s, 1 m, 2 m, ... capped at
 * 10 m) so a broken upstream is skipped without being permanently banned.
 */
export class ProviderSelector {
  private static cooldowns = new Map<number, Cooldown>();
  private static rrIndex = 0;

  public static policy(): string {
    return getSetting('gateway_provider_policy', 'priority');
  }

  public static isCooling(providerId: number, now = Date.now()): boolean {
    const cooldown = this.cooldowns.get(providerId);
    return !!cooldown && cooldown.until > now;
  }

  /**
   * @param estimatedTokens pre-flight estimate for this request. Providers whose
   *   TPM budget cannot fit it are removed, which is what lets several accounts
   *   add up to an aggregate TPM larger than any single one.
   */
  public static candidates(excludeIds: number[] = [], estimatedTokens = 0): ProviderRow[] {
    const excluded = new Set(excludeIds);
    const all = ProviderRegistry.enabled().filter(
      (provider) => !excluded.has(provider.id) && ProviderRegistry.hasKey(provider)
    );

    const withCapacity = all.filter((provider) =>
      TpmTracker.canAccept(provider.id, estimatedTokens, provider.tpm_limit)
    );
    if (withCapacity.length === 0) return [];

    const now = Date.now();
    const healthy = withCapacity.filter((provider) => !this.isCooling(provider.id, now));
    // If everything is cooling down we still have to try something.
    const pool = healthy.length > 0 ? healthy : withCapacity;

    switch (this.policy()) {
      case 'cost':
        return [...pool].sort(
          (a, b) => a.cost_per_1m_in - b.cost_per_1m_in || a.priority - b.priority || a.id - b.id
        );
      case 'round_robin':
        return this.rotate(pool);
      case 'priority':
      default:
        return [...pool].sort((a, b) => a.priority - b.priority || a.id - b.id);
    }
  }

  public static select(excludeIds: number[] = []): ProviderRow | null {
    return this.candidates(excludeIds)[0] || null;
  }

  public static recordSuccess(providerId: number, latencyMs?: number): void {
    this.cooldowns.delete(providerId);
    ProviderRegistry.recordEvent(providerId, 'success', 200, latencyMs);
  }

  public static recordFailure(providerId: number, kind: string, statusCode?: number): void {
    const previous = this.cooldowns.get(providerId) || { failures: 0, until: 0 };
    const failures = previous.failures + 1;
    const backoffMs = Math.min(10 * 60 * 1000, 30_000 * Math.pow(2, failures - 1));
    this.cooldowns.set(providerId, { failures, until: Date.now() + backoffMs });
    ProviderRegistry.recordEvent(providerId, kind, statusCode);
  }

  public static snapshot(): Array<{ id: number; name: string; cooling: boolean; failures: number; untilInMs: number }> {
    const now = Date.now();
    return ProviderRegistry.list().map((provider) => {
      const cooldown = this.cooldowns.get(provider.id);
      return {
        id: provider.id,
        name: provider.name,
        cooling: !!cooldown && cooldown.until > now,
        failures: cooldown?.failures || 0,
        untilInMs: cooldown ? Math.max(0, cooldown.until - now) : 0
      };
    });
  }

  /** Test hook: forget all cooldowns. */
  public static reset(): void {
    this.cooldowns.clear();
    this.rrIndex = 0;
  }

  private static rotate(pool: ProviderRow[]): ProviderRow[] {
    if (pool.length === 0) return pool;
    const ordered = [...pool].sort((a, b) => a.id - b.id);
    const start = this.rrIndex % ordered.length;
    this.rrIndex = (this.rrIndex + 1) % ordered.length;
    return [...ordered.slice(start), ...ordered.slice(0, start)];
  }
}
