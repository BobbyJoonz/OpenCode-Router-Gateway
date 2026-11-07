/**
 * Upstream error classification.
 *
 * Deciding *what* failed is what decides *where* to retry:
 *
 *   model_missing   -> another provider may host the model (provider failover)
 *   rate_limit      -> the IP is throttled (egress rotation, same provider)
 *   auth            -> nothing helps; return to the caller
 *   context_length  -> deterministic; retrying anywhere is pointless
 *   invalid_request -> the caller's body is wrong
 *   content_filter  -> deterministic
 *   server          -> another provider may be healthy
 *   network         -> another egress IP may be healthy
 *
 * Status codes alone are not enough: providers return 400 or 422 for an unknown
 * model, and 400 for both "context too long" and "bad parameter".
 */
export type UpstreamErrorKind =
  | 'ok'
  | 'model_missing'
  | 'rate_limit'
  | 'auth'
  | 'quota'
  | 'context_length'
  | 'invalid_request'
  | 'content_filter'
  | 'server'
  | 'network';

export interface UpstreamErrorInfo {
  kind: UpstreamErrorKind;
  status: number;
  /** try the next provider for this request */
  retryProvider: boolean;
  /** try another egress IP for this request */
  rotateEgress: boolean;
  /** the provider's own message, for logs and passthrough */
  message?: string;
  /** provider-specific code, e.g. "model_not_found" */
  code?: string;
}

const MODEL_MISSING_PATTERNS = [
  /model[^.]{0,40}(not\s*found|does\s*not\s*exist|doesn'?t\s*exist|unsupported|unknown|invalid|not\s*available|not\s*supported)/i,
  /(not\s*found|does\s*not\s*exist|unsupported|unknown|invalid)[^.]{0,40}model/i,
  /no\s+such\s+model/i,
  /model_not_found/i,
  /unknown_model/i,
  /invalid_model/i
];

const CONTEXT_PATTERNS = [
  /context\s*length/i,
  /maximum\s*context/i,
  /context\s*window/i,
  /too\s+many\s+tokens/i,
  /reduce\s+the\s+length/i,
  /prompt\s+is\s+too\s+long/i,
  /input\s+is\s+too\s+long/i,
  /exceeds?\s+the\s+maximum/i
];

const QUOTA_PATTERNS = [
  /insufficient_quota/i,
  /exceeded\s+your\s+current\s+quota/i,
  /billing/i,
  /credit\s+balance/i,
  /quota\s+exceeded/i,
  /usage\s+limit/i,
  /free\s+usage/i,
  /out\s+of\s+credits/i
];

const CONTENT_PATTERNS = [
  /content[_ ]filter/i,
  /safety/i,
  /blocked\s+by/i,
  /moderation/i
];

function extractMessage(bodyText: string): { message?: string; code?: string } {
  if (!bodyText) return {};
  try {
    const parsed = JSON.parse(bodyText);
    const err = parsed?.error;
    if (typeof err === 'string') return { message: err };
    if (err && typeof err === 'object') {
      return {
        message: typeof err.message === 'string' ? err.message : undefined,
        code: typeof err.code === 'string' ? err.code : typeof err.type === 'string' ? err.type : undefined
      };
    }
    if (typeof parsed?.message === 'string') return { message: parsed.message };
    return {};
  } catch {
    return { message: bodyText.slice(0, 300) };
  }
}

export function classifyUpstream(status: number, bodyText = ''): UpstreamErrorInfo {
  const { message, code } = extractMessage(bodyText);
  const haystack = `${code || ''} ${message || ''} ${bodyText.slice(0, 2000)}`;

  if (status >= 200 && status < 300) {
    return { kind: 'ok', status, retryProvider: false, rotateEgress: false, message, code };
  }

  // ---- 429 / quota ------------------------------------------------
  if (status === 429) {
    if (QUOTA_PATTERNS.some((re) => re.test(haystack))) {
      // Account-level quota: a new IP will not help, but another provider/account
      // can still serve this request, so fail over instead of giving up.
      return { kind: 'quota', status, retryProvider: true, rotateEgress: false, message, code };
    }
    // Throttled: another provider may serve; if none is left, the caller rotates
    // the egress IP and retries the same provider.
    return { kind: 'rate_limit', status, retryProvider: true, rotateEgress: true, message, code };
  }

  // ---- auth -------------------------------------------------------
  if (status === 401 || status === 403) {
    return { kind: 'auth', status, retryProvider: false, rotateEgress: false, message, code };
  }

  // ---- 5xx --------------------------------------------------------
  if (status >= 500) {
    return { kind: 'server', status, retryProvider: true, rotateEgress: false, message, code };
  }

  // ---- 4xx: the interesting part ----------------------------------
  // Model-not-found is checked before the generic 404 rule, and it applies to
  // 400/404/422 because providers disagree on the status for this condition.
  if (MODEL_MISSING_PATTERNS.some((re) => re.test(haystack))) {
    return { kind: 'model_missing', status, retryProvider: true, rotateEgress: false, message, code };
  }

  if (CONTEXT_PATTERNS.some((re) => re.test(haystack))) {
    return { kind: 'context_length', status, retryProvider: false, rotateEgress: false, message, code };
  }

  if (CONTENT_PATTERNS.some((re) => re.test(haystack))) {
    return { kind: 'content_filter', status, retryProvider: false, rotateEgress: false, message, code };
  }

  if (status === 404) {
    // A bare 404 with no model hint is still most likely a routing miss.
    return { kind: 'model_missing', status, retryProvider: true, rotateEgress: false, message, code };
  }

  return { kind: 'invalid_request', status, retryProvider: false, rotateEgress: false, message, code };
}

export function classifyNetworkError(code?: string): UpstreamErrorInfo {
  return {
    kind: 'network',
    status: 0,
    retryProvider: true,
    rotateEgress: true,
    code
  };
}

/** Human-readable hint for the client-facing error body. */
export function describeKind(kind: UpstreamErrorKind): string {
  switch (kind) {
    case 'model_missing':
      return 'The model is not available on any mapped provider.';
    case 'rate_limit':
      return 'Upstream rate limit reached.';
    case 'quota':
      return 'The provider account quota is exhausted; switching IP will not help.';
    case 'auth':
      return 'The provider rejected the credentials.';
    case 'context_length':
      return 'The request exceeds the model context window.';
    case 'content_filter':
      return 'The request was blocked by the provider content filter.';
    case 'invalid_request':
      return 'The provider rejected the request as invalid.';
    case 'server':
      return 'The provider returned a server error.';
    case 'network':
      return 'The upstream could not be reached.';
    default:
      return 'OK';
  }
}
