import type Database from 'better-sqlite3';
import { runServiceMigrations } from './service-migrations';

/**
 * Schema migrations for the "gateway" edition.
 *
 * Everything here is additive and idempotent: an existing database created by the
 * original OpenCode Router keeps working and simply gains the new tables/columns.
 */
export function runMigrations(db: Database.Database): void {
  db.exec(`
    -- ------------------------------------------------------------------
    -- API keys issued to clients of the OpenAI-compatible gateway
    -- ------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS api_keys (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      key_hash          TEXT NOT NULL UNIQUE,     -- sha256(secret), never the secret
      key_prefix        TEXT NOT NULL,            -- first chars, safe to display
      name              TEXT NOT NULL,
      rpm_limit         INTEGER NOT NULL DEFAULT 60,
      daily_token_limit INTEGER NOT NULL DEFAULT 0, -- 0 = unlimited
      enabled           INTEGER NOT NULL DEFAULT 1,
      created_at        TEXT DEFAULT (datetime('now')),
      last_used_at      TEXT,
      total_requests    INTEGER NOT NULL DEFAULT 0,
      total_tokens      INTEGER NOT NULL DEFAULT 0
    );

    -- ------------------------------------------------------------------
    -- Per-request accounting (drives quotas, dashboards, cost analysis)
    -- ------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS usage_log (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      key_id            INTEGER REFERENCES api_keys(id) ON DELETE SET NULL,
      model             TEXT,
      prompt_tokens     INTEGER DEFAULT 0,
      completion_tokens INTEGER DEFAULT 0,
      total_tokens      INTEGER DEFAULT 0,
      status_code       INTEGER,
      latency_ms        INTEGER,
      upstream          TEXT,
      egress_node_id    INTEGER,
      error             TEXT,
      created_at        TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_usage_key_time ON usage_log(key_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_usage_time ON usage_log(created_at);

    -- ------------------------------------------------------------------
    -- Distinct egress IPs (a "13 node" subscription is often 1 server)
    -- ------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS egress_groups (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      egress_ip   TEXT NOT NULL UNIQUE,
      first_seen  TEXT DEFAULT (datetime('now')),
      last_seen   TEXT DEFAULT (datetime('now')),
      node_count  INTEGER DEFAULT 0
    );

    -- ------------------------------------------------------------------
    -- Bulk TCP pre-screen runs
    -- ------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS prescreen_runs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at   TEXT DEFAULT (datetime('now')),
      finished_at  TEXT,
      total        INTEGER DEFAULT 0,
      alive        INTEGER DEFAULT 0,
      concurrency  INTEGER,
      timeout_ms   INTEGER,
      status       TEXT DEFAULT 'running',   -- running | done | aborted | error
      error        TEXT
    );

    -- ------------------------------------------------------------------
    -- D4: independent upstream providers (free / cheap / primary)
    -- ------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS providers (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT NOT NULL UNIQUE,
      kind            TEXT NOT NULL DEFAULT 'openai',   -- openai | anthropic | custom
      base_url        TEXT NOT NULL,
      key_env         TEXT NOT NULL,                    -- env var NAME, never the key
      model           TEXT,
      priority        INTEGER NOT NULL DEFAULT 100,     -- lower wins
      cost_per_1m_in  REAL NOT NULL DEFAULT 0,
      cost_per_1m_out REAL NOT NULL DEFAULT 0,
      rpm_limit       INTEGER NOT NULL DEFAULT 0,
      daily_usd_cap   REAL NOT NULL DEFAULT 0,
      enabled         INTEGER NOT NULL DEFAULT 1,
      created_at      TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS provider_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_id INTEGER REFERENCES providers(id) ON DELETE CASCADE,
      event       TEXT NOT NULL,   -- success | rate_limit | auth | server | timeout | failover
      status_code INTEGER,
      latency_ms  INTEGER,
      created_at  TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_provider_events_time ON provider_events(provider_id, created_at);

    -- ------------------------------------------------------------------
    -- Model routing: public alias -> (provider, upstream model name)
    --
    -- Without this the client's "model" string is forwarded verbatim to whichever
    -- provider the policy picked, and a provider that does not host that model
    -- answers 4xx. An alias makes the mapping explicit and lets one alias resolve
    -- to different upstream names per provider.
    -- ------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS model_routes (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      alias          TEXT NOT NULL,
      provider_id    INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
      upstream_model TEXT NOT NULL,
      priority       INTEGER NOT NULL DEFAULT 100,
      enabled        INTEGER NOT NULL DEFAULT 1,
      created_at     TEXT DEFAULT (datetime('now')),
      UNIQUE(alias, provider_id)
    );
    CREATE INDEX IF NOT EXISTS idx_model_routes_alias ON model_routes(alias, enabled);

    -- NOTE: model_prices is owned by service-migrations (canonical columns
    -- input_per_1m / output_per_1m). Do not create it here.
  `);

  // ---- additive columns on configs -------------------------------------
  const cols = new Set(
    (db.prepare('PRAGMA table_info(configs)').all() as Array<{ name: string }>).map((c) => c.name)
  );
  const addColumn = (name: string, ddl: string) => {
    if (!cols.has(name)) {
      db.exec(`ALTER TABLE configs ADD COLUMN ${name} ${ddl}`);
    }
  };
  addColumn('tcp_alive', 'INTEGER'); // NULL = never screened, 1 = alive, 0 = dead
  addColumn('tcp_latency_ms', 'INTEGER');
  addColumn('egress_ip', 'TEXT');
  addColumn('health_score', 'REAL DEFAULT 100');
  addColumn('last_health_check', 'TEXT');
  addColumn('bandwidth_bytes', 'INTEGER DEFAULT 0');
  addColumn('prescreen_at', 'TEXT');
  addColumn('last_error', 'TEXT');

  // D2: IP freshness instrumentation
  addColumn('rate_limit_hits', 'INTEGER DEFAULT 0');
  addColumn('success_streak', 'INTEGER DEFAULT 0');
  addColumn('last_429_at', 'TEXT');
  addColumn('requests_before_429', 'INTEGER');
  addColumn('freshness_score', 'REAL DEFAULT 100');

  // D4/D5: columns added to tables created earlier in this migration
  const addColumnTo = (table: string, name: string, ddl: string) => {
    const existing = new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)
    );
    if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
  };
  addColumnTo('usage_log', 'provider_id', 'INTEGER');
  addColumnTo('usage_log', 'cost_usd', 'REAL DEFAULT 0');
  addColumnTo('api_keys', 'spend_cap_usd_daily', 'REAL DEFAULT 0');
  addColumnTo('api_keys', 'spend_cap_usd_monthly', 'REAL DEFAULT 0');
  addColumnTo('api_keys', 'egress_policy', "TEXT DEFAULT ''");

  db.exec(`CREATE INDEX IF NOT EXISTS idx_configs_tcp ON configs(tcp_alive)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_configs_health ON configs(health_score)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_configs_egress ON configs(egress_ip)`);

  // ---- new default settings -------------------------------------------
  const defaults: Record<string, string> = {
    // pre-screen
    prescreen_concurrency: '200',
    prescreen_timeout_ms: '1500',
    // background health monitor
    health_check_enabled: 'true',
    health_check_interval_seconds: '300',
    health_check_batch: '8',
    health_check_ports_base: '11818',
    // gateway
    gateway_enabled: 'false',
    gateway_upstream_base_url: '',
    gateway_upstream_model: '',
    gateway_upstream_timeout_seconds: '120',
    gateway_max_body_bytes: '8388608',
    gateway_default_rpm: '60',
    gateway_rotate_on_429: 'true',
    gateway_rotate_on_5xx: 'false',
    gateway_upstream_bypass_proxy_loopback: 'true',
    gateway_stream_include_usage: 'true',
    gateway_quota_reserve_tokens: '2000',
    // serving pool (B1/B2/B3)
    pool_size: '2',
    pool_base_port: '12000',
    pool_drain_timeout_ms: '15000',
    pool_watchdog_interval_ms: '2000',
    // D4/D5
    gateway_provider_policy: 'priority',       // priority | cost | round_robin
    gateway_max_provider_attempts: '3',
    gateway_freshness_weight: '0.2',
    // Routing
    egress_policy: 'sticky',                   // sticky | round_robin | least_loaded | random
    gateway_require_model_route: 'false',      // true => unknown model is a 404, never a passthrough
    gateway_model_prefix_provider: 'false',     // true => 'provider/model' pins a provider
    // Storage / retention (bounded growth)
    usage_retention_days: '90',                 // 0 = keep forever
    test_history_retention_days: '30',
    usage_max_rows: '500000',
    db_max_mb: '512',
    retention_interval_seconds: '3600',
    retention_vacuum_threshold: '5000',         // rows deleted before a VACUUM is worth it
    xray_log_max_bytes: '5242880',
    retention_timezone: 'local',                // local | utc
    // Pool sizing / memory guard
    pool_max_size: '16',
    pool_max_rss_mb: '512',
    // Alerts (out-of-band notifications)
    alerts_enabled: 'false',
    alert_webhook_url: '',
    alert_telegram_chat_id: '',
    alert_cooldown_seconds: '900',
    alert_check_interval_seconds: '300'
  };
  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(defaults)) {
    insertSetting.run(k, v);
  }

  // Repair: an earlier revision created model_prices with cost_per_1m_* columns
  // while the runtime reads input_per_1m/output_per_1m. Add + backfill so both
  // fresh and upgraded databases agree.
  try {
    const priceCols = new Set(
      (db.prepare('PRAGMA table_info(model_prices)').all() as Array<{ name: string }>).map((c) => c.name)
    );
    if (priceCols.size > 0 && !priceCols.has('input_per_1m')) {
      db.exec('ALTER TABLE model_prices ADD COLUMN input_per_1m REAL NOT NULL DEFAULT 0');
      db.exec('ALTER TABLE model_prices ADD COLUMN output_per_1m REAL NOT NULL DEFAULT 0');
      if (priceCols.has('cost_per_1m_in')) {
        db.exec(
          'UPDATE model_prices SET input_per_1m = COALESCE(cost_per_1m_in, 0), output_per_1m = COALESCE(cost_per_1m_out, 0)'
        );
      }
    }
  } catch {
    // best effort
  }

  // Mark prescreen runs that were interrupted by a crash as aborted.
  db.prepare(`UPDATE prescreen_runs SET status = 'aborted', finished_at = datetime('now') WHERE status = 'running'`).run();

  // Axis C (service edition) schema.
  runServiceMigrations(db);
}
