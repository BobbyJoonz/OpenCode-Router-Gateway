/**
 * Coverage: src/backend/vpn/vpn-engine.ts (non-spawning surface only)
 *
 * The engine is imported with DATA_DIR redirected to an isolated temp directory
 * (DB module imported dynamically afterwards), so construction cannot touch the
 * repository ./data folder.
 *
 * - getInstance() returns one shared singleton instance.
 * - getBinaryPath() resolves to a non-empty absolute path (the checked-in
 *   bin/xray[.exe] unless XRAY_BIN overrides it).
 * - isRunning() is false and getActiveConfig() is null before anything starts.
 * - stop() resolves without throwing on an idle engine and leaves state clean;
 *   it is safe to call twice.
 *
 * start() is intentionally never called: it would spawn the real xray binary.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const TMP = path.join(os.tmpdir(), `orgw-vpn-${process.pid}-${Date.now()}`);
process.env.DATA_DIR = TMP;

// tests/unit -> repository root
const ROOT = path.resolve(__dirname, '../..');
const BIN_NAME = process.platform === 'win32' ? 'xray.exe' : 'xray';

let db: any;
let VpnEngine: any;
let engine: any;

before(async () => {
  const database = await import('../../src/backend/db/database.js');
  database.initDatabase();
  db = database.db;
  const vpn = await import('../../src/backend/vpn/vpn-engine.js');
  VpnEngine = vpn.VpnEngine;
  engine = VpnEngine.getInstance();
});

after(() => {
  try {
    db?.close();
  } catch {
    // already closed
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('VpnEngine singleton', () => {
  it('getInstance() always returns the same instance', () => {
    const first = VpnEngine.getInstance();
    const second = VpnEngine.getInstance();
    assert.equal(first, second);
    assert.equal(first, engine);
    assert.ok(first instanceof VpnEngine);
  });
});

describe('VpnEngine idle state', () => {
  it('getBinaryPath() returns a non-empty absolute path', () => {
    const binPath = engine.getBinaryPath();
    assert.equal(typeof binPath, 'string');
    assert.ok(binPath.length > 0);
    assert.ok(path.isAbsolute(binPath), `expected an absolute binary path, got ${binPath}`);
  });

  it('resolves the checked-in xray binary when XRAY_BIN is not set', () => {
    if (process.env.XRAY_BIN) {
      // Operator override wins; cannot assert the repository path.
      return;
    }
    assert.equal(engine.getBinaryPath(), path.join(ROOT, 'bin', BIN_NAME));
    assert.equal(fs.existsSync(engine.getBinaryPath()), true);
  });

  it('isRunning() is false before anything was started', () => {
    assert.equal(engine.isRunning(), false);
  });

  it('getActiveConfig() is null before anything was started', () => {
    assert.equal(engine.getActiveConfig(), null);
  });
});

describe('VpnEngine.stop on an idle engine', () => {
  it('resolves without throwing and keeps the engine idle', async () => {
    await assert.doesNotReject(async () => {
      await engine.stop();
    });
    assert.equal(engine.isRunning(), false);
    assert.equal(engine.getActiveConfig(), null);
  });

  it('can be called again safely', async () => {
    await assert.doesNotReject(async () => {
      await engine.stop();
    });
    assert.equal(engine.isRunning(), false);
  });
});
