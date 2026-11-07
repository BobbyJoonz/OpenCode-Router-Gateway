# Rollback — premium egress integration

## Known-good commits

| Commit | Meaning |
|---|---|
| `7c4a14c` | traceability + audit docs |
| `344e367` | premium HTTP/SOCKS5 egress (current) |

## Backup before any change

```bash
STAMP=$(date +%Y%m%d-%H%M%S)
BK=/root/backups/opencode-router-$STAMP
mkdir -p "$BK"
sqlite3 /opt/opencode-router-local/data/opencode-vpn.db "VACUUM INTO '$BK/db.sqlite'"
cp /opt/opencode-router-local/.env "$BK/env"
cp /etc/systemd/system/opencode-router-local.service "$BK/"
git -C /opt/opencode-router-local rev-parse HEAD > "$BK/commit"
sqlite3 "$BK/db.sqlite" "PRAGMA integrity_check;"
```

## Roll back the premium feature

```bash
cd /opt/opencode-router-local
git reset --hard 7c4a14c
npm ci && npm run build
systemctl restart opencode-router-local
curl -fsS http://100.91.206.72:3011/v1/health
```

The migration only **adds** `providers.egress_mode` (default `pool`); an older build
ignores the column, so no data is lost and no down-migration is required.

## Roll back data

```bash
systemctl stop opencode-router-local
cp data/opencode-vpn.db data/opencode-vpn.db.pre-restore
cp "$BK/db.sqlite" data/opencode-vpn.db
rm -f data/opencode-vpn.db-wal data/opencode-vpn.db-shm
chown opencode:opencode data/opencode-vpn.db
systemctl start opencode-router-local
```

## Remove the premium SOCKS5 bridge

```bash
pkill -f premium-socks-bridge.json || true
rm -f /opt/opencode-router-local/data/premium-socks-bridge.json
```

The bridge is started on demand and dies with the gateway process.

## Verify after rollback

1. `GET /v1/health` → ok, slots ready
2. `GET /v1/models` with a key → list
3. one real completion from Windows
4. `usage_log` row for that request
