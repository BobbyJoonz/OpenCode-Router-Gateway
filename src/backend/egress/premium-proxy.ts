import { request as undiciRequest, ProxyAgent, Dispatcher } from 'undici';
import { spawn, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../paths';

/**
 * Premium rotating HTTP/SOCKS5 proxy adapter.
 *
 * A premium proxy is an egress path, not an account trick: it changes the exit IP
 * and nothing else. Credentials live in the environment only and are never
 * returned by any API, log or response.
 */
export type PremiumKind = 'http' | 'socks5';
export type EgressMode = 'pool' | 'premium-http' | 'premium-socks5';

const agents = new Map<string, ProxyAgent>();

export function premiumProxyUrl(kind: PremiumKind): string | null {
  const env = kind === 'http' ? 'PREMIUM_HTTP_PROXY_URL' : 'PREMIUM_SOCKS5_PROXY_URL';
  const raw = (process.env[env] || '').trim();
  return raw || null;
}

/** `http://user:pass@host:port` -> `http://***:***@host:port` */
export function redactProxyUrl(url: string | null | undefined): string {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = '***';
      parsed.password = '***';
    }
    return parsed.toString();
  } catch {
    return '***';
  }
}

export function dispatcherForProxyUrl(url: string): Dispatcher {
  const cached = agents.get(url);
  if (cached) return cached;
  const agent = new ProxyAgent({
    uri: url,
    connections: Math.max(4, parseInt(process.env.PREMIUM_PROXY_CONNECTIONS || '64', 10) || 64),
    pipelining: 1
  });
  agents.set(url, agent);
  return agent;
}

export interface PremiumProbeResult {
  kind: PremiumKind;
  configured: boolean;
  ok: boolean;
  egressIp: string | null;
  latencyMs: number | null;
  error?: string;
}

/**
 * Proves the proxy works and reports the real exit IP. Uses a public IP echo so
 * the result is an observed fact, not a configuration claim.
 */
export async function probePremiumProxy(kind: PremiumKind, timeoutMs = 20000): Promise<PremiumProbeResult> {
  const url = premiumProxyUrl(kind);
  if (!url) return { kind, configured: false, ok: false, egressIp: null, latencyMs: null };

  const startedAt = Date.now();
  try {
    const target = kind === 'socks5' ? await ensureSocksBridge() : url;
    const response = await undiciRequest('https://api.ipify.org', {
      method: 'GET',
      dispatcher: dispatcherForProxyUrl(target),
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
      signal: AbortSignal.timeout(timeoutMs)
    });
    let body = '';
    for await (const chunk of response.body) body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    const ip = body.trim();
    return {
      kind,
      configured: true,
      ok: response.statusCode === 200 && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip),
      egressIp: ip || null,
      latencyMs: Date.now() - startedAt
    };
  } catch (err: any) {
    return {
      kind,
      configured: true,
      ok: false,
      egressIp: null,
      latencyMs: Date.now() - startedAt,
      error: String(err?.message || err).slice(0, 160)
    };
  }
}

export function egressModeOf(provider: { egress_mode?: string | null }): EgressMode {
  const mode = String(provider?.egress_mode || 'pool').trim().toLowerCase();
  if (mode === 'premium-http' || mode === 'premium-socks5') return mode;
  return 'pool';
}

/**
 * Resolves the proxy URL a provider needs, or throws a precise configuration
 * error instead of silently falling back to another egress.
 */
export async function proxyUrlForEgressMode(mode: EgressMode): Promise<string | undefined> {
  if (mode === 'premium-socks5') {
    const url = premiumProxyUrl('socks5');
    if (!url) throw Object.assign(new Error('Provider requires the premium SOCKS5 proxy but PREMIUM_SOCKS5_PROXY_URL is not configured'), { code: 'EGRESS_NOT_CONFIGURED' });
    return ensureSocksBridge();
  }
  if (mode === 'premium-http') {
    const url = premiumProxyUrl('http');
    if (!url) throw Object.assign(new Error('Provider requires the premium HTTP proxy but PREMIUM_HTTP_PROXY_URL is not configured'), { code: 'EGRESS_NOT_CONFIGURED' });
    return url;
  }
  return undefined;
}


// ---------------------------------------------------------------------------
// SOCKS5 bridge
//
// undici's ProxyAgent only speaks HTTP CONNECT. To use a SOCKS5 premium endpoint
// we run a tiny local Xray instance (HTTP inbound -> SOCKS outbound) on a
// dedicated port pair and point the dispatcher at it. Nothing leaves the host
// except through the premium proxy.
// ---------------------------------------------------------------------------
const SOCKS_BRIDGE_HTTP_PORT = 12211;
const SOCKS_BRIDGE_SOCKS_PORT = 12210;

let socksBridge: ChildProcess | null = null;

function parseSocksUrl(url: string): { host: string; port: number; user: string; pass: string } {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parseInt(parsed.port || '1080', 10) || 1080,
    user: decodeURIComponent(parsed.username || ''),
    pass: decodeURIComponent(parsed.password || '')
  };
}

function bridgeConfigFile(): string {
  const target = parseSocksUrl(premiumProxyUrl('socks5') || '');
  const config = {
    log: { loglevel: 'warning' },
    inbounds: [
      { tag: 'http-in', listen: '127.0.0.1', port: SOCKS_BRIDGE_HTTP_PORT, protocol: 'http', settings: {} }
    ],
    outbounds: [
      {
        tag: 'premium-socks',
        protocol: 'socks',
        settings: {
          servers: [
            {
              address: target.host,
              port: target.port,
              users: target.user ? [{ user: target.user, pass: target.pass }] : []
            }
          ]
        }
      }
    ]
  };
  const dir = path.join(PROJECT_ROOT, 'data');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  const file = path.join(dir, 'premium-socks-bridge.json');
  fs.writeFileSync(file, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 });
  return file;
}

async function portOpen(port: number, timeoutMs = 8000): Promise<boolean> {
  const net = await import('node:net');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port }, () => { socket.destroy(); resolve(true); });
      socket.on('error', () => resolve(false));
      socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

/** Starts (once) the local HTTP->SOCKS5 bridge and returns its HTTP proxy URL. */
export async function ensureSocksBridge(): Promise<string> {
  if (socksBridge && !socksBridge.killed) {
    if (await portOpen(SOCKS_BRIDGE_HTTP_PORT, 500)) return `http://127.0.0.1:${SOCKS_BRIDGE_HTTP_PORT}`;
  }
  const binary = path.join(PROJECT_ROOT, 'bin', process.platform === 'win32' ? 'xray.exe' : 'xray');
  if (!fs.existsSync(binary)) throw Object.assign(new Error('xray binary not found for the SOCKS5 bridge'), { code: 'EGRESS_NOT_CONFIGURED' });
  const configFile = bridgeConfigFile();
  socksBridge = spawn(binary, ['run', '-c', configFile], { stdio: 'ignore', detached: false });
  socksBridge.on('exit', () => { socksBridge = null; });
  const up = await portOpen(SOCKS_BRIDGE_HTTP_PORT, 10000);
  if (!up) throw Object.assign(new Error('SOCKS5 bridge did not start'), { code: 'EGRESS_NOT_CONFIGURED' });
  return `http://127.0.0.1:${SOCKS_BRIDGE_HTTP_PORT}`;
}

export function stopSocksBridge(): void {
  if (socksBridge) {
    try { socksBridge.kill(); } catch { /* ignore */ }
    socksBridge = null;
  }
}
