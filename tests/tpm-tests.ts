/**
 * TPM aggregation tests (unit, no server).
 *
 * Uses the real database only to create throwaway providers; the tracker itself
 * is pure in-memory.
 */
import { TpmTracker } from '../src/backend/providers/tpm-tracker';
import { ProviderRegistry } from '../src/backend/providers/provider-registry';
import { ProviderSelector } from '../src/backend/providers/provider-selector';
import { initDatabase } from '../src/backend/db/database';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function section(t: string): void {
  console.log(`\n▶ ${t}`);
}

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

function main(): void {
  initDatabase();
  process.env.MOCK_TPM_KEY_A = 'k';
  process.env.MOCK_TPM_KEY_B = 'k';

  section('Estimation');
  {
    const body = { messages: [{ role: 'user', content: 'x'.repeat(4000) }] };
    const estimate = TpmTracker.estimateFromBody(body);
    check('estimate is about chars/4', estimate >= 1000 && estimate <= 1100, String(estimate));
    check('empty body has a small estimate', TpmTracker.estimateFromBody({}) < 100);
    check('non-object body is safe', TpmTracker.estimateFromBody(null) >= 0);
  }

  section('Window accounting');
  {
    TpmTracker.reset();
    TpmTracker.record(1, 500);
    TpmTracker.record(1, 300);
    check('records accumulate', TpmTracker.used(1) === 800, String(TpmTracker.used(1)));
    check('unlimited provider always accepts', TpmTracker.canAccept(1, 999999, 0));
    check('limited provider rejects over budget', !TpmTracker.canAccept(1, 300, 1000));
    check('limited provider accepts within budget', TpmTracker.canAccept(1, 100, 1000));
    check('totals are lifetime', TpmTracker.totalFor(1) === 800, String(TpmTracker.totalFor(1)));
    TpmTracker.reset();
    check('reset clears the window', TpmTracker.used(1) === 0);
  }

  section('Provider selection respects TPM');
  {
    TpmTracker.reset();
    const a = ProviderRegistry.create({
      name: 'tpm-a',
      base_url: 'http://127.0.0.1:1/v1',
      key_env: 'MOCK_TPM_KEY_A',
      priority: 1,
      tpm_limit: 1000
    });
    const b = ProviderRegistry.create({
      name: 'tpm-b',
      base_url: 'http://127.0.0.1:2/v1',
      key_env: 'MOCK_TPM_KEY_B',
      priority: 2,
      tpm_limit: 1000
    });
    check('tpm_limit persisted', a.tpm_limit === 1000 && b.tpm_limit === 1000);

    let candidates = ProviderSelector.candidates([], 100);
    check('both providers available with room', candidates.length === 2, String(candidates.length));

    TpmTracker.record(a.id, 950);
    candidates = ProviderSelector.candidates([], 100);
    check('provider over budget is excluded', candidates.length === 1 && candidates[0].id === b.id, JSON.stringify(candidates.map((c) => c.id)));

    TpmTracker.record(b.id, 950);
    candidates = ProviderSelector.candidates([], 100);
    check('all providers over budget yields none', candidates.length === 0, String(candidates.length));

    TpmTracker.reset();
    ProviderRegistry.remove(a.id);
    ProviderRegistry.remove(b.id);
    check('cleanup removed providers', ProviderRegistry.list().every((p) => p.name !== 'tpm-a' && p.name !== 'tpm-b'));
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
