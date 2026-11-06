import { type NextFunction, type Request, type Response, Router } from 'express';
import { db, getSetting } from '../db/database';
import { lifecycle } from '../lifecycle';
import { egressRotations, gatewayRequests, tokensTotal, upstreamRateLimits } from '../observability/metrics';
import { annotateContext } from '../observability/request-context';
import { withSpan } from '../observability/tracing';
import { VpnEngine } from '../vpn/vpn-engine';
import { isRoutableEgressAddress } from './egress-filter';
import { classifyHttp, classifyNetwork, openAiError } from './error-mapper';
import { type ApiKeyRow, KeyManager } from './key-manager';
import { UpstreamClient } from './upstream-client';

interface GatewayRequest extends Request {
  apiKey?: ApiKeyRow;
}

const MAX_ATTEMPTS = 2;
const MAX_SSE_BUFFER = 2 * 1024 * 1024;

let startLock: Promise<boolean> | null = null;

function proxyPorts(): { socks: number; http: number } {
  return {
    socks: parseInt(getSetting('socks_port', '10808'), 10),
    http: parseInt(getSetting('http_port', '10809'), 10)
  };
}

function gatewayEnabled(): boolean {
  return getSetting('gateway_enabled', 'false') === 'true';
}

function authFailure(res: Response, reason: 'missing' | 'invalid' | 'disabled'): void {
  if (reason === 'missing') {
    res
      .status(401)
      .json(
        openAiError(
          'Missing bearer token. Send "Authorization: Bearer sk-or-...".',
          'invalid_request_error',
          'missing_api_key'
        )
      );
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

/**
 * Pick the healthiest *routable* candidate. Rows with loopback/private addresses
 * are skipped: they are artefacts and would poison the rotation.
 */
function pickCandidate(excludeId: number | null): any | null {
  const rows = db
    .prepare(
      `SELECT * FROM configs
        WHERE last_status = 'working'
          AND (? IS NULL OR id != ?)
        ORDER BY COALESCE(health_score, 100) DESC, COALESCE(last_latency_ms, 9999) ASC
        LIMIT 200`
    )
    .all(excludeId, excludeId) as any[];

  return rows.find((row) => isRoutableEgressAddress(row.address)) || null;
}

/**
 * Make sure *some* node is serving before we accept model traffic.
 *
 * Shares `startLock` with rotateNode: two cold-start requests must not both call
 * `VpnEngine.start()` (whose first action is `stop()`), or they kill each other.
 */
async function ensureConnection(): Promise<boolean> {
  const vpn = VpnEngine.getInstance();
  if (vpn.getActiveConfig()) return true;

  if (startLock) {
    try {
      await startLock;
    } catch {
      /* fall through */
    }
    return !!vpn.getActiveConfig();
  }

  const task = (async () => {
    const row = pickCandidate(null);
    if (!row) return false;

    const { socks, http } = proxyPorts();
    try {
      const ok = await vpn.start(row, socks, http);
      if (ok) {
        db.prepare('UPDATE configs SET is_active = 0').run();
        db.prepare('UPDATE configs SET is_active = 1 WHERE id = ?').run(row.id);
      }
      return ok;
    } catch (err: any) {
      console.error('[Gateway] could not start egress node:', err?.message || err);
      return false;
    }
  })();

  startLock = task;
  try {
    return await task;
  } finally {
    startLock = null;
  }
}

/**
 * Switch to the next healthy node. Serialized so two concurrent 429s cannot
 * fight over the single Xray process.
 */
async function rotateNode(): Promise<boolean> {
  if (startLock) return startLock;

  const task = (async () => {
    const vpn = VpnEngine.getInstance();
    const current = vpn.getActiveConfig();
    const currentId = current ? current.id : null;
    const { socks, http } = proxyPorts();

    const row = pickCandidate(currentId);
    if (!row) return false;

    try {
      const ok = await vpn.start(row, socks, http);
      if (ok) {
        db.prepare('UPDATE configs SET is_active = 0').run();
        db.prepare('UPDATE configs SET is_active = 1 WHERE id = ?').run(row.id);
        egressRotations.inc();
        annotateContext({ nodeId: row.id });
        console.log(`[Gateway] rotated egress to #${row.id} ${row.address}:${row.port}`);
      }
      return ok;
    } catch (err: any) {
      console.error('[Gateway] rotation failed:', err?.message || err);
      return false;
    }
  })();

  startLock = task;
  try {
    return await task;
  } finally {
    startLock = null;
  }
}

function makeUsageScanner() {
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let buffer = '';

  return {
    push(chunk: Buffer): void {
      buffer += chunk.toString('utf8');
      if (buffer.length > MAX_SSE_BUFFER) {
        // Malformed or non-SSE payload: keep only the tail so we never grow without bound.
        buffer = buffer.slice(-4096);
      }

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
            // partial JSON across chunk boundaries — ignore
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
    if (lifecycle.isShuttingDown()) {
      res.status(503).json({ status: 'shutting_down', connected: false });
      return;
    }
    const vpn = VpnEngine.getInstance();
    // Unauthenticated endpoint: report liveness only, never the egress endpoint.
    res.json({
      status: 'ok',
      gateway_enabled: gatewayEnabled(),
      upstream_configured: UpstreamClient.isConfigured(),
      connected: !!vpn.getActiveConfig()
    });
  });

  // ---------------------------------------------------------------- auth
  const authMiddleware = (req: GatewayRequest, res: Response, next: NextFunction) => {
    if (!gatewayEnabled()) {
      res
        .status(503)
        .json(
          openAiError(
            'The gateway is disabled. Set gateway_enabled=true in settings.',
            'server_error',
            'gateway_disabled'
          )
        );
      return;
    }

    const maxBody = parseInt(getSetting('gateway_max_body_bytes', '8388608'), 10);
    const declared = parseInt(String(req.headers['content-length'] || '0'), 10);
    if (Number.isFinite(declared) && declared > maxBody) {
      res
        .status(413)
        .json(openAiError(`Request body exceeds ${maxBody} bytes.`, 'invalid_request_error', 'request_too_large'));
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
      res
        .status(429)
        .json(openAiError('Rate limit exceeded for this API key.', 'rate_limit_error', 'rate_limit_exceeded'));
      return;
    }

    if (verified.key.daily_token_limit > 0) {
      // Reserve a slice of the quota before forwarding so concurrent requests
      // cannot all pass the check. Never reserve more than half the limit, or a
      // small quota would be permanently unusable.
      const configured = Math.max(0, parseInt(getSetting('gateway_quota_reserve_tokens', '2000'), 10));
      const reserve =
        configured > 0 ? Math.min(configured, Math.max(1, Math.floor(verified.key.daily_token_limit / 2))) : 0;
      const used = KeyManager.tokensUsedToday(verified.key.id) + KeyManager.pendingFor(verified.key.id);
      if (used + reserve > verified.key.daily_token_limit) {
        res
          .status(429)
          .json(
            openAiError('Daily token quota exhausted for this API key.', 'rate_limit_error', 'daily_quota_exceeded')
          );
        return;
      }
      if (reserve > 0) {
        KeyManager.reserveTokens(verified.key.id, reserve);
        res.on('close', () => KeyManager.releaseTokens(verified.key.id, reserve));
      }
    }

    req.apiKey = verified.key;
    annotateContext({ keyId: verified.key.id });
    next();
  };

  // ---------------------------------------------------------------- models
  router.get('/models', authMiddleware, async (_req: GatewayRequest, res: Response) => {
    const config = UpstreamClient.resolveConfig();

    if (config.baseUrl) {
      try {
        const forwarded = await UpstreamClient.forward({
          method: 'GET',
          path: '/models',
          httpProxyPort: proxyPorts().http,
          timeoutMs: 15000
        });
        if (forwarded.statusCode >= 200 && forwarded.statusCode < 300) {
          const text = await UpstreamClient.readAll(forwarded.body);
          forwarded.cleanup();
          try {
            res.json(JSON.parse(text));
            return;
          } catch {
            // fall through to synthetic list
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
        // upstream unreachable — still answer with a synthetic list
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
    const today = KeyManager.tokensUsedToday(key.id);
    res.json({
      key: { id: key.id, name: key.name, prefix: key.key_prefix },
      total: KeyManager.usageSummary(key.id),
      today_tokens: today,
      daily_token_limit: key.daily_token_limit,
      rpm_limit: key.rpm_limit
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
      res
        .status(400)
        .json(openAiError('"messages" must be a non-empty array.', 'invalid_request_error', 'invalid_messages'));
      return;
    }
    if (body.model !== undefined && typeof body.model !== 'string') {
      res.status(400).json(openAiError('"model" must be a string.', 'invalid_request_error', 'invalid_model'));
      return;
    }

    const wantsStream = body.stream === true;
    const startedAt = Date.now();

    // Ask the provider to emit token usage on the final SSE chunk, otherwise
    // streaming clients would bypass the daily quota entirely.
    let forwardBody = body;
    if (wantsStream && getSetting('gateway_stream_include_usage', 'true') === 'true') {
      const existing = body.stream_options && typeof body.stream_options === 'object' ? body.stream_options : {};
      forwardBody = { ...body, stream_options: { include_usage: true, ...existing } };
    }

    // Make sure an egress node is up before we spend the request — unless the
    // upstream is loopback (mock / co-located router), which bypasses the tunnel.
    if (UpstreamClient.requiresEgress()) {
      const connected = await ensureConnection();
      if (!connected) {
        res
          .status(503)
          .json(
            openAiError(
              'No working egress node is available. Run a workflow or a pre-screen first.',
              'server_error',
              'no_egress_node'
            )
          );
        return;
      }
    }

    const activeBefore = VpnEngine.getInstance().getActiveConfig();

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let forwarded: Awaited<ReturnType<typeof UpstreamClient.forward>>;
      try {
        const upstreamConfig = UpstreamClient.resolveConfig();
        forwarded = await withSpan(
          'upstream.chat_completions',
          {
            'http.request.method': 'POST',
            'upstream.url': upstreamConfig.baseUrl,
            'llm.model': String(body.model || upstreamConfig.model || ''),
            'llm.stream': wantsStream
          },
          () =>
            UpstreamClient.forward({
              method: 'POST',
              path: '/chat/completions',
              httpProxyPort: proxyPorts().http,
              body: forwardBody,
              accept: wantsStream ? 'text/event-stream' : 'application/json'
            })
        );
      } catch (err: any) {
        const classification = classifyNetwork(err?.code);
        gatewayRequests.inc({ outcome: 'network_error', stream: String(wantsStream) });
        if (classification.rotate && attempt < MAX_ATTEMPTS && (await rotateNode())) {
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
          egressNodeId: VpnEngine.getInstance().getActiveConfig()?.id ?? null,
          error: err?.code || 'upstream_network_error'
        });
        res
          .status(502)
          .json(
            openAiError(
              `Upstream request failed: ${err?.message || 'network error'}`,
              'server_error',
              'upstream_unreachable'
            )
          );
        return;
      }

      const classification = classifyHttp(forwarded.statusCode, forwarded.headers['retry-after'] as any);
      if (classification.class === 'rate_limit') upstreamRateLimits.inc();

      // ------------------------------------------------------ success
      if (classification.class === 'ok') {
        gatewayRequests.inc({ outcome: 'success', stream: String(wantsStream) });
        if (wantsStream) {
          await pipeStream(req, res, forwarded, key, body, startedAt);
        } else {
          await relayJson(res, forwarded, forwarded.statusCode, key, body, startedAt);
        }
        return;
      }

      // ------------------------------------------------------ retryable
      if (classification.rotate && attempt < MAX_ATTEMPTS) {
        try {
          await UpstreamClient.readAll(forwarded.body);
        } catch {
          /* drain */
        }
        forwarded.cleanup();
        if (await rotateNode()) continue;
      }

      // ------------------------------------------------------ pass through
      const text = await UpstreamClient.readAll(forwarded.body).catch(() => '');
      forwarded.cleanup();
      gatewayRequests.inc({ outcome: classification.class, stream: String(wantsStream) });

      KeyManager.recordUsage({
        keyId: key.id,
        model: body.model || null,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        statusCode: forwarded.statusCode,
        latencyMs: Date.now() - startedAt,
        upstream: UpstreamClient.resolveConfig().baseUrl,
        egressNodeId: activeBefore?.id ?? null,
        error: `upstream_${classification.class}`
      });

      res.status(forwarded.statusCode);
      try {
        res.json(JSON.parse(text));
      } catch {
        res.type('text/plain').send(text || 'Upstream error');
      }
      return;
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
  startedAt: number
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
    egressNodeId: VpnEngine.getInstance().getActiveConfig()?.id ?? null
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
  startedAt: number
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
        res.write(
          `data: ${JSON.stringify(openAiError(`Stream interrupted: ${err?.message || 'upstream error'}`, 'server_error', 'stream_interrupted'))}\n\n`
        );
      } catch {
        /* ignore */
      }
      res.end();
    }
  } finally {
    forwarded.cleanup();
    // If the client vanished mid-stream, the response object may still hold the
    // socket open. Closing it here is what lets the server actually shut down.
    if (!res.writableEnded) {
      try {
        res.end();
      } catch {
        /* already gone */
      }
    }
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
      egressNodeId: VpnEngine.getInstance().getActiveConfig()?.id ?? null,
      error: clientClosed ? 'client_closed' : null
    });
  }
}
