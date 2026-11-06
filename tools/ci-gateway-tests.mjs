/**
 * CI helper: boot the backend, wait for readiness, run the gateway integration
 * suite against it, then shut it down. Cross-platform (no bash needed).
 *
 *   node tools/ci-gateway-tests.mjs
 */
import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.CI_PORT || '3123';
const BASE = `http://127.0.0.1:${PORT}`;
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForHealth(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/v1/health`, { signal: AbortSignal.timeout(2000) });
      if (res.status === 200 || res.status === 503) return true;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  return false;
}

function killTree(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    /* already gone */
  }
}

const server = spawn(process.execPath, [TSX, 'src/backend/server.ts'], {
  cwd: ROOT,
  env: { ...process.env, PORT, NODE_ENV: 'test', LOG_LEVEL: 'warn' },
  stdio: ['ignore', 'pipe', 'pipe']
});

let serverOutput = '';
server.stdout.on('data', (d) => {
  serverOutput += d.toString();
});
server.stderr.on('data', (d) => {
  serverOutput += d.toString();
});

let exitCode = 1;

try {
  const ready = await waitForHealth();
  if (!ready) {
    console.error('[ci] server did not become ready in time');
    console.error(serverOutput.slice(-3000));
    process.exit(1);
  }
  console.log(`[ci] server ready on ${BASE}`);

  const tests = spawn(process.execPath, [TSX, 'tests/gateway-tests.ts'], {
    cwd: ROOT,
    env: { ...process.env, GATEWAY_URL: BASE, NODE_ENV: 'test' },
    stdio: 'inherit'
  });

  exitCode = await new Promise((resolve) => tests.on('exit', (code) => resolve(code ?? 1)));
} catch (err) {
  console.error('[ci] failed:', err);
} finally {
  // Graceful path first, then hard kill.
  try {
    await fetch(`${BASE}/api/admin/shutdown`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(2000)
    });
  } catch {
    /* ignore */
  }
  await sleep(1500);
  killTree(server);
}

process.exit(exitCode);
