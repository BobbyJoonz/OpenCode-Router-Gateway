import type Database from 'better-sqlite3';

/**
 * Migrations for the "service" edition (axis C).
 *
 * Additive and idempotent, same rules as the gateway migrations.
 */
export function runServiceMigrations(db: Database.Database): void {
  db.exec(`
    -- ------------------------------------------------------------------
    -- C1: multi-instance egress pool
    -- ------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS pool_slots (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      slot_index   INTEGER NOT NULL UNIQUE,
      socks_port   INTEGER NOT NULL,
      http_port    INTEGER NOT NULL,
      config_id    INTEGER REFERENCES configs(id) ON DELETE SET NULL,
      state        TEXT NOT NULL DEFAULT 'empty',   -- empty | starting | ready | failed
      pid          INTEGER,
      error        TEXT,
      assigned_at  TEXT,
      last_used_at TEXT
    );

    -- ------------------------------------------------------------------
    -- C3: money. model_prices used to be "owned by the gateway migrations",
    -- except no migration ever created it, so a brand-new database crashed on
    -- the first start (SqliteError: no such table: model_prices). It lives here
    -- with the canonical columns the runtime reads.
    -- ------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS model_prices (
      model         TEXT PRIMARY KEY,
      input_per_1m  REAL NOT NULL DEFAULT 0,
      output_per_1m REAL NOT NULL DEFAULT 0
    );

    -- ------------------------------------------------------------------
    -- C4: abuse signals
    -- ------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS abuse_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      key_id     INTEGER,
      ip         TEXT,
      reason     TEXT NOT NULL,
      score      REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_abuse_key_time ON abuse_events(key_id, created_at);

    -- ------------------------------------------------------------------
    -- C5: self-serve onboarding (invite-gated)
    -- ------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS signup_invites (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      code_hash  TEXT NOT NULL UNIQUE,
      label      TEXT,
      max_uses   INTEGER NOT NULL DEFAULT 1,
      uses       INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_signup_ip ON abuse_events(ip, created_at);

    -- ------------------------------------------------------------------
    -- C6: usage alerts
    -- ------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS usage_alerts (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      key_id        INTEGER NOT NULL,
      threshold_pct INTEGER NOT NULL,       -- 50 / 80 / 100
      last_fired_at TEXT,
      UNIQUE(key_id, threshold_pct)
    );
  `);

  // ---- additive columns -------------------------------------------------
  const keyCols = new Set(
    (db.prepare('PRAGMA table_info(api_keys)').all() as Array<{ name: string }>).map((c) => c.name)
  );
  const addKey = (name: string, ddl: string) => {
    if (!keyCols.has(name)) db.exec(`ALTER TABLE api_keys ADD COLUMN ${name} ${ddl}`);
  };
  addKey('pool_id', 'INTEGER DEFAULT 0');
  addKey('sticky', 'INTEGER DEFAULT 1');
  addKey('preferred_providers', 'TEXT'); // JSON array of provider ids
  addKey('spend_cap_usd_daily', 'REAL DEFAULT 0');
  addKey('spend_cap_usd_monthly', 'REAL DEFAULT 0');
  addKey('trust_level', 'INTEGER DEFAULT 100');
  addKey('throttled_until', 'TEXT');
  addKey('email', 'TEXT');

  const usageCols = new Set(
    (db.prepare('PRAGMA table_info(usage_log)').all() as Array<{ name: string }>).map((c) => c.name)
  );
  if (!usageCols.has('cost_usd')) db.exec('ALTER TABLE usage_log ADD COLUMN cost_usd REAL DEFAULT 0');
  if (!usageCols.has('slot_index')) db.exec('ALTER TABLE usage_log ADD COLUMN slot_index INTEGER');

  db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_cost ON usage_log(created_at)`);

  // ---- settings ---------------------------------------------------------
  const defaults: Record<string, string> = {
    // C1 pool
    pool_enabled: 'false',
    pool_size: '4',
    pool_ports_base: '12000',
    pool_refill_interval_seconds: '60',
    pool_strategy: 'least_loaded',
    // C3 cost
    cost_tracking_enabled: 'true',
    spend_reserve_usd: '0.002',
    // C4 abuse
    abuse_detection_enabled: 'true',
    abuse_429_threshold: '20',
    abuse_duplicate_threshold: '15',
    abuse_window_seconds: '60',
    // C5 onboarding
    signup_enabled: 'false',
    signup_max_per_ip_per_day: '3',
    // C6
    status_page_enabled: 'true'
  };
  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(defaults)) insertSetting.run(k, v);

  // Seed a small price table. Unknown models cost 0 and are logged as such.
  const priceCols = new Set(
    (db.prepare('PRAGMA table_info(model_prices)').all() as Array<{ name: string }>).map((c) => c.name)
  );
  const inCol = priceCols.has('cost_per_1m_in') ? 'cost_per_1m_in' : 'input_per_1m';
  const outCol = priceCols.has('cost_per_1m_out') ? 'cost_per_1m_out' : 'output_per_1m';
  const insertPrice = db.prepare(
    `INSERT OR IGNORE INTO model_prices (model, ${inCol}, ${outCol}) VALUES (?, ?, ?)`
  );
  const seedPrices: Array<[string, number, number]> = [
    ['gpt-4o-mini', 0.15, 0.6],
    ['gpt-4o', 2.5, 10.0],
    ['gpt-4.1-mini', 0.4, 1.6],
    ['claude-3-5-haiku', 0.8, 4.0],
    ['claude-sonnet-4', 3.0, 15.0],
    ['deepseek-chat', 0.27, 1.1],
    ['mock-ok', 0.15, 0.6]
  ];
  for (const [model, i, o] of seedPrices) insertPrice.run(model, i, o);
}
