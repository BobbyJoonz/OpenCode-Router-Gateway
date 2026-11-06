#!/usr/bin/env bash
set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
START_SCRIPT="${PROJECT_DIR}/start.sh"
DESKTOP_DIR="${HOME}/Desktop"
APP_DIR="${HOME}/.local/share/applications"

mkdir -p "${APP_DIR}"

DESKTOP_FILE_CONTENT="[Desktop Entry]
Version=1.0
Type=Application
Name=OpenCode Router
Comment=Smart VPN & Connectivity Router for OpenCode on Ubuntu
Exec=${START_SCRIPT}
Path=${PROJECT_DIR}
Icon=network-vpn
Terminal=true
Categories=Development;Network;
StartupNotify=true
"

echo "${DESKTOP_FILE_CONTENT}" > "${APP_DIR}/opencode-router.desktop"
chmod +x "${APP_DIR}/opencode-router.desktop"

if [ -d "${DESKTOP_DIR}" ]; then
  echo "${DESKTOP_FILE_CONTENT}" > "${DESKTOP_DIR}/OpenCode-Router.desktop"
  chmod +x "${DESKTOP_DIR}/OpenCode-Router.desktop"
  # If gio is available on Ubuntu, mark as trusted
  if command -v gio >/dev/null 2>&1; then
    gio set "${DESKTOP_DIR}/OpenCode-Router.desktop" metadata::trusted true 2>/dev/null || true
  fi
fi

echo "[OK] Desktop launcher created successfully at:"
echo "     - ${DESKTOP_DIR}/OpenCode-Router.desktop"
echo "     - ${APP_DIR}/opencode-router.desktop"
