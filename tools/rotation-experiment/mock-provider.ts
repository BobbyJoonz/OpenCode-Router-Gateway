import http from 'http';

/**
 * A deterministic OpenAI-shaped provider that rate-limits **per source IP**.
 *
 * This is the instrument that makes the experiment falsifiable offline: an arm
 * that keeps rotating over distinct exit IPs should never hit the limit, while
 * an arm pinned to one IP (or rotating over a shared IP) must.
 */
export interface MockOptions {
  limitPerWindow: number;
  windowMs: number;
  latencyMs: number;
  /** Extra artificial latency jitter in ms. */
  jitterMs?: number;
}

export interface MockStats {
  requests: number;
  rateLimited: number;
  byIp: Record<string, number>;
}

export interface MockProvider {
  baseUrl: string;
  port: number;
  stats: () => MockStats;
  reset: () => void;
  close: () => Promise<void>;
}

function normalizeIp(value: string | undefined): string {
  const ip = value || 'unknown';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

export async function startMockProvider(options: MockOptions): Promise<MockProvider> {
  const { limitPerWindow, windowMs, latencyMs } = options;
  const jitterMs = options.jitterMs ?? 0;

  const hits = new Map<string, number[]>();
  const byIp: Record<string, number> = {};
  let requests = 0;
  let rateLimited = 0;

  const server = http.createServer((req, res) => {
    const ip = normalizeIp(req.socket.remoteAddress);
    requests++;
    byIp[ip] = (byIp[ip] || 0) + 1;

    if (req.url === '/__stats') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ requests, rateLimited, byIp }));
      return;
    }

    if (req.method === 'GET' && req.url?.includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model' }] }));
      return;
    }

    // Sliding window per source IP.
    const now = Date.now();
    const windowStart = now - windowMs;
    const list = (hits.get(ip) || []).filter((t) => t > windowStart);

    if (list.length >= limitPerWindow) {
      rateLimited++;
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': String(Math.ceil(windowMs / 1000)) });
      res.end(JSON.stringify({ error: { message: 'rate limited', type: 'rate_limit_error', code: 'rate_limit_exceeded' } }));
      return;
    }
    list.push(now);
    hits.set(ip, list);

    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const delay = latencyMs + (jitterMs > 0 ? Math.floor(Math.random() * jitterMs) : 0);
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-mock',
            object: 'chat.completion',
            model: 'mock-model',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
          })
        );
      }, delay);
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    port,
    stats: () => ({ requests, rateLimited, byIp: { ...byIp } }),
    reset: () => {
      hits.clear();
      for (const key of Object.keys(byIp)) delete byIp[key];
      requests = 0;
      rateLimited = 0;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      })
  };
}
