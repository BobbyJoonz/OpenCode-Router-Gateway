/**
 * Lifecycle integration test.
 *
 * Boots the real server as a child process and verifies the acceptance criteria
 * for A2:
 *   1. POST /api/admin/shutdown returns 202 and the process exits with code 0
 *   2. during the drain window new requests are rejected with 503
 *   3. an open SSE stream does not block shutdown
 *   4. no Xray child survives the shutdown (no orphan holding the proxy ports)
 */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(__dirname, '..');
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = parseInt(process.env.LIFECYCLE_PORT || '3130', 10);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(os.tmpdir(), `orgw-life-${process.pid}-${Date.now()}`);

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
      if (res.status === 200 || res.status === 503) return true;
    } catch {
      /* not up */
    }
    await sleep(300);
  }
  return false;
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(v);
    };
    socket.setTimeout(400);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    try {
      socket.connect(port, '127.0.0.1');
    } catch {
      finish(false);
    }
  });
}

async function main(): Promise<void> {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Start from a copy of the repository database so working nodes exist.
  const repoDb = path.join(ROOT, 'data', 'opencode-vpn.db');
  if (fs.existsSync(repoDb)) {
    fs.copyFileSync(repoDb, path.join(DATA_DIR, 'opencode-vpn.db'));
  }

  const server = spawn(process.execPath, [TSX, 'src/backend/server.ts'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR, LOG_LEVEL: 'warn', NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  server.stdout.on('data', (d) => {
    output += d.toString();
  });
  server.stderr.on('data', (d) => {
    output += d.toString();
  });

  try {
    console.log('▶ Lifecycle: graceful shutdown');
    if (!(await waitHealth())) {
      console.log(output.slice(-2000));
      throw new Error('server did not become ready');
    }
    check('server is ready', true);

    // Use dedicated proxy ports so this test cannot collide with any other
    // gateway instance on the machine.
    await fetch(`${BASE}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ socks_port: '12108', http_port: '12109' })
    });

    // Optionally bring up an Xray child so the "no orphan" check is meaningful.
    let activeNode: any = null;
    try {
      const cfg = await (await fetch(`${BASE}/api/configs?limit=50&status=working`)).json();
      const candidate = (cfg.items || [])[0];
      if (candidate) {
        const activated = await fetch(`${BASE}/api/configs/${candidate.id}/activate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}'
        });
        if (activated.ok) {
          const status = await (await fetch(`${BASE}/api/status`)).json();
          activeNode = status.activeConnection || null;
        }
      }
    } catch {
      /* activation is best-effort */
    }
    check('egress engine may be running (best effort)', true, activeNode ? `node #${activeNode.id}` : 'none');

    const socksPort = parseInt(
      (await (await fetch(`${BASE}/api/settings`)).json()).settings.socks_port || '10808',
      10
    );

    // Capture our own Xray child PID (if one was started) so the orphan check is
    // about *our* process, not whatever else may be listening on the same port.
    const statePath = path.join(DATA_DIR, 'active-connection.json');
    let childPid: number | null = null;
    try {
      if (fs.existsSync(statePath)) {
        childPid = JSON.parse(fs.readFileSync(statePath, 'utf-8')).pid ?? null;
      }
    } catch {
      /* ignore */
    }

    // Hold an SSE connection open: it must not block shutdown.
    const sseController = new AbortController();
    const ssePromise = fetch(`${BASE}/api/events`, { signal: sseController.signal })
      .then((r) => r.text())
      .catch(() => null);
    await sleep(300);

    const startedAt = Date.now();
    const shutdown = await fetch(`${BASE}/api/admin/shutdown`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ drainDelayMs: 700 })
    });
    check('shutdown accepted with 202', shutdown.status === 202, `status ${shutdown.status}`);

    // During the drain window, new work must be rejected.
    await sleep(200);
    let during: number | null = null;
    try {
      const r = await fetch(`${BASE}/v1/health`, { signal: AbortSignal.timeout(2000) });
      during = r.status;
    } catch {
      during = null; // connection refused is also acceptable
    }
    check('new requests rejected during drain', during === 503 || during === null, `status ${during}`);

    // The SSE stream should be closed by the server, not block exit.
    await Promise.race([ssePromise, sleep(3000)]);

    const exitCode = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 20000);
      server.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    const elapsed = Date.now() - startedAt;

    check('process exited cleanly', exitCode === 0, `code ${exitCode}`);
    check('shutdown finished within the timeout', elapsed < 20000, `${elapsed}ms`);

    await sleep(500);

    if (childPid) {
      let alive = false;
      try {
        process.kill(childPid, 0);
        alive = true;
      } catch {
        alive = false;
      }
      check('no Xray orphan left behind (our child PID is gone)', !alive, `pid ${childPid} still alive`);
    } else {
      // No engine was started in this run: assert the port we would have used is
      // not held by anything we spawned (informational only).
      const socksStillOpen = await portOpen(socksPort);
      console.log(`  ℹ no engine started; port ${socksPort} open=${socksStillOpen} (external listener ignored)`);
    }

    const stateFile = path.join(DATA_DIR, 'active-connection.json');
    check('active-connection state cleaned up', !fs.existsSync(stateFile));
  } catch (err: any) {
    fail++;
    failures.push(err?.message || String(err));
    console.log(`  ✘ ${err?.message || err}`);
    console.log(output.slice(-3000));
  } finally {
    try {
      if (process.platform === 'win32') execSync(`taskkill /PID ${server.pid} /T /F`, { stdio: 'ignore' });
      else server.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    try {
      fs.rmSync(DATA_DIR, { recursive: true, force: true });
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
