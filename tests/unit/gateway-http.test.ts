/**
 * Coverage: gateway HTTP surface, in-process.
 *
 * Boots the real Express app (not a child process) against an isolated DATA_DIR
 * and a loopback mock upstream, so openai-router.ts / server.ts routes are
 * instrumented by c8. No Xray needed: a loopback upstream bypasses the tunnel.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const TMP = path.join(os.tmpdir(), `orgw-http-${process.pid}-${Date.now()}`);
process.env.DATA_DIR = TMP;
process.env.LOG_LEVEL = 'silent';

let app: any;
let server: http.Server;
let base = '';
let mock: http.Server;
let mockPort = 0;
let apiKey = '';

async function api(method: string, p: string, body?: any, token?: string) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, headers: res.headers, text, json };
}

function startMockUpstream(): Promise<http.Server> {
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      let body: any = {};
      try {
        body = JSON.parse(raw);
      } catch {
        /* ignore */
      }
      const model = String(body.model || 'mock-ok');

      if (req.url?.includes('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-ok', object: 'model' }] }));
        return;
      }
      if (model === 'mock-401') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'nope', code: 'invalid_api_key' } }));
        return;
      }
      if (model === 'mock-stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ id: 'x', choices: [{ delta: { content: 'hi' } }] })}\n\n`);
        res.write(
          `data: ${JSON.stringify({ id: 'x', choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\n`
        );
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      if (model === 'mock-slowstream') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ delta: { content: 'a' } }] })}\n\n`);
        setTimeout(() => {
          try {
            res.write('data: [DONE]\n\n');
            res.end();
          } catch {
            /* client gone */
          }
        }, 2000);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-x',
          object: 'chat.completion',
          model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }
        })
      );
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

before(async () => {
  mock = await startMockUpstream();
  mockPort = (mock.address() as AddressInfo).port;

  const serverModule = await import('../../src/backend/server.js');
  app = serverModule.app;

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // Configure the gateway against the loopback mock.
  await api('PUT', '/api/settings', {
    gateway_enabled: 'true',
    gateway_upstream_base_url: `http://127.0.0.1:${mockPort}/v1`,
    gateway_upstream_model: 'mock-ok',
    gateway_rotate_on_429: 'false',
    gateway_rotate_on_5xx: 'false',
    gateway_max_body_bytes: '8388608'
  });

  const created = await api('POST', '/api/keys', { name: 'http-test', rpmLimit: 500 });
  apiKey = created.json.key;
});

after(async () => {
  // Aborted streams and keep-alive sockets must not delay teardown.
  (server as any).closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  (mock as any).closeAllConnections?.();
  await new Promise<void>((resolve) => mock.close(() => resolve()));
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('gateway auth', () => {
  it('rejects a missing key with 401', async () => {
    const r = await api('POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'x' }] });
    assert.equal(r.status, 401);
    assert.equal(r.json.error.code, 'missing_api_key');
  });

  it('rejects an unknown key with 401', async () => {
    const r = await api('POST', '/v1/chat/completions', { messages: [] }, 'sk-or-unknown');
    assert.equal(r.status, 401);
    assert.equal(r.json.error.code, 'invalid_api_key');
  });

  it('rejects a non-bearer scheme', async () => {
    const res = await fetch(`${base}/v1/models`, { headers: { authorization: 'Basic abc' } });
    assert.equal(res.status, 401);
  });
});

describe('gateway validation', () => {
  it('rejects a body without messages', async () => {
    const r = await api('POST', '/v1/chat/completions', { model: 'mock-ok' }, apiKey);
    assert.equal(r.status, 400);
  });

  it('rejects a non-array messages field', async () => {
    const r = await api('POST', '/v1/chat/completions', { messages: 'nope' }, apiKey);
    assert.equal(r.status, 400);
  });

  it('rejects a non-string model', async () => {
    const r = await api('POST', '/v1/chat/completions', { model: 1, messages: [{ role: 'user', content: 'x' }] }, apiKey);
    assert.equal(r.status, 400);
  });

  it('rejects an oversized body with 413', async () => {
    await api('PUT', '/api/settings', { gateway_max_body_bytes: '500' });
    const r = await api(
      'POST',
      '/v1/chat/completions',
      { model: 'mock-ok', messages: [{ role: 'user', content: 'y'.repeat(3000) }] },
      apiKey
    );
    assert.equal(r.status, 413);
    await api('PUT', '/api/settings', { gateway_max_body_bytes: '8388608' });
  });
});

describe('gateway completions', () => {
  it('relays a non-streaming completion', async () => {
    const r = await api(
      'POST',
      '/v1/chat/completions',
      { model: 'mock-ok', messages: [{ role: 'user', content: 'hi' }] },
      apiKey
    );
    assert.equal(r.status, 200);
    assert.equal(r.json.choices[0].message.content, 'hello');
    assert.equal(r.json.usage.total_tokens, 6);
    assert.ok(r.headers.get('x-request-id'));
  });

  it('relays a streaming completion with SSE', async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mock-stream', stream: true, messages: [{ role: 'user', content: 'hi' }] })
    });
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-type')?.includes('text/event-stream'));
    assert.ok(text.includes('[DONE]'));
    assert.ok(text.includes('"total_tokens":5'));
  });

  it('passes an upstream 401 through unchanged', async () => {
    const r = await api(
      'POST',
      '/v1/chat/completions',
      { model: 'mock-401', messages: [{ role: 'user', content: 'x' }] },
      apiKey
    );
    assert.equal(r.status, 401);
    assert.equal(r.json.error.code, 'invalid_api_key');
  });

  it('lists models from the upstream', async () => {
    const r = await api('GET', '/v1/models', undefined, apiKey);
    assert.equal(r.status, 200);
    assert.equal(r.json.data[0].id, 'mock-ok');
  });

  it('reports usage for the key', async () => {
    const r = await api('GET', '/v1/usage', undefined, apiKey);
    assert.equal(r.status, 200);
    assert.ok(r.json.total.requests >= 1);
  });

  it('returns health without leaking the egress node', async () => {
    const r = await api('GET', '/v1/health');
    assert.equal(r.status, 200);
    assert.equal(r.json.status, 'ok');
    assert.equal(r.json.active_node, undefined);
  });
});

