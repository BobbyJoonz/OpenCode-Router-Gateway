# Deployment

## Layout

| Item | Path |
|---|---|
| Repo + runtime (working) | `/opt/opencode-router-local` |
| Repo + runtime (staging) | `/opt/opencode-router` |
| Service (working) | `opencode-router-local.service` → `100.91.206.72:3011` |
| Service (staging) | `opencode-router.service` → `127.0.0.1:3010` |
| Data | `<instance>/data/opencode-vpn.db` |
| Access file | `/root/opencode-router-access.txt` (600) |

## First install (fresh host)

```bash
git clone https://github.com/BobbyJoonz/OpenCode-Router-Gateway.git /opt/opencode-router
cd /opt/opencode-router
npm ci
mkdir -p bin && curl -fsSL https://github.com/XTLS/Xray-core/releases/download/v26.10.31/Xray-linux-64.zip -o /tmp/x.zip \
  && unzip -q -o /tmp/x.zip xray geoip.dat geosite.dat -d bin/ && chmod +x bin/xray
npm run build
# systemd unit: see deploy/opencode-router.service
```

The fresh-install path is covered by `npm run test:fresh` (11 assertions).

## Update

```bash
cd /opt/opencode-router-local
git pull origin main
npm ci          # only when package-lock changed
npm run build
systemctl restart opencode-router-local
curl -fsS http://100.91.206.72:3011/v1/health
```

## Staging first

Changes are validated on the staging instance (port 3010, loopback only) before the
working instance is restarted. Staging has its own database and its own egress port
range (12100-12103), so the two never collide.

## Readiness

- Liveness: `GET /v1/health` → `status: ok`.
- Readiness: `GET /readyz` (DB + upstream configured + pool state).
- `npm run doctor` (static) and `npm run doctor:live` (real upstream call).
