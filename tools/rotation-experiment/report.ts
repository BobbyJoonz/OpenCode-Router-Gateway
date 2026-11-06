import { ArmResult, ArmSummary, Comparison, ExperimentConfig, ExperimentReport } from './types';
import { decide, median, percentile } from './stats';

export const GO_THRESHOLD = 3;
export const KILL_THRESHOLD = 1.5;

export function summarize(arm: ArmResult, observedIps: string[]): ArmSummary {
  const successRate = arm.requests > 0 ? arm.successes / arm.requests : 0;
  const rateLimitRate = arm.requests > 0 ? arm.rateLimited / arm.requests : 0;
  return {
    arm: arm.arm,
    label: arm.label,
    requests: arm.requests,
    successes: arm.successes,
    successRate,
    rateLimited: arm.rateLimited,
    rateLimitRate,
    p50LatencyMs: Math.round(median(arm.latencies)),
    p95LatencyMs: Math.round(percentile(arm.latencies, 95)),
    requestsBeforeFirst429: arm.requestsBeforeFirst429,
    observedSourceIps: observedIps.length
  };
}

export function compare(baseline: ArmSummary, candidate: ArmSummary): Comparison {
  const verdict = decide({
    baseline: { successes: baseline.successes, total: baseline.requests },
    candidate: { successes: candidate.successes, total: candidate.requests },
    goThreshold: GO_THRESHOLD,
    killThreshold: KILL_THRESHOLD
  });
  return {
    baseline: baseline.arm,
    candidate: candidate.arm,
    ratio: verdict.ratio,
    ciLow: verdict.ciLow,
    ciHigh: verdict.ciHigh,
    verdict: verdict.verdict,
    reason: verdict.reason
  };
}

export function buildReport(params: {
  mode: 'mock' | 'real';
  config: ExperimentConfig;
  windowSummaries: ArmSummary[][];
  notes?: string[];
}): ExperimentReport {
  const { mode, config, windowSummaries } = params;

  // Combine windows: weighted by request count.
  const combined = new Map<string, ArmSummary>();
  for (const windowSummariesForWindow of windowSummaries) {
    for (const summary of windowSummariesForWindow) {
      const existing = combined.get(summary.arm);
      if (!existing) {
        combined.set(summary.arm, { ...summary });
        continue;
      }
      const requests = existing.requests + summary.requests;
      const successes = existing.successes + summary.successes;
      const rateLimited = existing.rateLimited + summary.rateLimited;
      combined.set(summary.arm, {
        ...existing,
        requests,
        successes,
        successRate: requests > 0 ? successes / requests : 0,
        rateLimited,
        rateLimitRate: requests > 0 ? rateLimited / requests : 0,
        p50LatencyMs: Math.round((existing.p50LatencyMs + summary.p50LatencyMs) / 2),
        p95LatencyMs: Math.max(existing.p95LatencyMs, summary.p95LatencyMs),
        requestsBeforeFirst429: existing.requestsBeforeFirst429 ?? summary.requestsBeforeFirst429,
        observedSourceIps: Math.max(existing.observedSourceIps, summary.observedSourceIps)
      });
    }
  }

  const combinedList = ['A', 'B', 'C']
    .map((id) => combined.get(id))
    .filter((x): x is ArmSummary => !!x);

  const byId = new Map(combinedList.map((s) => [s.arm, s]));
  const comparisons: Comparison[] = [];

  const a = byId.get('A');
  const b = byId.get('B');
  const c = byId.get('C');

  // Primary: does rotating over *distinct clean* IPs beat a pinned IP?
  if (a && b) comparisons.push(compare(a, b));
  // Secondary: do public/shared-exit configs help at all?
  if (a && c) comparisons.push(compare(a, c));

  const primary = comparisons.find((x) => x.candidate === 'B');
  const overallVerdict = primary ? primary.verdict : 'INCONCLUSIVE';

  const { apiKey: _omitSecret, ...safeConfig } = config;

  return {
    generatedAt: new Date().toISOString(),
    mode,
    config: safeConfig,
    windows: windowSummaries,
    combined: combinedList,
    comparisons,
    overallVerdict,
    notes: params.notes || []
  };
}

export function renderMarkdown(report: ExperimentReport): string {
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const lines: string[] = [];

  lines.push('# Rotation experiment — report');
  lines.push('');
  lines.push(`- Generated: **${report.generatedAt}**`);
  lines.push(`- Mode: **${report.mode}**`);
  lines.push(`- Requests per arm per window: **${report.config.requestsPerArm}**`);
  lines.push(`- Windows: **${report.config.windows}**`);
  lines.push(`- Model: \`${report.config.model}\``);
  lines.push('');
  lines.push('## Decision');
  lines.push('');
  lines.push(`**Overall verdict: ${report.overallVerdict}**`);
  lines.push('');
  lines.push(`Pre-registered rule: GO if the clean-rotation arm beats the pinned arm by ≥ ${GO_THRESHOLD}x`);
  lines.push(`with a 95% CI lower bound above ${KILL_THRESHOLD}x; NO-GO if the point estimate or CI upper bound`);
  lines.push(`falls below ${KILL_THRESHOLD}x.`);
  lines.push('');

  lines.push('## Arms');
  lines.push('');
  lines.push('| Arm | Description | Requests | Success | 429 | p50 | p95 | Successes before first 429 | Observed IPs |');
  lines.push('|---|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const arm of report.combined) {
    lines.push(
      `| ${arm.arm} | ${arm.label} | ${arm.requests} | ${pct(arm.successRate)} | ${pct(arm.rateLimitRate)} | ${arm.p50LatencyMs} ms | ${arm.p95LatencyMs} ms | ${arm.requestsBeforeFirst429 ?? '—'} | ${arm.observedSourceIps} |`
    );
  }
  lines.push('');

  lines.push('## Comparisons');
  lines.push('');
  lines.push('| Baseline | Candidate | Success ratio | 95% CI | Verdict | Why |');
  lines.push('|---|---|---:|---|---|---|');
  for (const comparison of report.comparisons) {
    lines.push(
      `| ${comparison.baseline} | ${comparison.candidate} | ${comparison.ratio.toFixed(2)}x | ${comparison.ciLow.toFixed(2)}–${comparison.ciHigh.toFixed(2)}x | **${comparison.verdict}** | ${comparison.reason} |`
    );
  }
  lines.push('');

  if (report.windows.length > 1) {
    lines.push('## Per-window stability');
    lines.push('');
    lines.push('| Window | Arm | Success | 429 |');
    lines.push('|---:|---|---:|---:|');
    report.windows.forEach((window, index) => {
      for (const arm of window) {
        lines.push(`| ${index + 1} | ${arm.arm} | ${pct(arm.successRate)} | ${pct(arm.rateLimitRate)} |`);
      }
    });
    lines.push('');
  }

  if (report.notes.length > 0) {
    lines.push('## Notes');
    lines.push('');
    for (const note of report.notes) lines.push(`- ${note}`);
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('_Generated by `tools/rotation-experiment`._');
  return lines.join('\n');
}
