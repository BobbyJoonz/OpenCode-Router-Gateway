/**
 * A brand-new install must be able to start.
 *
 * Regression: service-migrations seeded `model_prices` but no migration created
 * it, so the first start on an empty database crashed with
 * "SqliteError: no such table: model_prices". This test points the app at a
 * temporary data directory and runs the real init path.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`  OK   ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-router-fresh-'));
  process.env.APP_ROOT = tmp;

  console.log('\nFresh database initialization');
  console.log(`  data dir: ${tmp}\n`);

  // CJS require: the module reads APP_ROOT when it is first loaded, so it must
  // not be imported before the temporary directory above is set.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { initDatabase, db } = require('../src/backend/db/database');

  let threw: any = null;
  try {
    initDatabase();
  } catch (err: any) {
    threw = err;
  }
  check('initDatabase runs on an empty directory', !threw, threw?.message);

  const tableExists = (name: string): boolean =>
    !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);

  for (const table of ['configs', 'usage_log', 'api_keys', 'settings', 'model_prices', 'pool_slots', 'abuse_events']) {
    check(`${table} exists`, tableExists(table));
  }

  if (tableExists('model_prices')) {
    const prices = db.prepare('SELECT COUNT(*) AS c FROM model_prices').get() as { c: number };
    check('prices are seeded', prices.c > 0, String(prices.c));
    const cols = (db.prepare('PRAGMA table_info(model_prices)').all() as Array<{ name: string }>).map((c) => c.name);
    check('canonical price columns present', cols.includes('cost_per_1m_in') && cols.includes('cost_per_1m_out'), cols.join(','));
  }

  // A second init must be a no-op (idempotent migrations).
  let secondThrew: any = null;
  try {
    initDatabase();
  } catch (err: any) {
    secondThrew = err;
  }
  check('initDatabase is idempotent', !secondThrew, secondThrew?.message);

  try {
    db.close();
  } catch {
    /* ignore */
  }
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(`\n  PASSED: ${pass}    FAILED: ${fail}`);
  if (fail > 0) {
    console.log('\n  Failures:');
    for (const f of failures) console.log(`   - ${f}`);
  }
  console.log('');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
