export type ErrorCategory =
  | 'SUCCESS'
  | 'RATE_LIMIT'
  | 'AUTH_ERROR'
  | 'NETWORK_ERROR'
  | 'CONFIG_ERROR'
  | 'UNKNOWN';

export interface ClassificationResult {
  category: ErrorCategory;
  isRecoverableBySwitchingVpn: boolean;
  userMessage: string;
  rawDetails?: string;
}

export class ErrorClassifier {
  public static classify(exitCode: number | null, stdout: string, stderr: string): ClassificationResult {
    const combined = `${stdout}\n${stderr}`.toLowerCase();

    // Check for success
    if (
      exitCode === 0 &&
      (combined.includes('connection_ok') ||
        combined.includes('"type":"text"') ||
        combined.includes('step_finish') ||
        combined.includes('session.created') && !combined.includes('error'))
    ) {
      return {
        category: 'SUCCESS',
        isRecoverableBySwitchingVpn: false,
        userMessage: 'OpenCode session established successfully.'
      };
    }

    // Check for Provider Rate Limits
    if (
      combined.includes('free usage limit reached') ||
      combined.includes('rate limit') ||
      combined.includes('http 429') ||
      combined.includes('too many requests') ||
      combined.includes('quota exceeded') ||
      combined.includes('resource has been exhausted')
    ) {
      const isFreeModelLimit = combined.includes('free usage limit reached') || combined.includes('free models work in opencode');
      return {
        category: 'RATE_LIMIT',
        isRecoverableBySwitchingVpn: isFreeModelLimit, // Free model limit is often IP-tied in OpenCode
        userMessage: isFreeModelLimit
          ? 'OpenCode free usage limit reached for this IP. Rotating VPN endpoint may provide fresh quota.'
          : 'Provider account rate limit reached (HTTP 429). Rotating VPN will not bypass account-level quota.'
      };
    }

    // Check for Authentication / Account Errors
    if (
      combined.includes('unauthorized') ||
      combined.includes('http 401') ||
      combined.includes('http 403') ||
      combined.includes('forbidden') ||
      combined.includes('invalid api key') ||
      combined.includes('authentication failed') ||
      combined.includes('0 credentials') && combined.includes('auth error')
    ) {
      return {
        category: 'AUTH_ERROR',
        isRecoverableBySwitchingVpn: false,
        userMessage: 'Authentication error detected in OpenCode credentials. This is not a VPN connectivity issue.'
      };
    }

    // Check for Network Errors
    if (
      combined.includes('econnrefused') ||
      combined.includes('etimedout') ||
      combined.includes('enotfound') ||
      combined.includes('socket hang up') ||
      combined.includes('network timeout') ||
      combined.includes('failed to fetch') ||
      combined.includes('proxy error') ||
      combined.includes('connection refused') ||
      combined.includes('handshake failed') ||
      combined.includes('timed out') ||
      exitCode === 124 // timeout command exit code
    ) {
      return {
        category: 'NETWORK_ERROR',
        isRecoverableBySwitchingVpn: true,
        userMessage: 'Network connection failed or timed out through proxy endpoint.'
      };
    }

    // Configuration errors
    if (combined.includes('model not found') || combined.includes('invalid config') || combined.includes('syntaxerror')) {
      return {
        category: 'CONFIG_ERROR',
        isRecoverableBySwitchingVpn: false,
        userMessage: 'OpenCode configuration or model name error.'
      };
    }

    // Generic non-zero exit fallback
    if (exitCode !== 0) {
      return {
        category: 'NETWORK_ERROR',
        isRecoverableBySwitchingVpn: true,
        userMessage: `OpenCode exited with code ${exitCode}. Probable connection failure.`
      };
    }

    return {
      category: 'UNKNOWN',
      isRecoverableBySwitchingVpn: false,
      userMessage: 'Unrecognized response state.'
    };
  }
}