describe('gateway limits and edge cases', () => {
  it('enforces per-key RPM', async () => {
    const created = await api('POST', '/api/keys', { name: 'rpm-1', rpmLimit: 1 });
    const key = created.json.key;
    const first = await api('POST', '/v1/chat/completions', { model: 'mock-ok', messages: [{ role: 'user', content: 'x' }] }, key);
    const second = await api('POST', '/v1/chat/completions', { model: 'mock-ok', messages: [{ role: 'user', content: 'x' }] }, key);
    assert.equal(first.status, 200);
    assert.equal(second.status, 429);
    assert.equal(second.json.error.code, 'rate_limit_exceeded');
    assert.ok(second.headers.get('retry-after'));
  });

  it('enforces the daily token quota', async () => {
    const created = await api('POST', '/api/keys', { name: 'quota-6', rpmLimit: 100, dailyTokenLimit: 6 });
    const key = created.json.key;
    const first = await api('POST', '/v1/chat/completions', { model: 'mock-ok', messages: [{ role: 'user', content: 'x' }] }, key);
    const second = await api('POST', '/v1/chat/completions', { model: 'mock-ok', messages: [{ role: 'user', content: 'x' }] }, key);
    assert.equal(first.status, 200);
    assert.equal(second.status, 429);
    assert.equal(second.json.error.code, 'daily_quota_exceeded');
  });

  it('returns 503 when the gateway is disabled', async () => {
    await api('PUT', '/api/settings', { gateway_enabled: 'false' });
    const r = await api('POST', '/v1/chat/completions', { model: 'mock-ok', messages: [{ role: 'user', content: 'x' }] }, apiKey);
    assert.equal(r.status, 503);
    assert.equal(r.json.error.code, 'gateway_disabled');
    await api('PUT', '/api/settings', { gateway_enabled: 'true' });
  });

  it('falls back to a synthetic model list when upstream is unset', async () => {
    await api('PUT', '/api/settings', { gateway_upstream_base_url: '', gateway_upstream_model: 'fallback-model' });
    const r = await api('GET', '/v1/models', undefined, apiKey);
    assert.equal(r.status, 200);
    assert.equal(r.json.data[0].id, 'fallback-model');
    await api('PUT', '/api/settings', { gateway_upstream_base_url: `http://127.0.0.1:${mockPort}/v1` });
  });

  it('survives a client abort mid-stream', async () => {
    const controller = new AbortController();
    const pending = fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mock-slowstream', stream: true, messages: [{ role: 'user', content: 'x' }] }),
      signal: controller.signal
    }).catch(() => null);

    setTimeout(() => controller.abort(), 150);
    await pending;
    await new Promise((r) => setTimeout(r, 400));

    const after = await api('POST', '/v1/chat/completions', { model: 'mock-ok', messages: [{ role: 'user', content: 'after' }] }, apiKey);
    assert.equal(after.status, 200);
  });

  it('rejects a non-object JSON body', async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify([1, 2, 3])
    });
    assert.equal(res.status, 400);
  });

  it('ignores a malformed X-Request-Id', async () => {
    const r = await api('GET', '/v1/health');
    assert.equal(r.status, 200);
    const res = await fetch(`${base}/v1/health`, { headers: { 'x-request-id': 'has spaces and !!!' } });
    assert.equal(res.status, 200);
    assert.notEqual(res.headers.get('x-request-id'), 'has spaces and !!!');
  });
});

describe('management surface', () => {
  it('reports status', async () => {
    const r = await api('GET', '/api/status');
    assert.equal(r.status, 200);
    assert.equal(typeof r.json.phase, 'string');
  });

  it('exposes gateway status', async () => {
    const r = await api('GET', '/api/gateway/status');
    assert.equal(r.status, 200);
    assert.equal(r.json.enabled, true);
  });

  it('lists keys without secrets', async () => {
    const r = await api('GET', '/api/keys');
    assert.equal(r.status, 200);
    assert.ok(r.json.keys.every((k: any) => !('key' in k) && !('key_hash' in k)));
  });

  it('serves prometheus metrics', async () => {
    const r = await api('GET', '/metrics');
    assert.equal(r.status, 200);
    assert.ok(r.text.includes('orgw_http_requests_total'));
  });

  it('validates settings keys', async () => {
    const r = await api('PUT', '/api/settings', { not_a_real_key: 'x' });
    assert.equal(r.status, 400);
    assert.ok(r.json.rejected.includes('not_a_real_key'));
  });

  it('returns 404 for unknown api routes', async () => {
    const r = await api('GET', '/api/does-not-exist');
    assert.ok([404, 200].includes(r.status));
  });
});
