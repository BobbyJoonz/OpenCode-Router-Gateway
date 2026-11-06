import { Request, Response, NextFunction } from 'express';
import { KeyManager } from '../gateway/key-manager';
import { AbuseDetector } from '../gateway/abuse';
import { getSetting } from '../db/database';
import { openAiError } from '../gateway/error-mapper';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * C4 — abuse guard for the model surface.
 *
 * Mounted in front of `/v1`, so it never has to modify the gateway router:
 *   1. verifies the key itself (a cheap hash lookup; the router verifies again),
 *   2. rejects badly degraded keys,
 *   3. adds a small delay for throttled keys,
 *   4. records duplicate request bodies before forwarding,
 *   5. records upstream 429s after the response finishes.
 */
export function createAbuseGuard() {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (getSetting('abuse_detection_enabled', 'true') !== 'true') {
      next();
      return;
    }

    // Only model traffic is guarded; health/models/usage keep their own limits.
    if (!req.path.startsWith('/chat/completions')) {
      next();
      return;
    }

    const verified = KeyManager.verify(req.headers.authorization as string | undefined);
    if (!verified.ok) {
      next(); // let the gateway answer 401 consistently
      return;
    }

    const keyId = verified.key.id;
    const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() || req.socket.remoteAddress || '';

    const state = AbuseDetector.check(keyId);
    if (state.reject) {
      res.setHeader('Retry-After', String(Math.ceil(state.retryAfterMs / 1000)));
      res.status(429).json(openAiError('Too many failed requests. Slow down and retry shortly.', 'rate_limit_error', 'too_many_failures'));
      return;
    }

    if (state.delayMs > 0) {
      await sleep(state.delayMs);
    }

    AbuseDetector.noteRequestHash(keyId, req.body);

    res.on('finish', () => {
      if (res.statusCode === 429) {
        AbuseDetector.record(keyId, ip, 'upstream_429', 3);
      } else if (res.statusCode === 502) {
        AbuseDetector.record(keyId, ip, 'upstream_5xx', 1);
      }
    });

    next();
  };
}
