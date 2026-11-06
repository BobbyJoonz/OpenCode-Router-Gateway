/**
 * Real-provider contract test.
 *
 * Everything else in this repository is validated against a mock. This suite is
 * the only one that talks to a REAL provider through a REAL egress slot, and it
 * is what turns "should work" into "does work".
 *
 *   PROVIDER_TEST_BASE_URL=https://api.openai.com/v1 \
 *   PROVIDER_TEST_API_KEY=sk-... \
 *   PROVIDER_TEST_MODEL=gpt-4o-mini \
 *   npm run test:provider
 *
 * Exits 0 with a SKIP message when the variables are absent, so CI stays green.
 */
import { initDatabase } from '../src/backend/db/database';
import { egressPool } from '../src/backend/vpn/egress-pool';
import { UpstreamClient } from '../src/backend/gateway/upstream-client';

const BASE_URL = (process.env.PROVIDER_TEST_BASE_URL || '').trim();
const API_KEY = (process.env.PROVIDER_TEST_API_KEY || '').trim();
const MODEL = (process.env.PROVIDER_TEST_MODEL || 'gpt-4o-mini').trim();

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

async function main(): Promise<void> {
  if (!BASE_URL || !API_KEY) {
    console.log('\nSKIP: set PROVIDER_TEST_BASE_URL and PROVIDER_TEST_API_KEY to run the real-provider contract test.\n');
    process.exit(0);
  }

  console.log(`\nReal provider contract test`);
  console.log(`  base: ${BASE_URL}`);
  console.log(`  model: ${MODEL}\n`);

  process.env.GATEWAY_UPSTREAM_BASE_URL = BASE_URL;
  process.env.GATEWAY_UPSTREAM_API_KEY = API_KEY;

  initDatabase();
  egressPool.init(1);
  const started = await egressPool.ensureAll();
  check('egress slot started', started >= 1, `started=${started}`);

  const slot = await egressPool.acquire(null);
  check('egress slot acquired', !!slot);
  if (!slot) {
    await egressPool.shutdown();
    process.exit(1);
  }
  egressPool.track(slot);

  try {
    // ---------------------------------------------------------- models
    const models = await UpstreamClient.forward({
      method: 'GET',
      path: '/models',
      httpProxyPort: slot.httpPort,
      timeoutMs: 30000
    });
    const modelsText = await UpstreamClient.readAll(models.body).catch(() => '');
    models.cleanup();
    check('GET /models -> 2xx', models.statusCode >= 200 && models.statusCode < 300, `status ${models.statusCode}`);
    check('GET /models returns JSON', modelsText.trim().startsWith('{'), modelsText.slice(0, 80));

    // ---------------------------------------------------------- non-stream
    const body = {
      model: MODEL,
      messages: [{ role: 'user', content: 'Reply with exactly: CONTRACT_OK' }],
      max_tokens: 16
    };
    const nonStream = await UpstreamClient.forward({
      method: 'POST',
      path: '/chat/completions',
      httpProxyPort: slot.httpPort,
      body,
      timeoutMs: 90000
    });
    const nonStreamText = await UpstreamClient.readAll(nonStream.body).catch(() => '');
    nonStream.cleanup();
    check('POST /chat/completions -> 2xx', nonStream.statusCode >= 200 && nonStream.statusCode < 300, `status ${nonStream.statusCode}`);
    let parsed: any = null;
    try {
      parsed = JSON.parse(nonStreamText);
    } catch {
      /* handled below */
    }
    check('response has choices[0].message', !!parsed?.choices?.[0]?.message);
    check('response has usage.prompt_tokens', Number(parsed?.usage?.prompt_tokens) > 0, JSON.stringify(parsed?.usage));
    check('response has usage.completion_tokens', Number(parsed?.usage?.completion_tokens) >= 0, JSON.stringify(parsed?.usage));

    // ---------------------------------------------------------- stream
    const stream = await UpstreamClient.forward({
      method: 'POST',
      path: '/chat/completions',
      httpProxyPort: slot.httpPort,
      body: { ...body, stream: true, stream_options: { include_usage: true } },
      accept: 'text/event-stream',
      timeoutMs: 90000
    });
    check('stream -> 2xx', stream.statusCode >= 200 && stream.statusCode < 300, `status ${stream.statusCode}`);

    let streamText = '';
    try {
      for await (const chunk of stream.body) {
        streamText += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        if (streamText.length > 200000) break;
      }
    } finally {
      stream.cleanup();
    }
    check('stream contains data: chunks', streamText.includes('data:'));
    check('stream terminates with [DONE]', streamText.includes('[DONE]'));
    check(
      'stream reports usage (needed for quotas)',
      /"usage"\s*:\s*\{/.test(streamText),
      'provider ignored stream_options.include_usage — token quotas will not work for streaming'
    );

    // ---------------------------------------------------------- bad model
    const bad = await UpstreamClient.forward({
      method: 'POST',
      path: '/chat/completions',
      httpProxyPort: slot.httpPort,
      body: { model: 'definitely-not-a-real-model-xyz', messages: [{ role: 'user', content: 'x' }] },
      timeoutMs: 30000
    });
    await UpstreamClient.readAll(bad.body).catch(() => '');
    bad.cleanup();
    check('invalid model -> 4xx', bad.statusCode >= 400 && bad.statusCode < 500, `status ${bad.statusCode}`);
  } finally {
    egressPool.release(slot);
    await egressPool.shutdown();
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

main().catch(async (err) => {
  console.error('FATAL:', err);
  try {
    await egressPool.shutdown();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
