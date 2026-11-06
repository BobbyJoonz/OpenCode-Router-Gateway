import express, { type Request, type Response } from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { db, getSetting, initDatabase, setSetting } from './db/database';
import { ConfigFetcher } from './discovery/config-fetcher';
import { KeyManager } from './gateway/key-manager';
import { createGatewayRouter } from './gateway/openai-router';
import { UpstreamClient } from './gateway/upstream-client';
import { lifecycle } from './lifecycle';
import { logger } from './observability/logger';
import { metricsHandler, metricsMiddleware, refreshGauges } from './observability/metrics';
import { requestContextMiddleware } from './observability/request-context';
import { initTracing } from './observability/tracing';
import { OpenCodeService } from './opencode/opencode-service';
import { ConnectionOrchestrator } from './orchestrator/connection-orchestrator';
import {
  createAuthMiddleware,
  createCorsMiddleware,
  createSecurityGuardMiddleware,
  DEFAULT_BIND_HOST,
  maskAddress,
  resolveBindHost,
  sanitizeSubscriptionUrl,
  setActiveBindHost,
  validateRemoteBindingConfig
} from './security/api-guard';
import { PrivilegeWizard } from './security/privilege-wizard';
import { BulkPrescreener } from './tester/bulk-prescreener';
import { HealthMonitor } from './tester/health-monitor';
import { LatencyTester } from './tester/latency-tester';
import { VpnEngine } from './vpn/vpn-engine';

export const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const { host: INITIAL_BIND_HOST, warning: hostWarning } = resolveBindHost();
if (hostWarning) {
  logger.warn({ event: 'bind_warning' }, hostWarning);
}
setActiveBindHost(INITIAL_BIND_HOST);

// ---------------------------------------------------------------------------
// Observability + lifecycle run first so every request (including rejected
// ones) is counted, logged with a request id, and drained on shutdown.
// ---------------------------------------------------------------------------
app.use(requestContextMiddleware);
app.use(metricsMiddleware);
app.use(lifecycle.trackInFlight);

// Security Hardening: Restricted CORS with development-only origin allowlist
app.use(createCorsMiddleware(PORT, INITIAL_BIND_HOST));

// Security Hardening: Guard middleware for Host header validation and CSRF protection
app.use(createSecurityGuardMiddleware(PORT, INITIAL_BIND_HOST));

// Route-specific parser for the gateway. body-parser enforces its limit on the
// bytes actually received, so a `Transfer-Encoding: chunked` request cannot slip
// past the content-length check in the auth middleware.
app.use('/v1', express.json({ limit: process.env.GATEWAY_MAX_BODY || '8mb' }));

app.use(express.json({ limit: '10mb' }));

// ---------------------------------------------------------------------------
// OpenAI-compatible gateway (/v1). Mounted BEFORE the management auth
// middleware on purpose: it authenticates with its own `sk-or-...` keys and must
// stay usable by external clients even when the admin API is locked down.
// ---------------------------------------------------------------------------
app.use('/v1', createGatewayRouter());

// Security Hardening: Mandatory Bearer token authentication for remote access
app.use(createAuthMiddleware());

// Initialize SQLite database
initDatabase();

const orchestrator = ConnectionOrchestrator.getInstance();
const vpn = VpnEngine.getInstance();
// Lazy on purpose: the gateway must start and serve without the OpenCode CLI installed.
const getOpenCode = () => OpenCodeService.getInstance();

// Background health monitor (no-op when disabled in settings).
HealthMonitor.start();

// Server-Sent Events (SSE) clients
const sseClients: Set<Response> = new Set();

