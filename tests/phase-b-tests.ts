/**
 * Phase B acceptance tests (B1 failover, B2 zero-drop rotation, B3 stickiness)
 * plus B6 importer coverage.
 *
 *   PORT=3002 npx tsx src/backend/server.ts      # terminal 1
 *   GATEWAY_URL=http://127.0.0.1:3002 npx tsx tests/phase-b-tests.ts
 */
import http from 'http';
import { execSync } from 'child_process';
import { parseClash, parseSingbox, detectStructuredFormat } from '../src/backend/parser/structured-importers';

const GW = process.env.GATEWAY_URL || 'http://127.0.0.1:3002';
const MOCK_PORT = parseInt(process.env.MOCK_PORT || '19098', 10);

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
    failures.push(name + (detail ? ` — ${detail}` : ''));
    console.log(`  ✘ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function req(path: string, opts: { method?: string; token?: string; body?: any } = {}): Promise<any> {
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
    /* not JSON */
  }
  return { status: res.status, headers: res.headers, text, json };
}

// ---------------------------------------------------------------- fixtures
const CLASH_SAMPLE = `
mixed-port: 7890
proxies:
  - name: "clash-vless-reality"
    type: vless
    server: 192.0.2.10
    port: 443
    uuid: 11111111-1111-1111-1111-111111111111
    flow: xtls-rprx-vision
    tls: true
    servername: www.example.com
    client-fingerprint: chrome
    network: tcp
    reality-opts:
      public-key: PUBLICKEYPUBLICKEYPUBLICKEYPUBLICKEY1234
      short-id: abcd1234
  - name: "clash-vmess-ws"
    type: vmess
    server: 192.0.2.11
    port: 443
    uuid: 22222222-2222-2222-2222-222222222222
    alterId: 0
    cipher: auto
    tls: true
    servername: ws.example.com
    network: ws
    ws-opts:
      path: /ws
      headers:
        Host: ws.example.com
  - name: "clash-trojan"
    type: trojan
    server: 192.0.2.12
    port: 443
    password: secret
    sni: trojan.example.com
    network: grpc
    grpc-opts:
      grpc-service-name: svc
  - name: "clash-ss"
    type: ss
    server: 192.0.2.13
    port: 8388
    cipher: aes-256-gcm
    password: pass123
`;

const SINGBOX_SAMPLE = JSON.stringify({
  outbounds: [
    {
      type: 'vless',
      tag: 'sb-vless-reality',
      server: '192.0.2.20',
      server_port: 443,
      uuid: '33333333-3333-3333-3333-333333333333',
      flow: 'xtls-rprx-vision',
      tls: {
        enabled: true,
        server_name: 'www.example.com',
        reality: { enabled: true, public_key: 'PKPKPKPKPKPKPKPKPKPKPKPKPKPKPKPKPKPK', short_id: 'beef1234' },
        utls: { enabled: true, fingerprint: 'chrome' }
      }
    },
    {
      type: 'vmess',
      tag: 'sb-vmess-ws',
      server: '192.0.2.21',
      server_port: 8443,
      uuid: '44444444-4444-4444-4444-444444444444',
      security: 'auto',
      tls: { enabled: true, server_name: 'ws.example.com' },
      transport: { type: 'ws', path: '/ws', headers: { Host: 'ws.example.com' } }
    },
    {
      type: 'trojan',
      tag: 'sb-trojan',
      server: '192.0.2.22',
      server_port: 443,
      password: 'secret',
      tls: { enabled: true, server_name: 'trojan.example.com' },
      transport: { type: 'grpc', service_name: 'svc' }
    },
    {
      type: 'shadowsocks',
      tag: 'sb-ss',
      server: '192.0.2.23',
      server_port: 8388,
      method: 'aes-256-gcm',
      password: 'pass123'
    },
    { type: 'direct', tag: 'direct' }
  ]
});

function testImporters(): void {
  section('B6 — Clash YAML importer');
  const clash = parseClash(CLASH_SAMPLE);
  check('clash: 4 proxies parsed', clash.length === 4, `got ${clash.length}`);
  const cl = clash.find((c) => c.remark.includes('vless'));
  check('clash: vless mapped to reality', cl?.security === 'reality', cl?.security);
  check('clash: reality public key carried', cl?.details.pbk === 'PUBLICKEYPUBLICKEYPUBLICKEYPUBLICKEY1234');
  check('clash: reality short id carried', cl?.details.sid === 'abcd1234');
  check('clash: flow carried', cl?.details.flow === 'xtls-rprx-vision');
  const cv = clash.find((c) => c.remark.includes('vmess'));
  check('clash: vmess ws path', cv?.details.path === '/ws', cv?.details.path);
  check('clash: vmess host header', cv?.details.host === 'ws.example.com');
  const ct = clash.find((c) => c.remark.includes('trojan'));
  check('clash: trojan forced tls', ct?.security === 'tls');
  check('clash: trojan grpc service', ct?.details.serviceName === 'svc', ct?.details.serviceName);
  const cs = clash.find((c) => c.remark === 'clash-ss');
  check('clash: ss method', cs?.details.method === 'aes-256-gcm', JSON.stringify(cs?.details));

  section('B6 — sing-box importer');
  const sb = parseSingbox(SINGBOX_SAMPLE);
  check('singbox: 4 outbounds parsed (direct skipped)', sb.length === 4, `got ${sb.length}`);
  const sv = sb.find((c) => c.remark === 'sb-vless-reality');
  check('singbox: vless reality', sv?.security === 'reality');
  check('singbox: reality pk', sv?.details.pbk === 'PKPKPKPKPKPKPKPKPKPKPKPKPKPKPKPKPKPK');
  check('singbox: utls fingerprint', sv?.details.fp === 'chrome');
  const sm = sb.find((c) => c.remark === 'sb-vmess-ws');
  check('singbox: vmess ws transport', sm?.network === 'ws');
  check('singbox: vmess path', sm?.details.path === '/ws');
  const st = sb.find((c) => c.remark === 'sb-trojan');
  check('singbox: trojan grpc service', st?.details.serviceName === 'svc');

  section('B6 — format detection');
  check('detect: clash yaml', detectStructuredFormat(CLASH_SAMPLE) === 'clash');
  check('detect: sing-box json', detectStructuredFormat(SINGBOX_SAMPLE) === 'singbox');
  check(
    'detect: xray json',
    detectStructuredFormat(JSON.stringify({ outbounds: [{ protocol: 'vless', settings: {} }] })) === 'xray'
  );
  check('detect: share links', detectStructuredFormat('vless://uuid@1.2.3.4:443?security=tls#x') === 'unknown');

  section('B6 — malformed input is rejected, not thrown');
  check('clash: garbage yaml -> []', parseClash(':::not yaml:::\n  - [').length === 0);
  check('singbox: garbage json -> []', parseSingbox('{not json').length === 0);
  check('clash: empty -> []', parseClash('').length === 0);
  check('singbox: empty -> []', parseSingbox('{}').length === 0);
}

function startMockUpstream(): Promise<http.Server> {
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
      const model = String(body.model || 'mock-ok');

      if (request.url?.includes('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-ok', object: 'model' }] }));
        return;
      }

      if (model === 'mock-slowstream') {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const chunk = (o: any) => response.write(`data: ${JSON.stringify(o)}\n\n`);
        chunk({ id: 'm', object: 'chat.completion.chunk', choices: [{ delta: { content: 'part1' } }] });
        setTimeout(() => {
          chunk({ id: 'm', object: 'chat.completion.chunk', choices: [{ delta: { content: 'part2' } }] });
          setTimeout(() => {
            chunk({ id: 'm', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 9, completion_tokens: 6, total_tokens: 15 } });
            response.write('data: [DONE]\n\n');
            response.end();
          }, 800);
        }, 800);
        return;
      }

      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          id: 'x',
          object: 'chat.completion',
          model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
        })
      );
    });
  });
  return new Promise((resolve) => server.listen(MOCK_PORT, '127.0.0.1', () => resolve(server)));
}

function killPid(pid: number): void {
  if (process.platform === 'win32') {
    execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
  } else {
    process.kill(pid, 'SIGKILL');
  }
}

async function waitForGateway(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${GW}/v1/health`);
      if (r.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`gateway not reachable at ${GW}`);
}

