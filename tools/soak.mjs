/**
 * Soak harness: repeated load cycles with resident-memory sampling.
 *
 *   node tools/soak.mjs --minutes 3 --connections 30
 *
 * Memory is read from the app's own Prometheus endpoint
 * (orgw_process_resident_memory_bytes), so the measurement is portable.
 * A leak is declared when the trailing median RSS exceeds the leading median by
 * more than --max-growth percent.
 */
import { spawn, execSync } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const autocannon = require('autocannon');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const MINUTES = parseFloat(arg('minutes', '3'));
const CONNECTIONS = parseInt(arg('connections', '30'), 10);
const CYCLE_S = parseInt(arg('cycle', '20'), 10);
const MAX_GROWTH = parseFloat(arg('max-growth', '5'));
const PORT = parseInt(arg('port', '3211'), 10);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(os.tmpdir(), `orgw-soak-${process.pid}-${Date.now()}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startMock() {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      if (req.url?.includes('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock', object: 'model' }] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'x',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 }
        })
      );
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function waitHealth(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/v1/health`, { signal: AbortSignal.timeout(1500) });
      if (res.status === 200) return true;
    } catch {
      /* not up */
    }
    await sleep(300);
  }
  return false;
}

async function rssBytes() {
  const res = await fetch(`${BASE}/metrics`, { signal: AbortSignal.timeout(3000) });
  const text = await res.text();
  const match = text.match(/^orgw_process_resident_memory_bytes\s+([0-9.e+]+)$/m);
  return match ? Math.round(parseFloat(match[1])) : null;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

async function main() {
  const mock = await startMock();
  const mockPort = mock.address().port;

  const server = spawn(process.execPath, [TSX, 'src/backend/server.ts'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR, LOG_LEVEL: 'error', NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  server.stdout.on('data', (d) => {
    out += d;
  });
  server.stderr.on('data', (d) => {
    out += d;
  });

  try {
    if (!(await waitHealth())) {
      console.error('server did not start\n' + out.slice(-2000));
      process.exit(1);
    }

    await fetch(`${BASE}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        gateway_enabled: 'true',
        gateway_upstream_base_url: `http://127.0.0.1:${mockPort}/v1`,
        gateway_upstream_model: 'mock',
        gateway_rotate_on_429: 'false',
        gateway_rotate_on_5xx: 'false'
      })
    });

    const key = (
      await (
        await fetch(`${BASE}/api/keys`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'soak', rpmLimit: 1000000 })
        })
      ).json()
    ).key;

    const deadline = Date.now() + MINUTES * 60 * 1000;
    const samples = [];
    let cycle = 0;
    let totalRequests = 0;
    let totalErrors = 0;

    console.log(`soaking for ${MINUTES} min: ${CONNECTIONS} connections, ${CYCLE_S}s cycles`);

    while (Date.now() < deadline) {
      cycle++;
      const result = await autocannon({
        url: `${BASE}/v1/chat/completions`,
        connections: CONNECTIONS,
        duration: CYCLE_S,
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'mock', messages: [{ role: 'user', content: 'hi' }] })
      });

      totalRequests += result.requests.total;
      totalErrors += result.non2xx + result.errors;

      await sleep(1500);
      const rss = await rssBytes();
      samples.push(rss);
      console.log(
        `  cycle ${cycle}: rps=${Math.round(result.requests.average)} p95=${result.latency.p97_5}ms non2xx=${result.non2xx} rss=${rss ? (rss / 1024 / 1024).toFixed(1) + 'MB' : 'n/a'}`
      );
    }

    const valid = samples.filter((s) => typeof s === 'number');
    const head = median(valid.slice(0, Math.min(3, valid.length)));
    const tail = median(valid.slice(-Math.min(3, valid.length)));
    const growthPct = head > 0 ? Math.round(((tail - head) / head) * 10000) / 100 : 0;

    const summary = {
      minutes: MINUTES,
      connections: CONNECTIONS,
      cycles: cycle,
      total_requests: totalRequests,
      total_errors: totalErrors,
      error_rate_pct: totalRequests ? Math.round((totalErrors / totalRequests) * 10000) / 100 : 0,
      rss_head_mb: head ? Math.round((head / 1024 / 1024) * 10) / 10 : null,
      rss_tail_mb: tail ? Math.round((tail / 1024 / 1024) * 10) / 10 : null,
      rss_growth_pct: growthPct,
      max_growth_pct: MAX_GROWTH
    };

    console.log('\n=== SOAK RESULT ===');
    console.log(JSON.stringify(summary, null, 2));

    const reportPath = path.join(ROOT, 'load', 'last-soak-result.json');
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify({ ...summary, samples }, null, 2));
    console.log(`\nwrote ${reportPath}`);

    if (growthPct > MAX_GROWTH) {
      console.error(`\nFAILED: RSS grew ${growthPct}% (budget ${MAX_GROWTH}%)`);
      process.exitCode = 1;
    }
    if (totalRequests && totalErrors / totalRequests > 0.005) {
      console.error(`\nFAILED: error rate above 0.5%`);
      process.exitCode = 1;
    }
  } finally {
    try {
      await fetch(`${BASE}/api/admin/shutdown`, { method: 'POST', signal: AbortSignal.timeout(1500) });
    } catch {
      /* ignore */
    }
    await sleep(800);
    try {
      if (process.platform === 'win32') execSync(`taskkill /PID ${server.pid} /T /F`, { stdio: 'ignore' });
      else server.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    await new Promise((r) => mock.close(r));
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
