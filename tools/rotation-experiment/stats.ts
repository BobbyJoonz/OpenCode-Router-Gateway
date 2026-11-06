/**
 * Statistics for the rotation experiment.
 *
 * All intervals are 95 % unless stated otherwise. We use a Beta posterior
 * (Jeffreys prior) to model each arm's success probability and sample the ratio,
 * which is far more robust than a normal approximation when rates are near 0 or 1
 * — exactly the regime a rate-limit experiment lives in.
 */

export interface Proportion {
  successes: number;
  total: number;
}

export interface Interval {
  estimate: number;
  low: number;
  high: number;
}

export function wilson(successes: number, total: number, z = 1.959963984540054): Interval {
  if (total <= 0) return { estimate: 0, low: 0, high: 0 };
  const p = successes / total;
  const denom = 1 + (z * z) / total;
  const centre = p + (z * z) / (2 * total);
  const spread = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return {
    estimate: p,
    low: Math.max(0, (centre - spread) / denom),
    high: Math.min(1, (centre + spread) / denom)
  };
}

/** Marsaglia–Tsang gamma sampler (shape >= 1). */
function sampleGamma(shape: number, rng: () => number): number {
  if (shape < 1) {
    // Boost: Gamma(a) = Gamma(a+1) * U^(1/a)
    return sampleGamma(shape + 1, rng) * Math.pow(rng(), 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x: number;
    let v: number;
    do {
      x = gaussian(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function gaussian(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Beta(a, b) sampler built on two gamma draws. */
export function sampleBeta(a: number, b: number, rng: () => number): number {
  const x = sampleGamma(a, rng);
  const y = sampleGamma(b, rng);
  return x / (x + y);
}

/** Deterministic PRNG so reports are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Ratio of two success probabilities with a 95 % credible interval, using a
 * Beta(0.5,0.5) Jeffreys posterior per arm.
 */
export function ratioInterval(candidate: Proportion, baseline: Proportion, iterations = 20000, seed = 12345): Interval {
  const rng = mulberry32(seed);
  const aCand = candidate.successes + 0.5;
  const bCand = candidate.total - candidate.successes + 0.5;
  const aBase = baseline.successes + 0.5;
  const bBase = baseline.total - baseline.successes + 0.5;

  const ratios: number[] = [];
  let pointSum = 0;
  for (let i = 0; i < iterations; i++) {
    const pCand = sampleBeta(aCand, bCand, rng);
    const pBase = sampleBeta(aBase, bBase, rng);
    // Guard against a zero baseline rate: treat the ratio as "large but finite".
    const ratio = pBase <= 0 ? 1e6 : pCand / pBase;
    ratios.push(ratio);
    pointSum += ratio;
  }
  ratios.sort((x, y) => x - y);
  const low = ratios[Math.floor(0.025 * ratios.length)];
  const high = ratios[Math.floor(0.975 * ratios.length)];

  const pointCand = candidate.successes / Math.max(1, candidate.total);
  const pointBase = baseline.successes / Math.max(1, baseline.total);
  const estimate = pointBase <= 0 ? 1e6 : pointCand / pointBase;

  return { estimate, low, high };
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * (sorted.length - 1))));
  return sorted[index];
}

export function median(values: number[]): number {
  return percentile(values, 50);
}

export interface VerdictInput {
  baseline: Proportion;
  candidate: Proportion;
  goThreshold: number;
  killThreshold: number;
}

export interface Verdict {
  ratio: number;
  ciLow: number;
  ciHigh: number;
  verdict: 'GO' | 'NO-GO' | 'INCONCLUSIVE';
  reason: string;
}

/**
 * Apply the pre-registered decision rule.
 *
 *   GO          : point ratio >= goThreshold AND CI low > killThreshold
 *   NO-GO       : point ratio <  killThreshold OR CI high < killThreshold
 *   INCONCLUSIVE: anything else (needs more samples / another window)
 */
export function decide(input: VerdictInput): Verdict {
  const interval = ratioInterval(input.candidate, input.baseline);
  const { estimate, low, high } = interval;

  if (estimate >= input.goThreshold && low > input.killThreshold) {
    return {
      ratio: estimate,
      ciLow: low,
      ciHigh: high,
      verdict: 'GO',
      reason: `success ratio ${estimate.toFixed(2)}x (95% CI ${low.toFixed(2)}-${high.toFixed(2)}) >= ${input.goThreshold}x with lower bound > ${input.killThreshold}x`
    };
  }
  if (estimate < input.killThreshold || high < input.killThreshold) {
    return {
      ratio: estimate,
      ciLow: low,
      ciHigh: high,
      verdict: 'NO-GO',
      reason: `success ratio ${estimate.toFixed(2)}x (95% CI ${low.toFixed(2)}-${high.toFixed(2)}) is below the ${input.killThreshold}x kill threshold`
    };
  }
  return {
    ratio: estimate,
    ciLow: low,
    ciHigh: high,
    verdict: 'INCONCLUSIVE',
    reason: `success ratio ${estimate.toFixed(2)}x (95% CI ${low.toFixed(2)}-${high.toFixed(2)}) does not clear the ${input.goThreshold}x bar or trip the ${input.killThreshold}x kill switch`
  };
}
