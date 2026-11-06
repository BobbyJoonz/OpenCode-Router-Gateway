/**
 * Readiness check from the command line.
 *
 *   npm run doctor            # local checks only
 *   npm run doctor -- --live  # also performs one real upstream call
 *
 * Exit code 0 = ready, 1 = not ready. Safe to run in CI or a cron.
 */
import { initDatabase } from '../src/backend/db/database';
import { Doctor } from '../src/backend/doctor';
import { egressPool } from '../src/backend/vpn/egress-pool';

async function main(): Promise<void> {
  initDatabase();

  egressPool.init();
  await egressPool.ensureAll();

  const live = process.argv.includes('--live');
  const report = await Doctor.run({ live });

  console.log('\n══════════════════════════════════════════════════════════');
  console.log(` OpenCode Router Gateway — readiness report`);
  console.log('══════════════════════════════════════════════════════════\n');

  for (const check of report.checks) {
    const mark = check.ok ? '✔' : check.fatal ? '✘' : '!';
    console.log(` ${mark} ${check.name.padEnd(22)} ${check.detail}`);
    if (!check.ok && check.hint) console.log(`   ↳ ${check.hint}`);
  }

  console.log('\n──────────────────────────────────────────────────────────');
  console.log(` ${report.summary}`);
  console.log(
    ` nodes=${report.counts.configs} working=${report.counts.working} tcpAlive=${report.counts.tcpAlive} ` +
      `pool=${report.counts.poolReady}/${report.counts.poolSize} keys=${report.counts.keys}`
  );
  console.log('──────────────────────────────────────────────────────────\n');

  await egressPool.shutdown();
  process.exit(report.ok ? 0 : 1);
}

main().catch(async (err) => {
  console.error('doctor failed:', err);
  try {
    await egressPool.shutdown();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
