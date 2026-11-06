import { AsyncLocalStorage } from 'async_hooks';
import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { logger } from './logger';

export interface RequestStore {
  requestId: string;
  startedAt: number;
  route?: string;
  keyId?: number;
  nodeId?: number;
  providerId?: number;
}

const storage = new AsyncLocalStorage<RequestStore>();

export function currentContext(): RequestStore | undefined {
  return storage.getStore();
}

export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/** Attach request/key/node ids to the active context (used by the gateway). */
export function annotateContext(patch: Partial<RequestStore>): void {
  const store = storage.getStore();
  if (!store) return;
  Object.assign(store, patch);
}

function normalizeRoute(req: Request): string {
  const route = (req as any).route?.path as string | undefined;
  const base = req.baseUrl || '';
  if (!route) return 'unmatched';
  return `${base}${route}`.replace(/\/+$/, '') || '/';
}

/**
 * Assigns (or honours) a request id, exposes it as `X-Request-Id`, and emits one
 * structured line per request with status and duration.
 */
export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers['x-request-id'];
  const requestId =
    (typeof incoming === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(incoming) ? incoming : undefined) ||
    crypto.randomUUID();

  const store: RequestStore = { requestId, startedAt: Date.now() };
  res.setHeader('X-Request-Id', requestId);

  storage.run(store, () => {
    res.once('finish', () => {
      const durationMs = Date.now() - store.startedAt;
      const route = store.route || normalizeRoute(req);
      logger.info(
        {
          event: 'http_request',
          request_id: requestId,
          method: req.method,
          route,
          status: res.statusCode,
          duration_ms: durationMs,
          key_id: store.keyId,
          node_id: store.nodeId,
          provider_id: store.providerId
        },
        'request completed'
      );
    });
    next();
  });
}
