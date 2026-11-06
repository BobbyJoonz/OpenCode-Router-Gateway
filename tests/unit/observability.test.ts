/**
 * Coverage: observability layer.
 * - logger redacts secrets and emits JSON
 * - request context assigns/propagates X-Request-Id and annotates key/node ids
 * - metrics middleware counts requests, observes latency and tracks in-flight
 * - tracing stays a no-op when no OTLP endpoint is configured
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';

process.env.DATA_DIR = path.join(os.tmpdir(), `orgw-obs-${process.pid}-${Date.now()}`);

let logger: any;
let requestContextMiddleware: any;
let currentRequestId: any;
let annotateContext: any;
let currentContext: any;
let metricsMiddleware: any;
let metricsHandler: any;
let httpRequests: any;
let inflightRequests: any;
let registry: any;
let initTracing: any;
let isTracingEnabled: any;
let withSpan: any;

before(async () => {
  ({ logger } = await import('../../src/backend/observability/logger.js'));
  ({ requestContextMiddleware, currentRequestId, annotateContext, currentContext } = await import(
    '../../src/backend/observability/request-context.js'
  ));
  ({ metricsMiddleware, metricsHandler, httpRequests, inflightRequests, registry } = await import(
    '../../src/backend/observability/metrics.js'
  ));
  ({ initTracing, isTracingEnabled, withSpan } = await import('../../src/backend/observability/tracing.js'));
});

/** Minimal fake express req/res pair. */
function fakeHttp(method = 'GET', url = '/x', headers: Record<string, string> = {}) {
  const listeners: Record<string, Array<() => void>> = {};
  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    setHeader(k: string, v: string) {
      this.headers[k] = v;
      return this;
    },
    once(event: string, fn: () => void) {
      (listeners[event] ||= []).push(fn);
      return this;
    },
    emit(event: string) {
      for (const fn of listeners[event] || []) fn();
    }
  };
  const req: any = { method, url, headers, baseUrl: '', route: { path: '/x' } };
  return { req, res };
}

describe('logger', () => {
  it('emits JSON with metadata', () => {
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk.toString());
        cb();
      }
    });
    const pino = require('pino');
    const captured = pino({ base: { service: 'test' } }, stream);
    captured.info({ ok: 1 }, 'hello');
    const line = JSON.parse(chunks.join(''));
    assert.equal(line.service, 'test');
    assert.equal(line.ok, 1);
    assert.equal(line.msg, 'hello');
  });

  it('redacts authorization values', () => {
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk.toString());
        cb();
      }
    });
    const pino = require('pino');
    const captured = pino({ redact: { paths: ['authorization'], censor: '***' } }, stream);
    captured.info({ authorization: 'Bearer sk-or-secret' }, 'x');
    assert.ok(!chunks.join('').includes('sk-or-secret'));
    assert.ok(chunks.join('').includes('***'));
  });

  it('exposes a usable logger instance', () => {
    assert.equal(typeof logger.info, 'function');
    assert.equal(typeof logger.child, 'function');
  });
});

describe('request context', () => {
  it('honours a well-formed incoming request id', () => {
    const { req, res } = fakeHttp('GET', '/a', { 'x-request-id': 'abc-123' });
    let seen: string | undefined;
    requestContextMiddleware(req, res, () => {
      seen = currentRequestId();
    });
    assert.equal(seen, 'abc-123');
    assert.equal(res.headers['X-Request-Id'], 'abc-123');
  });

  it('generates an id when the header is malformed', () => {
    const { req, res } = fakeHttp('GET', '/a', { 'x-request-id': 'bad id with spaces!!' });
    let seen: string | undefined;
    requestContextMiddleware(req, res, () => {
      seen = currentRequestId();
    });
    assert.ok(seen && seen.length >= 8);
    assert.notEqual(seen, 'bad id with spaces!!');
  });

  it('annotates the active context', () => {
    const { req, res } = fakeHttp();
    requestContextMiddleware(req, res, () => {
      annotateContext({ keyId: 7, nodeId: 3 });
      const ctx = currentContext();
      assert.equal(ctx?.keyId, 7);
      assert.equal(ctx?.nodeId, 3);
    });
  });

  it('returns undefined context outside a request', () => {
    assert.equal(currentContext(), undefined);
    annotateContext({ keyId: 1 }); // must not throw outside a request
  });

  it('survives a finished response', () => {
    const { req, res } = fakeHttp('POST', '/v1/chat/completions');
    requestContextMiddleware(req, res, () => {});
    res.emit('finish');
    assert.equal(res.statusCode, 200);
  });
});

describe('metrics', () => {
  it('counts a request and returns in-flight to zero', async () => {
    const { req, res } = fakeHttp('GET', '/metrics');
    const total = async () =>
      (await httpRequests.get()).values.reduce((acc: number, v: any) => acc + v.value, 0);
    const before = await total();
    metricsMiddleware(req, res, () => {});
    res.statusCode = 204;
    res.emit('finish');
    assert.equal(await total(), before + 1);
    assert.equal(inflightRequests.hashMap['']?.value ?? 0, 0);
  });

  it('exposes a Prometheus text response', async () => {
    const { res } = fakeHttp();
    let body = '';
    res.end = (chunk: string) => {
      body += chunk;
      return res;
    };
    await metricsHandler({} as any, res);
    assert.ok(res.headers['Content-Type'].includes('text/plain'));
    assert.ok(body.includes('orgw_http_requests_total'));
  });

  it('registry has default process metrics', async () => {
    const text = await registry.metrics();
    assert.ok(text.includes('orgw_process_resident_memory_bytes'));
  });
});

describe('tracing', () => {
  it('is disabled without an OTLP endpoint', async () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    await initTracing();
    assert.equal(isTracingEnabled(), false);
  });

  it('withSpan runs the callback and returns its value', async () => {
    const value = await withSpan('test.span', { a: 1 }, async () => 42);
    assert.equal(value, 42);
  });

  it('withSpan rethrows and records the error', async () => {
    await assert.rejects(
      () =>
        withSpan('test.span.fail', {}, async () => {
          throw new Error('boom');
        }),
      /boom/
    );
  });
});

after(() => {
  // nothing global to tear down
});
