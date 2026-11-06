/**
 * SQLite backup / restore / verify for the gateway database.
 *
 *   npm run backup                 # create a consistent backup + integrity check
 *   npm run backup -- --list       # list existing backups
 *   npm run backup -- --restore data/backups/<file>.db --yes
 *
 * A backup is taken with `VACUUM INTO`, which produces a consistent snapshot even
 * while the server is running (WAL mode). Restore REQUIRES the server to be stopped.
 */
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

const DATA_DIR = path.resolve(__dirname, '../data');
const DB_PATH = path.join(DATA_DIR, 'opencode-vpn.db');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const KEEP = 10;

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function ensureDir(): void {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function listBackups(): string[] {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.endsWith('.db'))
    .map((f) => path.join(BACKUP_DIR, f))
    .sort();
}

function verify(file: string): { ok: boolean; detail: string } {
  try {
    const db = new Database(file, { readonly: true });
    const result = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
    const counts = db
      .prepare('SELECT (SELECT COUNT(*) FROM configs) AS configs, (SELECT COUNT(*) FROM api_keys) AS keys')
      .get() as any;
    db.close();
    const ok = result.length === 1 && result[0].integrity_check === 'ok';
    return { ok, detail: ok ? `integrity ok, ${counts.configs} configs, ${counts.keys} keys` : JSON.stringify(result) };
  } catch (err: any) {
    return { ok: false, detail: err?.message || 'verify failed' };
  }
}

function createBackup(): void {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`No database at ${DB_PATH}`);
    process.exit(1);
  }
  ensureDir();

  const target = path.join(BACKUP_DIR, `opencode-vpn-${timestamp()}.db`);
  const db = new Database(DB_PATH);
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }

  const check = verify(target);
  const size = fs.statSync(target).size;
  console.log(`backup: ${target}`);
  console.log(`size:   ${(size / 1024 / 1024).toFixed(2)} MB`);
  console.log(`verify: ${check.ok ? 'OK' : 'FAILED'} — ${check.detail}`);

  // Rotate old backups.
  const all = listBackups();
  while (all.length > KEEP) {
    const oldest = all.shift()!;
    fs.unlinkSync(oldest);
    console.log(`pruned: ${oldest}`);
  }

  if (!check.ok) process.exit(1);
}

function restore(file: string, confirmed: boolean): void {
  if (!confirmed) {
    console.error('Refusing to restore without --yes (this replaces the live database).');
    process.exit(1);
  }
  const source = path.resolve(file);
  if (!fs.existsSync(source)) {
    console.error(`No such backup: ${source}`);
    process.exit(1);
  }

  const check = verify(source);
  if (!check.ok) {
    console.error(`Backup failed verification, refusing to restore: ${check.detail}`);
    process.exit(1);
  }

  // Safety copy of the current database before overwriting it.
  if (fs.existsSync(DB_PATH)) {
    ensureDir();
    const safety = path.join(BACKUP_DIR, `pre-restore-${timestamp()}.db`);
    fs.copyFileSync(DB_PATH, safety);
    console.log(`safety copy: ${safety}`);
  }

  for (const suffix of ['-wal', '-shm']) {
    const sidecar = DB_PATH + suffix;
    if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
  }
  fs.copyFileSync(source, DB_PATH);
  console.log(`restored: ${source} -> ${DB_PATH}`);
  console.log('NOTE: stop the server before restoring, and start it afterwards.');
}

function main(): void {
  const args = process.argv.slice(2);

  if (args.includes('--list')) {
    const backups = listBackups();
    if (backups.length === 0) {
      console.log('no backups yet');
      return;
    }
    for (const b of backups) {
      const stat = fs.statSync(b);
      console.log(`${(stat.size / 1024 / 1024).toFixed(2).padStart(8)} MB  ${stat.mtime.toISOString()}  ${b}`);
    }
    return;
  }

  const restoreIndex = args.indexOf('--restore');
  if (restoreIndex >= 0) {
    const file = args[restoreIndex + 1];
    if (!file) {
      console.error('usage: --restore <file> --yes');
      process.exit(1);
    }
    restore(file, args.includes('--yes'));
    return;
  }

  createBackup();
}

main();
