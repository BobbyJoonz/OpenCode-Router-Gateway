import { Agent, ProxyAgent, request, Dispatcher } from 'undici';
import { Readable } from 'stream';
import { getSetting } from '../db/database';
import {
  ANTHROPIC_VERSION,
  anthropicJsonToOpenAi,
  anthropicModelsList,
  anthropicSseToOpenAi,
  toAnthropicRequest
} from '../providers/anthropic-adapter';
import * as premium_1 from '../egress/premium-proxy';

export interface UpstreamConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  model: string;
}

export interface ForwardOptions {
  method: 'GET' | 'POST';
  path: string;
  /** Egress proxy port. Omit for a direct connection (loopback upstream). */
  httpProxyPort?: number;
  body?: any;
  timeoutMs?: number;
  accept?: string;
  /** Override the configured upstream (used by the provider router). */
  baseUrl?: string;
  /** Override the configured upstream key (resolved from the provider's env var). */
  apiKey?: string;
  /** Provider flavour. `anthropic` triggers request/response translation. */
  kind?: string;
  /** Full proxy URL (with credentials) to use instead of the egress slot. */
  proxyUrl?: string;
}

export interface ForwardResult {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: any; // undici Readable
  cleanup: () => void;
}

/**
 * Forwards OpenAI-shaped requests to the configured upstream, *through* the
 * local Xray HTTP inbound. That is the whole point: the model traffic leaves
 * from a rotating egress IP while the gateway itself stays on loopback.
 */
export class UpstreamClient {
  private static agents = new Map<number, Dispatcher>();
  private static directAgent: Dispatcher | null = null;

  /**
   * Upstream credentials come from the environment on purpose: the database is
   * backed up and inspected far more often than the process environment.
   */
  public static resolveConfig(): UpstreamConfig {
    return {
      baseUrl: (process.env.GATEWAY_UPSTREAM_BASE_URL || getSetting('gateway_upstream_base_url', '')).trim(),
      apiKey: (process.env.GATEWAY_UPSTREAM_API_KEY || '').trim(),
      timeoutMs: Math.max(
        1,
        parseInt(getSetting('gateway_upstream_timeout_seconds', '120'), 10)
      ) * 1000,
      model: (process.env.GATEWAY_UPSTREAM_MODEL || getSetting('gateway_upstream_model', '')).trim()
    };
  }

  public static isConfigured(): boolean {
    return this.resolveConfig().baseUrl.length > 0;
  }

  public static joinUrl(baseUrl: string, path: string): string {
    const base = baseUrl.replace(/\/+$/, '');
    const suffix = path.startsWith('/') ? path : `/${path}`;
    return `${base}${suffix}`;
  }

  private static dispatcherFor(httpProxyPort: number): Dispatcher {
    const cached = this.agents.get(httpProxyPort);
    if (cached) return cached;

    const agent = new ProxyAgent({
      uri: `http://127.0.0.1:${httpProxyPort}`,
      // Keep the pool small: a single Xray inbound is the bottleneck anyway.
      connections: Math.max(4, parseInt(getSetting('upstream_connections', '64'), 10) || 64),
      pipelining: 1
    });
    this.agents.set(httpProxyPort, agent);
    return agent;
  }

  private static directDispatcher(): Dispatcher {
    if (!this.directAgent) {
      this.directAgent = new Agent({ connections: Math.max(4, parseInt(getSetting('upstream_connections', '64'), 10) || 64), pipelining: 1 });
    }
    return this.directAgent;
  }

  private static isLoopbackHost(hostname: string): boolean {
    const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0';
  }

  /**
   * A loopback upstream (e.g. 9Router or a mock on the same host) must NOT be
   * tunnelled: the remote node would try to connect to its own localhost.
   */
  private static dispatcherForTarget(url: string, httpProxyPort?: number): Dispatcher {
    try {
      const parsed = new URL(url);
      const bypass =
        getSetting('gateway_upstream_bypass_proxy_loopback', 'true') === 'true' &&
        this.isLoopbackHost(parsed.hostname);
      if (bypass) return this.directDispatcher();
    } catch {
      // fall through to the proxy
    }
    if (!httpProxyPort || httpProxyPort <= 0) return this.directDispatcher();
    return this.dispatcherFor(httpProxyPort);
  }

