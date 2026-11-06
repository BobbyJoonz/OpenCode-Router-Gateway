/**
 * Coverage: BulkPrescreener.run() — the socket fan-out, batching, run record and
 * abort bookkeeping. Uses an isolated DATA_DIR and localhost-only sockets.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const TMP = path.join(os.tmpdir(), `orgw-ps-${process.pid}-${Date.now()}`);
process.env.DATA_DIR = TMP;

let db: any;
let initDatabase: any;
let BulkPrescreener: any;
let listener: net.Server;
let openPort = 0;
let closedPort = 0;

before(async () => {
  ({ db, initDatabase } = await import('../../src/backend/db/database.js'));
  ({ BulkPrescreener } = await import('../../src/backend/tester/bulk-prescreener.js'));
  initDatabase();

  listener = net.createServer((socket) => socket.end());
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', () => resolve()));
  openPort = (listener.address() as AddressInfo).port;

  // Grab a port, then close it so we know nothing is listening there.
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
  closedPort = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
});

after(async () => {
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  try {
    db.close();
  } catch {
    /* ignore */
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

function insertConfig(address: string, port: number, hash: string): number {
  const info = db
    .prepare(
      `INSERT INTO configs (protocol, address, port, remark, security, network, raw_url, config_hash, details_json)
       VALUES ('vless', ?, ?, 'test', 'tls', 'tcp', ?, ?, '{}')`
    )
    .run(address, port, `vless://${hash}`, hash);
  return Number(info.lastInsertRowid);
}

describe('BulkPrescreener.run', () => {
  it('screens configs and records tcp_alive', async () => {
    const aliveId = insertConfig('127.0.0.1', openPort, 'hash-alive');
    const deadId = insertConfig('127.0.0.1', closedPort, 'hash-dead');
    const badId = insertConfig('127.0.0.1', 99999, 'hash-bad-port');

    const summary = await BulkPrescreener.run({ concurrency: 4, timeoutMs: 400, limit: 100 });

    assert.ok(summary.runId > 0);
    assert.ok(summary.total >= 3);
    assert.ok(summary.alive >= 1, `expected at least one alive, got ${summary.alive}`);
    assert.equal(summary.aborted, false);
    assert.ok(summary.durationMs >= 0);

    const aliveRow = db.prepare('SELECT tcp_alive, tcp_latency_ms, prescreen_at FROM configs WHERE id = ?').get(aliveId);
    assert.equal(aliveRow.tcp_alive, 1);
    assert.ok(aliveRow.tcp_latency_ms >= 0);
    assert.ok(aliveRow.prescreen_at);

    const deadRow = db.prepare('SELECT tcp_alive FROM configs WHERE id = ?').get(deadId);
    assert.equal(deadRow.tcp_alive, 0);

    const badRow = db.prepare('SELECT tcp_alive FROM configs WHERE id = ?').get(badId);
    assert.equal(badRow.tcp_alive, 0);

    const run = db.prepare('SELECT * FROM prescreen_runs WHERE id = ?').get(summary.runId);
    assert.equal(run.status, 'done');
    assert.ok(run.finished_at);
    assert.equal(run.alive, summary.alive);
    assert.equal(run.concurrency, 4);
    assert.equal(run.timeout_ms, 400);
  });

  it('leaves no run stuck in running state', () => {
    const stuck = db.prepare("SELECT COUNT(*) AS c FROM prescreen_runs WHERE status = 'running'").get();
    assert.equal(stuck.c, 0);
  });

  it('reports progress as finished', () => {
    const progress = BulkPrescreener.getProgress();
    assert.equal(progress.running, false);
    assert.equal(BulkPrescreener.isRunning(), false);
  });

  it('honours onlyUnhealthy', async () => {
    insertConfig('127.0.0.1', openPort, 'hash-second');
    const summary = await BulkPrescreener.run({ onlyUnhealthy: true, concurrency: 2, timeoutMs: 300, limit: 50 });
    // The alive node from the previous run is excluded; the fresh one is included.
    assert.ok(summary.total >= 1);
  });

  it('respects the limit', async () => {
    const summary = await BulkPrescreener.run({ concurrency: 1, timeoutMs: 200, limit: 1 });
    assert.equal(summary.total, 1);
  });

  it('requestAbort is a no-op when idle', () => {
    assert.doesNotThrow(() => BulkPrescreener.requestAbort());
  });

  it('probeTcp rejects invalid ports without throwing', async () => {
    const result = await BulkPrescreener.probeTcp('127.0.0.1', 0, 100);
    assert.equal(result.ok, false);
  });
});
