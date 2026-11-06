/**
 * Retention / storage-bound tests.
 *
 * Runs against a throwaway in-memory database so it never touches real data.
 */
import Database from 'better-sqlite3';
import { applyRetention } from '../src/backend/service/retention';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`  ✔ ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✘ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE usage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key_id INTEGER,
      model TEXT,
      total_tokens INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE test_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      config_id INTEGER,
      timestamp TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE prescreen_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE configs (id INTEGER PRIMARY KEY AUTOINCREMENT, address TEXT);
    CREATE TABLE api_keys (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
  `);
  return db;
}

function main(): void {
  // ---------------------------------------------------------- age pruning
  console.log('\n▶ Age-based pruning');
  {
    const db = makeDb();
    const insert = db.prepare(`INSERT INTO usage_log (created_at) VALUES (datetime('now', ?))`);
    for (let i = 0; i < 100; i++) insert.run('-200 days');
    for (let i = 0; i < 50; i++) insert.run('-1 days');

    const result = applyRetention(db, {
      usageRetentionDays: 90,
      testHistoryRetentionDays: 30,
      usageMaxRows: 0,
      vacuumThreshold: 999999
    });

    const remaining = (db.prepare('SELECT COUNT(*) c FROM usage_log').get() as any).c;
    check('old rows deleted', result.deletedUsage === 100, String(result.deletedUsage));
    check('recent rows kept', remaining === 50, String(remaining));
    db.close();
  }

  // ---------------------------------------------------------- row cap
  console.log('\n▶ Hard row cap');
  {
    const db = makeDb();
    const insert = db.prepare(`INSERT INTO usage_log (created_at) VALUES (datetime('now'))`);
    for (let i = 0; i < 120; i++) insert.run();

    const result = applyRetention(db, {
      usageRetentionDays: 0,
      testHistoryRetentionDays: 0,
      usageMaxRows: 100,
      vacuumThreshold: 999999
    });

    const remaining = (db.prepare('SELECT COUNT(*) c FROM usage_log').get() as any).c;
    check('excess rows removed', result.deletedUsage === 20, String(result.deletedUsage));
    check('row count capped', remaining === 100, String(remaining));

    const oldest = (db.prepare('SELECT MIN(id) id FROM usage_log').get() as any).id;
    check('oldest rows are the ones removed', oldest === 21, String(oldest));
    db.close();
  }

  // ---------------------------------------------------------- user data safe
  console.log('\n▶ User data is never touched');
  {
    const db = makeDb();
    db.prepare("INSERT INTO configs (address) VALUES ('1.2.3.4')").run();
    db.prepare("INSERT INTO api_keys (name) VALUES ('alice')").run();
    db.prepare("INSERT INTO usage_log (created_at) VALUES (datetime('now','-999 days'))").run();

    applyRetention(db, {
      usageRetentionDays: 1,
      testHistoryRetentionDays: 1,
      usageMaxRows: 1,
      vacuumThreshold: 999999
    });

    check('configs preserved', (db.prepare('SELECT COUNT(*) c FROM configs').get() as any).c === 1);
    check('api keys preserved', (db.prepare('SELECT COUNT(*) c FROM api_keys').get() as any).c === 1);
    db.close();
  }

  // ---------------------------------------------------------- history + runs
  console.log('\n▶ Test history and prescreen runs');
  {
    const db = makeDb();
    db.prepare("INSERT INTO test_history (timestamp) VALUES (datetime('now','-90 days'))").run();
    db.prepare("INSERT INTO test_history (timestamp) VALUES (datetime('now'))").run();
    for (let i = 0; i < 130; i++) db.prepare('INSERT INTO prescreen_runs DEFAULT VALUES').run();

    const result = applyRetention(db, {
      usageRetentionDays: 0,
      testHistoryRetentionDays: 30,
      usageMaxRows: 0,
      vacuumThreshold: 999999
    });

    check('old history deleted', result.deletedHistory === 1, String(result.deletedHistory));
    check('recent history kept', (db.prepare('SELECT COUNT(*) c FROM test_history').get() as any).c === 1);
    check('prescreen runs capped at 100', (db.prepare('SELECT COUNT(*) c FROM prescreen_runs').get() as any).c === 100);
    db.close();
  }

  // ---------------------------------------------------------- idempotency
  console.log('\n▶ Idempotency and safety');
  {
    const db = makeDb();
    const opts = { usageRetentionDays: 30, testHistoryRetentionDays: 30, usageMaxRows: 10, vacuumThreshold: 999999 };
    const first = applyRetention(db, opts);
    const second = applyRetention(db, opts);
    check('empty database is a no-op', first.deletedUsage === 0 && second.deletedUsage === 0);
    check('no throw on empty tables', true);

    // retention disabled means "keep everything"
    const db2 = makeDb();
    for (let i = 0; i < 5; i++) db2.prepare("INSERT INTO usage_log (created_at) VALUES (datetime('now','-999 days'))").run();
    applyRetention(db2, { usageRetentionDays: 0, testHistoryRetentionDays: 0, usageMaxRows: 0, vacuumThreshold: 999999 });
    check('retention 0 keeps everything', (db2.prepare('SELECT COUNT(*) c FROM usage_log').get() as any).c === 5);
    db.close();
    db2.close();
  }

  console.log('\n==================================================');
  console.log(`  PASSED: ${pass}    FAILED: ${fail}`);
  if (fail > 0) {
    console.log('\n  Failures:');
    for (const f of failures) console.log(`   - ${f}`);
  }
  console.log('==================================================\n');
  process.exit(fail === 0 ? 0 : 1);
}

main();
