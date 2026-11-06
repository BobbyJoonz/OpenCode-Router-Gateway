import cors from 'cors';
import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';

export const DEFAULT_BIND_HOST = '127.0.0.1';

let activeBindHost: string = DEFAULT_BIND_HOST;

export function setActiveBindHost(host: string): void {
  activeBindHost = host;
}

export function getActiveBindHost(): string {
  return activeBindHost;
}

export class SecurityConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityConfigurationError';
    Object.setPrototypeOf(this, SecurityConfigurationError.prototype);
  }
}

/**
 * Check whether a host represents a local loopback address
 */
export function isLoopbackHost(host: string): boolean {
  if (!host) return false;
  const trimmed = host.trim().toLowerCase();
  return (
    trimmed === '127.0.0.1' ||
    trimmed === 'localhost' ||
    trimmed === '::1' ||
    trimmed === '[::1]' ||
    trimmed.startsWith('127.')
  );
}

/**
 * Determine the safe listening host address.
 * Non-loopback addresses require an explicit opt-in (ALLOW_REMOTE_ACCESS=true).
 */
export function resolveBindHost(
  requestedHost?: string,
  allowRemote: boolean = false
): { host: string; isRemoteAllowed: boolean; warning?: string } {
  const candidate = (requestedHost || process.env.HOST || process.env.OPENCODE_ROUTER_HOST || DEFAULT_BIND_HOST).trim();

  if (isLoopbackHost(candidate)) {
    return { host: candidate, isRemoteAllowed: false };
  }

  const remoteExplicitlyAllowed =
    allowRemote || process.env.ALLOW_REMOTE_ACCESS === 'true' || process.env.OPENCODE_ROUTER_ALLOW_REMOTE === 'true';

  if (!remoteExplicitlyAllowed) {
    const warning = `[SECURITY WARNING] Non-loopback bind host '${candidate}' requested without explicit opt-in (ALLOW_REMOTE_ACCESS=true). Defaulting to secure loopback address ${DEFAULT_BIND_HOST}.`;
    return { host: DEFAULT_BIND_HOST, isRemoteAllowed: false, warning };
  }

  const warning = `[CRITICAL SECURITY WARNING] Backend is binding to non-loopback host '${candidate}'. Remote access requires OPENCODE_ROUTER_API_KEY Bearer token authentication for all API endpoints.`;
  return { host: candidate, isRemoteAllowed: true, warning };
}

/**
 * Validate that non-loopback binding is protected by an API key.
 * Throws SecurityConfigurationError if remote binding is requested without OPENCODE_ROUTER_API_KEY.
 */
export function validateRemoteBindingConfig(bindHost: string, apiKey?: string): void {
  if (!isLoopbackHost(bindHost)) {
    const trimmedKey = (apiKey || process.env.OPENCODE_ROUTER_API_KEY || '').trim();
    if (!trimmedKey) {
      throw new SecurityConfigurationError(
        `[CRITICAL SECURITY ERROR] Binding to non-loopback host '${bindHost}' is prohibited without an API key. ` +
          `You MUST configure OPENCODE_ROUTER_API_KEY with a secure non-empty secret before enabling remote access.`
      );
    }
  }
}

/**
 * Construct the explicit allowlist of authorized web origins
 */
export function getAllowedOrigins(port: number, bindHost: string = DEFAULT_BIND_HOST): Set<string> {
  const allowed = new Set<string>();

  // Always allow local loopback origins for the active port
  allowed.add(`http://localhost:${port}`);
  allowed.add(`http://127.0.0.1:${port}`);
  allowed.add(`http://[::1]:${port}`);

  // If bound to a non-loopback host and explicitly allowed, permit that host
  if (bindHost && !isLoopbackHost(bindHost)) {
    allowed.add(`http://${bindHost}:${port}`);
  }

  // Development origins: Vite dev server ports
  if (process.env.NODE_ENV !== 'production') {
    allowed.add('http://localhost:5173');
    allowed.add('http://127.0.0.1:5173');
    allowed.add('http://[::1]:5173');
  }

  // Optional custom allowed origins from environment variable (comma-separated)
  const envOrigins = process.env.ALLOWED_ORIGINS || process.env.OPENCODE_ROUTER_ALLOWED_ORIGINS;
  if (envOrigins) {
    envOrigins.split(',').forEach((o) => {
      const trimmed = o.trim();
      if (trimmed) allowed.add(trimmed);
    });
  }

  return allowed;
}

/**
 * Check if a given request origin is authorized
 */
