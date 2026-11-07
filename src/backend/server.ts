import express, { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { db, initDatabase, getSetting, setSetting } from './db/database';
import { VpnEngine } from './vpn/vpn-engine';
import { OpenCodeService } from './opencode/opencode-service';
import { ConnectionOrchestrator } from './orchestrator/connection-orchestrator';
import { ConfigFetcher } from './discovery/config-fetcher';
import { LatencyTester } from './tester/latency-tester';
import { BulkPrescreener } from './tester/bulk-prescreener';
import { HealthMonitor } from './tester/health-monitor';
import { egressPool } from './vpn/egress-pool';
import { Doctor } from './doctor';
import { RetentionService } from './service/retention';
import { Metrics } from './metrics';
import { Notifier } from './service/notifier';
import { TpmTracker } from './providers/tpm-tracker';
import { ModelRouter } from './gateway/model-router';
import { KeyManager } from './gateway/key-manager';
import { UpstreamClient } from './gateway/upstream-client';
import { createGatewayRouter } from './gateway/openai-router';
import { createServiceRouter } from './service/service-router';
import { createAbuseGuard } from './service/abuse-guard';
import { ProviderRegistry } from './providers/provider-registry';
import { ProviderRouter } from './gateway/provider-router';
import { CostModel } from './gateway/cost';
import { FreshnessTracker } from './tester/freshness';
import { PrivilegeWizard } from './security/privilege-wizard';
import {
  createCorsMiddleware,
  createSecurityGuardMiddleware,
  createAuthMiddleware,
  resolveBindHost,
  validateRemoteBindingConfig,
  setActiveBindHost,
  DEFAULT_BIND_HOST,
  maskAddress,
  sanitizeSubscriptionUrl
} from './security/api-guard';
import { FRONTEND_DIST } from './paths';
import * as premiumProxy from './egress/premium-proxy';

export const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const { host: INITIAL_BIND_HOST, warning: hostWarning } = resolveBindHost();
if (hostWarning) {
  console.warn(hostWarning);
}
setActiveBindHost(INITIAL_BIND_HOST);

// Security Hardening: Restricted CORS with development-only origin allowlist
app.use(createCorsMiddleware(PORT, INITIAL_BIND_HOST));

// Security Hardening: Guard middleware for Host header validation and CSRF protection
app.use(createSecurityGuardMiddleware(PORT, INITIAL_BIND_HOST));

// Route-specific parser for the gateway. body-parser enforces its limit on the
// bytes actually received, so a `Transfer-Encoding: chunked` request cannot slip
// past the content-length check in the auth middleware.
app.use(
  '/v1',
  express.json({
    limit: process.env.GATEWAY_MAX_BODY || '8mb',
    // Capture the real body size: fetch/undici may send a chunked body without a
    // content-length header, and the byte budget must still see it.
    verify: (req: any, _res: any, buf: Buffer) => {
      req.rawBodyBytes = buf.length;
    }
  })
);

app.use(express.json({ limit: '10mb' }));

// ---------------------------------------------------------------------------
// Service surface (axis C): self-serve signup portal, public status page,
// readiness probe, privacy/GDPR endpoints and abuse admin.
// Mounted before the management auth middleware so the public pages and the
// signup endpoint work without it; admin routes inside carry their own guard.
// ---------------------------------------------------------------------------
app.use(createServiceRouter());

// ---------------------------------------------------------------------------
// OpenAI-compatible gateway (/v1). Mounted BEFORE the management auth
// middleware on purpose: it authenticates with its own `sk-or-...` keys and must
// stay usable by external clients even when the admin API is locked down.
// ---------------------------------------------------------------------------
app.use('/v1', createAbuseGuard());
app.use('/v1', createGatewayRouter());

// Security Hardening: Mandatory Bearer token authentication for remote access
app.use(createAuthMiddleware());

// Initialize SQLite database
initDatabase();

const orchestrator = ConnectionOrchestrator.getInstance();
const vpn = VpnEngine.getInstance();
const opencode = OpenCodeService.getInstance();

// ---------------------------------------------------------------------------
// Process bootstrap.
//
// IMPORTANT: this block must only run when the file is the *entry point*.
// `tests/*` import this module to reuse `startServer()`; running the bootstrap
// unconditionally made a test run spawn the whole egress pool (4 Xray children),
// which then kept the Node event loop alive and left orphan processes behind.
// ---------------------------------------------------------------------------
const isDirectRun = (() => {
  try {
    return require.main === module;
  } catch {
    return false;
  }
})();

/**
 * Starts the background machinery (health monitor, retention, alerts, egress pool)
 * and installs signal handlers. Exported so a cluster worker can run the same
 * bootstrap without being the process entry point.
 */
export function bootstrap(): void {
  // Background health monitor (no-op when disabled in settings).
  HealthMonitor.start();

  // Bounded growth: prune usage history and reclaim space on a timer.
  RetentionService.start();

  // Out-of-band alerting: storage pressure and pool capacity changes.
  startAlertMonitor();

  // Real per-slot probe: keeps the pool using only IPs that can actually reach
  // the target. 0 disables it (the /api/egress/probe endpoint still works).
  startEgressProbe();

  // Serving pool: N independent Xray slots with a watchdog for automatic failover.
  egressPool.init();
  egressPool
    .ensureAll()
    .then((started) => {
      if (started > 0) console.log(`[EgressPool] started ${started} slot(s)`);
    })
    .catch((err) => console.error('[EgressPool] init failed:', err?.message || err));

  // Shut the pool down cleanly so no Xray child outlives the server.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Server] ${signal} received — shutting down`);
    try {
      HealthMonitor.stop();
    } catch {
      /* ignore */
    }
    try {
      RetentionService.stop();
    } catch {
      /* ignore */
    }
    try {
      stopAlertMonitor();
    } catch {
      /* ignore */
    }
    try {
      await egressPool.shutdown();
    } catch (err: any) {
      console.error('[Server] pool shutdown error:', err?.message || err);
    }
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGHUP', () => void shutdown('SIGHUP'));
}

// Server-Sent Events (SSE) clients
const sseClients: Set<Response> = new Set();

orchestrator.on('progress', (data) => {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
});

// SSE endpoint
app.get('/api/events', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.add(res);

  // Send initial state immediately
  res.write(`data: ${JSON.stringify({
    phase: orchestrator.getStatus().phase,
    message: orchestrator.getStatus().message,
    stats: orchestrator.getStatus().stats,
    activeConnection: vpn.getActiveConfig()
  })}\n\n`);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

// Dashboard Status
app.get('/api/status', async (req: Request, res: Response) => {
  const status = orchestrator.getStatus();
  const normalIp = await LatencyTester.getNormalPublicIp();
  res.json({
    ...status,
    normalIp,
    socksPort: getSetting('socks_port', '10808'),
    httpPort: getSetting('http_port', '10809')
  });
});

// Trigger "Find Working Connection"
app.post('/api/workflow/start', async (req: Request, res: Response) => {
  const forceRefresh = Boolean(req.body.forceRefresh);
  if (orchestrator.getStatus().isRunning) {
    return res.status(409).json({ error: 'Testing workflow already running' });
  }

  // Run asynchronously so response is returned immediately
  orchestrator.findWorkingConnection(forceRefresh).catch((err) => {
    console.error('Workflow error:', err);
  });

  res.json({ success: true, message: 'Workflow started' });
});

// Stop Testing
app.post('/api/workflow/stop', (req: Request, res: Response) => {
  orchestrator.stopTesting();
  res.json({ success: true, message: 'Workflow cancellation requested' });
});

// Disconnect VPN
app.post('/api/vpn/disconnect', async (req: Request, res: Response) => {
  await vpn.stop();
  res.json({ success: true, message: 'VPN disconnected' });
});

// Test current active connection
app.post('/api/vpn/test-current', async (req: Request, res: Response) => {
  const active = vpn.getActiveConfig();
  if (!active) {
    return res.status(400).json({ error: 'No active VPN configuration' });
  }

  const httpPort = parseInt(getSetting('http_port', '10809'), 10);
  const socksPort = parseInt(getSetting('socks_port', '10808'), 10);

  const proxyTest = await LatencyTester.testProxyHttp(httpPort, 3000);
  const opencodeTest = await opencode.testOpenCodeConnection(
    httpPort,
    socksPort,
    parseInt(getSetting('opencode_timeout_seconds', '18'), 10)
  );

  res.json({
    active,
    proxyTest,
    opencodeTest
  });
});

// Get Paginated & Filtered Configurations
app.get('/api/configs', (req: Request, res: Response) => {
  const page = parseInt(req.query.page as string, 10) || 1;
  const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);
  const offset = (page - 1) * limit;
  const status = (req.query.status as string) || '';
  const protocol = (req.query.protocol as string) || '';
  const search = (req.query.search as string) || '';

  let whereClauses: string[] = [];
  let params: any[] = [];

  if (status) {
    whereClauses.push('last_status = ?');
    params.push(status);
  }
  if (protocol) {
    whereClauses.push('protocol = ?');
    params.push(protocol);
  }
  if (search) {
    whereClauses.push('(remark LIKE ? OR address LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }

  const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  const total = (db.prepare(`SELECT COUNT(*) as count FROM configs ${whereStr}`).get(...params) as any)?.count || 0;
  const items = db.prepare(`
    SELECT
      id, protocol, address, port, remark, security, network,
      last_tested_at, last_latency_ms, last_status, consecutive_failures, success_count, is_active,
      tcp_alive, tcp_latency_ms, egress_ip, health_score, last_health_check, prescreen_at,
      last_error,
      (SELECT name FROM sources WHERE sources.id = configs.source_id) AS source_name,
      created_at
    FROM configs
    ${whereStr}
    ORDER BY is_active DESC, success_count DESC, id ASC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  res.json({
    items,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit)
    }
  });
});

// Manually test a single configuration
app.post('/api/configs/test-single', async (req: Request, res: Response) => {
  const configId = parseInt(req.body.id, 10);
  const row = db.prepare('SELECT * FROM configs WHERE id = ?').get(configId) as any;
  if (!row) {
    return res.status(404).json({ error: 'Configuration not found' });
  }

  const httpPort = parseInt(getSetting('http_port', '10809'), 10);
  const socksPort = parseInt(getSetting('socks_port', '10808'), 10);

  const tcp = await LatencyTester.testRemoteTcp(row.address, row.port, 2000);
  if (!tcp.reachable) {
    return res.json({
      success: false,
      step: 'tcp',
      error: `TCP Unreachable: ${tcp.error}`
    });
  }

  const started = await vpn.start(row, socksPort, httpPort);
  if (!started) {
    return res.json({
      success: false,
      step: 'vpn_start',
      error: 'Proxy engine failed to start'
    });
  }

  const proxyTest = await LatencyTester.testProxyHttp(httpPort, 3500);
  if (!proxyTest.success) {
    await vpn.stop();
    return res.json({
      success: false,
      step: 'proxy_probe',
      error: proxyTest.error
    });
  }

  const opencodeTest = await opencode.testOpenCodeConnection(
    httpPort,
    socksPort,
    parseInt(getSetting('opencode_timeout_seconds', '18'), 10)
  );
  await vpn.stop();

  res.json({
    success: opencodeTest.category === 'SUCCESS',
    tcp,
    proxyTest,
    opencodeTest
  });
});

// Manually activate a configuration
app.post('/api/configs/:id/activate', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const row = db.prepare('SELECT * FROM configs WHERE id = ?').get(id) as any;
  if (!row) {
    return res.status(404).json({ error: 'Configuration not found' });
  }

  const httpPort = parseInt(getSetting('http_port', '10809'), 10);
  const socksPort = parseInt(getSetting('socks_port', '10808'), 10);

  const started = await vpn.start(row, socksPort, httpPort);
  if (!started) {
    return res.status(500).json({ error: 'Failed to start proxy engine' });
  }

  db.prepare('UPDATE configs SET is_active = 0').run();
  db.prepare('UPDATE configs SET is_active = 1 WHERE id = ?').run(id);

  res.json({
    success: true,
    message: `Activated ${row.remark || row.address}`,
    active: vpn.getActiveConfig()
  });
});

// Delete a configuration
app.delete('/api/configs/:id', (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  db.prepare('DELETE FROM configs WHERE id = ?').run(id);
  res.json({ success: true, message: 'Configuration deleted' });
});

// Import Configurations or raw text
app.post('/api/configs/import', (req: Request, res: Response) => {
  const { rawText, name } = req.body;
  if (!rawText || typeof rawText !== 'string') {
    return res.status(400).json({ error: 'Missing rawText parameter' });
  }

  const result = ConfigFetcher.importRawText(rawText, name);
  res.json({ success: true, ...result });
});

// Get GitHub Sources (with sensitive query tokens redacted)
app.get('/api/sources', (req: Request, res: Response) => {
  const sources = db.prepare('SELECT * FROM sources ORDER BY id ASC').all() as any[];
  const sanitizedSources = sources.map((s) => ({
    ...s,
    url: sanitizeSubscriptionUrl(s.url)
  }));
  res.json({ sources: sanitizedSources });
});

// Add Source
app.post('/api/sources', (req: Request, res: Response) => {
  const { name, url } = req.body;
  if (!name || !url) {
    return res.status(400).json({ error: 'Name and URL are required' });
  }

  try {
    const result = db.prepare('INSERT INTO sources (name, url) VALUES (?, ?)').run(name, url);
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err: any) {
    res.status(409).json({ error: 'Source URL already exists' });
  }
});

// Refresh single source
app.post('/api/sources/:id/refresh', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const summaries = await ConfigFetcher.fetchAllSources(id);
  res.json({ success: true, summary: summaries[0] });
});

// Refresh all sources
app.post('/api/sources/refresh-all', async (req: Request, res: Response) => {
  const summaries = await ConfigFetcher.fetchAllSources();
  res.json({ success: true, summaries });
});

// Delete Source
app.delete('/api/sources/:id', (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  db.prepare('DELETE FROM sources WHERE id = ?').run(id);
  res.json({ success: true });
});

// Diagnostics
app.get('/api/diagnostics', (req: Request, res: Response) => {
  const opencodeInfo = { ...opencode.getInfo() };
  const userHome = os.homedir() || process.env.HOME || '';
  const sanitizePath = (p?: string): string => {
    if (!p) return '';
    if (userHome && p.startsWith(userHome)) {
      return p.replace(userHome, '~');
    }
    return p;
  };

  opencodeInfo.configPath = sanitizePath(opencodeInfo.configPath);
  const privilegeStatus = { ...PrivilegeWizard.checkStatus() };
  privilegeStatus.setupScriptPath = sanitizePath(privilegeStatus.setupScriptPath);
  const launcherPath = sanitizePath(opencode.getLauncherPath());
  const history = db.prepare(`
    SELECT h.*, c.remark, c.protocol, c.address, c.port
    FROM test_history h
    JOIN configs c ON h.config_id = c.id
    ORDER BY h.id DESC
    LIMIT 15
  `).all() as any[];

  const sanitizedHistory = history.map((item) => ({
    ...item,
    address: maskAddress(item.address)
  }));

  res.json({
    opencode: opencodeInfo,
    privilege: privilegeStatus,
    launcherScript: launcherPath,
    history: sanitizedHistory
  });
});

// ---------------------------------------------------------------------------
// Alert monitor: turns storage/pool problems into out-of-band notifications.
// Every failure here is swallowed — alerting must never break serving.
// ---------------------------------------------------------------------------
// Declared with ar on purpose: startAlertMonitor() is called during module
// initialization, before this line would be reached in a let binding (TDZ).
var alertTimer: NodeJS.Timeout | null = null;

function startAlertMonitor(): void {
  if (alertTimer) return;

  const tick = async () => {
    try {
      if (getSetting('alerts_enabled', 'false') !== 'true') return;
      if (!Notifier.isConfigured()) return;

      const storage = RetentionService.stats();
      if (!storage.healthy) {
        await Notifier.send('storage', `Storage warning: ${storage.warnings.join('; ')}`, 'warning');
      }

      const pool = egressPool.status();
      if (pool.capacity === 'none') {
        await Notifier.send('pool', `Egress pool has no ready slot. ${pool.capacityNote}`, 'critical');
      } else if (pool.capacity === 'reduced') {
        await Notifier.send('pool', `Egress pool reduced. ${pool.capacityNote}`, 'warning');
      }
    } catch (err: any) {
      console.error('[Alerts] check failed:', err?.message || err);
    }
  };

  const seconds = Math.max(30, parseInt(getSetting('alert_check_interval_seconds', '300'), 10));
  alertTimer = setInterval(() => void tick(), seconds * 1000);
  alertTimer.unref?.();
}

// ---------------------------------------------------------------------------
// Periodic egress probe: marks slots that cannot reach the target so acquire()
// stops routing through them.
// ---------------------------------------------------------------------------
let egressProbeTimer: NodeJS.Timeout | null = null;

function startEgressProbe(): void {
  if (egressProbeTimer) return;
  const seconds = Math.max(0, parseInt(getSetting('egress_probe_interval_seconds', '0'), 10) || 0);
  if (seconds <= 0) return;
  if (!getSetting('egress_probe_url', '').trim()) return;
  egressProbeTimer = setInterval(() => {
    void egressPool.probeAll().catch((err: any) => {
      console.error('[EgressProbe] failed:', err?.message || err);
    });
  }, seconds * 1000);
  egressProbeTimer.unref?.();
}

function stopAlertMonitor(): void {
  if (alertTimer) {
    clearInterval(alertTimer);
    alertTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Prometheus metrics (management surface, loopback by default)
// ---------------------------------------------------------------------------
app.get('/metrics', (req: Request, res: Response) => {
  const pool = egressPool.status();
  const storage = RetentionService.stats();
  const lastRun = RetentionService.getLastRun();
  const providerLimits = new Map<number, number>(ProviderRegistry.list().map((p: any) => [p.id, p.tpm_limit] as [number, number]));
  const providerRpmLimits = new Map<number, number>(ProviderRegistry.list().map((p: any) => [p.id, p.rpm_limit] as [number, number]));
  const providerNames = new Map<number, string>(ProviderRegistry.list().map((p: any) => [p.id, p.name] as [number, string]));
  const tpmSnapshot = TpmTracker.snapshot(providerLimits, providerRpmLimits);
  const body = Metrics.render({
    poolSize: pool.size,
    poolReady: pool.ready,
    poolInFlight: pool.slots.reduce((sum: number, s: any) => sum + (s.inFlight || 0), 0),
    poolCapacity: pool.capacity,
    dbBytes: storage.dbBytes,
    walBytes: storage.walBytes,
    usageRows: storage.usageRows,
    retentionDeletedTotal: (lastRun?.deletedUsage || 0) + (lastRun?.deletedHistory || 0),
    rotations: pool.metrics.rotations,
    failovers: pool.metrics.failovers,
    providers: tpmSnapshot.map((t: any) => ({
      name: providerNames.get(t.providerId) || String(t.providerId),
      used: t.used,
      limit: t.limit,
      total: TpmTracker.totalFor(t.providerId),
      rpmUsed: t.requests,
      rpmLimit: t.rpmLimit
    }))
  });
  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(body);
});

// ---------------------------------------------------------------------------
// Alerts (out-of-band notifications)
// ---------------------------------------------------------------------------
app.get('/api/alerts/status', (req: Request, res: Response) => {
  res.json({
    enabled: getSetting('alerts_enabled', 'false') === 'true',
    configured: Notifier.isConfigured(),
    channels: {
      webhook: !!(process.env.ALERT_WEBHOOK_URL || getSetting('alert_webhook_url', '')),
      telegram: !!(
        process.env.ALERT_TELEGRAM_BOT_TOKEN &&
        (process.env.ALERT_TELEGRAM_CHAT_ID || getSetting('alert_telegram_chat_id', ''))
      )
    },
    history: Notifier.getHistory()
  });
});

app.post('/api/alerts/test', async (req: Request, res: Response) => {
  const message = String(req.body?.message || 'Test alert from OpenCode Router Gateway');
  const result = await Notifier.send('test', message, 'info');
  res.json({ success: result.sent, result });
});

// ---------------------------------------------------------------------------
// Storage / retention (bounded growth)
// ---------------------------------------------------------------------------
app.get('/api/retention/status', (req: Request, res: Response) => {
  res.json({
    stats: RetentionService.stats(),
    lastRun: RetentionService.getLastRun(),
    scheduled: RetentionService.isScheduled()
  });
});

app.post('/api/retention/run', (req: Request, res: Response) => {
  if (RetentionService.isRunning()) {
    return res.status(409).json({ error: 'A retention run is already in progress' });
  }
  try {
    const result = RetentionService.runNow();
    res.json({ success: true, result, stats: RetentionService.stats() });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'retention failed' });
  }
});

// ---------------------------------------------------------------------------
// Doctor: one call that answers "can this deployment serve?"
// ---------------------------------------------------------------------------
app.get('/api/doctor', async (req: Request, res: Response) => {
  const live = String(req.query.live || '') === '1' || String(req.query.live) === 'true';
  try {
    const report = await Doctor.run({ live });
    res.status(report.ok ? 200 : 503).json(report);
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || 'doctor failed' });
  }
});

// ---------------------------------------------------------------------------
// Egress pool (B1/B2/B3): slots, failover, rotation, stickiness
// ---------------------------------------------------------------------------
app.get('/api/egress/status', (req: Request, res: Response) => {
  res.json(egressPool.status());
});

app.post('/api/egress/ensure', async (req: Request, res: Response) => {
  const started = await egressPool.ensureAll();
  res.json({ success: true, started, status: egressPool.status() });
});

app.post('/api/egress/rotate/:slot', async (req: Request, res: Response) => {
  const slot = parseInt(String(req.params.slot), 10);
  if (!Number.isInteger(slot)) return res.status(400).json({ error: 'invalid slot index' });
  const ok = await egressPool.rotateSlot(slot, 'manual');
  res.json({ success: ok, status: egressPool.status() });
});

app.post('/api/egress/failover/:slot', async (req: Request, res: Response) => {
  const slot = parseInt(String(req.params.slot), 10);
  if (!Number.isInteger(slot)) return res.status(400).json({ error: 'invalid slot index' });
  const ok = await egressPool.failoverSlot(slot, 'manual');
  res.json({ success: ok, status: egressPool.status() });
});

app.get('/api/egress/premium', async (req: Request, res: Response) => {
  try {
    const http = await premiumProxy.probePremiumProxy('http');
    const socks = await premiumProxy.probePremiumProxy('socks5');
    res.json({
      proxies: [http, socks].map((p) => ({ ...p, endpoint: premiumProxy.redactProxyUrl(premiumProxy.premiumProxyUrl(p.kind)) })),
      secretsExposed: false
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'premium probe failed' });
  }
});

app.post('/api/egress/probe', async (req: Request, res: Response) => {
  try {
    const results = await egressPool.probeAll();
    res.json({ success: true, results, status: egressPool.status() });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'probe failed' });
  }
});

app.post('/api/egress/reinit', async (req: Request, res: Response) => {
  egressPool.init(req.body?.size);
  const started = await egressPool.ensureAll();
  res.json({ success: true, started, status: egressPool.status() });
});

// ---------------------------------------------------------------------------
// Bulk TCP pre-screen
// ---------------------------------------------------------------------------
app.post('/api/configs/prescreen', (req: Request, res: Response) => {
  if (BulkPrescreener.isRunning()) {
    return res.status(409).json({ error: 'A pre-screen run is already in progress', progress: BulkPrescreener.getProgress() });
  }

  const { concurrency, timeoutMs, onlyUnhealthy, limit, sourceId } = req.body || {};
  BulkPrescreener.run({ concurrency, timeoutMs, onlyUnhealthy, limit, sourceId })
    .then((summary) => console.log('[Prescreen] finished:', JSON.stringify(summary)))
    .catch((err) => console.error('[Prescreen] failed:', err?.message || err));

  res.json({ success: true, message: 'Pre-screen started', progress: BulkPrescreener.getProgress() });
});

app.get('/api/prescreen/status', (req: Request, res: Response) => {
  const runs = db.prepare('SELECT * FROM prescreen_runs ORDER BY id DESC LIMIT 5').all();
  res.json({ progress: BulkPrescreener.getProgress(), runs });
});

app.post('/api/prescreen/abort', (req: Request, res: Response) => {
  BulkPrescreener.requestAbort();
  res.json({ success: true, message: 'Abort requested' });
});

// ---------------------------------------------------------------------------
// Node health
// ---------------------------------------------------------------------------
app.get('/api/nodes/health', (req: Request, res: Response) => {
  const nodes = db
    .prepare(
      `SELECT id, protocol, address, port, remark, last_status, health_score, tcp_alive,
              tcp_latency_ms, egress_ip, consecutive_failures, last_health_check
         FROM configs
        WHERE last_status = 'working' OR tcp_alive = 1
        ORDER BY COALESCE(health_score, 100) DESC, COALESCE(tcp_latency_ms, 9999) ASC
        LIMIT 50`
    )
    .all();
  res.json({ monitor: HealthMonitor.getStatus(), nodes });
});

app.post('/api/health/check-now', async (req: Request, res: Response) => {
  if (HealthMonitor.isChecking()) {
    return res.status(409).json({ error: 'A health check is already running' });
  }
  try {
    const summary = await HealthMonitor.checkNow(req.body?.batch);
    res.json({ success: true, summary });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'health check failed' });
  }
});

// ---------------------------------------------------------------------------
// Egress IP grouping
// ---------------------------------------------------------------------------
app.get('/api/egress/groups', (req: Request, res: Response) => {
  const groups = db
    .prepare(
      `SELECT g.egress_ip, g.first_seen, g.last_seen,
              (SELECT COUNT(*) FROM configs c WHERE c.egress_ip = g.egress_ip) AS live_nodes
         FROM egress_groups g
        ORDER BY live_nodes DESC, g.egress_ip ASC`
    )
    .all();
  const distinct = (db.prepare('SELECT COUNT(DISTINCT egress_ip) AS n FROM configs WHERE egress_ip IS NOT NULL').get() as any)?.n || 0;
  res.json({ distinct_egress_ips: distinct, groups });
});

// ---------------------------------------------------------------------------
// Gateway API keys
// ---------------------------------------------------------------------------
app.get('/api/keys', (req: Request, res: Response) => {
  res.json({ keys: KeyManager.list() });
});

app.post('/api/keys', (req: Request, res: Response) => {
  try {
    const created = KeyManager.create({
      name: req.body?.name,
      rpmLimit: req.body?.rpmLimit,
      dailyTokenLimit: req.body?.dailyTokenLimit,
      spendCapDailyUsd: req.body?.spendCapDailyUsd ?? req.body?.spend_cap_usd_daily,
      spendCapMonthlyUsd: req.body?.spendCapMonthlyUsd ?? req.body?.spend_cap_usd_monthly,
      egressPolicy: req.body?.egressPolicy ?? req.body?.egress_policy
    });
    res.json({
      success: true,
      ...created,
      warning: 'Store this key now: it is hashed at rest and will never be shown again.'
    });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'could not create key' });
  }
});

app.delete('/api/keys/:id', (req: Request, res: Response) => {
  const ok = KeyManager.revoke(parseInt(String(req.params.id), 10));
  res.status(ok ? 200 : 404).json({ success: ok });
});

app.patch('/api/keys/:id', (req: Request, res: Response) => {
  const ok = KeyManager.setEnabled(parseInt(String(req.params.id), 10), req.body?.enabled !== false);
  res.status(ok ? 200 : 404).json({ success: ok });
});

// ---------------------------------------------------------------------------
// Gateway status
// ---------------------------------------------------------------------------
app.get('/api/gateway/status', (req: Request, res: Response) => {
  const cfg = UpstreamClient.resolveConfig();
  res.json({
    enabled: getSetting('gateway_enabled', 'false') === 'true',
    upstream_configured: UpstreamClient.isConfigured(),
    upstream_base_url: redactSetting('gateway_upstream_base_url', cfg.baseUrl),
    upstream_key_present: cfg.apiKey.length > 0,
    upstream_model: cfg.model,
    active_node: vpn.getActiveConfig(),
    usage: KeyManager.usageSummary(),
    key_count: KeyManager.list().length
  });
});

// ---------------------------------------------------------------------------
// Settings (whitelisted keys only; secrets are never echoed back)
// ---------------------------------------------------------------------------
const SETTING_WHITELIST = new Set([
  'socks_port',
  'http_port',
  'max_test_attempts',
  'test_timeout_seconds',
  'opencode_timeout_seconds',
  'rank_by',
  'prescreen_concurrency',
  'prescreen_timeout_ms',
  'health_check_enabled',
  'health_check_interval_seconds',
  'health_check_batch',
  'health_check_ports_base',
  'gateway_enabled',
  'gateway_upstream_base_url',
  'gateway_upstream_model',
  'gateway_upstream_timeout_seconds',
  'gateway_max_body_bytes',
  'gateway_default_rpm',
  'gateway_rotate_on_429',
  'gateway_rotate_on_5xx',
  'gateway_upstream_bypass_proxy_loopback',
  'gateway_stream_include_usage',
  'egress_policy',
  'egress_probe_url',
  'egress_probe_timeout_ms',
  'egress_probe_rotate_on_fail',
  'egress_probe_interval_seconds',
  'gateway_require_model_route',
  'gateway_model_prefix_provider',
  'usage_retention_days',
  'test_history_retention_days',
  'usage_max_rows',
  'db_max_mb',
  'retention_interval_seconds',
  'retention_vacuum_threshold',
  'xray_log_max_bytes',
  'retention_timezone',
  'pool_max_size',
  'pool_max_rss_mb',
  'alerts_enabled',
  'alert_webhook_url',
  'alert_telegram_chat_id',
  'alert_cooldown_seconds',
  'alert_check_interval_seconds',
  'gateway_max_concurrent',
  'pool_max_inflight_per_slot',
  'pool_acquire_timeout_ms',
  'upstream_connections',
  'gateway_max_inflight_bytes',
  'gateway_mapreduce_enabled',
  'gateway_mapreduce_context_limit',
  'gateway_mapreduce_chunk_tokens',
  'gateway_mapreduce_max_chunks',
  'gateway_mapreduce_instruction',
  'gateway_quota_reserve_tokens',
  'gateway_provider_policy',
  'gateway_max_provider_attempts',
  'gateway_freshness_weight',
  'pool_size',
  // axis C service settings (C4 abuse, C5 onboarding, C6 status)
  'signup_enabled',
  'signup_max_per_ip_per_day',
  'status_page_enabled',
  'abuse_detection_enabled',
  'abuse_window_seconds',
  'abuse_429_threshold',
  'abuse_duplicate_threshold',
  'cost_tracking_enabled',
  'spend_reserve_usd',
  'pool_base_port',
  'pool_drain_timeout_ms',
  'pool_watchdog_interval_ms'
]);

const SENSITIVE_SETTINGS = new Set(['gateway_upstream_base_url', 'alert_webhook_url']);

function redactSetting(key: string, value: string): string {
  if (!SENSITIVE_SETTINGS.has(key)) return value;
  try {
    const u = new URL(value);
    if (u.username || u.password) {
      u.username = '***';
      u.password = '***';
    }
    return u.toString();
  } catch {
    return value;
  }
}

app.get('/api/settings', (req: Request, res: Response) => {
  const rows = db.prepare('SELECT key, value FROM settings ORDER BY key').all() as Array<{ key: string; value: string }>;
  const settings: Record<string, string> = {};
  for (const row of rows) {
    if (!SETTING_WHITELIST.has(row.key)) continue;
    settings[row.key] = redactSetting(row.key, row.value);
  }
  res.json({ settings });
});

app.put('/api/settings', (req: Request, res: Response) => {
  const payload = req.body;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return res.status(400).json({ error: 'Body must be an object of { key: value }' });
  }

  const rejected: string[] = [];
  const applied: Record<string, string> = {};

  for (const [key, raw] of Object.entries(payload)) {
    if (!SETTING_WHITELIST.has(key)) {
      rejected.push(key);
      continue;
    }
    if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') {
      rejected.push(key);
      continue;
    }
    const value = String(raw);
    if (value.length > 2048) {
      rejected.push(key);
      continue;
    }
    setSetting(key, value);
    applied[key] = redactSetting(key, value);
  }

  if (Object.keys(applied).length === 0) {
    return res.status(400).json({ error: 'No valid settings supplied', rejected });
  }

  // Apply side effects that are not read lazily.
  if ('health_check_enabled' in applied) {
    if (applied.health_check_enabled === 'true') {
      HealthMonitor.start();
    } else {
      HealthMonitor.stop();
    }
  }

  res.json({ success: true, applied, rejected });
});

// ---------------------------------------------------------------------------
// D4 — providers
// ---------------------------------------------------------------------------
app.get('/api/providers', (req: Request, res: Response) => {
  res.json({ providers: ProviderRegistry.list(), routing: ProviderRouter.status() });
});

app.post('/api/providers', (req: Request, res: Response) => {
  try {
    const provider = ProviderRegistry.create(req.body || {});
    res.json({ success: true, provider });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'could not create provider' });
  }
});

app.patch('/api/providers/:id', (req: Request, res: Response) => {
  try {
    const ok = ProviderRegistry.update(parseInt(String(req.params.id), 10), req.body || {});
    res.status(ok ? 200 : 404).json({ success: ok });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'could not update provider' });
  }
});

app.delete('/api/providers/:id', (req: Request, res: Response) => {
  const ok = ProviderRegistry.remove(parseInt(String(req.params.id), 10));
  res.status(ok ? 200 : 404).json({ success: ok });
});

// ---------------------------------------------------------------------------
// Model routing: public alias -> (provider, upstream model)
// ---------------------------------------------------------------------------
app.get('/api/models', (req: Request, res: Response) => {
  res.json({
    require_route: ModelRouter.requireRoute(),
    routes: ModelRouter.describe(),
    raw: ModelRouter.list(),
    providers: ProviderRegistry.list().map((p) => ({ id: p.id, name: p.name, model: p.model }))
  });
});

app.post('/api/models', (req: Request, res: Response) => {
  try {
    const route = ModelRouter.create({
      alias: req.body?.alias,
      providerId: parseInt(String(req.body?.providerId ?? req.body?.provider_id), 10),
      upstreamModel: req.body?.upstreamModel ?? req.body?.upstream_model,
      priority: req.body?.priority,
      enabled: req.body?.enabled
    });
    res.json({ success: true, route });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'could not create route' });
  }
});

app.delete('/api/models/:id', (req: Request, res: Response) => {
  const ok = ModelRouter.remove(parseInt(String(req.params.id), 10));
  res.status(ok ? 200 : 404).json({ success: ok });
});

app.delete('/api/models/alias/:alias', (req: Request, res: Response) => {
  const removed = ModelRouter.removeAlias(String(req.params.alias));
  res.status(removed > 0 ? 200 : 404).json({ success: removed > 0, removed });
});

// ---------------------------------------------------------------------------
// D5 — prices and spend
// ---------------------------------------------------------------------------
app.get('/api/prices', (req: Request, res: Response) => {
  res.json({ prices: CostModel.listPrices() });
});

app.put('/api/prices', (req: Request, res: Response) => {
  try {
    const { model, costPer1mIn, costPer1mOut } = req.body || {};
    if (!model) return res.status(400).json({ error: 'model is required' });
    CostModel.setPrice(model, Number(costPer1mIn) || 0, Number(costPer1mOut) || 0);
    res.json({ success: true });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'could not set price' });
  }
});

app.get('/api/costs', (req: Request, res: Response) => {
  const byKey = db
    .prepare(
      `SELECT key_id, COUNT(*) AS requests, COALESCE(SUM(total_tokens), 0) AS tokens,
              COALESCE(SUM(cost_usd), 0) AS cost_usd
         FROM usage_log GROUP BY key_id ORDER BY cost_usd DESC`
    )
    .all();
  const byProvider = db
    .prepare(
      `SELECT provider_id, COUNT(*) AS requests, COALESCE(SUM(cost_usd), 0) AS cost_usd
         FROM usage_log GROUP BY provider_id ORDER BY cost_usd DESC`
    )
    .all();
  res.json({
    today_usd: CostModel.spendToday(),
    month_usd: CostModel.spendThisMonth(),
    by_key: byKey,
    by_provider: byProvider
  });
});

// ---------------------------------------------------------------------------
// D2 — IP freshness
// ---------------------------------------------------------------------------
app.get('/api/freshness', (req: Request, res: Response) => {
  res.json({
    average_requests_before_429: FreshnessTracker.averageRequestsBefore429(),
    nodes: FreshnessTracker.list(parseInt(String(req.query.limit || '50'), 10))
  });
});

app.post('/api/freshness/recompute', (req: Request, res: Response) => {
  const count = FreshnessTracker.recomputeAll();
  res.json({ success: true, recomputed: count });
});

// Serve static frontend files if built
const frontendDist = FRONTEND_DIST;
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.use((req: Request, res: Response) => {
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
}

export function startServer(port: number = PORT, host?: string) {
  const { host: bindHost, warning } = resolveBindHost(host);
  if (warning) {
    console.warn(warning);
  }
  // Validate that remote binding is protected by an API key
  validateRemoteBindingConfig(bindHost, process.env.OPENCODE_ROUTER_API_KEY);
  setActiveBindHost(bindHost);

  const server = app.listen(port, bindHost, () => {
    console.log(`[OpenCode Router] Backend server running on http://${bindHost}:${port}`);
  });

  // Graceful shutdown: drain HTTP, then kill the Xray pool. Without this a
  // restart leaves orphaned xray processes holding the pool ports.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[OpenCode Router] ${signal} received — shutting down`);
    try {
      server.close();
    } catch {
      /* ignore */
    }
    try {
      await egressPool.shutdown();
    } catch {
      /* ignore */
    }
    try {
      await VpnEngine.getInstance().stop();
    } catch {
      /* ignore */
    }
    setTimeout(() => process.exit(0), 200).unref?.();
  };

  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });

  return server;
}

if (isDirectRun) {
  bootstrap();
  startServer();
}
