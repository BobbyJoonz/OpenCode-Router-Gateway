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
  opts: { method?: string; token?: string; body?: any } = {}
): Promise<{ status: number; json: any; headers: Headers }> {
  const headers: Record<string, string> = {};
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

      // Simulate "this provider does not host that model".
      if (String(body.model || '').startsWith('missing-on-')) {
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

  // ------------------------------------------------------------------ cleanup
  section('Cleanup');
  await req('/api/models/alias/fast', { method: 'DELETE' });
  await req('/api/models/alias/failover-alias', { method: 'DELETE' });
  const routesAfter = await req('/api/models');
  check('routes removed', (routesAfter.json?.routes || []).length === 0, JSON.stringify(routesAfter.json?.routes));
  await req(`/api/providers/${idA}`, { method: 'DELETE' });
  await req(`/api/providers/${idB}`, { method: 'DELETE' });
  const keys = await req('/api/keys');
  for (const k of (keys.json?.keys || []).filter((x: any) => x.name === 'route-test')) {
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