  /** Drop cached agents (used when the proxy port changes). */
  public static resetAgents(): void {
    for (const agent of this.agents.values()) {
      try {
        agent.close();
      } catch {
        // ignore
      }
    }
    this.agents.clear();
    try {
      this.directAgent?.close();
    } catch {
      // ignore
    }
    this.directAgent = null;
  }

  public static async forward(opts: ForwardOptions): Promise<ForwardResult> {
    const config = this.resolveConfig();
    const baseUrl = (opts.baseUrl || config.baseUrl || '').trim();
    if (!baseUrl) {
      throw Object.assign(new Error('Upstream base URL is not configured'), { code: 'UPSTREAM_NOT_CONFIGURED' });
    }

    const kind = String(opts.kind || 'openai').toLowerCase();
    const isAnthropic = kind === 'anthropic';

    // Anthropic has no model-listing endpoint; answer locally so /v1/models works.
    if (isAnthropic && opts.path === '/models') {
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: Readable.from([Buffer.from(anthropicModelsList(), 'utf8')]),
        cleanup: () => undefined
      };
    }

    const path = isAnthropic ? '/messages' : opts.path;
    const url = this.joinUrl(baseUrl, path);
    const timeoutMs = opts.timeoutMs ?? config.timeoutMs;
    const apiKey = opts.apiKey !== undefined ? opts.apiKey : config.apiKey;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: opts.accept || 'application/json'
    };
    if (isAnthropic) {
      if (apiKey) headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = ANTHROPIC_VERSION;
    } else if (apiKey) {
      headers.authorization = `Bearer ${apiKey}`;
    }

    const payload =
      opts.body === undefined
        ? undefined
        : JSON.stringify(isAnthropic ? toAnthropicRequest(opts.body) : opts.body);

    try {
      const response = await request(url, {
        method: opts.method,
        headers,
        body: payload,
        dispatcher: opts.proxyUrl
          ? premium_1.dispatcherForProxyUrl(opts.proxyUrl)
          : this.dispatcherForTarget(url, opts.httpProxyPort || 0),
        signal: controller.signal,
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs
      });

      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        clearTimeout(timer);
      };

      // Translate a successful Anthropic answer back into the OpenAI shape.
      let responseBody: any = response.body;
      if (isAnthropic && response.statusCode >= 200 && response.statusCode < 300) {
        const contentType = String(response.headers['content-type'] || '');
        responseBody = contentType.includes('text/event-stream')
          ? (response.body as any).pipe(anthropicSseToOpenAi())
          : (response.body as any).pipe(anthropicJsonToOpenAi());
      }

      return {
        statusCode: response.statusCode,
        headers: response.headers as Record<string, string | string[] | undefined>,
        body: responseBody,
        cleanup
      };
    } catch (err: any) {
      clearTimeout(timer);
      const aborted = err?.name === 'AbortError' || err?.code === 'UND_ERR_ABORTED';
      const wrapped: any = new Error(
        aborted ? `Upstream request timed out after ${Math.round(timeoutMs / 1000)}s` : err?.message || 'Upstream request failed'
      );
      wrapped.code = aborted ? 'UPSTREAM_TIMEOUT' : err?.code || 'UPSTREAM_NETWORK_ERROR';
      wrapped.cause = err;
      throw wrapped;
    }
  }

  /** Read a whole (non-streaming) body with a hard size cap. */
  public static async readAll(body: any, maxBytes = 8 * 1024 * 1024): Promise<string> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) {
        throw Object.assign(new Error('Upstream response exceeded the size cap'), { code: 'UPSTREAM_RESPONSE_TOO_LARGE' });
      }
      chunks.push(buf);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
}
