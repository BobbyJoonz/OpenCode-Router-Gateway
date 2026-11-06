/**
 * Axis D acceptance tests: D2 (freshness), D4 (providers/failover), D5 (cost).
 *
 *   npx tsx tests/axis-d-tests.ts
 */
import assert from 'assert';
import http from 'http';
import { initDatabase, db } from '../src/backend/db/database';
import { FreshnessTracker } from '../src/backend/tester/freshness';
import { ProviderRegistry } from '../src/backend/providers/provider-registry';
import { ProviderSelector } from '../src/backend/providers/provider-selector';
import { ProviderRouter } from '../src/backend/gateway/provider-router';
import { costOf, upsertPrice, spendToday } from '../src/backend/gateway/cost';
import { KeyManager } from '../src/backend/gateway/key-manager';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    pass++;
    console.log(`  ✔ ${name}`);
  } else {
    fail++;
    failures.push(name + (detail ? ` — ${detail}` : ''));
    console.log(`  ✘ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n▶ ${title}`);
}

function startMock(status: number): Promise<{ url: string; port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      if (status >= 200 && status < 300) {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'mock',
            object: 'chat.completion',
            model: 'mock-model',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
          })
        );
      } else {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'mock failure', type: 'server_error', code: 'mock' } }));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        port,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          })
      });
    });
  });
}

