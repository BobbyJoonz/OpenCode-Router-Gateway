import { randomUUID } from 'node:crypto';
import { Router, Request, Response, NextFunction } from 'express';
import { db, getSetting } from '../db/database';
import { KeyManager, ApiKeyRow } from './key-manager';
import { UpstreamClient } from './upstream-client';
import { classifyHttp, classifyNetwork, openAiError } from './error-mapper';
import { egressPool } from '../vpn/egress-pool';
import { XraySlot } from '../vpn/xray-slot';
import { ProviderRouter } from './provider-router';
import { ModelRouter } from './model-router';
import { runMapPhase, shouldMapReduce } from './map-reduce';
import { TpmTracker } from '../providers/tpm-tracker';
import { ProviderRegistry, ProviderRow } from '../providers/provider-registry';
import { FreshnessTracker } from '../tester/freshness';
import { costOf, spendToday, spendThisMonth } from './cost';

interface GatewayRequest extends Request {
  apiKey?: ApiKeyRow;
}

const MAX_ATTEMPTS = 2;
// Bounded per-stream scanner buffer. 256 KB is far more than any single SSE
// event needs; the old 2 MB multiplied by concurrency was a real memory risk.
const MAX_SSE_BUFFER = 256 * 1024;

// Global admission control: protects the single Node process from being handed
// more concurrent streams than it can relay.
let activeRequests = 0;

function maxConcurrentRequests(): number {
  return Math.max(1, parseInt(getSetting('gateway_max_concurrent', '200'), 10) || 200);
}

// Bytes currently buffered for in-flight requests. Bodies are parsed into memory,
// so N concurrent 1.2 MB bodies cost N x a few MB. This budget is what keeps a
// large-payload workload from OOMing the host.
let inFlightBytes = 0;

function maxInFlightBytes(): number {
  const configured = parseInt(getSetting('gateway_max_inflight_bytes', String(256 * 1024 * 1024)), 10);
  // Floor is 64 KB (not 1 MB) so operators can set a genuinely small budget for
  // memory-constrained hosts and test the guard.
  return Math.max(64 * 1024, Number.isFinite(configured) ? configured : 256 * 1024 * 1024);
}

function gatewayEnabled(): boolean {
  return getSetting('gateway_enabled', 'false') === 'true';
}

function authFailure(res: Response, reason: 'missing' | 'invalid' | 'disabled'): void {
  if (reason === 'missing') {
    res.status(401).json(openAiError('Missing bearer token. Send "Authorization: Bearer sk-or-...".', 'invalid_request_error', 'missing_api_key'));
    return;
  }
  // "unknown" and "disabled" deliberately return the same answer: any difference
  // would confirm to an attacker that a guessed key exists.
  res.status(401).json(openAiError('Incorrect API key provided.', 'invalid_request_error', 'invalid_api_key'));
}

function toNonNegativeInt(value: any): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

type ExplicitProvider =
  | { kind: 'none' }
  | { kind: 'invalid'; value: string }
  | { kind: 'ok'; provider: ProviderRow; model: string };

/**
 * Client-side provider pinning.
 *
 *   x-provider: 3            (id)
 *   x-provider: openrouter   (name, case-insensitive)
 *
 * Optionally also `provider/model` prefixes, when
 * `gateway_model_prefix_provider=true`.
 */
function resolveExplicitProvider(req: Request, model: string | undefined): ExplicitProvider {
  const rawHeader = String((req.headers['x-provider'] as string) || '').trim();

  if (rawHeader) {
    const providers = ProviderRegistry.list().filter((p) => p.enabled);
    const byId = providers.find((p) => String(p.id) === rawHeader);
    const byName = providers.find((p) => p.name.toLowerCase() === rawHeader.toLowerCase());
    const provider = byId || byName;
    if (!provider) return { kind: 'invalid', value: rawHeader };
    if (!ProviderRegistry.hasKey(provider)) return { kind: 'invalid', value: `${rawHeader} (no credential)` };
    return { kind: 'ok', provider, model: String(model || provider.model || '') };
  }

  if (getSetting('gateway_model_prefix_provider', 'false') === 'true' && model && model.includes('/')) {
    const [prefix, ...rest] = model.split('/');
    const provider = ProviderRegistry.list().find(
      (p) => p.enabled && p.name.toLowerCase() === prefix.toLowerCase()
    );
    if (provider && rest.length > 0) {
      if (!ProviderRegistry.hasKey(provider)) return { kind: 'invalid', value: `${prefix} (no credential)` };
      return { kind: 'ok', provider, model: rest.join('/') };
    }
  }

  return { kind: 'none' };
}

