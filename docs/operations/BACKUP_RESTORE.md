# Backup and Restore

## What to back up

| Item | Why |
|---|---|
| `data/opencode-vpn.db` (+ `-wal`, `-shm`) | keys, providers, routes, usage, configs |
| `.env` | ports, launcher dir, provider keys (secrets) |
| `/etc/systemd/system/opencode-router*.service` | unit files |
| `git rev-parse HEAD` | exact code version |

## Backup

```bash
STAMP=$(date +%Y%m%d-%H%M%S)
BK=/root/backups/opencode-router-$STAMP
mkdir -p "$BK"
sqlite3 /opt/opencode-router-local/data/opencode-vpn.db "VACUUM INTO '$BK/db.sqlite'"
tar -czf "$BK/config.tgz" -C /opt/opencode-router-local .env
cp /etc/systemd/system/opencode-router-local.service "$BK/"
git -C /opt/opencode-router-local rev-parse HEAD > "$BK/commit"
ls -lh "$BK"
```

`VACUUM INTO` produces a consistent single-file copy without stopping the service.

## Restore (isolated test first)

```bash
mkdir -p /tmp/restore-test
sqlite3 /root/backups/opencode-router-<stamp>/db.sqlite "PRAGMA integrity_check;"
cp /root/backups/opencode-router-<stamp>/db.sqlite /tmp/restore-test/opencode-vpn.db
sqlite3 /tmp/restore-test/opencode-vpn.db "select count(*) from api_keys; select count(*) from usage_log;"
```

## Restore in place

```bash
systemctl stop opencode-router-local
cp data/opencode-vpn.db data/opencode-vpn.db.before-restore
cp /root/backups/opencode-router-<stamp>/db.sqlite data/opencode-vpn.db
rm -f data/opencode-vpn.db-wal data/opencode-vpn.db-shm
chown opencode:opencode data/opencode-vpn.db
systemctl start opencode-router-local
curl -fsS http://100.91.206.72:3011/v1/health
```

## Retention

`tools/backup.ts` keeps the last 10 database copies and verifies integrity before
declaring success. Run it from cron if unattended backups are required.
