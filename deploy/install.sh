#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# OpenCode Router Gateway — bare-metal installer (Debian/Ubuntu)
#
#   sudo ./deploy/install.sh
#
# Idempotent: safe to re-run for upgrades. Never overwrites an existing .env.
# ---------------------------------------------------------------------------
set -euo pipefail

APP_DIR="/opt/opencode-router"
APP_USER="opencode"
XRAY_VERSION="v26.10.31"
# Point this at a mirror when github.com is blocked on the target host.
XRAY_BASE="${XRAY_BASE:-https://github.com}"
NODE_MAJOR_MIN=18

log()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

[[ "${EUID}" -eq 0 ]] || die "run as root (sudo $0)"

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -f "${SRC_DIR}/package.json" ]] || die "package.json not found next to deploy/"

# ---------------------------------------------------------------- packages
log "Installing base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl unzip git >/dev/null

# ---------------------------------------------------------------- node
if ! command -v node >/dev/null 2>&1; then
  log "Installing Node.js 22 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJOR >= NODE_MAJOR_MIN )) || die "Node.js >= ${NODE_MAJOR_MIN} required (found $(node -v))"
log "Node $(node -v), npm $(npm -v)"

# ---------------------------------------------------------------- user
if ! id -u "${APP_USER}" >/dev/null 2>&1; then
  log "Creating system user ${APP_USER}"
  useradd --system --create-home --shell /usr/sbin/nologin "${APP_USER}"
fi

# ---------------------------------------------------------------- files
log "Syncing application to ${APP_DIR}"
mkdir -p "${APP_DIR}"
# Copy the tree without node_modules/data/binaries.
tar -C "${SRC_DIR}" \
    --exclude=node_modules --exclude=data --exclude=.git \
    --exclude='bin/xray' --exclude='bin/xray.exe' \
    --exclude='*.db' --exclude='*.db-wal' --exclude='*.db-shm' \
    -cf - . | tar -C "${APP_DIR}" -xf -

mkdir -p "${APP_DIR}/data" "${APP_DIR}/bin"
chmod 700 "${APP_DIR}/data"

# ---------------------------------------------------------------- deps
log "Installing npm dependencies (this can take a minute)"
cd "${APP_DIR}"
npm install --no-audit --no-fund
npm rebuild better-sqlite3 >/dev/null 2>&1 || warn "better-sqlite3 rebuild failed; check build tools"

log "Building frontend"
( cd "${APP_DIR}/src/frontend" && npx vite build )

# ---------------------------------------------------------------- xray
if [[ ! -x "${APP_DIR}/bin/xray" ]]; then
  log "Downloading Xray-core ${XRAY_VERSION}"
  ARCH="$(uname -m)"
  case "${ARCH}" in
    x86_64|amd64) XARCH="64" ;;
    aarch64|arm64) XARCH="arm64-v8a" ;;
    *) die "unsupported architecture: ${ARCH}" ;;
  esac
  TMP="$(mktemp)"
  if curl -fsSL "${XRAY_BASE}/XTLS/Xray-core/releases/download/${XRAY_VERSION}/Xray-linux-${XARCH}.zip" -o "${TMP}"; then
    unzip -q -o "${TMP}" xray geoip.dat geosite.dat -d "${APP_DIR}/bin/"
    chmod +x "${APP_DIR}/bin/xray"
    rm -f "${TMP}"
    log "Xray $( "${APP_DIR}/bin/xray" version | head -1 )"
  else
    rm -f "${TMP}"
    warn "Could not download Xray. Set XRAY_BASE to a mirror and re-run, e.g.:"
    warn "  sudo XRAY_BASE=https://gh-proxy.com/https://github.com ./deploy/install.sh"
  fi
fi

# ---------------------------------------------------------------- env
if [[ ! -f "${APP_DIR}/.env" ]]; then
  log "Creating ${APP_DIR}/.env from .env.example"
  cp "${APP_DIR}/.env.example" "${APP_DIR}/.env"
  chmod 600 "${APP_DIR}/.env"
  warn "Edit ${APP_DIR}/.env and set GATEWAY_UPSTREAM_BASE_URL / GATEWAY_UPSTREAM_API_KEY"
else
  log "Keeping existing ${APP_DIR}/.env"
fi

# ---------------------------------------------------------------- perms
chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"
chmod 600 "${APP_DIR}/.env"

# ---------------------------------------------------------------- systemd
log "Installing systemd unit"
cp "${APP_DIR}/deploy/opencode-router.service" /etc/systemd/system/opencode-router.service
systemctl daemon-reload
systemctl enable opencode-router >/dev/null
systemctl restart opencode-router

sleep 2
if systemctl is-active --quiet opencode-router; then
  log "Service is running"
else
  warn "Service failed to start — inspect with: journalctl -u opencode-router -n 100"
fi

cat <<EOF

────────────────────────────────────────────────────────────
 Installed at: ${APP_DIR}
 Service:      systemctl status opencode-router
 Logs:         journalctl -u opencode-router -f

 Next steps
 1. Edit ${APP_DIR}/.env  (upstream base URL + key, gateway_enabled=true)
 2. systemctl restart opencode-router
 3. Reach the admin API locally:   ssh -L 3000:127.0.0.1:3000 user@this-host
    then http://localhost:3000
 4. Create an API key:
      curl -s -X POST http://127.0.0.1:3000/api/keys \\
        -H 'content-type: application/json' \\
        -d '{"name":"laptop","rpmLimit":120}' | jq
 5. Put Caddy in front (deploy/Caddyfile) for TLS on /v1/*
────────────────────────────────────────────────────────────
EOF