function makeUsageScanner() {
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let buffer = '';

  return {
    push(chunk: Buffer): void {
      buffer += chunk.toString('utf8');
      if (buffer.length > MAX_SSE_BUFFER) buffer = buffer.slice(-4096);

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        for (const line of event.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data);
            if (parsed && parsed.usage) {
              usage.prompt_tokens = parsed.usage.prompt_tokens ?? usage.prompt_tokens;
              usage.completion_tokens = parsed.usage.completion_tokens ?? usage.completion_tokens;
              usage.total_tokens = parsed.usage.total_tokens ?? usage.total_tokens;
            }
          } catch {
            /* partial JSON across chunk boundaries */
          }
        }
        boundary = buffer.indexOf('\n\n');
      }
    },
    get usage() {
      return usage;
    }
  };
}

export function createGatewayRouter(): Router {
  const router = Router();

  // ---------------------------------------------------------------- health
  router.get('/health', (_req: Request, res: Response) => {
    const pool = egressPool.status();
    // Unauthenticated endpoint: report liveness only, never the egress endpoint.
    res.json({
      status: 'ok',
      gateway_enabled: gatewayEnabled(),
      upstream_configured: UpstreamClient.isConfigured(),
      ready_slots: pool.ready,
      pool_size: pool.size
    });
  });

  // ---------------------------------------------------------------- auth
  const authMiddleware = (req: GatewayRequest, res: Response, next: NextFunction) => {
    if (!gatewayEnabled()) {
      res.status(503).json(openAiError('The gateway is disabled. Set gateway_enabled=true in settings.', 'server_error', 'gateway_disabled'));
      return;
    }

    const maxBody = parseInt(getSetting('gateway_max_body_bytes', '8388608'), 10);
    const declared = parseInt(String(req.headers['content-length'] || '0'), 10);
    if (Number.isFinite(declared) && declared > maxBody) {
      res.status(413).json(openAiError(`Request body exceeds ${maxBody} bytes.`, 'invalid_request_error', 'request_too_large'));
      return;
    }

    const verified = KeyManager.verify(req.headers.authorization as string | undefined);
    if (!verified.ok) {
      authFailure(res, verified.reason);
      return;
    }

    const limit = KeyManager.checkRateLimit(verified.key.id, verified.key.rpm_limit);
    if (!limit.ok) {
      res.setHeader('Retry-After', String(Math.ceil(limit.retryAfterMs / 1000)));
      res.status(429).json(openAiError('Rate limit exceeded for this API key.', 'rate_limit_error', 'rate_limit_exceeded'));
      return;
    }

    if (verified.key.daily_token_limit > 0) {
      const configured = Math.max(0, parseInt(getSetting('gateway_quota_reserve_tokens', '2000'), 10));
      const reserve = configured > 0 ? Math.min(configured, Math.max(1, Math.floor(verified.key.daily_token_limit / 2))) : 0;
      const used = KeyManager.tokensUsedToday(verified.key.id) + KeyManager.pendingFor(verified.key.id);
      if (used + reserve > verified.key.daily_token_limit) {
        res.status(429).json(openAiError('Daily token quota exhausted for this API key.', 'rate_limit_error', 'daily_quota_exceeded'));
        return;
      }
      if (reserve > 0) {
        KeyManager.reserveTokens(verified.key.id, reserve);
        res.on('close', () => KeyManager.releaseTokens(verified.key.id, reserve));
      }
    }

    // D5: dollar caps are the only limit that actually protects the operator.
    const dailySpendCap = Number(verified.key.spend_cap_usd_daily) || 0;
    const monthlySpendCap = Number(verified.key.spend_cap_usd_monthly) || 0;
    if (dailySpendCap > 0 && spendToday(verified.key.id) >= dailySpendCap) {
      res.status(429).json(openAiError('Daily spend cap exhausted for this API key.', 'rate_limit_error', 'daily_spend_cap_exceeded'));
      return;
    }
    if (monthlySpendCap > 0 && spendThisMonth(verified.key.id) >= monthlySpendCap) {
      res.status(429).json(openAiError('Monthly spend cap exhausted for this API key.', 'rate_limit_error', 'monthly_spend_cap_exceeded'));
      return;
    }

    req.apiKey = verified.key;
    next();
  };

  // ---------------------------------------------------------------- models
  router.get('/models', authMiddleware, async (req: GatewayRequest, res: Response) => {
    const config = UpstreamClient.resolveConfig();

    // Upstream models are merged with the aliases, never substituted for them.
    const upstreamIds: string[] = [];

    if (ProviderRouter.hasProviders()) {
      const slot = await egressPool.acquire(null, req.apiKey?.egress_policy || undefined);
      if (slot) {
        egressPool.track(slot);
        try {
          const routed = await ProviderRouter.forward({
            method: 'GET',
            path: '/models',
            httpProxyPort: slot.httpPort,
            timeoutMs: 15000
          });
          const forwarded = routed.forwarded;
          if (forwarded.statusCode >= 200 && forwarded.statusCode < 300) {
            const text = await UpstreamClient.readAll(forwarded.body);
            forwarded.cleanup();
            try {
              const parsed = JSON.parse(text);
              for (const item of parsed?.data || []) {
                if (item?.id && !upstreamIds.includes(item.id)) upstreamIds.push(item.id);
              }
            } catch {
              /* not JSON */
            }
          } else {
            try {
              await UpstreamClient.readAll(forwarded.body);
            } catch {
              /* ignore */
            }
            forwarded.cleanup();
          }
        } catch {
          /* upstream unreachable — answer with a synthetic list */
        } finally {
          egressPool.release(slot);
        }
      }
    }

    // A settings/env upstream without provider rows (a local 9Router, say) still
    // has a model list. Fetch it directly so clients can discover what is available.
    if (upstreamIds.length === 0 && config.baseUrl) {
      try {
        const direct = await UpstreamClient.forward({ method: 'GET', path: '/models', timeoutMs: 15000 });
        if (direct.statusCode >= 200 && direct.statusCode < 300) {
          const text = await UpstreamClient.readAll(direct.body);
          direct.cleanup();
          try {
            const parsed = JSON.parse(text);
            for (const item of parsed?.data || []) {
              if (item?.id && !upstreamIds.includes(item.id)) upstreamIds.push(item.id);
            }
          } catch {
            /* not JSON */
          }
        } else {
          try {
            await UpstreamClient.readAll(direct.body);
          } catch {
            /* ignore */
          }
          direct.cleanup();
        }
      } catch {
        /* upstream unreachable â€” keep the alias list */
      }
    }

    const aliases = ModelRouter.aliases();
    const fallback = config.model || 'gpt-4o-mini';

    const data: Array<{ id: string; object: string; created: number; owned_by: string }> = [
      ...aliases.map((id) => ({
        id,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'opencode-router:route'
      })),
      ...upstreamIds
        .filter((id) => !aliases.includes(id))
        .map((id) => ({
          id,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: 'upstream'
        }))
    ];

    if (data.length === 0) {
      data.push({
        id: fallback,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'opencode-router'
      });
    }

    res.json({ object: 'list', data });
  });

  // ---------------------------------------------------------------- usage
  router.get('/usage', authMiddleware, (req: GatewayRequest, res: Response) => {
    const key = req.apiKey!;
    res.json({
      key: { id: key.id, name: key.name, prefix: key.key_prefix },
      total: KeyManager.usageSummary(key.id),
      today_tokens: KeyManager.tokensUsedToday(key.id),
      daily_token_limit: key.daily_token_limit,
      rpm_limit: key.rpm_limit,
      sticky_slots: egressPool.status().slots.map((s) => ({ slot: s.index, nodeId: s.node?.id ?? null }))
    });
  });

  // ------------------------------------------------- chat/completions
  router.post('/chat/completions', authMiddleware, async (req: GatewayRequest, res: Response) => {
    const key = req.apiKey!;
    const body = req.body;

    // Every request carries a trace id so a client report can be matched to the
    // exact usage row, provider, egress slot and attempt count.
    const requestId = randomUUID();
    res.setHeader('x-request-id', requestId);

    // Admission control: refuse fast with Retry-After instead of accepting work
    // the process cannot relay (which shows up as timeouts and runaway memory).
    if (activeRequests >= maxConcurrentRequests()) {
      res.setHeader('Retry-After', '1');
      res.status(503).json(
        openAiError('The gateway is at its concurrency limit. Retry shortly.', 'server_error', 'too_many_concurrent_requests')
      );
      return;
    }

    const declaredBytes =
      Number((req as any).rawBodyBytes) ||
      parseInt(String(req.headers['content-length'] || '0'), 10) ||
      0;
    if (inFlightBytes + declaredBytes > maxInFlightBytes()) {
      res.setHeader('Retry-After', '1');
      res.status(503).json(
        openAiError('The gateway is buffering too much request data right now. Retry shortly.', 'server_error', 'inflight_bytes_exceeded')
      );
      return;
    }

    activeRequests++;
    inFlightBytes += declaredBytes;
    res.once('close', () => {
      activeRequests = Math.max(0, activeRequests - 1);
      inFlightBytes = Math.max(0, inFlightBytes - declaredBytes);
    });

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      res.status(400).json(openAiError('Request body must be a JSON object.', 'invalid_request_error', 'invalid_body'));
      return;
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      res.status(400).json(openAiError('"messages" must be a non-empty array.', 'invalid_request_error', 'invalid_messages'));
      return;
    }
    if (body.model !== undefined && typeof body.model !== 'string') {
      res.status(400).json(openAiError('"model" must be a string.', 'invalid_request_error', 'invalid_model'));
      return;
    }

    const wantsStream = body.stream === true;
    const startedAt = Date.now();

    let forwardBody = body;
    if (wantsStream && getSetting('gateway_stream_include_usage', 'true') === 'true') {
      const existing = body.stream_options && typeof body.stream_options === 'object' ? body.stream_options : {};
      forwardBody = { ...body, stream_options: { include_usage: true, ...existing } };
    }

    // Resolve the client's model name into (provider, upstream model) pairs.
    // With routes configured this is what makes model selection deterministic.
    // A client may pin a provider explicitly (x-provider header, or the
    // provider/model prefix when enabled). That wins over alias routing.
    const explicit = resolveExplicitProvider(req, body.model);
    if (explicit.kind === 'invalid') {
      res.status(400).json(
        openAiError(
          `Unknown or unusable provider '${explicit.value}'. See GET /api/providers.`,
          'invalid_request_error',
          'invalid_provider'
        )
      );
      return;
    }

    let selection: { providerIds: number[]; modelByProvider: Record<number, string> } | undefined;

    if (explicit.kind === 'ok') {
      selection = { providerIds: [explicit.provider.id], modelByProvider: { [explicit.provider.id]: explicit.model } };
    } else {
      const plan = ModelRouter.plan(body.model);
      if (!plan) {
        if (ModelRouter.requireRoute()) {
          res.status(404).json(
            openAiError(
              `The model '${body.model ?? ''}' is not routed. Configure a route (POST /api/models) or set gateway_require_model_route=false.`,
              'invalid_request_error',
              'model_not_found'
            )
          );
          return;
        }
        if (!body.model) {
          res.status(400).json(openAiError('"model" is required.', 'invalid_request_error', 'missing_model'));
          return;
        }
      } else if (plan.providerIds.length === 0) {
        // The route exists but none of its providers can serve it. This must be a
        // loud, actionable error — never a silent passthrough to another provider.
        const detail = plan.unavailable.map((u) => `${u.providerName}: ${u.reason}`).join('; ');
        res.status(503).json(
          openAiError(
            `Model '${plan.alias}' is routed but no target provider is usable (${detail}).`,
            'server_error',
            'model_route_unavailable'
          )
        );
        return;
      }
      selection = plan ? { providerIds: plan.providerIds, modelByProvider: plan.modelByProvider } : undefined;
    }

    // Map-reduce: opt-in handling for prompts larger than the model window.
    // The map phase runs here (non-streaming), then the reduce body is forwarded
    // through the normal path — so a streaming client still receives a live stream
    // instead of waiting for the whole answer.
    let extraUsage = { prompt: 0, completion: 0, total: 0 };
    const mapReduceEnabled = getSetting('gateway_mapreduce_enabled', 'false') === 'true';
    const contextLimit = parseInt(getSetting('gateway_mapreduce_context_limit', '0'), 10) || 0;
    if (mapReduceEnabled && shouldMapReduce(body, contextLimit, TpmTracker.estimateFromBody(body))) {
      const slot = await egressPool.acquire(key.id, key.egress_policy || undefined);
      if (!slot) {
        res.status(503).json(openAiError('No working egress slot is available.', 'server_error', 'no_egress_node'));
        return;
      }
      egressPool.track(slot);
      try {
        const phase = await runMapPhase({
          body: forwardBody,
          contextLimit,
          chunkTokens: Math.max(1000, parseInt(getSetting('gateway_mapreduce_chunk_tokens', '30000'), 10)),
          maxChunks: Math.max(1, Math.min(parseInt(getSetting('gateway_mapreduce_max_chunks', '16'), 10), 64)),
          mapInstruction: getSetting('gateway_mapreduce_instruction', ''),
          forwardJson: async (chunkBody: any) => {
            const routed = await ProviderRouter.forward(
              {
                method: 'POST',
                path: '/chat/completions',
                httpProxyPort: slot.httpPort,
                body: chunkBody,
                accept: 'application/json'
              },
              selection
            );
            const text = await UpstreamClient.readAll(routed.forwarded.body);
            routed.forwarded.cleanup();
            return JSON.parse(text);
          }
        });

        // Hand the reduce call to the normal path (streaming or not) and carry the
        // map-phase tokens into the usage record.
        forwardBody = phase.reduceBody;
        extraUsage = {
          prompt: phase.usage.prompt_tokens,
          completion: phase.usage.completion_tokens,
          total: phase.usage.total_tokens
        };
        res.setHeader('x-opencode-mapreduce', '1');
        res.setHeader('x-opencode-chunks', String(phase.chunks));
      } catch (err: any) {
        if (err?.code === 'MAPREDUCE_TOO_LARGE') {
          res.status(413).json(
            openAiError(
              `The input needs ${err?.chunks} chunks, above the configured limit. Split the request upstream.`,
              'invalid_request_error',
              'input_too_large_for_mapreduce'
            )
          );
          return;
        }
        if (err?.code !== 'MAPREDUCE_NOT_APPLICABLE') {
          res.status(502).json(openAiError(`Map-reduce failed: ${err?.message || 'upstream error'}`, 'server_error', 'mapreduce_failed'));
          return;
        }
        // Not applicable: fall through to the normal single-call path.
      } finally {
        egressPool.release(slot);
      }
    }

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const slot = await egressPool.acquire(key.id, key.egress_policy || undefined);
      if (!slot) {
        res.status(503).json(
          openAiError('No working egress slot is available. Run a workflow or a pre-screen first.', 'server_error', 'no_egress_node')
        );
        return;
      }

      egressPool.track(slot);
      let released = false;
      const releaseOnce = () => {
        if (released) return;
        released = true;
        egressPool.release(slot);
      };
      const nodeId = slot.node?.id ?? null;

      let forwarded;
      let provider: ProviderRow | null = null;
      let routedError: any = undefined;
      let providerAttempts = 1;
      try {
        const routed = await ProviderRouter.forward({
          method: 'POST',
          path: '/chat/completions',
          httpProxyPort: slot.httpPort,
          body: forwardBody,
          accept: wantsStream ? 'text/event-stream' : 'application/json'
        }, selection);
        forwarded = routed.forwarded;
        provider = routed.provider;
        routedError = routed.error;
        providerAttempts = (routed as any).attempts ?? 1;
      } catch (err: any) {
        releaseOnce();
        const classification = classifyNetwork(err?.code);
        if (classification.rotate && attempt < MAX_ATTEMPTS) {
          await egressPool.penalize(slot, `network error: ${err?.code || err?.message}`);
          continue;
        }
        KeyManager.recordUsage({
          keyId: key.id,
          model: body.model || null,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          statusCode: 502,
          latencyMs: Date.now() - startedAt,
          upstream: UpstreamClient.resolveConfig().baseUrl,
          egressNodeId: nodeId,
          error: err?.code || 'upstream_network_error'
        });
        res.status(502).json(openAiError(`Upstream request failed: ${err?.message || 'network error'}`, 'server_error', 'upstream_unreachable'));
        return;
      }

      // The classifier decides whether a fresh egress IP could help. A quota
      // error, an auth error or a context-length error never triggers rotation.
      if (routedError?.rotateEgress && attempt < MAX_ATTEMPTS) {
        releaseOnce();
        await egressPool.penalize(slot, `${routedError.kind}: ${routedError.message || 'upstream error'}`);
        continue;
      }

      const classification = classifyHttp(forwarded.statusCode, forwarded.headers['retry-after'] as any);
      // Trust the body-aware classifier over the status-only heuristic.
      if (routedError && !routedError.rotateEgress) classification.rotate = false;

      try {
        if (classification.class === 'ok') {
          if (nodeId) FreshnessTracker.recordSuccess(nodeId);
          const meta = { nodeId, provider };
          // Source identity: what was asked for, what actually served it, and how
          // many attempts it took. A model substitution is never silent.
          const resolvedModel = provider?.model || (body?.model ? String(body.model) : null);
          const requestedModel = body?.model ? String(body.model) : null;
          const fallbackUsed =
            attempt > 1 ||
            !!(selection?.providerIds?.length && provider && selection.providerIds[0] !== provider.id);
          // Provider attempts (e.g. OpenCode 429 then a fallback) rather than
          // egress-slot attempts. providerAttempts comes from the forward result.
          const trace = { requestId, requestedModel, resolvedModel, attempts: providerAttempts, fallbackUsed };
          res.setHeader('x-model-requested', requestedModel || '');
          res.setHeader('x-model-resolved', resolvedModel || '');
          res.setHeader('x-attempts', String(providerAttempts));
          res.setHeader('x-fallback-used', fallbackUsed ? '1' : '0');
          if (provider) {
            res.setHeader('x-provider', provider.name);
            res.setHeader('x-provider-id', String(provider.id));
          }
          res.setHeader('x-egress-node', String(nodeId ?? ''));
          if (wantsStream) {
            await pipeStream(req, res, forwarded, key, body, startedAt, meta, extraUsage, trace);
          } else {
            await relayJson(res, forwarded, forwarded.statusCode, key, body, startedAt, meta, extraUsage, trace);
          }
          return;
        }

        // D2: a 429 is a measurement about this egress IP.
        if (classification.class === 'rate_limit' && nodeId) {
          FreshnessTracker.recordRateLimit(nodeId);
        }

        // retryable: rotate this slot away and try again on a fresh one
        if (classification.rotate && attempt < MAX_ATTEMPTS) {
          try {
            await UpstreamClient.readAll(forwarded.body);
          } catch {
            /* drain */
          }
          forwarded.cleanup();
          releaseOnce();
          await egressPool.penalize(slot, `upstream ${forwarded.statusCode}`);
          continue;
        }

        // pass through unchanged
        const text = await UpstreamClient.readAll(forwarded.body).catch(() => '');
        forwarded.cleanup();
        KeyManager.recordUsage({
          keyId: key.id,
          model: body.model || null,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          statusCode: forwarded.statusCode,
          latencyMs: Date.now() - startedAt,
          upstream: UpstreamClient.resolveConfig().baseUrl,
          egressNodeId: nodeId,
          error: `upstream_${classification.class}`
        });

        res.status(forwarded.statusCode);
        try {
          res.json(JSON.parse(text));
        } catch {
          res.type('text/plain').send(text || 'Upstream error');
        }
        return;
      } finally {
        releaseOnce();
      }
    }
  });

  return router;
}