async function main(): Promise<void> {
  initDatabase();

  // Clean up anything left by a previous run.
  db.prepare("DELETE FROM providers WHERE name LIKE 'axis-d-%'").run();
  db.prepare("DELETE FROM configs WHERE address = '203.0.113.9'").run();
  db.prepare("DELETE FROM api_keys WHERE name LIKE 'axis-d-%'").run();
  ProviderSelector.reset();

  // ------------------------------------------------------------------ D2
  section('D2 — freshness scoring');
  check('fresh node scores 100', FreshnessTracker.scoreFrom(0, 0, null) === 100, String(FreshnessTracker.scoreFrom(0, 0, null)));
  check('5 rate-limit hits cost 35 points', FreshnessTracker.scoreFrom(5, 0, null) === 65, String(FreshnessTracker.scoreFrom(5, 0, null)));
  check('streak bonus is capped at +20', FreshnessTracker.scoreFrom(0, 50, null) === 100, String(FreshnessTracker.scoreFrom(0, 50, null)));
  check('surviving 50 requests before 429 keeps full score', FreshnessTracker.scoreFrom(0, 0, 50) === 100);
  check('surviving 5 requests before 429 collapses to 20', FreshnessTracker.scoreFrom(0, 0, 5) === 20, String(FreshnessTracker.scoreFrom(0, 0, 5)));
  check('penalty is capped at 70', FreshnessTracker.scoreFrom(50, 0, null) === 30, String(FreshnessTracker.scoreFrom(50, 0, null)));

  db.prepare(
    `INSERT INTO configs (protocol, address, port, remark, security, network, raw_url, config_hash, last_status, details_json)
     VALUES ('vless', '203.0.113.9', 443, 'axis-d freshness probe', 'tls', 'ws', 'vless://test', 'axis-d-hash-1', 'working', '{}')`
  ).run();
  const nodeId = (db.prepare("SELECT id FROM configs WHERE config_hash = 'axis-d-hash-1'").get() as { id: number }).id;

  FreshnessTracker.recordSuccess(nodeId);
  FreshnessTracker.recordSuccess(nodeId);
  FreshnessTracker.recordSuccess(nodeId);
  let snapshot = FreshnessTracker.snapshot(nodeId)!;
  check('three successes raise the streak', snapshot.successStreak === 3, JSON.stringify(snapshot));

  FreshnessTracker.recordRateLimit(nodeId);
  snapshot = FreshnessTracker.snapshot(nodeId)!;
  check('a 429 records the streak as requests-before-429', snapshot.requestsBefore429 === 3, JSON.stringify(snapshot));
  check('a 429 resets the streak', snapshot.successStreak === 0);
  check('a 429 increments rate-limit hits', snapshot.rateLimitHits === 1);
  check('a 429 lowers the score below 100', snapshot.freshnessScore < 100, String(snapshot.freshnessScore));

  const avg = FreshnessTracker.averageRequestsBefore429();
  check('average requests-before-429 is reported as a number', !!avg && avg.samples >= 1, JSON.stringify(avg));

  // ------------------------------------------------------------------ D5
  section('D5 — cost accounting');
  upsertPrice('axis-d-model', 2, 8);
  const exactCost = costOf('axis-d-model', 1_000_000, 1_000_000);
  check('1M in + 1M out at $2/$8 costs $10', exactCost === 10, String(exactCost));
  check('half a million tokens costs half', costOf('axis-d-model', 500_000, 0) === 1, String(costOf('axis-d-model', 500_000, 0)));
  check('negative tokens are clamped to zero cost', costOf('axis-d-model', -5, -5) === 0);
  check('unknown model falls back to the cheapest known price', costOf('nope-not-priced', 0, 0) === 0);

  // ------------------------------------------------------------------ D4
  section('D4 — provider failover');
  const providerA = await startMock(500); // unhealthy upstream
  const providerB = await startMock(200); // healthy upstream

  process.env.AXIS_D_KEY_A = 'test-key-a';
  process.env.AXIS_D_KEY_B = 'test-key-b';

  ProviderRegistry.create({
    name: 'axis-d-a',
    base_url: providerA.url,
    key_env: 'AXIS_D_KEY_A',
    priority: 10,
    cost_per_1m_in: 0
  });
  ProviderRegistry.create({
    name: 'axis-d-b',
    base_url: providerB.url,
    key_env: 'AXIS_D_KEY_B',
    priority: 20,
    cost_per_1m_in: 5
  });

  const ordered = ProviderRegistry.enabled().filter((p) => p.name.startsWith('axis-d-'));
  check('providers are stored and listed', ordered.length === 2, String(ordered.length));
  check('provider keys resolve from the environment', ProviderRegistry.hasKey(ordered[0]));
  check('priority ordering puts the cheap/free provider first', ordered[0].name === 'axis-d-a', ordered[0].name);

  const selected = ProviderSelector.select([]);
  check('selector picks the highest-priority provider', selected?.name === 'axis-d-a', selected?.name);

  const routed = await ProviderRouter.forward({
    method: 'POST',
    path: '/chat/completions',
    httpProxyPort: 1, // unused: loopback upstreams bypass the tunnel
    body: { model: 'mock-model', messages: [{ role: 'user', content: 'x' }] },
    timeoutMs: 5000
  });
  check('a failing provider is skipped automatically', routed.forwarded.statusCode === 200, String(routed.forwarded.statusCode));
  check('the request lands on the healthy provider', routed.provider.name === 'axis-d-b', routed.provider.name);
  check('failover took more than one attempt', routed.attempts === 2, String(routed.attempts));

  const failureEvents = db
    .prepare("SELECT COUNT(*) AS c FROM provider_events WHERE event = 'server' AND provider_id = ?")
    .get(ordered[0].id) as { c: number };
  check('the failure is recorded as a provider event', failureEvents.c >= 1, String(failureEvents.c));
  check('the failed provider enters cooldown', ProviderSelector.isCooling(ordered[0].id));

  // All providers dead -> the router must throw, not hang.
  await providerB.close();
  let threw = false;
  try {
    await ProviderRouter.forward({
      method: 'POST',
      path: '/chat/completions',
      httpProxyPort: 1,
      body: { model: 'mock-model', messages: [{ role: 'user', content: 'x' }] },
      timeoutMs: 2000
    });
  } catch {
    threw = true;
  }
  check('router throws when every provider is unreachable', threw);

  // ------------------------------------------------------------------ spend
  section('D5 — spend accounting per key');
  const created = KeyManager.create({ name: 'axis-d-key', rpmLimit: 100, spendCapDailyUsd: 1 });
  KeyManager.recordUsage({
    keyId: created.id,
    model: 'axis-d-model',
    promptTokens: 1_000_000,
    completionTokens: 0,
    totalTokens: 1_000_000,
    statusCode: 200,
    latencyMs: 10,
    upstream: 'mock',
    egressNodeId: nodeId,
    providerId: ordered[1].id,
    costUsd: costOf('axis-d-model', 1_000_000, 0)
  });
  const spent = spendToday(created.id);
  check('usage records the dollar cost', spent === 2, String(spent));
  const keyRow = KeyManager.list().find((k) => k.id === created.id)!;
  check('key exposes its daily spend cap', keyRow.spend_cap_usd_daily === 1, String(keyRow.spend_cap_usd_daily));

  // ------------------------------------------------------------------ cleanup
  section('Cleanup');
  db.prepare("DELETE FROM providers WHERE name LIKE 'axis-d-%'").run();
  db.prepare("DELETE FROM configs WHERE config_hash = 'axis-d-hash-1'").run();
  KeyManager.revoke(created.id);
  db.prepare("DELETE FROM usage_log WHERE key_id IS NULL OR key_id NOT IN (SELECT id FROM api_keys)").run();
  await providerA.close();
  ProviderSelector.reset();

  console.log('\n==================================================');
  console.log(`  PASSED: ${pass}    FAILED: ${fail}`);
  if (fail > 0) {
    console.log('\n  Failures:');
    for (const failure of failures) console.log(`   - ${failure}`);
  }
  console.log('==================================================');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
