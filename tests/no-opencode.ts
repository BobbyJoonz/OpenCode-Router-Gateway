/**
 * Proves the gateway runs on a host where the OpenCode CLI is not available.
 *
 * The child server is started with a PATH that cannot resolve `opencode`, an
 * APPDATA pointing at an empty temp dir, and OPENCODE_BIN pointing at a missing
 * file. /v1/health, /api/status and a chat completion must still work.
 */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(__dirname, '..');
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = parseInt(process.env.NO_OPENCODE_PORT || '3131', 10);
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = path.join(os.tmpdir(), `orgw-nooc-${process.pid}-${Date.now()}`);
const EMPTY_APPDATA = path.join(TMP, 'appdata');

let pass = 0;
let fail = 0;
const failures: string[] = [];

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitHealth(timeoutMs = 60000): Promise<boolean> {
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

function startMock(): Promise<http.Server> {
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'x',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        })
      );
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

async function main(): Promise<void> {
  fs.mkdirSync(EMPTY_APPDATA, { recursive: true });
  const mock = await startMock();
  const mockPort = (mock.address() as any).port;

  // A PATH with no node/npm/opencode, and an APPDATA with no opencode-ai package.
  const barePath = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/usr/bin:/bin';

  const server = spawn(process.execPath, [TSX, 'src/backend/server.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: path.join(TMP, 'data'),
      APPDATA: EMPTY_APPDATA,
      HOME: EMPTY_APPDATA,
      USERPROFILE: EMPTY_APPDATA,
      OPENCODE_BIN: path.join(TMP, 'missing', 'opencode'),
      PATH: barePath,
      LOG_LEVEL: 'warn',
      NODE_ENV: 'test'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  server.stdout.on('data', (d) => {
    out += d.toString();
  });
  server.stderr.on('data', (d) => {
    out += d.toString();
  });

  try {
    console.log('▶ Gateway without the OpenCode CLI');
    if (!(await waitHealth())) {
      console.log(out.slice(-2500));
      throw new Error('server did not start without opencode');
    }
    check('server starts with no opencode on PATH', true);

    const status = await (await fetch(`${BASE}/api/status`)).json();
    check('/api/status responds', typeof status.phase === 'string');
    check('opencode reported as not installed', status.opencode?.installed === false, JSON.stringify(status.opencode));

    const settings = await fetch(`${BASE}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        gateway_enabled: 'true',
        gateway_upstream_base_url: `http://127.0.0.1:${mockPort}/v1`,
        gateway_upstream_model: 'mock',
        gateway_rotate_on_429: 'false'
      })
    });
    check('gateway settings applied', settings.status === 200);

    const created = await (
      await fetch(`${BASE}/api/keys`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'no-opencode' })
      })
    ).json();
    check('API key created', typeof created.key === 'string');

    const completion = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${created.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mock', messages: [{ role: 'user', content: 'hi' }] })
    });
    check('chat completion works', completion.status === 200, `status ${completion.status}`);
    const json = await completion.json();
    check('completion body relayed', json.choices?.[0]?.message?.content === 'ok');
  } catch (err: any) {
    fail++;
    failures.push(err?.message || String(err));
    console.log(`  ✘ ${err?.message || err}`);
    console.log(out.slice(-3000));
  } finally {
    try {
      if (process.platform === 'win32') execSync(`taskkill /PID ${server.pid} /T /F`, { stdio: 'ignore' });
      else server.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    await new Promise((r) => mock.close(r));
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  console.log(`\nPASSED: ${pass}   FAILED: ${fail}`);
  if (fail) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