export function isAllowedOrigin(origin: string | undefined, allowedOrigins: Set<string>): boolean {
  if (!origin) return false;
  const normalized = origin.trim().toLowerCase().replace(/\/+$/, '');
  for (const allowed of allowedOrigins) {
    if (allowed.toLowerCase().replace(/\/+$/, '') === normalized) {
      return true;
    }
  }
  return false;
}

/**
 * Check if the Host header matches an authorized local host (DNS Rebinding protection)
 */
export function isAllowedHost(
  hostHeader: string | undefined,
  port: number,
  bindHost: string = DEFAULT_BIND_HOST
): boolean {
  if (!hostHeader) return true; // Direct non-HTTP/CLI sockets without Host header

  // Split hostname and port (handling IPv6 like [::1]:3000)
  let hostname = hostHeader.toLowerCase().trim();
  if (hostname.startsWith('[')) {
    const closingIdx = hostname.indexOf(']');
    if (closingIdx !== -1) {
      hostname = hostname.slice(1, closingIdx);
    }
  } else if (hostname.includes(':')) {
    hostname = hostname.split(':')[0];
  }

  // Loopback hostnames are always allowed
  if (isLoopbackHost(hostname)) {
    return true;
  }

  // If remote access is explicitly enabled and matches bindHost
  if (bindHost && !isLoopbackHost(bindHost) && hostname === bindHost.toLowerCase().trim()) {
    return true;
  }

  return false;
}

/**
 * Configure restricted CORS middleware with an explicit origin allowlist
 */
export function createCorsMiddleware(port: number, bindHost: string = DEFAULT_BIND_HOST) {
  const allowedOrigins = getAllowedOrigins(port, bindHost);

  return cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (such as CLI tools, curl, or same-origin direct navigation)
      if (!origin) {
        return callback(null, true);
      }

      if (isAllowedOrigin(origin, allowedOrigins)) {
        return callback(null, true);
      }

      // Disallow untrusted cross-origin requests
      return callback(null, false);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    credentials: false,
    maxAge: 86400
  });
}

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

/**
 * Guard middleware for Host header validation and CSRF protection on state-changing API endpoints
 */
export function createSecurityGuardMiddleware(port: number, bindHost: string = DEFAULT_BIND_HOST) {
  const allowedOrigins = getAllowedOrigins(port, bindHost);

  return (req: Request, res: Response, next: NextFunction) => {
    // 1. Host header validation (Protection against DNS Rebinding)
    const hostHeader = req.headers.host;
    if (hostHeader && !isAllowedHost(hostHeader, port, bindHost)) {
      return res.status(403).json({
        error: 'Forbidden: Invalid or untrusted Host header.',
        code: 'INVALID_HOST'
      });
    }

    // 2. State-changing requests origin/referer validation (CSRF protection)
    if (STATE_CHANGING_METHODS.has(req.method.toUpperCase())) {
      const origin = req.headers.origin;
      const referer = req.headers.referer;

      if (origin) {
        if (!isAllowedOrigin(origin, allowedOrigins)) {
          return res.status(403).json({
            error: `Forbidden: Cross-origin request from origin '${origin}' is blocked.`,
            code: 'UNTRUSTED_ORIGIN'
          });
        }
      } else if (referer) {
        try {
          const refererUrl = new URL(referer);
          if (!isAllowedOrigin(refererUrl.origin, allowedOrigins)) {
            return res.status(403).json({
              error: `Forbidden: Request from referer '${refererUrl.origin}' is blocked.`,
              code: 'UNTRUSTED_REFERER'
            });
          }
        } catch {
          return res.status(403).json({
            error: 'Forbidden: Malformed Referer header.',
            code: 'MALFORMED_REFERER'
          });
        }
      }
    }

    next();
  };
}

/**
 * Constant-time string comparison using SHA-256 and crypto.timingSafeEqual.
 * Protects against timing side-channel attacks and buffer length leakage.
 */
