/**
 * End-to-end integration tests for the gateway edition.
 *
 * Runs against a live server (default http://127.0.0.1:3001) and a local mock
 * upstream, so it exercises the real HTTP path: auth -> validation -> upstream
 * forwarding -> streaming -> usage accounting.
 *
 * Usage:
 *   PORT=3001 npx tsx src/backend/server.ts     # terminal 1
 *   npx tsx tests/gateway-tests.ts              # terminal 2
 */
import http from 'http';

const GW = process.env.GATEWAY_URL || 'http://127.0.0.1:3001';
const MOCK_PORT = parseInt(process.env.MOCK_PORT || '19099', 10);

let pass = 0;
let fail = 0;
const failures: string[] = [];

function section(title: string): void {
  console.log(`\n▶ ${title}`);
}

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`  ✔ ${name}`);
  } else {
    fail++;
    failures.push(name + (detail ? ` — ${detail}` : ''));
    console.log(`  ✘ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function req(
  path: string,
  opts: { method?: string; token?: string; body?: any; signal?: AbortSignal; headers?: Record<string, string> } = {}
): Promise<{ status: number; headers: Headers; text: string; json: any }> {
  const headers: Record<string, string> = { ...(opts.headers || {}) };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';

  const res = await fetch(`${GW}${path}`, {
    method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal
  });

  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, headers: res.headers, text, json };
}

function startMockUpstream(): Promise<http.Server> {
  const server = http.createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
    });
    request.on('end', () => {
      let body: any = {};
      try {
        body = JSON.parse(raw);
      } catch {
        /* ignore */
      }
      const model = String(body.model || 'mock-ok');

      if (request.url?.includes('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-ok', object: 'model' }] }));
        return;
      }

      if (model === 'mock-401') {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'bad key', type: 'auth_error', code: 'invalid_api_key' } }));
        return;
      }
      if (model === 'mock-400') {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'bad request', type: 'invalid_request_error', code: 'bad' } }));
        return;
      }
      if (model === 'mock-429') {
        response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
        response.end(
          JSON.stringify({ error: { message: 'rate limited', type: 'rate_limit_error', code: 'rate_limit' } })
        );
        return;
      }
      if (model === 'mock-500') {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'boom', type: 'server_error', code: 'internal' } }));
        return;
      }

      if (model === 'mock-stream' || model === 'mock-slowstream') {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const chunk = (obj: any) => response.write(`data: ${JSON.stringify(obj)}\n\n`);
        chunk({ id: 'mock', object: 'chat.completion.chunk', choices: [{ delta: { content: 'Hel' } }] });
        chunk({ id: 'mock', object: 'chat.completion.chunk', choices: [{ delta: { content: 'lo' } }] });
        const finish = () => {
          chunk({ id: 'mock', object: 'chat.completion.chunk', choices: [{ delta: {}, finish_reason: 'stop' }] });
          chunk({
            id: 'mock',
            object: 'chat.completion.chunk',
            choices: [],
            usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }
          });
          response.write('data: [DONE]\n\n');
          response.end();
        };
        if (model === 'mock-slowstream') setTimeout(finish, 2000);
        else setTimeout(finish, 30);
        return;
      }

      if (model === 'mock-slow') {
        setTimeout(() => {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              id: 'mock',
              object: 'chat.completion',
              model,
              choices: [{ index: 0, message: { role: 'assistant', content: 'slow ok' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }
            })
          );
        }, 3000);
        return;
      }

      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          id: 'chatcmpl-mock',
          object: 'chat.completion',
          model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'Hello from mock' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }
        })
      );
    });
  });

  return new Promise((resolve) => server.listen(MOCK_PORT, '127.0.0.1', () => resolve(server)));
}

async function waitForGateway(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`${GW}/v1/health`);
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Gateway not reachable at ${GW}`);
}

