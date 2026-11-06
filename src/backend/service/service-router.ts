import crypto from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import { db, getSetting } from '../db/database';
import { KeyManager } from '../gateway/key-manager';
import { AbuseDetector } from '../gateway/abuse';
import { CostModel } from '../gateway/cost';
import { egressPool } from '../vpn/egress-pool';
import { VpnEngine } from '../vpn/vpn-engine';
import { openAiError } from '../gateway/error-mapper';

const STARTED_AT = Date.now();

/** C7: a draining instance reports itself unready so an LB stops sending traffic. */
let draining = false;

export function isDraining(): boolean {
  return draining;
}

export function beginDrain(): void {
  draining = true;
}

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function clientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || '';
}

function isLoopback(req: Request): boolean {
  const ip = req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

/**
 * Admin guard for the service router, which is mounted *before* the global
 * management auth middleware (so public pages stay reachable). Admin routes
 * require either a loopback caller or the management bearer token.
 */
function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const key = process.env.OPENCODE_ROUTER_API_KEY || getSetting('management_api_key', '');
  const header = String(req.headers.authorization || '');
  if (key && header === `Bearer ${key}`) {
    next();
    return;
  }
  if (isLoopback(req)) {
    next();
    return;
  }
  res.status(403).json({ error: 'admin access requires a loopback connection or the management bearer token' });
}

