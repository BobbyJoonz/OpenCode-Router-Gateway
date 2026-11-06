import { ProxyAgent, request } from 'undici';
import { ArmDefinition, ArmResult, ExperimentConfig, RequestOutcome } from './types';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Executes one arm: N identical chat-completion requests, sequentially, rotating
 * through the arm's proxies. Sequential on purpose — concurrency would confound
 * the rate-limit signal we are trying to measure.
 */
export async function runArm(arm: ArmDefinition, config: ExperimentConfig): Promise<ArmResult> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  const agents = new Map<string, ProxyAgent>();
  const agentFor = (proxyUrl: string): ProxyAgent => {
    let agent = agents.get(proxyUrl);
    if (!agent) {
      agent = new ProxyAgent({ uri: proxyUrl, connections: 1, pipelining: 1 });
      agents.set(proxyUrl, agent);
    }
    return agent;
  };

  const outcomes: RequestOutcome[] = [];
  const latencies: number[] = [];
  let successes = 0;
  let rateLimited = 0;
  let authErrors = 0;
  let serverErrors = 0;
  let networkErrors = 0;
  let requestsBeforeFirst429: number | null = null;

  for (let i = 0; i < config.requestsPerArm; i++) {
    const proxyIndex = arm.proxies.length > 0 ? i % arm.proxies.length : -1;
    const proxyUrl = proxyIndex >= 0 ? arm.proxies[proxyIndex] : null;

    const startedRequest = Date.now();
    let status = 0;
    let error: string | undefined;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      try {
        const response = await request(`${config.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${config.apiKey}`
          },
          body: JSON.stringify({
            model: config.model,
            messages: [{ role: 'user', content: 'rotation-experiment probe' }]
          }),
          dispatcher: proxyUrl ? agentFor(proxyUrl) : undefined,
          signal: controller.signal,
          headersTimeout: config.timeoutMs,
          bodyTimeout: config.timeoutMs
        });
        status = response.statusCode;
        // Drain the body so the connection can be reused / released.
        await response.body.text();
      } finally {
        clearTimeout(timer);
      }
    } catch (err: any) {
      error = err?.code || err?.name || 'NETWORK_ERROR';
    }

    const latencyMs = Date.now() - startedRequest;

    if (status >= 200 && status < 300) {
      successes++;
      latencies.push(latencyMs);
      if (requestsBeforeFirst429 !== null) {
        // already hit the limit once; keep counting successes but do not reset
      }
    } else if (status === 429) {
      rateLimited++;
      if (requestsBeforeFirst429 === null) {
        requestsBeforeFirst429 = successes;
      }
    } else if (status === 401 || status === 403) {
      authErrors++;
    } else if (status >= 500) {
      serverErrors++;
    } else if (status === 0) {
      networkErrors++;
    }

    outcomes.push({ ok: status >= 200 && status < 300, status, latencyMs, error, proxyIndex });

    if (config.delayMs > 0) await sleep(config.delayMs);
  }

  for (const agent of agents.values()) {
    try {
      await agent.close();
    } catch {
      /* ignore */
    }
  }

  return {
    arm: arm.id,
    label: arm.label,
    startedAt,
    durationMs: Date.now() - t0,
    requests: config.requestsPerArm,
    successes,
    rateLimited,
    authErrors,
    serverErrors,
    networkErrors,
    requestsBeforeFirst429,
    latencies,
    observedSourceIps: [],
    outcomes
  };
}

/** Fetch the mock provider's per-IP observation counts (direct, not via proxy). */
export async function fetchObservedIps(statsUrl: string): Promise<string[]> {
  try {
    const res = await fetch(statsUrl);
    if (!res.ok) return [];
    const json = (await res.json()) as { byIp?: Record<string, number> };
    return Object.keys(json.byIp || {});
  } catch {
    return [];
  }
}