async function main(): Promise<void> {
  testImporters();

  const mock = await startMockUpstream();
  await waitForGateway();

  // ------------------------------------------------------------------ setup
  section('Setup');
  await req('/api/settings', {
    method: 'PUT',
    body: {
      gateway_enabled: 'true',
      gateway_upstream_base_url: `http://127.0.0.1:${MOCK_PORT}/v1`,
      gateway_upstream_model: 'mock-ok',
      pool_size: '2',
      pool_base_port: '12200'
    }
  });
  const reinit = await req('/api/egress/reinit', { method: 'POST', body: { size: 2 } });
  check('pool initialised', reinit.status === 200 && reinit.json?.status?.size === 2, `status ${reinit.status}`);

  let pool = await req('/api/egress/status');
  check('pool reports slots', Array.isArray(pool.json?.slots) && pool.json.slots.length === 2);
  check('at least one slot ready', (pool.json?.ready || 0) >= 1, `ready=${pool.json?.ready}`);

  const keyRes = await req('/api/keys', { method: 'POST', body: { name: 'pb-main', rpmLimit: 2000 } });
  const KEY = keyRes.json?.key as string;
  check('key created', typeof KEY === 'string');

  // warm the pool and pin the key
  const warm = await req('/v1/chat/completions', {
    method: 'POST',
    token: KEY,
    body: { model: 'mock-ok', messages: [{ role: 'user', content: 'warm' }] }
  });
  check('warmup completion 200', warm.status === 200, `status ${warm.status}`);

  // --------------------------------------------------------------------- B3
  section('B3 — per-client stickiness');
  const usage1 = await req('/v1/usage', { token: KEY });
  const assigned = usage1.json?.assigned_slot;
  check('key pinned to a slot', Number.isInteger(assigned), JSON.stringify(assigned));

  let stable = true;
  const seen = new Set<number>();
  for (let i = 0; i < 6; i++) {
    await req('/v1/chat/completions', {
      method: 'POST',
      token: KEY,
      body: { model: 'mock-ok', messages: [{ role: 'user', content: `s${i}` }] }
    });
    const u = await req('/v1/usage', { token: KEY });
    if (u.json?.assigned_slot !== assigned) stable = false;
    seen.add(u.json?.assigned_slot);
  }
  check('assignment stays stable across 6 requests', stable, `slots seen: ${[...seen].join(',')}`);

  // --------------------------------------------------------------------- B1
  section('B1 — automatic failover (kill -9 the serving xray)');
  pool = await req('/api/egress/status');
  const victim = (pool.json?.slots || []).find((s: any) => s.state === 'ready' && s.pid);
  check('found a serving slot', !!victim, JSON.stringify(pool.json?.slots?.map((s: any) => s.state)));

  if (victim) {
    const oldPid = victim.pid;
    const oldSlot = victim.index;
    const t0 = Date.now();
    killPid(oldPid);

    let recovered = false;
    let newPid: number | null = null;
    while (Date.now() - t0 < 12000) {
      await new Promise((r) => setTimeout(r, 250));
      const st = await req('/api/egress/status');
      const slot = (st.json?.slots || []).find((s: any) => s.index === oldSlot);
      if (slot && slot.state === 'ready' && slot.pid && slot.pid !== oldPid) {
        recovered = true;
        newPid = slot.pid;
        break;
      }
    }
    const elapsed = Date.now() - t0;
    check('slot replaced automatically', recovered, `elapsed ${elapsed}ms`);
    check('failover under 5s', elapsed < 5000, `${elapsed}ms`);
    check('new process is different', newPid !== oldPid, `${oldPid} -> ${newPid}`);

    const after = await req('/api/egress/status');
    check('failover counter incremented', (after.json?.metrics?.failovers || 0) >= 1, JSON.stringify(after.json?.metrics));
  }

  // --------------------------------------------------------------------- B2
  section('B2 — zero-drop rotation with an in-flight stream');
  // Make sure both slots are healthy first.
  await req('/api/egress/ensure', { method: 'POST', body: {} });
  const u2 = await req('/v1/usage', { token: KEY });
  const servingSlot = u2.json?.assigned_slot ?? 0;

  const streamPromise = fetch(`${GW}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'mock-slowstream', stream: true, messages: [{ role: 'user', content: 'long' }] })
  }).then((r) => r.text());

  // Give the stream a moment to be in flight, then rotate its slot.
  await new Promise((r) => setTimeout(r, 400));
  const rotateT0 = Date.now();
  const rotate = await req(`/api/egress/rotate/${servingSlot}`, { method: 'POST', body: {} });
  const rotateMs = Date.now() - rotateT0;
  const streamText = await streamPromise;

  check('rotation succeeded', rotate.status === 200 && rotate.json?.success === true, `status ${rotate.status}`);
  check('stream completed with [DONE]', streamText.includes('[DONE]'), `len ${streamText.length}`);
  check('stream was not interrupted', !streamText.includes('stream_interrupted'), 'stream cut');
  check('stream delivered all chunks', streamText.includes('part1') && streamText.includes('part2'));
  check('rotation waited for the drain', rotateMs >= 500, `${rotateMs}ms (drained, not instant)`);

  const afterRotate = await req('/api/egress/status');
  check('rotation counter incremented', (afterRotate.json?.metrics?.rotations || 0) >= 1, JSON.stringify(afterRotate.json?.metrics));
  check('no stuck slots reported', (afterRotate.json?.stuck || []).length === 0, JSON.stringify(afterRotate.json?.stuck));

  // ------------------------------------------------------------------ health
  section('Pool integrity');
  await new Promise((r) => setTimeout(r, 500));
  const finalPool = await req('/api/egress/status');
  check('both slots ready at the end', finalPool.json?.ready === finalPool.json?.size, `ready=${finalPool.json?.ready}/${finalPool.json?.size}`);
  check('every ready slot has a node', (finalPool.json?.slots || []).every((s: any) => s.state !== 'ready' || s.node));
  check('no orphan ports left', (finalPool.json?.stuck || []).length === 0);
  check('avg start time recorded', (finalPool.json?.metrics?.avgStartMs || 0) > 0, JSON.stringify(finalPool.json?.metrics));

  // cleanup
  await req('/api/settings', { method: 'PUT', body: { gateway_enabled: 'false' } });
  const keys = await req('/api/keys');
  for (const k of (keys.json?.keys || []).filter((x: any) => String(x.name).startsWith('pb-'))) {
    await req(`/api/keys/${k.id}`, { method: 'DELETE' });
  }
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