export function constantTimeCompare(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  const hashA = crypto.createHash('sha256').update(a).digest();
  const hashB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

export interface AuthMiddlewareOptions {
  apiKey?: string;
  isRemote?: boolean;
  enforceLocal?: boolean;
}

/**
 * Mandatory Bearer token authentication middleware for remote access.
 * Protects all /api/* endpoints against unauthenticated remote clients.
 */
export function createAuthMiddleware(options: AuthMiddlewareOptions = {}) {
  return (req: Request, res: Response, next: NextFunction) => {
    // Only protect /api/* endpoints
    if (!req.path.startsWith('/api')) {
      return next();
    }

    // Allow CORS preflight OPTIONS requests without auth header
    if (req.method === 'OPTIONS') {
      return next();
    }

    const currentApiKey = (options.apiKey ?? process.env.OPENCODE_ROUTER_API_KEY ?? '').trim();

    const envHost = (process.env.HOST || process.env.OPENCODE_ROUTER_HOST || '').trim();
    const isEnvHostRemote = envHost ? !isLoopbackHost(envHost) : false;
    const isBoundRemote = !isLoopbackHost(getActiveBindHost());

    const isRemoteActive =
      options.isRemote !== undefined
        ? options.isRemote
        : isBoundRemote ||
          process.env.ALLOW_REMOTE_ACCESS === 'true' ||
          process.env.OPENCODE_ROUTER_ALLOW_REMOTE === 'true' ||
          isEnvHostRemote;

    const enforceLocal =
      options.enforceLocal !== undefined
        ? options.enforceLocal
        : process.env.ENFORCE_LOCAL_AUTH === 'true' || process.env.OPENCODE_ROUTER_REQUIRE_LOCAL_AUTH === 'true';

    // If neither remote access nor explicit local auth enforcement is active, loopback is frictionless
    if (!isRemoteActive && !enforceLocal) {
      return next();
    }

    // Remote access or local auth is active: validate Bearer token
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="OpenCode Router"');
      return res.status(401).json({
        error: 'Unauthorized: Missing Bearer API key.',
        code: 'UNAUTHORIZED'
      });
    }

    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match || !match[1]) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="OpenCode Router"');
      return res.status(401).json({
        error: 'Unauthorized: Malformed Authorization header. Expected Bearer token.',
        code: 'UNAUTHORIZED'
      });
    }

    const token = match[1].trim();
    if (!currentApiKey || !constantTimeCompare(token, currentApiKey)) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="OpenCode Router"');
      return res.status(401).json({
        error: 'Unauthorized: Invalid API key.',
        code: 'INVALID_API_KEY'
      });
    }

    return next();
  };
}

/**
 * Mask IP addresses for privacy in diagnostics and public logs (RFC 5737 compliant)
 */
export function maskAddress(addr?: string): string {
  if (!addr) return '';
  const trimmed = addr.trim();

  // IPv4 masking: x.x.*.*
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(trimmed)) {
    const parts = trimmed.split('.');
    return `${parts[0]}.${parts[1]}.*.*`;
  }

  // IPv6 masking: preserve first 2 parts, mask remainder
  if (trimmed.includes(':') && !trimmed.includes('.')) {
    const parts = trimmed.split(':');
    if (parts.length >= 2) {
      return `${parts[0]}:${parts[1]}:*:*:*:*:*:*`;
    }
  }

  return trimmed;
}

const SENSITIVE_QUERY_NAMES = ['token', 'key', 'secret', 'password', 'auth', 'pass', 'api_key', 'access_token'];

const SENSITIVE_PARAM_REGEX = new RegExp(`([?&])(${SENSITIVE_QUERY_NAMES.join('|')})=([^&#\\s]*)`, 'gi');

const USERINFO_REGEX = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^:/@\s]+)(?::([^@\s]*))?(@)/g;

/**
 * Redact sensitive query parameter values (tokens, keys, passwords) and userinfo credentials.
 * Handles standalone URLs and URLs embedded in error strings case-insensitively.
 */
export function sanitizeSubscriptionUrl(input: string): string {
  if (!input) return '';
  let sanitized = input;

  // 1. Redact username:password or username in userinfo: http(s)://user:pass@host -> http(s)://***:***@host
  sanitized = sanitized.replace(USERINFO_REGEX, (_match, protocol, _user, pass, at) => {
    return pass !== undefined ? `${protocol}***:***${at}` : `${protocol}***${at}`;
  });

  // 2. Redact sensitive query parameter values case-insensitively
  sanitized = sanitized.replace(SENSITIVE_PARAM_REGEX, (_match, prefix, paramName) => {
    return `${prefix}${paramName}=***`;
  });

  // 3. For direct valid URLs, double check with standard URL object
  try {
    const parsed = new URL(sanitized);
    let modified = false;
    for (const [key] of parsed.searchParams) {
      if (SENSITIVE_QUERY_NAMES.includes(key.toLowerCase())) {
        parsed.searchParams.set(key, '***');
        modified = true;
      }
    }
    if (parsed.username && parsed.username !== '***') {
      parsed.username = '***';
      modified = true;
    }
    if (parsed.password && parsed.password !== '***') {
      parsed.password = '***';
      modified = true;
    }
    if (modified) {
      return parsed.toString();
    }
  } catch {
    // Input might be an error string or freeform text containing URLs
  }

  return sanitized;
}
