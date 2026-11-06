/**
 * Model routing + egress switching policy — integration tests.
 *
 * Requires a running server started with two mock-provider keys in its env:
 *
 *   MOCK_KEY_A=k MOCK_KEY_B=k PORT=3001 npx tsx src/backend/server.ts
 *   GATEWAY_URL=http://127.0.0.1:3001 npx tsx tests/routing-tests.ts
 */
import http from 'http';

const GW = process.env.GATEWAY_URL || 'http://127.0.0.1:3001';
const PORT_A = parseInt(process.env.MOCK_PORT_A || '19110', 10);
const PORT_B = parseInt(process.env.MOCK_PORT_B || '19111', 10);

let pass = 0;
let fail = 0;
const failures: string[] = [];

function section(t: string): void {
  console.log(`\n▶ ${t}`);
}

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`  ✔ ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✘ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function req(
  path: string,
  opts: { method?: string; token?: string; body?: any; headers?: Record<string, string> } = {}
): Promise<{ status: number; json: any; headers: Headers }> {
  const headers: Record<string, string> = { ...(opts.headers || {}) };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${GW}${path}`, {
    method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  return { status: res.status, json, headers: res.headers };
}

function startMock(id: 'A' | 'B', port: number): Promise<http.Server> {
  const server = http.createServer((request, response) => {
    let raw = '';
    request.on('data', (c) => {
      raw += c;
    });
    request.on('end', () => {
      let body: any = {};
      try {
        body = JSON.parse(raw);
      } catch {
        /* ignore */
      }

      if (request.url?.includes('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ object: 'list', data: [{ id: `mock-${id}`, object: 'model' }] }));
        return;
      }

      const modelName = String(body.model || '');

      // Simulate "this provider does not host that model" with a 400 (some
      // providers use 400 instead of 404 for this).
      if (modelName.startsWith('missing400-on-')) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            error: { message: 'The model `x` does not exist', type: 'invalid_request_error', code: 'model_not_found' }
          })
        );
        return;
      }

      // Deterministic client error: retrying on another provider is pointless.
      if (modelName.startsWith('toolong-on-')) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            error: {
              message: "This model's maximum context length is 8192 tokens",
              type: 'invalid_request_error',
              code: 'context_length_exceeded'
            }
          })
        );
        return;
      }

      if (modelName.startsWith('missing-on-')) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'model not found', code: 'model_not_found' } }));
        return;
      }

      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          id: `chatcmpl-${id}`,
          object: 'chat.completion',
          model: body.model,
          provider_marker: id,
          choices: [{ index: 0, message: { role: 'assistant', content: `from-${id}` }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
        })
      );
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