async function main(): Promise<void> {
  const mock = await startMockUpstream();
  console.log(`mock upstream on http://127.0.0.1:${MOCK_PORT}/v1`);
  await waitForGateway();

  // ------------------------------------------------------------------ setup
  section('Setup');
  const settings = await req('/api/settings', {
    method: 'PUT',
    body: {
      gateway_enabled: 'true',
      gateway_upstream_base_url: `http://127.0.0.1:${MOCK_PORT}/v1`,
      gateway_upstream_model: 'mock-ok',
      gateway_upstream_timeout_seconds: '15',
      gateway_max_body_bytes: '8388608',
      gateway_rotate_on_429: 'false', // keep the retry test fast & deterministic
      gateway_rotate_on_5xx: 'false'
    }
  });
  check('gateway settings applied', settings.status === 200, `status ${settings.status}`);

  const keyRes = await req('/api/keys', { method: 'POST', body: { name: 'it-main', rpmLimit: 500 } });
  check('API key created', keyRes.status === 200 && typeof keyRes.json?.key === 'string');
  const KEY = keyRes.json?.key as string;

  const slowKey = await req('/api/keys', { method: 'POST', body: { name: 'it-rpm', rpmLimit: 1 } });
  const RPM_KEY = slowKey.json?.key as string;

  const quotaKey = await req('/api/keys', {
    method: 'POST',
    body: { name: 'it-quota', rpmLimit: 500, dailyTokenLimit: 5 }
  });
  const QUOTA_KEY = quotaKey.json?.key as string;

  const toggleKey = await req('/api/keys', { method: 'POST', body: { name: 'it-toggle', rpmLimit: 500 } });
  const TOGGLE_KEY = toggleKey.json?.key as string;
  const TOGGLE_ID = toggleKey.json?.id as number;

  // ------------------------------------------------------------------ auth
  section('Authentication');
  const noAuth = await req('/v1/chat/completions', {
    method: 'POST',
    body: { model: 'mock-ok', messages: [{ role: 'user', content: 'hi' }] }
  });
  check('missing token -> 401', noAuth.status === 401, `status ${noAuth.status}`);
  check('missing token error code', noAuth.json?.error?.code === 'missing_api_key', JSON.stringify(noAuth.json?.error));

  const badAuth = await req('/v1/chat/completions', {
    method: 'POST',
    token: 'sk-or-not-a-real-key',
    body: { model: 'mock-ok', messages: [{ role: 'user', content: 'hi' }] }
  });
  check('invalid token -> 401', badAuth.status === 401, `status ${badAuth.status}`);
  check('invalid token error code', badAuth.json?.error?.code === 'invalid_api_key');

  const wrongScheme = await req('/v1/models', { headers: { authorization: `Basic ${KEY}` } });
  check('non-bearer scheme -> 401', wrongScheme.status === 401, `status ${wrongScheme.status}`);

  await req(`/api/keys/${TOGGLE_ID}`, { method: 'PATCH', body: { enabled: false } });
  const disabled = await req('/v1/chat/completions', {
    method: 'POST',
    token: TOGGLE_KEY,
    body: { model: 'mock-ok', messages: [{ role: 'user', content: 'hi' }] }
  });
  check('disabled key -> 401 (no key enumeration)', disabled.status === 401, `status ${disabled.status}`);
  await req(`/api/keys/${TOGGLE_ID}`, { method: 'PATCH', body: { enabled: true } });

  // ------------------------------------------------------------- validation
  section('Request validation');
  const noMessages = await req('/v1/chat/completions', { method: 'POST', token: KEY, body: { model: 'mock-ok' } });
  check('missing messages -> 400', noMessages.status === 400, `status ${noMessages.status}`);

  const badMessages = await req('/v1/chat/completions', {
    method: 'POST',
    token: KEY,
    body: { model: 'mock-ok', messages: 'nope' }
  });
  check('messages not array -> 400', badMessages.status === 400, `status ${badMessages.status}`);

  const emptyMessages = await req('/v1/chat/completions', {
    method: 'POST',
    token: KEY,
    body: { model: 'mock-ok', messages: [] }
  });
  check('empty messages -> 400', emptyMessages.status === 400, `status ${emptyMessages.status}`);

  const badModel = await req('/v1/chat/completions', {
    method: 'POST',
    token: KEY,
    body: { model: 42, messages: [{ role: 'user', content: 'x' }] }
  });
  check('non-string model -> 400', badModel.status === 400, `status ${badModel.status}`);

  await req('/api/settings', { method: 'PUT', body: { gateway_max_body_bytes: '600' } });
  const tooBig = await req('/v1/chat/completions', {
    method: 'POST',
    token: KEY,
    body: { model: 'mock-ok', messages: [{ role: 'user', content: 'x'.repeat(2000) }] }
  });
  check('oversized body -> 413', tooBig.status === 413, `status ${tooBig.status}`);
  await req('/api/settings', { method: 'PUT', body: { gateway_max_body_bytes: '8388608' } });

  // ------------------------------------------------------------- happy path
  section('Model listing');
  const models = await req('/v1/models', { token: KEY });
  check('models endpoint 200', models.status === 200, `status ${models.status}`);
  check(
    'models list proxied from upstream',
    Array.isArray(models.json?.data),
    JSON.stringify(models.json).slice(0, 120)
  );
  check(
    'models contains the mock model',
    (models.json?.data || []).some((m: any) => m.id === 'mock-ok')
  );

  section('Non-streaming completion');
  const ok = await req('/v1/chat/completions', {
    method: 'POST',
    token: KEY,
    body: { model: 'mock-ok', messages: [{ role: 'user', content: 'hello' }] }
  });
  check('200 OK', ok.status === 200, `status ${ok.status}`);
  check('assistant content relayed', ok.json?.choices?.[0]?.message?.content === 'Hello from mock');
  check('usage relayed', ok.json?.usage?.total_tokens === 8);

  section('Streaming completion');
  const streamRes = await fetch(`${GW}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'mock-stream', stream: true, messages: [{ role: 'user', content: 'hi' }] })
  });
  const streamText = await streamRes.text();
  check('stream status 200', streamRes.status === 200, `status ${streamRes.status}`);
  check('SSE content type', (streamRes.headers.get('content-type') || '').includes('text/event-stream'));
  check('stream contains data chunks', streamText.includes('data: {'));
  check('stream terminates with [DONE]', streamText.includes('[DONE]'));
  check('stream carries usage', streamText.includes('"total_tokens":18'));

  // ----------------------------------------------------------------- errors
  section('Upstream error mapping');
  const e401 = await req('/v1/chat/completions', {
    method: 'POST',
    token: KEY,
    body: { model: 'mock-401', messages: [{ role: 'user', content: 'x' }] }
  });
  check('401 passes through unchanged', e401.status === 401, `status ${e401.status}`);
  check('401 body preserved', e401.json?.error?.code === 'invalid_api_key');

  const e400 = await req('/v1/chat/completions', {
    method: 'POST',
    token: KEY,
    body: { model: 'mock-400', messages: [{ role: 'user', content: 'x' }] }
  });
  check('400 passes through unchanged', e400.status === 400, `status ${e400.status}`);

  const e500 = await req('/v1/chat/completions', {
    method: 'POST',
    token: KEY,
    body: { model: 'mock-500', messages: [{ role: 'user', content: 'x' }] }
  });
  check('500 passes through when rotation disabled', e500.status === 500, `status ${e500.status}`);

  const e429 = await req('/v1/chat/completions', {
    method: 'POST',
    token: KEY,
    body: { model: 'mock-429', messages: [{ role: 'user', content: 'x' }] }
  });
  check('429 passes through when rotation disabled', e429.status === 429, `status ${e429.status}`);

  section('Upstream timeout');
  await req('/api/settings', { method: 'PUT', body: { gateway_upstream_timeout_seconds: '1' } });
  const slow = await req('/v1/chat/completions', {
    method: 'POST',
    token: KEY,
    body: { model: 'mock-slow', messages: [{ role: 'user', content: 'x' }] }
  });
  check('slow upstream -> 502', slow.status === 502, `status ${slow.status}`);
  check('timeout error code', slow.json?.error?.code === 'upstream_unreachable', JSON.stringify(slow.json?.error));
  await req('/api/settings', { method: 'PUT', body: { gateway_upstream_timeout_seconds: '15' } });

  // ------------------------------------------------------------- rate limit
  section('Rate limiting');
  const r1 = await req('/v1/chat/completions', {
    method: 'POST',
    token: RPM_KEY,
    body: { model: 'mock-ok', messages: [{ role: 'user', content: 'x' }] }
  });
  const r2 = await req('/v1/chat/completions', {
    method: 'POST',
    token: RPM_KEY,
    body: { model: 'mock-ok', messages: [{ role: 'user', content: 'x' }] }
  });
  check('first request allowed', r1.status === 200, `status ${r1.status}`);
  check('second request rate limited', r2.status === 429, `status ${r2.status}`);
  check('Retry-After present', !!r2.headers.get('retry-after'));

  // ------------------------------------------------------------ daily quota
  section('Daily token quota');
  const q1 = await req('/v1/chat/completions', {
    method: 'POST',
    token: QUOTA_KEY,
    body: { model: 'mock-ok', messages: [{ role: 'user', content: 'x' }] }
  });
  const q2 = await req('/v1/chat/completions', {
    method: 'POST',
    token: QUOTA_KEY,
    body: { model: 'mock-ok', messages: [{ role: 'user', content: 'x' }] }
  });
  check('quota key first call allowed', q1.status === 200, `status ${q1.status}`);
  check('quota exceeded -> 429', q2.status === 429, `status ${q2.status}`);
  check('quota error code', q2.json?.error?.code === 'daily_quota_exceeded', JSON.stringify(q2.json?.error));

  // ------------------------------------------------------------------ usage
  section('Usage accounting');
  const usage = await req('/v1/usage', { token: KEY });
  check('usage endpoint works', usage.status === 200, `status ${usage.status}`);
  check('usage counts requests', (usage.json?.total?.requests || 0) >= 1, JSON.stringify(usage.json?.total));
  check('usage counts tokens', (usage.json?.total?.total_tokens || 0) >= 8, JSON.stringify(usage.json?.total));

  // ------------------------------------------------------------ client abort
  section('Client abort mid-stream');
  const controller = new AbortController();
  const abortPromise = fetch(`${GW}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'mock-slowstream', stream: true, messages: [{ role: 'user', content: 'x' }] }),
    signal: controller.signal
  }).catch(() => null);

  setTimeout(() => controller.abort(), 400);
  await abortPromise;
  await new Promise((r) => setTimeout(r, 600));
  const afterAbort = await req('/v1/chat/completions', {
    method: 'POST',
    token: KEY,
    body: { model: 'mock-ok', messages: [{ role: 'user', content: 'after abort' }] }
  });
  check('server survives client abort', afterAbort.status === 200, `status ${afterAbort.status}`);

  // --------------------------------------------------------------- prescreen
  section('Bulk pre-screen');
  const prescreen = await req('/api/configs/prescreen', {
    method: 'POST',
    body: { limit: 60, concurrency: 30, timeoutMs: 800 }
  });
  check('prescreen accepted', prescreen.status === 200, `status ${prescreen.status}`);

  const duplicate = await req('/api/configs/prescreen', { method: 'POST', body: { limit: 10 } });
  check('concurrent prescreen rejected -> 409', duplicate.status === 409, `status ${duplicate.status}`);

  let prescreenDone = false;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const status = await req('/api/prescreen/status');
    if (
      status.json?.progress?.running === false &&
      (status.json?.runs?.[0]?.status === 'done' || status.json?.runs?.[0]?.status === 'aborted')
    ) {
      prescreenDone = true;
      break;
    }
  }
  check('prescreen finished', prescreenDone);

  const statusAfter = await req('/api/prescreen/status');
  const lastRun = statusAfter.json?.runs?.[0];
  check('prescreen recorded totals', (lastRun?.total || 0) > 0, JSON.stringify(lastRun));
  check('prescreen marked some nodes alive', (lastRun?.alive || 0) >= 0);

  const screenedConfigs = await req('/api/configs?limit=60');
  const screenedRows = (screenedConfigs.json?.items || []).filter(
    (c: any) => c.tcp_alive !== null && c.tcp_alive !== undefined
  );
  check('prescreen persisted tcp_alive on configs', screenedRows.length > 0, `${screenedRows.length} rows`);

  // ----------------------------------------------------------------- health
  section('Health monitor');
  const healthStatus = await req('/api/nodes/health');
  check('health endpoint works', healthStatus.status === 200);
  check('monitor status exposed', typeof healthStatus.json?.monitor?.enabled === 'boolean');

  const checkNow = await req('/api/health/check-now', { method: 'POST', body: { batch: 1 } });
  check(
    'health check-now runs (or refuses concurrent)',
    checkNow.status === 200 || checkNow.status === 409,
    `status ${checkNow.status}`
  );

  // ------------------------------------------------------------ egress path
  section('Egress path (proof that traffic really goes through Xray)');
  await req('/api/settings', { method: 'PUT', body: { gateway_upstream_bypass_proxy_loopback: 'false' } });
  const forcedThroughProxy = await req('/v1/chat/completions', {
    method: 'POST',
    token: KEY,
    body: { model: 'mock-ok', messages: [{ role: 'user', content: 'x' }] }
  });
  check(
    'loopback upstream is unreachable when forced through the proxy',
    forcedThroughProxy.status === 502 || forcedThroughProxy.status === 503,
    `status ${forcedThroughProxy.status}`
  );

  await req('/api/settings', { method: 'PUT', body: { gateway_upstream_bypass_proxy_loopback: 'true' } });
  const bypassRestored = await req('/v1/chat/completions', {
    method: 'POST',
    token: KEY,
    body: { model: 'mock-ok', messages: [{ role: 'user', content: 'x' }] }
  });
  check('loopback bypass restores connectivity', bypassRestored.status === 200, `status ${bypassRestored.status}`);

  // --------------------------------------------------------------- cleanup
  section('Cleanup');
  const keys = await req('/api/keys');
  const created = (keys.json?.keys || []).filter((k: any) => String(k.name).startsWith('it-'));
  for (const k of created) {
    await req(`/api/keys/${k.id}`, { method: 'DELETE' });
  }
  const afterCleanup = await req('/api/keys');
  const leftover = (afterCleanup.json?.keys || []).filter((k: any) => String(k.name).startsWith('it-'));
  check('test keys revoked', leftover.length === 0, `${leftover.length} left`);

  await req('/api/settings', { method: 'PUT', body: { gateway_enabled: 'false' } });

  mock.close();

  console.log('\n==================================================');
  console.log(`  PASSED: ${pass}    FAILED: ${fail}`);
  if (fail > 0) {
    console.log('\n  Failures:');
    for (const f of failures) console.log(`   - ${f}`);
  }
  console.log('==================================================');

  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nFATAL:', err);
  process.exit(1);
});
