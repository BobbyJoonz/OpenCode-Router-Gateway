import { getSetting } from '../db/database';

export type ErrorClass = 'ok' | 'rate_limit' | 'auth' | 'client' | 'server' | 'network';

export interface Classification {
  class: ErrorClass;
  rotate: boolean;
  retry: boolean;
  retryAfterMs?: number;
}

function rotateOn(settingKey: string): boolean {
  return getSetting(settingKey, 'false') === 'true';
}

/**
 * Decide what to do with an upstream response.
 *
 * Rotation is only attempted for conditions that are plausibly IP-related.
 * Auth failures must never rotate (it just burns nodes), and 4xx client errors
 * are the caller's fault.
 */
export function classifyHttp(statusCode: number, retryAfterHeader?: string | string[]): Classification {
  if (statusCode >= 200 && statusCode < 300) {
    return { class: 'ok', rotate: false, retry: false };
  }

  if (statusCode === 429) {
    const raw = Array.isArray(retryAfterHeader) ? retryAfterHeader[0] : retryAfterHeader;
    const seconds = raw ? parseInt(String(raw), 10) : NaN;
    return {
      class: 'rate_limit',
      rotate: rotateOn('gateway_rotate_on_429'),
      retry: true,
      retryAfterMs: Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : undefined
    };
  }

  if (statusCode === 401 || statusCode === 403) {
    return { class: 'auth', rotate: false, retry: false };
  }

  if (statusCode >= 500) {
    return { class: 'server', rotate: rotateOn('gateway_rotate_on_5xx'), retry: true };
  }

  return { class: 'client', rotate: false, retry: false };
}

/**
 * Network-level failures that a different egress IP could plausibly fix.
 * Anything else (misconfiguration, bad TLS on our side) must NOT tear down the
 * live tunnel.
 */
const ROTATABLE_NETWORK_CODES = new Set([
  'UPSTREAM_TIMEOUT',
  'UPSTREAM_NETWORK_ERROR',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN'
]);

export function classifyNetwork(code?: string): Classification {
  const rotatable = !!code && ROTATABLE_NETWORK_CODES.has(code);
  return { class: 'network', rotate: rotatable, retry: rotatable };
}

/** OpenAI-compatible error envelope. */
export function openAiError(message: string, type: string, code: string, param: string | null = null) {
  return {
    error: {
      message,
      type,
      param,
      code
    }
  };
}
