import type Database from 'better-sqlite3';

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
    gateway_quota_reserve_tokens: '2000'
  };
  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(defaults)) {
    insertSetting.run(k, v);
  }

  // Mark prescreen runs that were interrupted by a crash as aborted.
  db.prepare(`UPDATE prescreen_runs SET status = 'aborted', finished_at = datetime('now') WHERE status = 'running'`).run();
}
