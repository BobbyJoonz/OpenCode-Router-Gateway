import type { NextFunction, Request, Response } from 'express';
import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client';
import { lifecycle } from '../lifecycle';

/**
 * Prometheus metrics.
 *
 * Labels are deliberately low-cardinality: route templates (never raw paths),
 * HTTP status codes, and node/provider ids.
 */
export const registry = new Registry();

collectDefaultMetrics({ register: registry, prefix: 'orgw_' });

export const httpRequests = new Counter({
  name: 'orgw_http_requests_total',
  help: 'HTTP requests by method, route template and status',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry]
});

export const httpDuration = new Histogram({
  name: 'orgw_http_request_duration_seconds',
  help: 'HTTP request latency',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [registry]
});

export const inflightRequests = new Gauge({
  name: 'orgw_inflight_requests',
  help: 'Requests currently being served',
  registers: [registry]
});

export const egressRotations = new Counter({
  name: 'orgw_egress_rotations_total',
  help: 'Egress node rotations triggered by the gateway',
  registers: [registry]
});

export const upstreamRateLimits = new Counter({
  name: 'orgw_upstream_rate_limits_total',
  help: 'Upstream HTTP 429 responses',
  registers: [registry]
});

export const gatewayRequests = new Counter({
  name: 'orgw_gateway_requests_total',
  help: 'Gateway completions by outcome',
  labelNames: ['outcome', 'stream'] as const,
  registers: [registry]
});

export const tokensTotal = new Counter({
  name: 'orgw_tokens_total',
  help: 'Tokens accounted per kind',
  labelNames: ['kind'] as const,
  registers: [registry]
});

export const nodeHealthScore = new Gauge({
  name: 'orgw_node_health_score',
  help: 'EWMA health score per egress node',
  labelNames: ['node_id'] as const,
  registers: [registry]
});

export const prescreenRunning = new Gauge({
  name: 'orgw_prescreen_running',
  help: '1 while a bulk pre-screen is running',
  registers: [registry]
});

export const healthMonitorChecking = new Gauge({
  name: 'orgw_health_check_running',
  help: '1 while a health check batch is running',
  registers: [registry]
});

function routeLabel(req: Request): string {
  const route = (req as any).route?.path as string | undefined;
  const base = req.baseUrl || '';
  if (!route) return 'unmatched';
  return `${base}${route}`.replace(/\/+$/, '') || '/';
}

export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  inflightRequests.inc();
  let done = false;

  const finish = () => {
    if (done) return;
    done = true;
    inflightRequests.dec();

    const route = routeLabel(req);
    const status = String(res.statusCode);
    const startedAt = (res as any).__startedAt || Date.now();
    httpRequests.inc({ method: req.method, route, status });
    httpDuration.observe({ method: req.method, route, status }, Math.max(0, Date.now() - startedAt) / 1000);
  };

  (res as any).__startedAt = Date.now();
  res.once('finish', finish);
  res.once('close', finish);
  next();
}

export async function metricsHandler(_req: Request, res: Response): Promise<void> {
  res.setHeader('Content-Type', registry.contentType);
  res.end(await registry.metrics());
}

/** Refresh point-in-time gauges before a scrape. */
export function refreshGauges(): void {
  inflightRequests.set(lifecycle.getInFlight());
}
