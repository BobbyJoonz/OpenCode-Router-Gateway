import { Router, Request, Response, NextFunction } from 'express';
import { db, getSetting } from '../db/database';
import { KeyManager, ApiKeyRow } from './key-manager';
import { UpstreamClient } from './upstream-client';
import { classifyHttp, classifyNetwork, openAiError } from './error-mapper';
import { egressPool } from '../vpn/egress-pool';
import { XraySlot } from '../vpn/xray-slot';

interface GatewayRequest extends Request {
  apiKey?: ApiKeyRow;
}

const MAX_ATTEMPTS = 2;
const MAX_SSE_BUFFER = 2 * 1024 * 1024;

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

    req.apiKey = verified.key;
    next();
  };

  // ---------------------------------------------------------------- models
  router.get('/models', authMiddleware, async (_req: GatewayRequest, res: Response) => {
    const config = UpstreamClient.resolveConfig();

    if (config.baseUrl) {
      const slot = await egressPool.acquire(null);
      if (slot) {
        egressPool.track(slot);
        try {
          const forwarded = await UpstreamClient.forward({
            method: 'GET',
            path: '/models',
            httpProxyPort: slot.httpPort,
            timeoutMs: 15000
          });
          if (forwarded.statusCode >= 200 && forwarded.statusCode < 300) {
            const text = await UpstreamClient.readAll(forwarded.body);
            forwarded.cleanup();
            try {
              res.json(JSON.parse(text));
              return;
            } catch {
              /* fall through */
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

    const model = config.model || 'gpt-4o-mini';
    res.json({
      object: 'list',
      data: [
        {
          id: model,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: 'opencode-router'
        }
      ]
    });
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

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const slot = await egressPool.acquire(key.id);
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
      try {
        forwarded = await UpstreamClient.forward({
          method: 'POST',
          path: '/chat/completions',
          httpProxyPort: slot.httpPort,
          body: forwardBody,
          accept: wantsStream ? 'text/event-stream' : 'application/json'
        });
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

      const classification = classifyHttp(forwarded.statusCode, forwarded.headers['retry-after'] as any);

      try {
        if (classification.class === 'ok') {
          if (wantsStream) {
            await pipeStream(req, res, forwarded, key, body, startedAt, nodeId);
          } else {
            await relayJson(res, forwarded, forwarded.statusCode, key, body, startedAt, nodeId);
          }
          return;
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
  nodeId: number | null
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
  KeyManager.recordUsage({
    keyId: key.id,
    model: parsed?.model || body.model || null,
    promptTokens: toNonNegativeInt(usage.prompt_tokens),
    completionTokens: toNonNegativeInt(usage.completion_tokens),
    totalTokens: toNonNegativeInt(usage.total_tokens),
    statusCode,
    latencyMs: Date.now() - startedAt,
    upstream: UpstreamClient.resolveConfig().baseUrl,
    egressNodeId: nodeId
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
  nodeId: number | null
): Promise<void> {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof (res as any).flushHeaders === 'function') (res as any).flushHeaders();

  const scanner = makeUsageScanner();
  let clientClosed = false;

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
    KeyManager.recordUsage({
      keyId: key.id,
      model: body.model || null,
      promptTokens: toNonNegativeInt(usage.prompt_tokens),
      completionTokens: toNonNegativeInt(usage.completion_tokens),
      totalTokens: toNonNegativeInt(usage.total_tokens),
      statusCode: clientClosed ? 499 : 200,
      latencyMs: Date.now() - startedAt,
      upstream: UpstreamClient.resolveConfig().baseUrl,
      egressNodeId: nodeId,
      error: clientClosed ? 'client_closed' : null
    });
  }
}

export type { XraySlot };
