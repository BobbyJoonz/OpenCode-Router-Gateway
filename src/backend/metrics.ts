/**
 * Dependency-free Prometheus exporter.
 *
 * Everything is rendered in the Prometheus text exposition format, so a scraper
 * needs no sidecar and the gateway needs no extra package. Counters live in
 * memory (reset on restart, which is what `_total` means in Prometheus) and
 * gauges are read from the live components at scrape time.
 */
export class Metrics {
  private static startedAt = Date.now();

  private static requestCounts = new Map<string, number>();
  private static latencyBuckets = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000];
  private static latencyCounts = new Array(Metrics.latencyBuckets.length + 1).fill(0);
  private static latencySum = 0;
  private static latencyCount = 0;
  private static promptTokens = 0;
  private static completionTokens = 0;
  private static costUsd = 0;


  public static recordRequest(statusCode: number, latencyMs: number): void {
    const key = String(statusCode);
    this.requestCounts.set(key, (this.requestCounts.get(key) || 0) + 1);

    this.latencySum += latencyMs;
    this.latencyCount++;
    let placed = false;
    for (let i = 0; i < this.latencyBuckets.length; i++) {
      if (latencyMs <= this.latencyBuckets[i]) {
        this.latencyCounts[i]++;
        placed = true;
        break;
      }
    }
    if (!placed) this.latencyCounts[this.latencyBuckets.length]++;
  }

  public static recordUsage(promptTokens: number, completionTokens: number, costUsd: number): void {
    if (Number.isFinite(promptTokens) && promptTokens > 0) this.promptTokens += promptTokens;
    if (Number.isFinite(completionTokens) && completionTokens > 0) this.completionTokens += completionTokens;
    if (Number.isFinite(costUsd) && costUsd > 0) this.costUsd += costUsd;
  }


  private static esc(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  }

  /**
   * @param gauges values read at scrape time by the caller
   */
  public static render(gauges: {
    poolSize: number;
    poolReady: number;
    poolInFlight: number;
    poolCapacity: string;
    dbBytes: number;
    walBytes: number;
    usageRows: number;
    retentionDeletedTotal: number;
    rotations: number;
    failovers: number;
    providers: Array<{ name: string; used: number; limit: number; total: number; rpmUsed: number; rpmLimit: number }>;
  }): string {
    const lines: string[] = [];
    const help = (name: string, type: string, text: string) => {
      lines.push(`# HELP ${name} ${text}`);
      lines.push(`# TYPE ${name} ${type}`);
    };

    help('opencode_router_uptime_seconds', 'gauge', 'Seconds since the process started.');
    lines.push(`opencode_router_uptime_seconds ${Math.round((Date.now() - this.startedAt) / 1000)}`);

    const mem = process.memoryUsage();
    help('opencode_router_process_resident_memory_bytes', 'gauge', 'Resident set size.');
    lines.push(`opencode_router_process_resident_memory_bytes ${mem.rss}`);
    help('opencode_router_process_heap_used_bytes', 'gauge', 'V8 heap used.');
    lines.push(`opencode_router_process_heap_used_bytes ${mem.heapUsed}`);

    help('opencode_router_pool_slots', 'gauge', 'Egress slots by state.');
    lines.push(`opencode_router_pool_slots{state="ready"} ${gauges.poolReady}`);
    lines.push(`opencode_router_pool_slots{state="total"} ${gauges.poolSize}`);

    help('opencode_router_pool_capacity', 'gauge', 'Pool capacity: 2=full, 1=reduced, 0=none.');
    const capacityValue = gauges.poolCapacity === 'full' ? 2 : gauges.poolCapacity === 'reduced' ? 1 : 0;
    lines.push(`opencode_router_pool_capacity ${capacityValue}`);

    help('opencode_router_pool_in_flight', 'gauge', 'Requests currently in flight across all slots.');
    lines.push(`opencode_router_pool_in_flight ${gauges.poolInFlight}`);

    help('opencode_router_pool_rotations_total', 'counter', 'Planned egress rotations.');
    lines.push(`opencode_router_pool_rotations_total ${gauges.rotations}`);
    help('opencode_router_pool_failovers_total', 'counter', 'Failovers after a slot died.');
    lines.push(`opencode_router_pool_failovers_total ${gauges.failovers}`);

    help('opencode_router_gateway_requests_total', 'counter', 'Gateway requests by HTTP status.');
    for (const [status, count] of this.requestCounts) {
      lines.push(`opencode_router_gateway_requests_total{status="${this.esc(status)}"} ${count}`);
    }

    help('opencode_router_gateway_request_duration_seconds', 'histogram', 'Gateway request latency.');
    for (let i = 0; i < this.latencyBuckets.length; i++) {
      lines.push(`opencode_router_gateway_request_duration_seconds_bucket{le="${this.latencyBuckets[i] / 1000}"} ${this.latencyCounts[i]}`);
    }
    lines.push(`opencode_router_gateway_request_duration_seconds_bucket{le="+Inf"} ${this.latencyCounts[this.latencyBuckets.length]}`);
    lines.push(`opencode_router_gateway_request_duration_seconds_sum ${(this.latencySum / 1000).toFixed(3)}`);
    lines.push(`opencode_router_gateway_request_duration_seconds_count ${this.latencyCount}`);

    help('opencode_router_tokens_total', 'counter', 'Tokens forwarded upstream.');
    lines.push(`opencode_router_tokens_total{type="prompt"} ${this.promptTokens}`);
    lines.push(`opencode_router_tokens_total{type="completion"} ${this.completionTokens}`);

    help('opencode_router_cost_usd_total', 'counter', 'Estimated upstream cost in USD.');
    lines.push(`opencode_router_cost_usd_total ${this.costUsd.toFixed(6)}`);

    help('opencode_router_db_bytes', 'gauge', 'Database size by file kind.');
    lines.push(`opencode_router_db_bytes{kind="db"} ${gauges.dbBytes}`);
    lines.push(`opencode_router_db_bytes{kind="wal"} ${gauges.walBytes}`);

    help('opencode_router_usage_rows', 'gauge', 'Rows currently stored in usage_log.');
    lines.push(`opencode_router_usage_rows ${gauges.usageRows}`);

    help('opencode_router_retention_deleted_total', 'counter', 'Rows removed by the retention service.');
    lines.push(`opencode_router_retention_deleted_total ${gauges.retentionDeletedTotal}`);

    help('opencode_router_provider_tpm_used', 'gauge', 'Tokens sent to a provider in the current minute.');
    help('opencode_router_provider_tpm_limit', 'gauge', 'Configured TPM ceiling for a provider (0 = unlimited).');
    help('opencode_router_provider_tokens_total', 'counter', 'Tokens sent to a provider since start.');
    help('opencode_router_provider_rpm_used', 'gauge', 'Requests sent to a provider in the current minute.');
    help('opencode_router_provider_rpm_limit', 'gauge', 'Configured RPM ceiling for a provider (0 = unlimited).');
    for (const provider of gauges.providers) {
      const name = this.esc(provider.name);
      lines.push(`opencode_router_provider_tpm_used{provider="${name}"} ${provider.used}`);
      lines.push(`opencode_router_provider_tpm_limit{provider="${name}"} ${provider.limit}`);
      lines.push(`opencode_router_provider_tokens_total{provider="${name}"} ${provider.total}`);
      lines.push(`opencode_router_provider_rpm_used{provider="${name}"} ${provider.rpmUsed}`);
      lines.push(`opencode_router_provider_rpm_limit{provider="${name}"} ${provider.rpmLimit}`);
    }

    return lines.join('\n') + '\n';
  }
}