async function relayJson(
  res: Response,
  forwarded: { body: any; cleanup: () => void },
  statusCode: number,
  key: ApiKeyRow,
  body: any,
  startedAt: number,
  meta: { nodeId: number | null; provider: ProviderRow | null },
  extraUsage: { prompt: number; completion: number; total: number } = { prompt: 0, completion: 0, total: 0 },
  trace: {
    requestId?: string | null;
    requestedModel?: string | null;
    resolvedModel?: string | null;
    attempts?: number;
    fallbackUsed?: boolean;
  } = {}
): Promise<void> {
  let text = '';
  try {
    text = await UpstreamClient.readAll(forwarded.body);
  } finally {
    forwarded.cleanup();
  }

  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* not JSON */
  }

  const usage = parsed?.usage || {};
  const promptTokens = toNonNegativeInt(usage.prompt_tokens);
  const completionTokens = toNonNegativeInt(usage.completion_tokens);
  const modelName = parsed?.model || body.model || null;
  KeyManager.recordUsage({
    keyId: key.id,
    model: modelName,
    promptTokens: promptTokens + extraUsage.prompt,
    completionTokens: completionTokens + extraUsage.completion,
    totalTokens: toNonNegativeInt(usage.total_tokens) + extraUsage.total,
    statusCode,
    latencyMs: Date.now() - startedAt,
    upstream: meta.provider?.base_url || UpstreamClient.resolveConfig().baseUrl,
    egressNodeId: meta.nodeId,
    providerId: meta.provider?.id ?? null,
    costUsd: costOf(modelName, promptTokens, completionTokens),
    requestId: trace.requestId ?? null,
    requestedModel: trace.requestedModel ?? null,
    resolvedModel: trace.resolvedModel ?? modelName,
    attempts: trace.attempts ?? 1,
    fallbackUsed: trace.fallbackUsed ?? false
  });

  if (parsed === null) {
    res.type('text/plain').send(text);
    return;
  }
  res.json(parsed);
}

