import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { runMigrations } from './migrations';
import { dataDir } from '../paths';

const DB_DIR = dataDir();
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true, mode: 0o700 });
}
try {
  fs.chmodSync(DB_DIR, 0o700);
} catch {}

const DB_PATH = path.join(DB_DIR, 'opencode-vpn.db');
export const db = new Database(DB_PATH);
try {
  if (fs.existsSync(DB_PATH)) {
    fs.chmodSync(DB_PATH, 0o600);
  }
} catch {}

// Enable WAL mode for high concurrency
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_fetched_at TEXT,
      fetch_status TEXT,
      config_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      protocol TEXT NOT NULL,
      address TEXT NOT NULL,
      port INTEGER NOT NULL,
      remark TEXT,
      security TEXT DEFAULT 'none',
      network TEXT DEFAULT 'tcp',
      raw_url TEXT NOT NULL,
      config_hash TEXT NOT NULL UNIQUE,
      source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
      last_tested_at TEXT,
      last_latency_ms INTEGER,
      last_status TEXT DEFAULT 'untested',
      consecutive_failures INTEGER DEFAULT 0,
      success_count INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 0,
      details_json TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_configs_status ON configs(last_status);
    CREATE INDEX IF NOT EXISTS idx_configs_hash ON configs(config_hash);

    CREATE TABLE IF NOT EXISTS test_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      config_id INTEGER NOT NULL REFERENCES configs(id) ON DELETE CASCADE,
      timestamp TEXT DEFAULT (datetime('now')),
      latency_ms INTEGER,
      proxy_success INTEGER NOT NULL,
      opencode_success INTEGER NOT NULL,
      error_category TEXT,
      error_message TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_history_config ON test_history(config_id);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS active_connection (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      config_id INTEGER REFERENCES configs(id) ON DELETE SET NULL,
      pid INTEGER,
      socks_port INTEGER DEFAULT 10808,
      http_port INTEGER DEFAULT 10809,
      egress_ip TEXT,
      normal_ip TEXT,
      latency_ms INTEGER,
      reason TEXT,
      connected_at TEXT
    );
  `);

  // Seed default settings if missing
  const defaultSettings: Record<string, string> = {
    socks_port: '10808',
    http_port: '10809',
    opencode_path: '/usr/local/bin/opencode',
    max_test_attempts: '25',
    test_timeout_seconds: '15',
    opencode_timeout_seconds: '20',
    rank_by: 'latency'
  };

  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(defaultSettings)) {
    insertSetting.run(k, v);
  }

  // Seed default curated GitHub sources
  const defaultSources = [
    {
      name: 'ermaozi v2ray (VLESS/Trojan/SS/VMess)',
      url: 'https://raw.githubusercontent.com/ermaozi/get_subscribe/main/subscribe/v2ray.txt'
    },
    {
      name: 'Pawdroid Free Servers (VLESS/SS)',
      url: 'https://raw.githubusercontent.com/Pawdroid/Free-servers/main/sub'
    },
    {
      name: 'nyeinkokoaung404 V2Ray Configs (Mix)',
      url: 'https://raw.githubusercontent.com/nyeinkokoaung404/V2ray-Configs/main/All_Configs_Sub.txt'
    },
    {
      name: 'freefq Free Nodes (VMess/SS)',
      url: 'https://raw.githubusercontent.com/freefq/free/master/v2'
    }
  ];

  const insertSource = db.prepare('INSERT OR IGNORE INTO sources (name, url) VALUES (?, ?)');
  for (const s of defaultSources) {
    insertSource.run(s.name, s.url);
  }

  // Additive, idempotent schema upgrades for the gateway edition.
  runMigrations(db);
}

export function getSetting(key: string, defaultValue: string = ''): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : defaultValue;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}
