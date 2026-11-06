#!/usr/bin/env bash
set -e

# Setup Privileges for OpenCode Router
# This script applies the principle of least privilege:
# 1. Grants cap_net_admin to the xray binary (if TUN is desired)
# 2. Creates a narrowly scoped sudoers file restricted strictly to the xray binary

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
XRAY_BIN="${PROJECT_DIR}/bin/xray"
SUDOERS_FILE="/etc/sudoers.d/opencode-router"
CURRENT_USER="$(id -un)"

echo "=== OpenCode Router Security & Privilege Setup ==="
echo "Configuring permissions for user: ${CURRENT_USER}"

# 1. Verify binary exists
if [ ! -f "${XRAY_BIN}" ]; then
  echo "Error: Xray binary not found at ${XRAY_BIN}"
  exit 1
fi

chmod +x "${XRAY_BIN}"

# 2. Grant Linux capabilities for unprivileged network administration (TUN support without root)
if command -v setcap >/dev/null 2>&1; then
  echo "Applying Linux capabilities (cap_net_admin, cap_net_bind_service) to xray..."
  sudo setcap 'cap_net_admin,cap_net_bind_service=+ep' "${XRAY_BIN}"
  echo "[OK] Linux capabilities granted to ${XRAY_BIN}"
fi

# 3. Create narrowly-scoped sudoers entry ONLY for the specific xray binary
echo "Installing narrowly-scoped sudoers rule..."
TMP_SUDOERS=$(mktemp)
cat <<EOF > "${TMP_SUDOERS}"
# Strictly scoped permission for OpenCode Router
# Only allows executing the specific xray binary without full root access
${CURRENT_USER} ALL=(root) NOPASSWD: ${XRAY_BIN}
EOF

# Validate syntax with visudo before installing
sudo visudo -cf "${TMP_SUDOERS}"
sudo cp "${TMP_SUDOERS}" "${SUDOERS_FILE}"
sudo chmod 0440 "${SUDOERS_FILE}"
rm -f "${TMP_SUDOERS}"

echo "[OK] Sudoers rule installed at ${SUDOERS_FILE}"
echo "Setup complete! Privileged operations are now configured safely without exposing root."