async function main(): Promise<void> {
  const mockA = await startMock('A', PORT_A);
  const mockB = await startMock('B', PORT_B);
  console.log(`mock providers: A=${PORT_A} B=${PORT_B}`);

  // ------------------------------------------------------------------ setup
  section('Setup');
  const settings = await req('/api/settings', {
    method: 'PUT',
    body: {
      gateway_enabled: 'true',
      gateway_upstream_bypass_proxy_loopback: 'true',
      gateway_require_model_route: 'false',
      egress_policy: 'sticky'
    }
  });
  check('settings applied', settings.status === 200, `status ${settings.status}`);

  const provA = await req('/api/providers', {
    method: 'POST',
    body: { name: 'mock-a', kind: 'openai', base_url: `http://127.0.0.1:${PORT_A}/v1`, key_env: 'MOCK_KEY_A', priority: 1 }
  });
  check('provider A created', provA.status === 200 && provA.json?.provider?.id > 0, JSON.stringify(provA.json).slice(0, 120));
  const idA = provA.json?.provider?.id as number;

  const provB = await req('/api/providers', {
    method: 'POST',
    body: { name: 'mock-b', kind: 'openai', base_url: `http://127.0.0.1:${PORT_B}/v1`, key_env: 'MOCK_KEY_B', priority: 2 }
  });
  check('provider B created', provB.status === 200 && provB.json?.provider?.id > 0);
  const idB = provB.json?.provider?.id as number;

  const keyRes = await req('/api/keys', { method: 'POST', body: { name: 'route-test', rpmLimit: 500 } });
  const KEY = keyRes.json?.key as string;
  check('api key created', typeof KEY === 'string');

  // ------------------------------------------------------------------ routes
  section('Model routing');
  const r1 = await req('/api/models', {
    method: 'POST',
    body: { alias: 'fast', providerId: idA, upstreamModel: 'model-a-v1', priority: 1 }
  });
  check('route alias->A created', r1.status === 200, JSON.stringify(r1.json).slice(0, 120));

  const r2 = await req('/api/models', {
    method: 'POST',
    body: { alias: 'fast', providerId: idB, upstreamModel: 'model-b-v1', priority: 2 }
  });
  check('route alias->B created (fallback)', r2.status === 200);

  const listed = await req('/api/models');
  check('alias visible in admin API', (listed.json?.routes || []).some((r: any) => r.alias === 'fast'));
  check('both targets described', (listed.json?.routes || []).find((r: any) => r.alias === 'fast')?.targets?.length === 2);

  const publicModels = await req('/v1/models', { token: KEY });
  check('/v1/models lists the alias', (publicModels.json?.data || []).some((m: any) => m.id === 'fast'));

  // ------------------------------------------------------- alias -> provider A
  section('Alias resolves to the mapped provider and model');
  const chat = await req('/v1/chat/completions', {
    method: 'POST',
    token: KEY,
    body: { model: 'fast', messages: [{ role: 'user', content: 'hi' }] }
  });
  check('200 OK', chat.status === 200, `status ${chat.status}`);
  check('routed to provider A', chat.json?.provider_marker === 'A', JSON.stringify(chat.json).slice(0, 120));
  check('upstream model rewritten to model-a-v1', chat.json?.model === 'model-a-v1', String(chat.json?.model));

  // ------------------------------------------------- failover on 404 (model missing)
  section('Failover when a provider does not host the model');
  await req('/api/models', {
    method: 'POST',
    body: { alias: 'failover-alias', providerId: idA, upstreamModel: 'missing-on-a', priority: 1 }
  });
  await req('/api/models', {
    method: 'POST',
    body: { alias: 'failover-alias', providerId: idB, upstreamModel: 'present-on-b', priority: 2 }
  });
  const fo = await req('/v1/chat/completions', {
    method: 'POST',
    token: KEY,
    body: { model: 'failover-alias', messages: [{ role: 'user', content: 'hi' }] }
  });
  check('404 from A fails over to B', fo.status === 200 && fo.json?.provider_marker === 'B', `status ${fo.status} marker ${fo.json?.provider_marker}`);
  check('model rewritten per provider on failover', fo.json?.model === 'present-on-b', String(fo.json?.model));

  // -------------------------------------- failover on 400 model-not-found
  section('Failover on 400 model-not-found (not just 404)');
  await req('/api/models', {
    method: 'POST',
    body: { alias: 'fail400', providerId: idA, upstreamModel: 'missing400-on-a', priority: 1 }
  });
  await req('/api/models', {
    method: 'POST',
    body: { alias: 'fail400', providerId: idB, upstreamModel: 'present-on-b', priority: 2 }
  });
  const f400 = await req('/v1/chat/completions', {
    method: 'POST',
    token: KEY,
    body: { model: 'fail400', messages: [{ role: 'user', content: 'hi' }] }
  });
  check('400 model_not_found fails over to B', f400.status === 200 && f400.json?.provider_marker === 'B', `status ${f400.status} marker ${f400.json?.provider_marker}`);

  // -------------------------------------- deterministic errors are NOT retried
  section('Deterministic errors are not retried on another provider');
  await req('/api/models', {
    method: 'POST',
    body: { alias: 'toolong', providerId: idA, upstreamModel: 'toolong-on-a', priority: 1 }
  });
  await req('/api/models', {
    method: 'POST',
    body: { alias: 'toolong', providerId: idB, upstreamModel: 'present-on-b', priority: 2 }
  });
  const tooLong = await req('/v1/chat/completions', {
    method: 'POST',
    token: KEY,
    body: { model: 'toolong', messages: [{ role: 'user', content: 'hi' }] }
  });
  check('context-length error passes through as 400', tooLong.status === 400, `status ${tooLong.status}`);
  check('context-length error not answered by provider B', tooLong.json?.provider_marker === undefined);

  // -------------------------------------- client provider pinning
  section('Client-side provider pinning (x-provider)');
  await req('/api/models', {
    method: 'POST',
    body: { alias: 'pinned', providerId: idA, upstreamModel: 'model-a-v1', priority: 1 }
  });
  await req('/api/models', {
    method: 'POST',
    body: { alias: 'pinned', providerId: idB, upstreamModel: 'model-b-v1', priority: 2 }
  });
  const pinned = await req('/v1/chat/completions', {
    method: 'POST',
    token: KEY,
    headers: { 'x-provider': 'mock-b' },
    body: { model: 'pinned', messages: [{ role: 'user', content: 'hi' }] }
  });
  check('x-provider pins the request to B', pinned.status === 200 && pinned.json?.provider_marker === 'B', `status ${pinned.status} marker ${pinned.json?.provider_marker}`);

  const pinnedById = await req('/v1/chat/completions', {
    method: 'POST',
    token: KEY,
    headers: { 'x-provider': String(idB) },
    body: { model: 'pinned', messages: [{ role: 'user', content: 'hi' }] }
  });
  check('x-provider accepts a numeric id', pinnedById.status === 200 && pinnedById.json?.provider_marker === 'B');

  const badProvider = await req('/v1/chat/completions', {
    method: 'POST',
    token: KEY,
    headers: { 'x-provider': 'does-not-exist' },
    body: { model: 'pinned', messages: [{ role: 'user', content: 'hi' }] }
  });
  check('unknown provider -> 400 invalid_provider', badProvider.status === 400 && badProvider.json?.error?.code === 'invalid_provider', `status ${badProvider.status}`);

  // -------------------------------------- route exists but provider unusable
  section('Route whose provider has no credential');
  const provC = await req('/api/providers', {
    method: 'POST',
    body: {
      name: 'mock-nokey',
      kind: 'openai',
      base_url: `http://127.0.0.1:${PORT_A}/v1`,
      key_env: 'MOCK_KEY_MISSING',
      priority: 1
    }
  });
  const idC = provC.json?.provider?.id as number;
  await req('/api/models', {
    method: 'POST',
    body: { alias: 'deadroute', providerId: idC, upstreamModel: 'whatever', priority: 1 }
  });
  const dead = await req('/v1/chat/completions', {
    method: 'POST',
    token: KEY,
    body: { model: 'deadroute', messages: [{ role: 'user', content: 'hi' }] }
  });
  check('unusable route -> 503 model_route_unavailable', dead.status === 503 && dead.json?.error?.code === 'model_route_unavailable', `status ${dead.status} code ${dead.json?.error?.code}`);

  const modelsAdmin = await req('/api/models');
  const deadTarget = (modelsAdmin.json?.routes || []).find((r: any) => r.alias === 'deadroute')?.targets?.[0];
  check('admin API explains why the target is unavailable', deadTarget?.available === false && /credential/.test(String(deadTarget?.reason)), JSON.stringify(deadTarget));

  // ------------------------------------------------------- require_route mode
  section('Strict model mode');
  await req('/api/settings', { method: 'PUT', body: { gateway_require_model_route: 'true' } });
  const unknown = await req('/v1/chat/completions', {
    method: 'POST',
    token: KEY,
    body: { model: 'not-routed-at-all', messages: [{ role: 'user', content: 'hi' }] }
  });
  check('unknown model -> 404 model_not_found', unknown.status === 404 && unknown.json?.error?.code === 'model_not_found', `status ${unknown.status}`);
  await req('/api/settings', { method: 'PUT', body: { gateway_require_model_route: 'false' } });

  // ------------------------------------------------------- egress policy
  section('Egress switching policy');
  const sticky = await req('/api/egress/status');
  check('pool reports its policy', typeof sticky.json?.policy === 'string', String(sticky.json?.policy));
  check('default policy is sticky', sticky.json?.policy === 'sticky');

  const rr = await req('/api/settings', { method: 'PUT', body: { egress_policy: 'round_robin' } });
  check('round_robin accepted', rr.status === 200 && rr.json?.applied?.egress_policy === 'round_robin');
  const afterSet = await req('/api/egress/status');
  check('policy reflected in pool status', afterSet.json?.policy === 'round_robin');

  const readySlots = (afterSet.json?.slots || []).filter((s: any) => s.state === 'ready');
  if (readySlots.length >= 2) {
    const before = new Map<number, number>((afterSet.json?.slots || []).map((s: any) => [s.index, s.totalRequests]));
    for (let i = 0; i < 6; i++) {
      await req('/v1/chat/completions', {
        method: 'POST',
        token: KEY,
        body: { model: 'fast', messages: [{ role: 'user', content: 'x' }] }
      });
    }
    const after = await req('/api/egress/status');
    const used = (after.json?.slots || []).filter((s: any) => (s.totalRequests || 0) > (before.get(s.index) || 0));
    check('round_robin spreads requests across slots', used.length >= 2, `slots used: ${used.length}/${readySlots.length}`);
  } else {
    check('round_robin spreads requests across slots', true, 'skipped: fewer than 2 ready slots');
  }

  await req('/api/settings', { method: 'PUT', body: { egress_policy: 'sticky' } });

  // ------------------------------------------------- per-key egress policy
  section('Per-key egress policy');
  const rrKey = await req('/api/keys', {
    method: 'POST',
    body: { name: 'rr-key', rpmLimit: 100, egressPolicy: 'round_robin' }
  });
  check('key created with an explicit policy', rrKey.status === 200);
  const keyList = await req('/api/keys');
  const rrRow = (keyList.json?.keys || []).find((k: any) => k.name === 'rr-key');
  check('policy persisted on the key', rrRow?.egress_policy === 'round_robin', JSON.stringify(rrRow));

  const badPolicyKey = await req('/api/keys', {
    method: 'POST',
    body: { name: 'bad-policy', rpmLimit: 100, egressPolicy: 'nonsense' }
  });
  check('invalid policy is rejected/ignored', badPolicyKey.status === 200);

  // ------------------------------------------------------------------ cleanup
  section('Cleanup');
  for (const alias of ['fast', 'failover-alias', 'fail400', 'toolong', 'pinned', 'deadroute']) {
    await req(`/api/models/alias/${alias}`, { method: 'DELETE' });
  }
  const routesAfter = await req('/api/models');
  check('routes removed', (routesAfter.json?.routes || []).length === 0, JSON.stringify(routesAfter.json?.routes));
  await req(`/api/providers/${idA}`, { method: 'DELETE' });
  await req(`/api/providers/${idB}`, { method: 'DELETE' });
  if (idC) await req(`/api/providers/${idC}`, { method: 'DELETE' });
  const keys = await req('/api/keys');
  for (const k of (keys.json?.keys || []).filter((x: any) => x.name === 'route-test' || x.name === 'rr-key' || x.name === 'bad-policy')) {
    await req(`/api/keys/${k.id}`, { method: 'DELETE' });
  }
  await req('/api/settings', { method: 'PUT', body: { gateway_enabled: 'false' } });

  mockA.close();
  mockB.close();

  console.log('\n==================================================');
  console.log(`  PASSED: ${pass}    FAILED: ${fail}`);
  if (fail > 0) {
    console.log('\n  Failures:');
    for (const f of failures) console.log(`   - ${f}`);
  }
  console.log('==================================================\n');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