function signupCountFromIp(ip: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM abuse_events
        WHERE ip = ? AND reason = 'signup' AND created_at >= datetime('now', 'start of day')`
    )
    .get(ip) as { c: number } | undefined;
  return row?.c || 0;
}

function findInvite(code: string): any | null {
  if (!code) return null;
  const hash = crypto.createHash('sha256').update(code.trim()).digest('hex');
  return db.prepare('SELECT * FROM signup_invites WHERE code_hash = ?').get(hash) as any;
}

function publicStatus() {
  const poolStatus = egressPool.status();
  const today = db
    .prepare(`SELECT COUNT(*) AS requests, COALESCE(SUM(total_tokens),0) AS tokens FROM usage_log WHERE created_at >= datetime('now','start of day')`)
    .get() as any;

  return {
    status: draining ? 'draining' : 'ok',
    uptime_seconds: Math.floor((Date.now() - STARTED_AT) / 1000),
    gateway_enabled: getSetting('gateway_enabled', 'false') === 'true',
    pool: {
      size: poolStatus.size,
      ready: poolStatus.slots.filter((s: any) => s.state === 'ready').length
    },
    today: { requests: today?.requests || 0, tokens: today?.tokens || 0 },
    spend_today_usd: CostModel.spendToday()
  };
}

/**
 * C5 (onboarding), C6 (customer-facing observability), C7 (readiness) and
 * C8 (privacy endpoints).
 *
 * Kept in one router so the gateway router stays untouched.
 */
export function createServiceRouter(): Router {
  const router = Router();

  // ------------------------------------------------------------- C7 readiness
  router.get('/readyz', (_req: Request, res: Response) => {
    if (draining) {
      res.status(503).json({ ready: false, reason: 'draining' });
      return;
    }
    const poolReady = egressPool.status().slots.filter((s: any) => s.state === 'ready').length;
    const legacyReady = VpnEngine.getInstance().getActiveConfig() ? 1 : 0;
    const ready = poolReady + legacyReady;
    res.status(ready > 0 ? 200 : 503).json({ ready: ready > 0, ready_slots: poolReady, legacy: legacyReady > 0 });
  });

  router.post('/api/service/drain', requireAdmin, (_req: Request, res: Response) => {
    beginDrain();
    res.json({ success: true, draining: true });
  });

  router.post('/api/service/undrain', requireAdmin, (_req: Request, res: Response) => {
    draining = false;
    res.json({ success: true, draining: false });
  });

  // ------------------------------------------------------- C6 public status
  router.get('/api/public/status', (_req: Request, res: Response) => {
    if (getSetting('status_page_enabled', 'true') !== 'true') {
      res.status(404).json({ error: 'status page disabled' });
      return;
    }
    res.json(publicStatus());
  });

  router.get('/status', (_req: Request, res: Response) => {
    const st = publicStatus();
    res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>OpenCode Router — status</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:dark}
body{font:15px/1.5 ui-sans-serif,system-ui,sans-serif;margin:0;background:#0b0f14;color:#e6edf3}
main{max-width:640px;margin:8vh auto;padding:0 24px}
h1{font-size:20px;margin:0 0 4px}
.badge{display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600}
.ok{background:#12351f;color:#3fb950}.bad{background:#3d1d1d;color:#f85149}
dl{display:grid;grid-template-columns:1fr auto;gap:10px 16px;margin-top:28px}
dt{color:#8b949e}dd{margin:0;font-variant-numeric:tabular-nums}
footer{margin-top:32px;color:#8b949e;font-size:12px}
</style></head><body><main>
<h1>OpenCode Router Gateway</h1>
<span class="badge ${st.status === 'ok' ? 'ok' : 'bad'}">${esc(st.status)}</span>
<dl>
<dt>Uptime</dt><dd>${Math.floor(st.uptime_seconds / 60)} min</dd>
<dt>Egress slots ready</dt><dd>${st.pool.ready} / ${st.pool.size}</dd>
<dt>Gateway</dt><dd>${st.gateway_enabled ? 'enabled' : 'disabled'}</dd>
<dt>Requests today</dt><dd>${st.today.requests}</dd>
<dt>Tokens today</dt><dd>${st.today.tokens.toLocaleString('en-US')}</dd>
<dt>Spend today</dt><dd>$${st.spend_today_usd.toFixed(4)}</dd>
</dl>
<footer>Generated ${new Date().toISOString()} — no customer data is exposed on this page.</footer>
</main></body></html>`);
  });

  // ------------------------------------------------------------ C5 onboarding
  router.get('/portal', (_req: Request, res: Response) => {
    const enabled = getSetting('signup_enabled', 'false') === 'true';
    res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Get an API key</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:dark}
body{font:15px/1.6 ui-sans-serif,system-ui,sans-serif;margin:0;background:#0b0f14;color:#e6edf3}
main{max-width:680px;margin:7vh auto;padding:0 24px}
h1{font-size:22px;margin:0 0 6px}p{color:#8b949e}
input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid #30363d;background:#0d1117;color:#e6edf3;margin:6px 0 14px}
button{padding:10px 18px;border-radius:8px;border:0;background:#238636;color:#fff;font-weight:600;cursor:pointer}
pre{background:#0d1117;border:1px solid #21262d;border-radius:8px;padding:14px;overflow:auto;font-size:13px}
code{font-family:ui-monospace,SFMono-Regular,monospace}
.note{border-left:3px solid #d29922;padding:8px 12px;background:#1c1710;color:#d29922;border-radius:4px;margin:18px 0}
</style></head><body><main>
<h1>Get an API key</h1>
<p>OpenAI-compatible endpoint: <code><span id="base"></span>/v1</code></p>
<div class="note">${enabled ? 'Registration is open. You need an invite code.' : 'Registration is currently closed.'}</div>
<label>Invite code</label><input id="code" placeholder="inv-..." autocomplete="off">
<label>Name</label><input id="name" placeholder="my-laptop">
<button id="go" ${enabled ? '' : 'disabled'}>Create key</button>
<p id="msg"></p>
<pre id="out" style="display:none"></pre>
<script>
document.getElementById('base').textContent = location.origin;
async function go(){
  const msg=document.getElementById('msg'), out=document.getElementById('out');
  msg.textContent='…';
  try{
    const r=await fetch('/api/signup',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({inviteCode:document.getElementById('code').value,name:document.getElementById('name').value})});
    const j=await r.json();
    if(!r.ok){msg.textContent=j.error?.message||j.error||'failed';return;}
    msg.textContent='Key created — copy it now, it is shown only once.';
    out.style.display='block';
    out.textContent=JSON.stringify({base_url:location.origin+'/v1',api_key:j.key},null,2);
  }catch(e){msg.textContent=String(e);}
}
document.getElementById('go').onclick=go;
</script>
</main></body></html>`);
  });

  router.post('/api/signup', (req: Request, res: Response) => {
    if (getSetting('signup_enabled', 'false') !== 'true') {
      res.status(403).json(openAiError('Registration is closed.', 'invalid_request_error', 'signup_disabled'));
      return;
    }

    const ip = clientIp(req);
    const maxPerIp = Math.max(1, parseInt(getSetting('signup_max_per_ip_per_day', '3'), 10));
    if (signupCountFromIp(ip) >= maxPerIp) {
      res.status(429).json(openAiError('Too many signups from this address today.', 'rate_limit_error', 'signup_limit'));
      return;
    }

    const invite = findInvite(String(req.body?.inviteCode || ''));
    if (!invite) {
      res.status(401).json(openAiError('Invalid invite code.', 'invalid_request_error', 'invalid_invite'));
      return;
    }
    if (invite.uses >= invite.max_uses) {
      res.status(409).json(openAiError('This invite has already been used.', 'invalid_request_error', 'invite_exhausted'));
      return;
    }
    if (invite.expires_at && new Date(invite.expires_at + 'Z').getTime() < Date.now()) {
      res.status(409).json(openAiError('This invite has expired.', 'invalid_request_error', 'invite_expired'));
      return;
    }

    const name = String(req.body?.name || 'self-serve').trim().slice(0, 80) || 'self-serve';

    try {
      const created = KeyManager.create({
        name,
        rpmLimit: 60,
        dailyTokenLimit: 200_000,
        spendCapDailyUsd: 1,
        spendCapMonthlyUsd: 10
      });

      db.prepare('UPDATE signup_invites SET uses = uses + 1 WHERE id = ?').run(invite.id);
      db.prepare('INSERT INTO abuse_events (key_id, ip, reason, score) VALUES (?, ?, ?, ?)').run(
        created.id,
        ip,
        'signup',
        0
      );

      res.json({
        success: true,
        key: created.key,
        key_prefix: created.key_prefix,
        base_url: '/v1',
        limits: { rpm: 60, daily_tokens: 200_000, daily_usd: 1, monthly_usd: 10 },
        warning: 'Store the key now: it is hashed at rest and never shown again.'
      });
    } catch (err: any) {
      res.status(500).json(openAiError('Could not create the key.', 'server_error', 'signup_failed'));
    }
  });

  // ------------------------------------------------- C5 admin: invite management
  router.post('/api/invites', requireAdmin, (req: Request, res: Response) => {
    const label = String(req.body?.label || 'invite').trim().slice(0, 80);
    const maxUses = Math.max(1, Math.min(parseInt(String(req.body?.maxUses || '1'), 10) || 1, 100));
    const hours = Math.max(1, Math.min(parseInt(String(req.body?.expiresInHours || '168'), 10) || 168, 24 * 365));

    const code = `inv-${crypto.randomBytes(9).toString('base64url')}`;
    const hash = crypto.createHash('sha256').update(code).digest('hex');

    db.prepare(
      `INSERT INTO signup_invites (code_hash, label, max_uses, expires_at)
       VALUES (?, ?, ?, datetime('now', ?))`
    ).run(hash, label, maxUses, `+${hours} hours`);

    res.json({ success: true, invite_code: code, label, max_uses: maxUses, expires_in_hours: hours, warning: 'Shown once.' });
  });

  router.get('/api/invites', requireAdmin, (_req: Request, res: Response) => {
    const invites = db
      .prepare('SELECT id, label, max_uses, uses, expires_at, created_at FROM signup_invites ORDER BY id DESC LIMIT 100')
      .all();
    res.json({ invites });
  });

  // ----------------------------------------------------------- C6 alerts
  router.get('/api/alerts', requireAdmin, (_req: Request, res: Response) => {
    const alerts = db
      .prepare(
        `SELECT a.id, a.key_id, a.threshold_pct, a.last_fired_at, k.name AS key_name
           FROM usage_alerts a LEFT JOIN api_keys k ON k.id = a.key_id
          ORDER BY a.id ASC`
      )
      .all();
    res.json({ alerts });
  });

  router.post('/api/alerts', requireAdmin, (req: Request, res: Response) => {
    const keyId = parseInt(String(req.body?.keyId || ''), 10);
    const pct = Math.max(1, Math.min(parseInt(String(req.body?.thresholdPct || '80'), 10) || 80, 100));
    if (!Number.isFinite(keyId) || keyId <= 0) {
      res.status(400).json({ error: 'keyId is required' });
      return;
    }
    const exists = db.prepare('SELECT id FROM api_keys WHERE id = ?').get(keyId);
    if (!exists) {
      res.status(404).json({ error: 'key not found' });
      return;
    }
    try {
      db.prepare('INSERT OR IGNORE INTO usage_alerts (key_id, threshold_pct) VALUES (?, ?)').run(keyId, pct);
      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'could not create alert' });
    }
  });

  /** Evaluate every alert and return the ones that fired now. */
  router.post('/api/alerts/check', requireAdmin, (_req: Request, res: Response) => {
    const alerts = db.prepare('SELECT * FROM usage_alerts').all() as any[];
    const fired: any[] = [];

    for (const alert of alerts) {
      const key = db.prepare('SELECT id, name, daily_token_limit, spend_cap_usd_daily FROM api_keys WHERE id = ?').get(alert.key_id) as any;
      if (!key) continue;

      let pct = 0;
      let basis = 'none';
      if (key.daily_token_limit > 0) {
        const used = KeyManager.tokensUsedToday(key.id);
        pct = (used / key.daily_token_limit) * 100;
        basis = 'daily_tokens';
      } else if (key.spend_cap_usd_daily > 0) {
        pct = (CostModel.spendToday(key.id) / key.spend_cap_usd_daily) * 100;
        basis = 'daily_spend';
      }

      if (pct >= alert.threshold_pct) {
        db.prepare('UPDATE usage_alerts SET last_fired_at = datetime(\'now\') WHERE id = ?').run(alert.id);
        fired.push({ key_id: key.id, key_name: key.name, threshold_pct: alert.threshold_pct, used_pct: Math.round(pct), basis });
      }
    }

    res.json({ checked: alerts.length, fired });
  });

  // -------------------------------------------------------- C8 privacy / GDPR
  router.get('/api/privacy/export', requireAdmin, (req: Request, res: Response) => {
    const keyId = parseInt(String(req.query.key_id || ''), 10);
    if (!Number.isFinite(keyId)) {
      res.status(400).json({ error: 'key_id is required' });
      return;
    }
    const key = db
      .prepare(
        `SELECT id, key_prefix, name, email, rpm_limit, daily_token_limit, spend_cap_usd_daily,
                spend_cap_usd_monthly, enabled, created_at, last_used_at, total_requests, total_tokens
           FROM api_keys WHERE id = ?`
      )
      .get(keyId);
    if (!key) {
      res.status(404).json({ error: 'key not found' });
      return;
    }
    const usage = db
      .prepare(
        `SELECT id, model, prompt_tokens, completion_tokens, total_tokens, cost_usd,
                status_code, latency_ms, egress_node_id, created_at
           FROM usage_log WHERE key_id = ? ORDER BY id ASC`
      )
      .all(keyId);
    res.json({ exported_at: new Date().toISOString(), key, usage, usage_rows: usage.length });
  });

  router.delete('/api/privacy/erase', requireAdmin, (req: Request, res: Response) => {
    const keyId = parseInt(String(req.query.key_id || ''), 10);
    if (!Number.isFinite(keyId)) {
      res.status(400).json({ error: 'key_id is required' });
      return;
    }
    const exists = db.prepare('SELECT id FROM api_keys WHERE id = ?').get(keyId);
    if (!exists) {
      res.status(404).json({ error: 'key not found' });
      return;
    }

    const erase = db.transaction(() => {
      const usage = db.prepare('DELETE FROM usage_log WHERE key_id = ?').run(keyId);
      db.prepare('DELETE FROM usage_alerts WHERE key_id = ?').run(keyId);
      db.prepare('DELETE FROM abuse_events WHERE key_id = ?').run(keyId);
      const key = db.prepare('DELETE FROM api_keys WHERE id = ?').run(keyId);
      return { usage_rows: usage.changes, keys: key.changes };
    });
    const result = erase();
    res.json({ success: true, erased: result });
  });

  // ------------------------------------------------------------- C4 admin view
  router.get('/api/abuse/events', requireAdmin, (req: Request, res: Response) => {
    const limit = parseInt(String(req.query.limit || '50'), 10) || 50;
    res.json({ events: AbuseDetector.listRecent(limit) });
  });

  router.post('/api/keys/:id/reset-trust', requireAdmin, (req: Request, res: Response) => {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: 'invalid key id' });
      return;
    }
    AbuseDetector.reset(id);
    res.json({ success: true, trust: AbuseDetector.getStatus(id) });
  });

  return router;
}
