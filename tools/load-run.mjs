/**
 * Load harness (autocannon).
 *
 * Boots an isolated gateway + loopback mock upstream, creates a key, then drives
 * the real /v1/chat/completions path and reports latency/throughput/errors.
 *
 *   node tools/load-run.mjs --connections 50 --duration 20
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

const CONNECTIONS = parseInt(arg('connections', '50'), 10);
const DURATION = parseInt(arg('duration', '20'), 10);
const PORT = parseInt(arg('port', '3210'), 10);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(os.tmpdir(), `orgw-load-${process.pid}-${Date.now()}`);

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

async function main() {
  const mock = await startMock();
  const mockPort = mock.address().port;
  console.log(`mock upstream: 127.0.0.1:${mockPort}`);

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

    const keyRes = await fetch(`${BASE}/api/keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'load', rpmLimit: 1000000 })
    });
    const key = (await keyRes.json()).key;

    console.log(`driving ${CONNECTIONS} connections for ${DURATION}s against ${BASE}/v1/chat/completions`);

    const result = await autocannon({
      url: `${BASE}/v1/chat/completions`,
      connections: CONNECTIONS,
      duration: DURATION,
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mock', messages: [{ role: 'user', content: 'hi' }] })
    });

    const summary = {
      duration_s: DURATION,
      connections: CONNECTIONS,
      requests: result.requests.total,
      rps_avg: Math.round(result.requests.average),
      latency_p50_ms: result.latency.p50,
      latency_p95_ms: result.latency.p97_5,
      latency_p99_ms: result.latency.p99,
      latency_max_ms: result.latency.max,
      non2xx: result.non2xx,
      errors: result.errors,
      timeouts: result.timeouts,
      throughput_mb: Math.round((result.throughput.total / 1024 / 1024) * 10) / 10
    };

    const errorRate = result.requests.total ? result.non2xx / result.requests.total : 0;
    summary.error_rate = Math.round(errorRate * 10000) / 100;

    console.log('\n=== LOAD RESULT ===');
    console.log(JSON.stringify(summary, null, 2));

    const reportPath = path.join(ROOT, 'load', 'last-load-result.json');
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(summary, null, 2));
    console.log(`\nwrote ${reportPath}`);

    // Acceptance gate used by CI: p95 overhead and error rate.
    const p95Budget = parseInt(arg('p95-budget', '3000'), 10);
    const errorBudget = parseFloat(arg('error-budget', '0.5'));
    const failed = summary.latency_p95_ms > p95Budget || summary.error_rate > errorBudget;
    if (failed) {
      console.error(`\nFAILED budgets: p95 ${summary.latency_p95_ms}ms (budget ${p95Budget}ms), error ${summary.error_rate}% (budget ${errorBudget}%)`);
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
