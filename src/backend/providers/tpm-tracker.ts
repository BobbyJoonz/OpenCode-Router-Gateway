/**
 * Per-provider token-per-minute accounting.
 *
 * A single provider account has a TPM ceiling. To reach an aggregate TPM larger
 * than any one account, the router must know how much each provider has consumed
 * in the current minute and only send a request where it still fits.
 *
 * The window is in-process (a few hundred entries at most) and is rebuilt from
 * live traffic; `usage_log` remains the durable record.
 */
export interface TpmSnapshot {
  providerId: number;
  used: number;
  limit: number;
  /** Requests sent in the current minute. */
  requests: number;
  /** Configured requests-per-minute ceiling (0 = unlimited). */
  rpmLimit: number;
}

const WINDOW_MS = 60_000;

export class TpmTracker {
  /** provider id -> [timestamp, tokens] entries inside the current window */
  private static windows = new Map<number, Array<[number, number]>>();
  private static totals = new Map<number, number>();
  /** provider id -> request timestamps inside the current window */
  private static requestWindows = new Map<number, number[]>();
  private static requestTotals = new Map<number, number>();

  /**
   * Cheap pre-flight estimate: characters / 4 plus a fixed overhead. Good enough
   * to decide whether a provider has room; the exact count is recorded after the
   * response arrives.
   */
  public static estimateFromBody(body: any): number {
    try {
      const messages = Array.isArray(body?.messages) ? body.messages : [];
      let chars = 0;
      for (const message of messages) {
        const content = message?.content;
        if (typeof content === 'string') chars += content.length;
        else if (Array.isArray(content)) {
          for (const part of content) {
            if (typeof part?.text === 'string') chars += part.text.length;
          }
        }
        chars += 16; // role/formatting overhead
      }
      return Math.ceil(chars / 4) + 32;
    } catch {
      return 0;
    }
  }

  private static prune(providerId: number, now: number): Array<[number, number]> {
    const entries = (this.windows.get(providerId) || []).filter(([t]) => now - t < WINDOW_MS);
    this.windows.set(providerId, entries);
    return entries;
  }

  public static used(providerId: number): number {
    const now = Date.now();
    return this.prune(providerId, now).reduce((sum, [, tokens]) => sum + tokens, 0);
  }

  private static pruneRequests(providerId: number, now: number): number[] {
    const entries = (this.requestWindows.get(providerId) || []).filter((t) => now - t < WINDOW_MS);
    this.requestWindows.set(providerId, entries);
    return entries;
  }

  public static usedRequests(providerId: number): number {
    return this.pruneRequests(providerId, Date.now()).length;
  }

  public static recordRequest(providerId: number): void {
    const now = Date.now();
    const entries = this.pruneRequests(providerId, now);
    entries.push(now);
    this.requestWindows.set(providerId, entries);
    this.requestTotals.set(providerId, (this.requestTotals.get(providerId) || 0) + 1);
  }

  public static totalRequestsFor(providerId: number): number {
    return this.requestTotals.get(providerId) || 0;
  }

  /**
   * Admission check for one request.
   *
   * @param tpmLimit tokens/minute ceiling, 0 = unlimited
   * @param rpmLimit requests/minute ceiling, 0 = unlimited
   */
  public static canAccept(
    providerId: number,
    estimatedTokens: number,
    tpmLimit: number,
    rpmLimit: number = 0
  ): boolean {
    if (rpmLimit && rpmLimit > 0 && this.usedRequests(providerId) >= rpmLimit) return false;
    if (!tpmLimit || tpmLimit <= 0) return true;
    return this.used(providerId) + estimatedTokens <= tpmLimit;
  }

  public static record(providerId: number, tokens: number): void {
    if (!Number.isFinite(tokens) || tokens <= 0) return;
    const now = Date.now();
    const entries = this.prune(providerId, now);
    entries.push([now, tokens]);
    this.windows.set(providerId, entries);
    this.totals.set(providerId, (this.totals.get(providerId) || 0) + tokens);
  }

  public static snapshot(limits: Map<number, number>, rpmLimits: Map<number, number> = new Map()): TpmSnapshot[] {
    const out: TpmSnapshot[] = [];
    for (const providerId of this.windows.keys()) {
      out.push({
        providerId,
        used: this.used(providerId),
        limit: limits.get(providerId) || 0,
        requests: this.usedRequests(providerId),
        rpmLimit: rpmLimits.get(providerId) || 0
      });
    }
    return out;
  }

  /** Total tokens ever recorded per provider (process lifetime). */
  public static totalFor(providerId: number): number {
    return this.totals.get(providerId) || 0;
  }

  public static reset(): void {
    this.windows.clear();
    this.totals.clear();
    this.requestWindows.clear();
    this.requestTotals.clear();
  }
}
