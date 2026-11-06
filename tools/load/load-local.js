#!/usr/bin/env node
/**
 * Local capacity probe.
 *
 * Measures the gateway itself (not the provider): how many requests/second it can
 * relay, at what latency, and how much RSS it uses — with realistic payload sizes.
 *
 *   node tools/load/load-local.js --requests 400 --concurrency 50 --kb 1200
 *   node tools/load/load-local.js --requests 200 --concurrency 20 --kb 64 --stream
 *
 * It starts its own mock upstream and configures the gateway to use it, so no
 * provider key is needed. The gateway must already be running.
 */
const http = require('http');

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}
const GW = process.env.GATEWAY_URL || 'http://127.0.0.1:3001';
const REQUESTS = parseInt(arg('requests', '400'), 10);
const CONCURRENCY = parseInt(arg('concurrency', '50'), 10);
const KB = parseInt(arg('kb', '1200'), 10);
const STREAM = args.includes('--stream');
const MOCK_PORT = parseInt(arg('mock-port', '19200'), 10);

function pct(sorted, p) {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

function startMock() {
  const server = http.createServer((req, res) => {
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
    });
    req.on('end', () => {
      if (req.url.includes('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'load-model', object: 'model' }] }));
        return;
      }
      if (STREAM) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const chunk = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
        for (let i = 0; i < 5; i++) chunk({ id: 'x', object: 'chat.completion.chunk', choices: [{ delta: { content: 'tok' } }] });
        chunk({ id: 'x', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-load',
          object: 'chat.completion',
          model: 'load-model',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          echo_bytes: size
        })
      );
    });
  });
  return new Promise((resolve) => server.listen(MOCK_PORT, '127.0.0.1', () => resolve(server)));
}

async function api(path, body, method) {
  const res = await fetch(`${GW}${path}`, {
    method: method || (body ? 'POST' : 'GET'),
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function rssMb() {
  try {
    const res = await fetch(`${GW}/metrics`);
    const text = await res.text();
    const match = /opencode_router_process_resident_memory_bytes (\d+)/.exec(text);
    return match ? Math.round(Number(match[1]) / 1024 / 1024) : -1;
  } catch {
    return -1;
  }
}

async function main() {
  const mock = await startMock();
  console.log(`mock upstream: http://127.0.0.1:${MOCK_PORT}/v1`);
  console.log(`gateway: ${GW}`);
  console.log(`scenario: ${REQUESTS} requests, concurrency ${CONCURRENCY}, ${KB} KB body, ${STREAM ? 'streaming' : 'non-streaming'}\n`);

  await api('/api/settings', {
    gateway_enabled: 'true',
    gateway_upstream_base_url: `http://127.0.0.1:${MOCK_PORT}/v1`,
    gateway_upstream_model: 'load-model',
    gateway_upstream_bypass_proxy_loopback: 'true',
    gateway_max_concurrent: '1000',
    gateway_max_body_bytes: String(Math.max(8 * 1024 * 1024, KB * 1024 * 4)),
    abuse_detection_enabled: 'false'
  }, 'PUT');

  const keyRes = await api('/api/keys', { name: 'load-test', rpmLimit: 1000000 });
  const KEY = keyRes.key;
  if (!KEY) throw new Error('could not create a key');

  const filler = 'x'.repeat(KB * 1024);
  const makePayload = (i) => ({
    model: 'load-model',
    messages: [{ role: 'user', content: filler + ' #' + i }],
    ...(STREAM ? { stream: true } : {})
  });

  // warm-up
  await fetch(`${GW}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(makePayload(0))
  }).then((r) => r.text());

  const rssBefore = await rssMb();
  const latencies = [];
  const statuses = new Map();
  let cursor = 0;
  const startedAt = Date.now();

  async function worker() {
    for (;;) {
      const index = cursor++;
      if (index >= REQUESTS) return;
      const t0 = Date.now();
      try {
        const res = await fetch(`${GW}/v1/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
          body: JSON.stringify(makePayload(index))
        });
        await res.text();
        statuses.set(res.status, (statuses.get(res.status) || 0) + 1);
      } catch {
        statuses.set('error', (statuses.get('error') || 0) + 1);
      }
      latencies.push(Date.now() - t0);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  const elapsed = Date.now() - startedAt;
  const rssAfter = await rssMb();

  latencies.sort((a, b) => a - b);
  const ok = statuses.get(200) || 0;

  console.log('── results ──────────────────────────────────────────');
  console.log(`elapsed          : ${(elapsed / 1000).toFixed(1)} s`);
  console.log(`throughput       : ${(REQUESTS / (elapsed / 1000)).toFixed(1)} req/s`);
  console.log(`success          : ${ok}/${REQUESTS}`);
  console.log(`status breakdown : ${JSON.stringify([...statuses.entries()])}`);
  console.log(`latency p50/p95  : ${pct(latencies, 50)} / ${pct(latencies, 95)} ms`);
  console.log(`latency max      : ${latencies[latencies.length - 1]} ms`);
  console.log(`gateway RSS      : ${rssBefore} -> ${rssAfter} MB`);
  console.log(`payload per req  : ${(KB / 1024).toFixed(2)} MB`);
  console.log(`bytes relayed    : ${((REQUESTS * KB) / 1024).toFixed(1)} MB`);
  console.log('─────────────────────────────────────────────────────');

  await api('/api/settings', { gateway_enabled: 'false' }, 'PUT');
  for (const k of (await api('/api/keys')).keys || []) {
    if (k.name === 'load-test') await fetch(`${GW}/api/keys/${k.id}`, { method: 'DELETE' });
  }
  mock.close();
}

main().catch((err) => {
  console.error('load probe failed:', err);
  process.exit(1);
});
