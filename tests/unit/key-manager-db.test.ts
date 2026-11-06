/**
 * Coverage: database bootstrap + API key lifecycle.
 *
 * Uses an isolated DATA_DIR so the repository database is never touched.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = path.join(os.tmpdir(), `orgw-km-${process.pid}-${Date.now()}`);
process.env.DATA_DIR = TMP;

let db: any;
let KeyManager: any;
let initDatabase: any;
let getSetting: any;
let setSetting: any;
let runMigrations: any;

before(async () => {
  const database = await import('../../src/backend/db/database.js');
  const migrations = await import('../../src/backend/db/migrations.js');
  const keyManager = await import('../../src/backend/gateway/key-manager.js');
  db = database.db;
  initDatabase = database.initDatabase;
  getSetting = database.getSetting;
  setSetting = database.setSetting;
  KeyManager = keyManager.KeyManager;
  runMigrations = migrations.runMigrations;
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

describe('database bootstrap', () => {
  it('creates the database inside DATA_DIR', () => {
    assert.ok(fs.existsSync(path.join(TMP, 'opencode-vpn.db')));
  });

  it('seeds default settings', () => {
    assert.equal(getSetting('socks_port', ''), '10808');
    assert.equal(getSetting('gateway_enabled', ''), 'false');
    assert.equal(typeof getSetting('prescreen_concurrency', ''), 'string');
  });

  it('setSetting upserts', () => {
    setSetting('gateway_enabled', 'true');
    assert.equal(getSetting('gateway_enabled', ''), 'true');
    setSetting('gateway_enabled', 'false');
    assert.equal(getSetting('gateway_enabled', ''), 'false');
  });

  it('initDatabase is idempotent', () => {
    assert.doesNotThrow(() => initDatabase());
    assert.doesNotThrow(() => initDatabase());
  });

  it('runMigrations is idempotent', () => {
    assert.doesNotThrow(() => runMigrations(db));
    assert.doesNotThrow(() => runMigrations(db));
  });

  it('creates the gateway tables', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: any) => r.name);
    for (const t of ['configs', 'settings', 'api_keys', 'usage_log', 'egress_groups', 'prescreen_runs', 'test_history']) {
      assert.ok(tables.includes(t), `missing table ${t}`);
    }
  });

  it('adds the gateway columns to configs', () => {
    const cols = db
      .prepare('PRAGMA table_info(configs)')
      .all()
      .map((c: any) => c.name);
    for (const c of ['tcp_alive', 'tcp_latency_ms', 'egress_ip', 'health_score', 'last_health_check']) {
      assert.ok(cols.includes(c), `missing column ${c}`);
    }
  });
});

describe('KeyManager', () => {
  it('hashes deterministically to 64 hex chars', () => {
    const h1 = KeyManager.hash('secret');
    const h2 = KeyManager.hash('secret');
    assert.equal(h1, h2);
    assert.match(h1, /^[0-9a-f]{64}$/);
    assert.notEqual(KeyManager.hash('secret'), KeyManager.hash('secret2'));
  });

  it('creates a key with the sk-or- prefix and stores only a hash', () => {
    const created = KeyManager.create({ name: 'unit-key', rpmLimit: 10, dailyTokenLimit: 0 });
    assert.match(created.key, /^sk-or-[A-Za-z0-9_-]{20,}$/);
    assert.equal(created.key_prefix, created.key.slice(0, 12));

    const row = db.prepare('SELECT key_hash FROM api_keys WHERE id = ?').get(created.id);
    assert.notEqual(row.key_hash, created.key);
    assert.equal(row.key_hash, KeyManager.hash(created.key));
  });

  it('verifies a valid key', () => {
    const created = KeyManager.create({ name: 'verify-me' });
    const result = KeyManager.verify(`Bearer ${created.key}`);
    assert.equal(result.ok, true);
    assert.equal(result.key.name, 'verify-me');
  });

  it('rejects missing, malformed and unknown keys', () => {
    assert.equal(KeyManager.verify(undefined).ok, false);
    assert.equal(KeyManager.verify('').ok, false);
    assert.equal(KeyManager.verify('Bearer not-a-key').ok, false);
    assert.equal(KeyManager.verify('Basic abc').ok, false);
    assert.equal(KeyManager.verify('Bearer sk-or-AAAAAAAAAAAAAAAAAAAAAAAA').ok, false);
  });

  it('rejects a disabled key', () => {
    const created = KeyManager.create({ name: 'disable-me' });
    KeyManager.setEnabled(created.id, false);
    const result = KeyManager.verify(`Bearer ${created.key}`);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'disabled');
    KeyManager.setEnabled(created.id, true);
    assert.equal(KeyManager.verify(`Bearer ${created.key}`).ok, true);
  });

  it('revokes keys', () => {
    const created = KeyManager.create({ name: 'revoke-me' });
    assert.equal(KeyManager.revoke(created.id), true);
    assert.equal(KeyManager.verify(`Bearer ${created.key}`).ok, false);
    assert.equal(KeyManager.revoke(999999), false);
  });

  it('lists keys without exposing secrets', () => {
    KeyManager.create({ name: 'list-me' });
    const keys = KeyManager.list();
    assert.ok(keys.length > 0);
    for (const k of keys) {
      assert.ok(!('key' in k));
      assert.ok(!('key_hash' in k));
      assert.match(k.key_prefix, /^sk-or-/);
    }
  });

  it('enforces the requests-per-minute window', () => {
    const created = KeyManager.create({ name: 'rpm', rpmLimit: 2 });
    assert.equal(KeyManager.checkRateLimit(created.id, 2).ok, true);
    assert.equal(KeyManager.checkRateLimit(created.id, 2).ok, true);
    const third = KeyManager.checkRateLimit(created.id, 2);
    assert.equal(third.ok, false);
    assert.ok(third.retryAfterMs > 0);
  });

  it('treats rpm 0 as unlimited', () => {
    const created = KeyManager.create({ name: 'unlimited' });
    for (let i = 0; i < 5; i++) assert.equal(KeyManager.checkRateLimit(created.id, 0).ok, true);
  });

  it('falls back safely on NaN limits', () => {
    const created = KeyManager.create({ name: 'nan', rpmLimit: Number.NaN as any, dailyTokenLimit: Number.NaN as any });
    const row = db.prepare('SELECT rpm_limit, daily_token_limit FROM api_keys WHERE id = ?').get(created.id);
    assert.equal(row.rpm_limit, 60);
    assert.equal(row.daily_token_limit, 0);
  });

  it('reserves and releases in-flight tokens', () => {
    const created = KeyManager.create({ name: 'reserve' });
    KeyManager.reserveTokens(created.id, 100);
    KeyManager.reserveTokens(created.id, 50);
    assert.equal(KeyManager.pendingFor(created.id), 150);
    KeyManager.releaseTokens(created.id, 150);
    assert.equal(KeyManager.pendingFor(created.id), 0);
    KeyManager.releaseTokens(created.id, 999);
    assert.equal(KeyManager.pendingFor(created.id), 0);
  });

  it('records usage and aggregates it', () => {
    const created = KeyManager.create({ name: 'usage' });
    KeyManager.recordUsage({
      keyId: created.id,
      model: 'm',
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      statusCode: 200,
      latencyMs: 12,
      upstream: 'http://x/v1',
      egressNodeId: 1
    });
    assert.equal(KeyManager.tokensUsedToday(created.id), 15);
    const summary = KeyManager.usageSummary(created.id);
    assert.equal(summary.requests, 1);
    assert.equal(summary.total_tokens, 15);
    const key = db.prepare('SELECT total_requests, total_tokens FROM api_keys WHERE id = ?').get(created.id);
    assert.equal(key.total_requests, 1);
    assert.equal(key.total_tokens, 15);
  });
});
