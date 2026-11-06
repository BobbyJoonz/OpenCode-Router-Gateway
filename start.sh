#!/usr/bin/env bash
set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${PROJECT_DIR}"

PORT="${PORT:-3000}"

echo "=========================================================="
echo "🛡️  Starting OpenCode Router"
echo "=========================================================="

# 1. Download Xray-core if missing
if [ ! -f "bin/xray" ]; then
  echo "📥 Xray binary not found. Downloading Xray-core..."
  mkdir -p bin
  ARCH=$(uname -m)
  case "$ARCH" in
    x86_64) XRAY_ARCH="64" ;;
    aarch64|arm64) XRAY_ARCH="arm64-v8a" ;;
    *) XRAY_ARCH="64" ;;
  esac
  TMP_ZIP=$(mktemp)
  XRAY_VER="v26.10.31"
  XRAY_URL="https://github.com/XTLS/Xray-core/releases/download/${XRAY_VER}/Xray-linux-${XRAY_ARCH}.zip"
  if curl -sSL -f -o "$TMP_ZIP" "$XRAY_URL"; then
    unzip -q -o "$TMP_ZIP" xray geoip.dat geosite.dat -d bin/
    chmod +x bin/xray
    rm -f "$TMP_ZIP"
    echo "✅ Xray-core downloaded successfully."
  else
    echo "⚠️ Failed to download Xray-core automatically. Please install Xray into bin/xray."
    rm -f "$TMP_ZIP"
  fi
fi

# 2. Build frontend if dist/ does not exist
if [ ! -f "src/frontend/dist/index.html" ]; then
  echo "📦 Compiling modern frontend application..."
  (cd src/frontend && npx vite build)
fi

# 3. Ensure opencode-vpn launcher script is executable
if [ -f "bin/opencode-vpn" ]; then
  chmod +x "bin/opencode-vpn"
fi

# 4. Trap exit signals for clean shutdown
cleanup() {
  echo ""
  echo "Shutting down OpenCode Router server..."
  # Clean up any child processes spawned by this session
  kill $(jobs -p) 2>/dev/null || true
  exit 0
}
trap cleanup SIGINT SIGTERM EXIT

# 5. Start backend server in the background
echo "🚀 Launching backend server on port ${PORT}..."
npx tsx src/backend/server.ts &
SERVER_PID=$!

# 6. Wait for server readiness
echo "⏳ Waiting for HTTP service to become ready..."
READY=0
for i in {1..30}; do
  if curl -s "http://127.0.0.1:${PORT}/api/status" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 0.5
done

if [ $READY -eq 1 ]; then
  echo ""
  echo "=========================================================="
  echo "✅ Application running at: http://localhost:${PORT}"
  echo "=========================================================="
  echo ""
  echo "Open your browser to http://localhost:${PORT} and click"
  echo "   [ Find Working Connection ]"
  echo ""

  # Open browser if graphical environment is available
  if [ -n "$DISPLAY" ] && command -v xdg-open >/dev/null 2>&1; then
    xdg-open "http://localhost:${PORT}" >/dev/null 2>&1 &
  fi
else
  echo "⚠️  Server took longer than expected to start. Check logs above."
fi

# Keep script running while server process is active
wait $SERVER_PID
