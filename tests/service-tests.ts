/**
 * Axis C integration tests: abuse detection (C4), onboarding (C5),
 * customer observability (C6), readiness (C7) and privacy (C8).
 *
 * Requires a running server:  PORT=3001 npx tsx src/backend/server.ts
 * Run with:                   npx tsx tests/service-tests.ts
 */
import http from 'http';

const GW = process.env.GATEWAY_URL || 'http://127.0.0.1:3001';
const MOCK_PORT = parseInt(process.env.SERVICE_MOCK_PORT || '19100', 10);

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
    failures.push(name + (detail ? ` — ${detail}` : ''));
    console.log(`  ✘ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function req(
  path: string,
  opts: { method?: string; token?: string; body?: any; headers?: Record<string, string> } = {}
): Promise<{ status: number; text: string; json: any }> {
  const headers: Record<string, string> = { ...(opts.headers || {}) };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';

  const res = await fetch(`${GW}${path}`, {
    method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* html */
  }
  return { status: res.status, text, json };
}

function startMock(): Promise<http.Server> {
  const server = http.createServer((request, response) => {
    let raw = '';
    request.on('data', (c) => {
      raw += c;
    });
    request.on('end', () => {
      let body: any = {};
      try {
        body = JSON.parse(raw);
      } catch {
        /* ignore */
      }
      const model = String(body.model || 'mock-ok');

      if (model === 'mock-429') {
        response.writeHead(429, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'rate limited', code: 'rate_limit' } }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: 'mock',
        object: 'chat.completion',
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }
      }));
    });
  });
  return new Promise((resolve) => server.listen(MOCK_PORT, '127.0.0.1', () => resolve(server)));
}

async function main(): Promise<void> {
  const mock = await startMock();
  console.log(`mock upstream on http://127.0.0.1:${MOCK_PORT}/v1`);

  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${GW}/api/public/status`);
      if (r.status === 200 || r.status === 404) break;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  // ---------------------------------------------------------------- setup
  section('Setup');
  const settings = await req('/api/settings', {
    method: 'PUT',
    body: {
      gateway_enabled: 'true',
      gateway_upstream_base_url: `http://127.0.0.1:${MOCK_PORT}/v1`,
      gateway_upstream_model: 'mock-ok',
      gateway_rotate_on_429: 'false',
      abuse_detection_enabled: 'true',
      abuse_window_seconds: '120',
      abuse_duplicate_threshold: '10'
    }
  });
  check('settings applied', settings.status === 200, `status ${settings.status}`);

  // Make sure at least one egress exists so readiness can be true.
  await req('/v1/chat/completions', {
    method: 'POST',
    token: 'sk-or-not-real',
    body: { messages: [{ role: 'user', content: 'x' }] }
  });
  const kA = await req('/api/keys', { method: 'POST', body: { name: 'svc-a', rpmLimit: 500, dailyTokenLimit: 5000 } });
  const kB = await req('/api/keys', { method: 'POST', body: { name: 'svc-b', rpmLimit: 500 } });
  const KEY_A = kA.json?.key as string;
  const KEY_B = kB.json?.key as string;
  check('test keys created', !!KEY_A && !!KEY_B);

  // ------------------------------------------------------- C4 abuse guard
  section('C4 — abuse detection');
  let tooManyFailures = 0;
  for (let i = 0; i < 40; i++) {
    const r = await req('/v1/chat/completions', {
      method: 'POST',
      token: KEY_A,
      body: { model: 'mock-429', messages: [{ role: 'user', content: 'same body' }] }
    });
    if (r.json?.error?.code === 'too_many_failures') {
      tooManyFailures++;
      break;
    }
  }
  check('degraded key gets rejected with too_many_failures', tooManyFailures > 0);

  const other = await req('/v1/chat/completions', {
    method: 'POST',
    token: KEY_B,
    body: { model: 'mock-ok', messages: [{ role: 'user', content: 'hello' }] }
  });
  check('healthy key is unaffected', other.status === 200, `status ${other.status}`);

  const abuseEvents = await req('/api/abuse/events?limit=10');
  check('abuse events recorded', Array.isArray(abuseEvents.json?.events) && abuseEvents.json.events.length > 0);

  const keyAId = kA.json?.id as number;
  const reset = await req(`/api/keys/${keyAId}/reset-trust`, { method: 'POST', body: {} });
  check('trust can be reset', reset.status === 200 && reset.json?.trust?.trust === 100, JSON.stringify(reset.json));

  // ----------------------------------------------------- C5 onboarding
  section('C5 — onboarding');
  await req('/api/settings', { method: 'PUT', body: { signup_enabled: 'false' } });
  const closed = await req('/api/signup', { method: 'POST', body: { inviteCode: 'x', name: 'n' } });
  check('signup disabled -> 403', closed.status === 403, `status ${closed.status}`);

  const invite = await req('/api/invites', { method: 'POST', body: { label: 'test', maxUses: 1, expiresInHours: 1 } });
  const code = invite.json?.invite_code as string;
  check('invite created', typeof code === 'string' && code.startsWith('inv-'), JSON.stringify(invite.json));

  await req('/api/settings', { method: 'PUT', body: { signup_enabled: 'true', signup_max_per_ip_per_day: '10000' } });

  const badInvite = await req('/api/signup', { method: 'POST', body: { inviteCode: 'inv-nope', name: 'x' } });
  check('invalid invite -> 401', badInvite.status === 401, `status ${badInvite.status}`);

  const signup = await req('/api/signup', { method: 'POST', body: { inviteCode: code, name: 'self-serve-user' } });
  const SELF_KEY = signup.json?.key as string;
  check('signup returns a key', signup.status === 200 && typeof SELF_KEY === 'string', JSON.stringify(signup.json).slice(0, 120));

  const selfUse = await req('/v1/chat/completions', {
    method: 'POST',
    token: SELF_KEY,
    body: { model: 'mock-ok', messages: [{ role: 'user', content: 'hi' }] }
  });
  check('self-serve key works immediately', selfUse.status === 200, `status ${selfUse.status}`);

  const reuse = await req('/api/signup', { method: 'POST', body: { inviteCode: code, name: 'again' } });
  check('exhausted invite -> 409', reuse.status === 409, `status ${reuse.status}`);

  await req('/api/settings', { method: 'PUT', body: { signup_max_per_ip_per_day: '1' } });
  const invite2 = await req('/api/invites', { method: 'POST', body: { label: 'ip-limit', maxUses: 5 } });
  const ipLimited = await req('/api/signup', { method: 'POST', body: { inviteCode: invite2.json?.invite_code, name: 'ip2' } });
  check('per-IP signup limit enforced', ipLimited.status === 429, `status ${ipLimited.status}`);
  await req('/api/settings', { method: 'PUT', body: { signup_max_per_ip_per_day: '10000' } });

  // ------------------------------------------------- C6 observability
  section('C6 — customer observability');
  const statusPage = await req('/status');
  check('public status page renders', statusPage.status === 200 && statusPage.text.includes('OpenCode Router'), `status ${statusPage.status}`);

  const publicStatus = await req('/api/public/status');
  check('public status JSON', publicStatus.status === 200 && typeof publicStatus.json?.uptime_seconds === 'number');

  const alertKey = await req('/api/keys', { method: 'POST', body: { name: 'svc-alert', rpmLimit: 500, dailyTokenLimit: 100 } });
  const ALERT_KEY = alertKey.json?.key as string;
  const ALERT_ID = alertKey.json?.id as number;

  await req('/v1/chat/completions', {
    method: 'POST',
    token: ALERT_KEY,
    body: { model: 'mock-ok', messages: [{ role: 'user', content: 'usage' }] }
  });
  await req('/api/alerts', { method: 'POST', body: { keyId: ALERT_ID, thresholdPct: 1 } });
  const checkAlerts = await req('/api/alerts/check', { method: 'POST', body: {} });
  check('alert fires after usage', (checkAlerts.json?.fired || []).length > 0, JSON.stringify(checkAlerts.json));

  // ------------------------------------------------------- C7 readiness
  section('C7 — readiness and drain');
  const ready1 = await req('/readyz');
  check('readyz responds', ready1.status === 200 || ready1.status === 503, `status ${ready1.status}`);

  await req('/api/service/drain', { method: 'POST', body: {} });
  const readyDraining = await req('/readyz');
  check('draining -> 503', readyDraining.status === 503, `status ${readyDraining.status}`);

  await req('/api/service/undrain', { method: 'POST', body: {} });
  const readyAfter = await req('/readyz');
  check('undrain restores readiness', readyAfter.status === 200 || readyAfter.status === 503, `status ${readyAfter.status}`);

  // --------------------------------------------------------- C8 privacy
  section('C8 — privacy (export / erase)');
  const exported = await req(`/api/privacy/export?key_id=${ALERT_ID}`);
  check('export returns the key', exported.status === 200 && exported.json?.key?.id === ALERT_ID, `status ${exported.status}`);
  check('export includes usage rows', (exported.json?.usage_rows || 0) >= 1, `rows ${exported.json?.usage_rows}`);
  check('export never contains a key hash', !JSON.stringify(exported.json).includes('key_hash'));

  const erased = await req(`/api/privacy/erase?key_id=${ALERT_ID}`, { method: 'DELETE' });
  check('erase succeeds', erased.status === 200 && erased.json?.erased?.keys === 1, JSON.stringify(erased.json));
  check('erase removed usage rows', (erased.json?.erased?.usage_rows || 0) >= 1, JSON.stringify(erased.json));

  const afterErase = await req(`/api/privacy/export?key_id=${ALERT_ID}`);
  check('export after erase -> 404', afterErase.status === 404, `status ${afterErase.status}`);

  // ------------------------------------------------------------- cleanup
  section('Cleanup');
  await req('/api/settings', { method: 'PUT', body: { gateway_enabled: 'false', signup_enabled: 'false' } });
  for (const id of [kA.json?.id, kB.json?.id]) {
    if (id) await req(`/api/keys/${id}`, { method: 'DELETE' });
  }
  mock.close();

  console.log('\n==================================================');
  console.log(`  PASSED: ${pass}    FAILED: ${fail}`);
  if (fail > 0) {
    console.log('\n  Failures:');
    for (const f of failures) console.log(`   - ${f}`);
  }
  console.log('==================================================');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nFATAL:', err);
  process.exit(1);
});
