/** Shared types for the rotation experiment harness. */

export type ArmId = 'A' | 'B' | 'C';

export interface ArmDefinition {
  id: ArmId;
  label: string;
  /** Proxy URLs in rotation order. Empty means "go direct". */
  proxies: string[];
  /** Optional: the arm uses one shared exit IP on purpose (models public configs). */
  sharedExit?: boolean;
}

export interface RequestOutcome {
  ok: boolean;
  status: number;
  latencyMs: number;
  error?: string;
  /** Index of the proxy that served this request (for rotation tracing). */
  proxyIndex: number;
}

export interface ArmResult {
  arm: ArmId;
  label: string;
  startedAt: string;
  durationMs: number;
  requests: number;
  successes: number;
  rateLimited: number;
  authErrors: number;
  serverErrors: number;
  networkErrors: number;
  /** Successes observed before the first HTTP 429 in this arm's sequence. */
  requestsBeforeFirst429: number | null;
  latencies: number[];
  /** Distinct source IPs the provider actually observed, when reported. */
  observedSourceIps: string[];
  outcomes: RequestOutcome[];
}

export interface ExperimentConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  requestsPerArm: number;
  timeoutMs: number;
  delayMs: number;
  /** Repetitions (time windows). Each repetition re-runs all arms. */
  windows: number;
  arms: ArmDefinition[];
}

export interface ArmSummary {
  arm: ArmId;
  label: string;
  requests: number;
  successes: number;
  successRate: number;
  rateLimited: number;
  rateLimitRate: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  requestsBeforeFirst429: number | null;
  observedSourceIps: number;
}

export interface Comparison {
  baseline: ArmId;
  candidate: ArmId;
  ratio: number;
  ciLow: number;
  ciHigh: number;
  verdict: 'GO' | 'NO-GO' | 'INCONCLUSIVE';
  reason: string;
}

export interface ExperimentReport {
  generatedAt: string;
  mode: 'mock' | 'real';
  config: Omit<ExperimentConfig, 'apiKey'>;
  windows: ArmSummary[][];
  combined: ArmSummary[];
  comparisons: Comparison[];
  overallVerdict: 'GO' | 'NO-GO' | 'INCONCLUSIVE';
  notes: string[];
}
