---
title: "Getting Started with OpenCode Router"
description: "Quickstart guide to OpenCode Router. Learn the automated 3-stage health check workflow, proxy rotation, and one-command OpenCode execution."
---

# Getting Started with OpenCode Router

Welcome to **OpenCode Router**, an intelligent proxy discovery and routing manager designed specifically for [OpenCode](https://github.com/anomaly/opencode) on Linux.

---

## What is OpenCode Router?

When working with command-line AI coding assistants, developers frequently experience network interruptions:
- **Regional ISP blocks and deep packet inspection (DPI)** severing TLS handshakes (`ECONNRESET`).
- **Connection timeouts (`ETIMEDOUT`)** when accessing model provider APIs.
- **HTTP 429 Too Many Requests** throttling on shared public endpoints.

Standard VPN clients solve this crudely by creating a system-wide TUN network adapter that intercepts all traffic on your machine (`0.0.0.0/0`). This frequently terminates active SSH connections, breaks local Docker bridges, and risks DNS leaks.

**OpenCode Router** provides a clean, application-specific solution:
1. It manages an unprivileged local user-space proxy (SOCKS5 on port `10808` and HTTP on port `10809`).
2. It discovers public V2Ray/Xray configurations from GitHub, ranks them by latency, and runs deterministic 3-stage health checks.
3. It routes OpenCode strictly through a dedicated launcher script (`bin/opencode-vpn`) without modifying host network routing or DNS settings.

---

## 3-Minute Quickstart

### Step 1: Clone and Install
```bash
git clone https://github.com/EhsanCreator/OpenCode-Router.git
cd OpenCode-Router
npm install
```

### Step 2: Start the Application
```bash
./start.sh
```
The startup script automatically downloads the headless Xray-core binary if missing, builds the modern React frontend, and launches the web dashboard at `http://localhost:3000`.

### Step 3: Find Working Connection
1. Open `http://localhost:3000` in your browser.
2. Click **Find Working Connection**.
3. The orchestrator tests candidate nodes sequentially until an active proxy completes a real OpenCode test prompt.

### Step 4: Execute OpenCode through Proxy
Run your OpenCode sessions through the dedicated launcher:
```bash
bin/opencode-vpn run "Explain TypeScript utility types"
```

---

## Next Steps
- [Installation Guide](installation.md) — Detailed requirements and Ubuntu setup.
- [OpenCode CLI Integration](opencode-cli-integration.md) — CLI flags and system-wide aliases.
- [Proxy Architecture](proxy-architecture.md) — How user-space isolation works.
