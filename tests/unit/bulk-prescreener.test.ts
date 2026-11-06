// Covers BulkPrescreener.probeTcp: invalid host/port short-circuits to
// { ok: false, ms: -1 }, a closed localhost port resolves false within the
// timeout, and a real listening TCP socket resolves true with a non-negative
// latency. Also covers the DB-free progress/abort accessors.

import assert from 'node:assert/strict';
import net from 'node:net';
import test, { describe } from 'node:test';
import { BulkPrescreener } from '../../src/backend/tester/bulk-prescreener';

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') resolve(address.port);
      else reject(new Error('server did not report a port'));
    });
  });
}

function close(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('probeTcp: invalid input', () => {
  test('rejects invalid ports without opening a socket', async () => {
    for (const port of [0, -1, 65536, 1.5, NaN]) {
      const result = await BulkPrescreener.probeTcp('127.0.0.1', port, 500);
      assert.deepEqual(result, { ok: false, ms: -1 });
    }
  });

  test('rejects a missing or empty host', async () => {
    assert.deepEqual(await BulkPrescreener.probeTcp('', 443, 500), { ok: false, ms: -1 });
    assert.deepEqual(await BulkPrescreener.probeTcp(undefined as any, 443, 500), { ok: false, ms: -1 });
  });
});

describe('probeTcp: closed port', () => {
  test('a closed localhost port resolves false within the timeout', async () => {
    const server = net.createServer();
    const port = await listen(server);
    await close(server);

    const startedAt = Date.now();
    const result = await BulkPrescreener.probeTcp('127.0.0.1', port, 1000);
    assert.equal(result.ok, false);
    assert.equal(result.ms, -1);
    assert.ok(Date.now() - startedAt < 1000, 'closed port should fail fast, not hang');
  });

  test('an unroutable host resolves false (timeout or unreachable)', async () => {
    const result = await BulkPrescreener.probeTcp('192.0.2.1', 81, 150);
    assert.equal(result.ok, false);
    assert.equal(result.ms, -1);
  });
});

describe('probeTcp: listening socket', () => {
  test('a real listening socket resolves true with non-negative latency', async () => {
    const server = net.createServer((socket) => socket.destroy());
    const port = await listen(server);
    try {
      const result = await BulkPrescreener.probeTcp('127.0.0.1', port, 1000);
      assert.equal(result.ok, true);
      assert.ok(result.ms >= 0, 'successful probe must report a non-negative latency');
      assert.ok(Number.isFinite(result.ms));
    } finally {
      await close(server);
    }
  });
});

describe('progress accessors (no run started)', () => {
  test('isRunning is false and getProgress returns a copy with a sane shape', () => {
    assert.equal(BulkPrescreener.isRunning(), false);
    const progress = BulkPrescreener.getProgress();
    assert.equal(progress.running, false);
    assert.equal(typeof progress.done, 'number');
    assert.equal(typeof progress.total, 'number');
    assert.equal(typeof progress.alive, 'number');
    assert.equal(progress.startedAt, null);

    progress.running = true;
    assert.equal(BulkPrescreener.getProgress().running, false, 'getProgress must return a defensive copy');
  });

  test('requestAbort while idle is a no-op', () => {
    assert.doesNotThrow(() => BulkPrescreener.requestAbort());
    assert.equal(BulkPrescreener.isRunning(), false);
  });
});
