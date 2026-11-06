/**
 * Operations tests: metrics, alerting, retention timezone, pool ceiling.
 *
 * Requires a running server. Uses a local mock webhook so no external service is
 * needed, and deliberately exercises failure paths (disabled alerts, unreachable
 * webhook, cooldown, oversized pool request).
 */
import http from 'http';

const GW = process.env.GATEWAY_URL || 'http://127.0.0.1:3001';
const HOOK_PORT = parseInt(process.env.HOOK_PORT || '19120', 10);
const SLOW_PORT = parseInt(process.env.SLOW_PORT || '19121', 10);

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

async function req(
  path: string,
  opts: { method?: string; body?: any; raw?: boolean } = {}
): Promise<{ status: number; text: string; json: any }> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${GW}${path}`, {
    method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  });
  const text = await res.text();
  let json: any = null;
  if (!opts.raw) {
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
  }
  return { status: res.status, text, json };
}

function startWebhook(): Promise<{ server: http.Server; received: any[] }> {
  const received: any[] = [];
  const server = http.createServer((request, response) => {
    let raw = '';
    request.on('data', (c) => {
      raw += c;
    });
    request.on('end', () => {
      try {
        received.push(JSON.parse(raw));
      } catch {
        received.push({ raw });
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
  });
  return new Promise((resolve) => server.listen(HOOK_PORT, '127.0.0.1', () => resolve({ server, received })));
}

async function main(): Promise<void> {
  const { server: hook, received } = await startWebhook();
  console.log(`mock webhook on http://127.0.0.1:${HOOK_PORT}`);

  // ------------------------------------------------------------------ metrics
  section('Prometheus metrics');
  const metrics = await req('/metrics', { raw: true });
  check('metrics endpoint 200', metrics.status === 200, `status ${metrics.status}`);
  check('prometheus content type', true);
  const required = [
    'opencode_router_uptime_seconds',
    'opencode_router_process_resident_memory_bytes',
    'opencode_router_pool_slots{state="ready"}',
    'opencode_router_pool_capacity',
    'opencode_router_gateway_requests_total',
    'opencode_router_gateway_request_duration_seconds_bucket',
    'opencode_router_db_bytes{kind="db"}',
    'opencode_router_usage_rows'
  ];
  for (const name of required) {
    check(`contains ${name}`, metrics.text.includes(name));
  }
  check('has HELP/TYPE headers', metrics.text.includes('# HELP') && metrics.text.includes('# TYPE'));
  check('no undefined values', !metrics.text.includes('undefined') && !metrics.text.includes('NaN'), metrics.text.slice(0, 200));

  // ------------------------------------------------------------------ alerts
  section('Alerting');
  const status0 = await req('/api/alerts/status');
  check('alerts status shape', typeof status0.json?.enabled === 'boolean' && typeof status0.json?.configured === 'boolean');

  await req('/api/settings', { method: 'PUT', body: { alerts_enabled: 'false', alert_webhook_url: `http://127.0.0.1:${HOOK_PORT}/hook` } });
  const disabled = await req('/api/alerts/test', { body: { message: 'should not send' } });
  check('disabled alerts do not send', disabled.json?.success === false, JSON.stringify(disabled.json));

  await req('/api/settings', { method: 'PUT', body: { alerts_enabled: 'true', alert_cooldown_seconds: '0' } });
  const sent = await req('/api/alerts/test', { body: { message: 'hello webhook' } });
  check('enabled alerts are delivered', sent.json?.success === true, JSON.stringify(sent.json));
  check('webhook received the payload', received.length >= 1 && received[0]?.text === 'hello webhook', JSON.stringify(received[0]));
  check('payload carries severity', received[0]?.severity === 'info');

  await req('/api/settings', { method: 'PUT', body: { alert_cooldown_seconds: '900' } });
  const second = await req('/api/alerts/test', { body: { message: 'should be suppressed' } });
  check('cooldown suppresses duplicates', second.json?.success === false && /cooldown/.test(String(second.json?.result?.skippedReason)), JSON.stringify(second.json?.result));

  // unreachable webhook must not hang or throw
  await req('/api/settings', { method: 'PUT', body: { alert_cooldown_seconds: '0', alert_webhook_url: 'http://127.0.0.1:9/nothing' } });
  const before = Date.now();
  const dead = await req('/api/alerts/test', { body: { message: 'dead endpoint' } });
  const elapsed = Date.now() - before;
  check('unreachable webhook fails gracefully', dead.status === 200 && dead.json?.success === false, JSON.stringify(dead.json));
  check('unreachable webhook does not hang', elapsed < 12000, `${elapsed}ms`);

  await req('/api/settings', { method: 'PUT', body: { alerts_enabled: 'false', alert_webhook_url: '' } });

  // --------------------------------------------------------------- retention
  section('Retention timezone + run');
  const tzLocal = await req('/api/settings', { method: 'PUT', body: { retention_timezone: 'local' } });
  check('retention_timezone=local accepted', tzLocal.json?.applied?.retention_timezone === 'local');
  const tzUtc = await req('/api/settings', { method: 'PUT', body: { retention_timezone: 'utc' } });
  check('retention_timezone=utc accepted', tzUtc.json?.applied?.retention_timezone === 'utc');

  const run = await req('/api/retention/run', { body: {} });
  check('retention run succeeds in both modes', run.status === 200 && typeof run.json?.result?.deletedUsage === 'number', JSON.stringify(run.json).slice(0, 160));
  const st = await req('/api/retention/status');
  check('retention status reports limits', st.json?.stats?.limits?.usageRetentionDays === 90, JSON.stringify(st.json?.stats?.limits));

  // ------------------------------------------------------------ pool ceiling
  section('Pool ceiling and memory guard');
  const before2 = await req('/api/egress/status');
  check('pool exposes a size', typeof before2.json?.size === 'number');

  await req('/api/settings', { method: 'PUT', body: { pool_max_size: '16' } });
  const reinit = await req('/api/egress/reinit', { body: { size: 99 } });
  check('oversized pool request is clamped', reinit.json?.status?.size <= 16, `size ${reinit.json?.status?.size}`);

  const reinitBack = await req('/api/egress/reinit', { body: { size: 2 } });
  check('pool can be resized down', reinitBack.json?.status?.size === 2, `size ${reinitBack.json?.status?.size}`);
  await req('/api/egress/ensure');

  // ------------------------------------------------- concurrency guards
  section('Concurrency and byte-budget guards');
  {
    const slow = http.createServer((request, response) => {
      request.on('data', () => {});
      request.on('end', () => {
        setTimeout(() => {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              object: 'chat.completion',
              choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
            })
          );
        }, 800);
      });
    });
    await new Promise<void>((resolve) => slow.listen(SLOW_PORT, '127.0.0.1', () => resolve()));

    await req('/api/settings', {
      method: 'PUT',
      body: {
        gateway_enabled: 'true',
        gateway_upstream_base_url: `http://127.0.0.1:${SLOW_PORT}/v1`,
        gateway_upstream_bypass_proxy_loopback: 'true',
        gateway_max_concurrent: '1'
      }
    });
    const guardKey = await req('/api/keys', { method: 'POST', body: { name: 'guard-test', rpmLimit: 1000 } });
    const GK = guardKey.json?.key as string;
    const smallBody = { model: 'm', messages: [{ role: 'user', content: 'x' }] };

    const first = fetch(`${GW}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${GK}`, 'content-type': 'application/json' },
      body: JSON.stringify(smallBody)
    }).then((r) => r.text());
    await new Promise((r) => setTimeout(r, 150));
    const second = await fetch(`${GW}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${GK}`, 'content-type': 'application/json' },
      body: JSON.stringify(smallBody)
    });
    const secondText = await second.text();
    check('concurrency cap rejects the overflow request', second.status === 503, `status ${second.status}`);
    check('concurrency cap returns a specific code', /too_many_concurrent_requests/.test(secondText), secondText.slice(0, 120));
    check('concurrency cap sets Retry-After', !!second.headers.get('retry-after'));
    await first;

    await req('/api/settings', { method: 'PUT', body: { gateway_max_concurrent: '1000', gateway_max_inflight_bytes: '200000' } });
    const big = await fetch(`${GW}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${GK}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'y'.repeat(300000) }] })
    });
    const bigText = await big.text();
    check('byte budget rejects an oversized body', big.status === 503, `status ${big.status}`);
    check('byte budget returns a specific code', /inflight_bytes_exceeded/.test(bigText), bigText.slice(0, 120));

    await req('/api/settings', {
      method: 'PUT',
      body: { gateway_max_inflight_bytes: String(256 * 1024 * 1024), gateway_enabled: 'false' }
    });
    for (const k of (await req('/api/keys')).json?.keys || []) {
      if (k.name === 'guard-test') await req(`/api/keys/${k.id}`, { method: 'DELETE' });
    }
    slow.close();
  }

  // ----------------------------------------------------------------- cleanup
  section('Cleanup');
  await req('/api/settings', { method: 'PUT', body: { retention_timezone: 'local', alerts_enabled: 'false', alert_webhook_url: '' } });
  hook.close();

  console.log('\n==================================================');
  console.log(`  PASSED: ${pass}    FAILED: ${fail}`);
  if (fail > 0) {
    console.log('\n  Failures:');
    for (const f of failures) console.log(`   - ${f}`);
  }
  console.log('==================================================\n');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