// ---------------------------------------------------------------------------
// Graceful shutdown wiring.
// `pre` hooks release long-lived connections that would otherwise block drain;
// `post` hooks stop the engine and flush telemetry.
// ---------------------------------------------------------------------------
lifecycle.onShutdown(
  'sse-clients',
  () => {
    for (const client of sseClients) {
      try {
        client.end();
      } catch {
        /* ignore */
      }
    }
    sseClients.clear();
  },
  'pre'
);
lifecycle.onShutdown('prescreener', () => BulkPrescreener.requestAbort(), 'pre');
lifecycle.onShutdown('health-monitor', () => HealthMonitor.stop(), 'pre');
lifecycle.onShutdown('vpn-engine', async () => {
  await vpn.stop();
});
lifecycle.onShutdown('upstream-agents', () => UpstreamClient.resetAgents());

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
  res.write(
    `data: ${JSON.stringify({
      phase: orchestrator.getStatus().phase,
      message: orchestrator.getStatus().message,
      stats: orchestrator.getStatus().stats,
      activeConnection: vpn.getActiveConfig()
    })}\n\n`
  );

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
  const opencodeTest = await getOpenCode().testOpenCodeConnection(
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

  const whereClauses: string[] = [];
  const params: any[] = [];

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
  const items = db
    .prepare(`
    SELECT
      id, protocol, address, port, remark, security, network,
      last_tested_at, last_latency_ms, last_status, consecutive_failures, success_count, is_active,
      tcp_alive, tcp_latency_ms, egress_ip, health_score, last_health_check, prescreen_at,
      created_at
    FROM configs
    ${whereStr}
    ORDER BY is_active DESC, success_count DESC, id ASC
    LIMIT ? OFFSET ?
  `)
    .all(...params, limit, offset);

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

  const opencodeTest = await getOpenCode().testOpenCodeConnection(
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
  const opencodeInfo = { ...getOpenCode().getInfo() };
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
  const launcherPath = sanitizePath(getOpenCode().getLauncherPath());
  const history = db
    .prepare(`
    SELECT h.*, c.remark, c.protocol, c.address, c.port
    FROM test_history h
    JOIN configs c ON h.config_id = c.id
    ORDER BY h.id DESC
    LIMIT 15
  `)
    .all() as any[];

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
// Bulk TCP pre-screen
// ---------------------------------------------------------------------------
app.post('/api/configs/prescreen', (req: Request, res: Response) => {
  if (BulkPrescreener.isRunning()) {
    return res
      .status(409)
      .json({ error: 'A pre-screen run is already in progress', progress: BulkPrescreener.getProgress() });
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
  const distinct =
    (db.prepare('SELECT COUNT(DISTINCT egress_ip) AS n FROM configs WHERE egress_ip IS NOT NULL').get() as any)?.n || 0;
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
      dailyTokenLimit: req.body?.dailyTokenLimit
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
  'gateway_quota_reserve_tokens'
]);

const SENSITIVE_SETTINGS = new Set(['gateway_upstream_base_url']);

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
  const rows = db.prepare('SELECT key, value FROM settings ORDER BY key').all() as Array<{
    key: string;
    value: string;
  }>;
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
// Observability: Prometheus scrape endpoint (management auth applies)
// ---------------------------------------------------------------------------
app.get('/metrics', async (req: Request, res: Response) => {
  refreshGauges();
  await metricsHandler(req, res);
});

// ---------------------------------------------------------------------------
// Graceful shutdown trigger.
// systemd delivers SIGTERM on Linux; this endpoint lets the same path be
// exercised on Windows and in automated lifecycle tests.
// ---------------------------------------------------------------------------
app.post('/api/admin/shutdown', (req: Request, res: Response) => {
  const drainDelayMs = Math.max(0, Math.min(parseInt(String(req.body?.drainDelayMs ?? 0), 10) || 0, 10000));
  res.status(202).json({ success: true, message: 'Shutdown scheduled', drainDelayMs });
  setTimeout(() => {
    void lifecycle.shutdown({ reason: 'api', drainDelayMs, timeoutMs: 15000 });
  }, 25);
});

// Serve static frontend files if built
const frontendDist = path.resolve(__dirname, '../frontend/dist');
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.use((req: Request, res: Response) => {
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
}

export function startServer(port: number = PORT, host?: string) {
  const { host: bindHost, warning } = resolveBindHost(host);
  if (warning) {
    logger.warn({ event: 'bind_warning' }, warning);
  }
  // Validate that remote binding is protected by an API key
  validateRemoteBindingConfig(bindHost, process.env.OPENCODE_ROUTER_API_KEY);
  setActiveBindHost(bindHost);

  // Tracing is opt-in (OTEL_EXPORTER_OTLP_ENDPOINT); never blocks startup.
  void initTracing();

  const server = app.listen(port, bindHost, () => {
    logger.info({ event: 'server_started', bindHost, port }, `backend listening on http://${bindHost}:${port}`);
  });

  lifecycle.install(server, {
    timeoutMs: Math.max(1000, parseInt(process.env.SHUTDOWN_TIMEOUT_MS || '15000', 10))
  });

  return server;
}

if (require.main === module) {
  startServer();
}
