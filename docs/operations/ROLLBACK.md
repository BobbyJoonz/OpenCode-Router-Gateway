# Rollback

## Before every change

```bash
STAMP=$(date +%Y%m%d-%H%M%S)
mkdir -p /root/backups/opencode-router-$STAMP
tar -czf /root/backups/opencode-router-$STAMP/data.tgz -C /opt/opencode-router-local data
cp /opt/opencode-router-local/.env /root/backups/opencode-router-$STAMP/env
git -C /opt/opencode-router-local rev-parse HEAD > /root/backups/opencode-router-$STAMP/commit
```

## Rollback code

```bash
cd /opt/opencode-router-local
git reset --hard <previous-commit>
npm ci && npm run build
systemctl restart opencode-router-local
curl -fsS http://100.91.206.72:3011/v1/health
```

## Rollback data

```bash
systemctl stop opencode-router-local
rm -f data/opencode-vpn.db data/opencode-vpn.db-wal data/opencode-vpn.db-shm
tar -xzf /root/backups/opencode-router-<stamp>/data.tgz -C /opt/opencode-router-local
chown -R opencode:opencode data
systemctl start opencode-router-local
```

## Verify after rollback

1. `GET /v1/health` → ok
2. `GET /v1/models` with a key → model list
3. One real completion from Windows
4. `usage_log` row for that request (request id, provider, egress node)

## Known-good points

| Commit | Meaning |
|---|---|
| `c99732c` | fresh install fixed |
| `aa09cfd` | cost columns fixed |
| `f6632cb` | `[DONE]` + real model list |
| `4992e43` | 429 failover |
| `cf5ee56` | real per-slot probe |
| `77cb3fd` | egress port collision |
