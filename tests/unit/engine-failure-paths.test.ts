/**
 * Coverage: engine failure paths that do not need a working Xray.
 * - EphemeralTunnelTester: stale probe sweep, busy guard, invalid details
 * - VpnEngine: spawn failure via a non-executable XRAY_BIN, idle stop()
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = path.join(os.tmpdir(), `orgw-engine-${process.pid}-${Date.now()}`);
process.env.DATA_DIR = TMP;
// A file that exists but cannot be executed: the constructor accepts it, spawn fails.
const FAKE_BIN = path.join(TMP, 'fake-xray.txt');
process.env.XRAY_BIN = FAKE_BIN;

let EphemeralTunnelTester: any;
let VpnEngine: any;
let initDatabase: any;
let db: any;

before(async () => {
  fs.mkdirSync(TMP, { recursive: true });
  fs.writeFileSync(FAKE_BIN, 'not a binary');
  ({ db, initDatabase } = await import('../../src/backend/db/database.js'));
  ({ EphemeralTunnelTester } = await import('../../src/backend/tester/ephemeral-tunnel.js'));
  ({ VpnEngine } = await import('../../src/backend/vpn/vpn-engine.js'));
  initDatabase();
});

after(() => {
  try {
    db.close();
  } catch {
    /* ignore */
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

const row = {
  id: 1,
  protocol: 'vless',
  address: '127.0.0.1',
  port: 443,
  security: 'tls',
  network: 'tcp',
  details_json: '{"uuid":"00000000-0000-0000-0000-000000000000","sni":"example.com"}'
};

describe('EphemeralTunnelTester', () => {
  it('sweeps stale probe configs and keeps fresh ones', () => {
    const stale = path.join(TMP, 'probe-deadbeef.json');
    fs.writeFileSync(stale, '{"secret":"x"}');
    const old = Date.now() - 2 * 60 * 60 * 1000;
    fs.utimesSync(stale, old / 1000, old / 1000);

    const fresh = path.join(TMP, 'probe-fresh.json');
    fs.writeFileSync(fresh, '{}');

    EphemeralTunnelTester.sweepStaleProbeFiles();

    assert.equal(fs.existsSync(stale), false, 'stale probe file should be removed');
    assert.equal(fs.existsSync(fresh), true, 'fresh probe file must be kept');
  });

  it('rejects an invalid details_json without throwing', async () => {
    const result = await EphemeralTunnelTester.test({ ...row, details_json: 'null' }, 500);
    assert.equal(result.tunnel, false);
  });

  it('reports a spawn error instead of throwing', async () => {
    const result = await EphemeralTunnelTester.test(row, 1500);
    assert.equal(result.tunnel, false);
    assert.ok(result.error);
    assert.equal(EphemeralTunnelTester.isBusy(), false);
  });
});

describe('VpnEngine failure paths', () => {
  it('returns a singleton', () => {
    assert.equal(VpnEngine.getInstance(), VpnEngine.getInstance());
  });

  it('exposes a non-empty binary path', () => {
    assert.ok(VpnEngine.getInstance().getBinaryPath().length > 0);
  });

  it('is idle before start', () => {
    assert.equal(VpnEngine.getInstance().isRunning(), false);
    assert.equal(VpnEngine.getInstance().getActiveConfig(), null);
  });

  it('start() resolves false when the binary cannot be executed', async () => {
    const started = await VpnEngine.getInstance().start(row, 11990, 11991);
    assert.equal(started, false);
    assert.equal(VpnEngine.getInstance().isRunning(), false);
  });

  it('stop() on an idle engine resolves cleanly', async () => {
    await assert.doesNotReject(() => VpnEngine.getInstance().stop());
  });
});