async function pipeStream(
  req: Request,
  res: Response,
  forwarded: { body: any; cleanup: () => void },
  key: ApiKeyRow,
  body: any,
  startedAt: number,
  meta: { nodeId: number | null; provider: ProviderRow | null },
  extraUsage: { prompt: number; completion: number; total: number } = { prompt: 0, completion: 0, total: 0 },
  trace: {
    requestId?: string | null;
    requestedModel?: string | null;
    resolvedModel?: string | null;
    attempts?: number;
    fallbackUsed?: boolean;
  } = {}
): Promise<void> {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof (res as any).flushHeaders === 'function') (res as any).flushHeaders();

  const scanner = makeUsageScanner();
  let clientClosed = false;
  let sawDone = false;

  req.on('close', () => {
    clientClosed = true;
    try {
      forwarded.body?.destroy?.();
    } catch {
      /* ignore */
    }
  });

  try {
    for await (const chunk of forwarded.body) {
      if (clientClosed || res.writableEnded) break;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      scanner.push(buf);
      if (!sawDone && buf.includes('[DONE]')) sawDone = true;
      if (!res.write(buf)) {
        // Race drain against close: after a client disconnect 'drain' never
        // fires, and waiting on it forever would leak the upstream body.
        await new Promise<void>((resolve) => {
          const done = () => {
            res.off('drain', done);
            res.off('close', done);
            resolve();
          };
          res.once('drain', done);
          res.once('close', done);
        });
      }
    }
    // Some upstreams (9Router among them) never send the [DONE] sentinel. OpenAI
    // SDKs wait for it, so synthesise it rather than leaving the client hanging.
    if (!sawDone && !clientClosed && !res.writableEnded) {
      try {
        res.write('data: [DONE]\n\n');
      } catch {
        /* ignore */
      }
    }
    if (!clientClosed && !res.writableEnded) res.end();
  } catch (err: any) {
    if (!clientClosed && !res.writableEnded) {
      try {
        res.write(`data: ${JSON.stringify(openAiError(`Stream interrupted: ${err?.message || 'upstream error'}`, 'server_error', 'stream_interrupted'))}\n\n`);
      } catch {
        /* ignore */
      }
      res.end();
    }
  } finally {
    forwarded.cleanup();
    const usage = scanner.usage;
    const promptTokens = toNonNegativeInt(usage.prompt_tokens);
    const completionTokens = toNonNegativeInt(usage.completion_tokens);
    const modelName = body.model || null;
    KeyManager.recordUsage({
      keyId: key.id,
      model: modelName,
      promptTokens: promptTokens + extraUsage.prompt,
      completionTokens: completionTokens + extraUsage.completion,
      totalTokens: toNonNegativeInt(usage.total_tokens) + extraUsage.total,
      statusCode: clientClosed ? 499 : 200,
      latencyMs: Date.now() - startedAt,
      upstream: meta.provider?.base_url || UpstreamClient.resolveConfig().baseUrl,
      egressNodeId: meta.nodeId,
      providerId: meta.provider?.id ?? null,
      costUsd: costOf(modelName, promptTokens, completionTokens),
      requestId: trace.requestId ?? null,
      requestedModel: trace.requestedModel ?? null,
      resolvedModel: trace.resolvedModel ?? modelName,
      attempts: trace.attempts ?? 1,
      fallbackUsed: trace.fallbackUsed ?? false,
      error: clientClosed ? 'client_closed' : null
    });
  }
}

export type { XraySlot };
