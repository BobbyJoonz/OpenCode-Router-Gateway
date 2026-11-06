/**
 * Coverage: src/backend/tester/health-monitor.ts
 *
 * Uses an isolated temp DATA_DIR (set before the DB is dynamically imported) so
 * the repository database is untouched.
 *
 * - getStatus() exposes the documented HealthMonitorStatus shape and reads the
 *   seeded defaults (enabled=true, intervalSeconds=300, batch=8), with
 *   lastRun=null and nextRunInMs=null before scheduling.
 * - start() schedules the monitor (scheduled=true, nextRunInMs in range) and
 *   stop() clears it again (scheduled=false, nextRunInMs=null); both are safe
 *   to call repeatedly.
 * - checkNow() on an EMPTY config table returns { checked: 0, healthy: 0,
 *   dead: 0, tunnelFailed: 0 } without throwing, records lastRun and resets
 *   the checking flag. No probes are attempted, so no sockets are opened.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const TMP = path.join(os.tmpdir(), `orgw-health-${process.pid}-${Date.now()}`);
process.env.DATA_DIR = TMP;

let db: any;
let HealthMonitor: any;

before(async () => {
  const database = await import('../../src/backend/db/database.js');
  database.initDatabase();
  db = database.db;
  const monitor = await import('../../src/backend/tester/health-monitor.js');
  HealthMonitor = monitor.HealthMonitor;
});

after(() => {
  try {
    HealthMonitor?.stop();
  } catch {
    // ignore
  }
  try {
    db?.close();
  } catch {
    // already closed
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('HealthMonitor.getStatus', () => {
  it('returns the documented status shape', () => {
    const status = HealthMonitor.getStatus();
    for (const key of [
      'enabled',
      'scheduled',
      'checking',
      'intervalSeconds',
      'batch',
      'lastRun',
      'nextRunInMs'
    ]) {
      assert.ok(key in status, `missing field ${key}`);
    }
    assert.equal(typeof status.enabled, 'boolean');
    assert.equal(typeof status.scheduled, 'boolean');
    assert.equal(typeof status.checking, 'boolean');
    assert.equal(typeof status.intervalSeconds, 'number');
    assert.equal(typeof status.batch, 'number');
  });

  it('reflects the seeded defaults while idle', () => {
    const status = HealthMonitor.getStatus();
    assert.equal(status.enabled, true);
    assert.equal(status.scheduled, false);
    assert.equal(status.checking, false);
    assert.equal(status.intervalSeconds, 300);
    assert.equal(status.batch, 8);
    assert.equal(status.lastRun, null);
    assert.equal(status.nextRunInMs, null);
    assert.equal(HealthMonitor.isScheduled(), false);
    assert.equal(HealthMonitor.isChecking(), false);
  });
});

describe('HealthMonitor start/stop', () => {
  it('start() schedules and stop() unschedules the timer', () => {
    HealthMonitor.start();
    assert.equal(HealthMonitor.isScheduled(), true);

    const running = HealthMonitor.getStatus();
    assert.equal(running.scheduled, true);
    assert.equal(typeof running.nextRunInMs, 'number');
    assert.ok(running.nextRunInMs! > 0, 'next run must be in the future');
    assert.ok(running.nextRunInMs! <= 300_000, 'next run must respect the interval');

    HealthMonitor.stop();
    assert.equal(HealthMonitor.isScheduled(), false);
    assert.equal(HealthMonitor.getStatus().scheduled, false);
    assert.equal(HealthMonitor.getStatus().nextRunInMs, null);
  });

  it('start() twice keeps a single schedule and stop() is idempotent', () => {
    HealthMonitor.start();
    HealthMonitor.start();
    assert.equal(HealthMonitor.isScheduled(), true);
    HealthMonitor.stop();
    assert.equal(HealthMonitor.isScheduled(), false);
    assert.doesNotThrow(() => HealthMonitor.stop());
  });
});

describe('HealthMonitor.checkNow on an empty database', () => {
  it('returns checked: 0 without throwing and records lastRun', async () => {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM configs').get().n, 0);

    let summary: any;
    await assert.doesNotReject(async () => {
      summary = await HealthMonitor.checkNow();
    });

    assert.equal(summary.checked, 0);
    assert.equal(summary.healthy, 0);
    assert.equal(summary.dead, 0);
    assert.equal(summary.tunnelFailed, 0);
    assert.equal(typeof summary.durationMs, 'number');
    assert.ok(summary.durationMs >= 0);
    assert.ok(Number.isFinite(Date.parse(summary.at)), 'at must be an ISO timestamp');

    const status = HealthMonitor.getStatus();
    assert.equal(status.checking, false);
    assert.deepEqual(status.lastRun, summary);
  });

  it('can run again and still reports zero checks', async () => {
    const summary = await HealthMonitor.checkNow();
    assert.equal(summary.checked, 0);
    assert.equal(HealthMonitor.isChecking(), false);
  });
});
