---
title: "System Architecture"
description: "Technical subsystem overview of OpenCode Router: Express backend, React frontend, SQLite storage, and Xray proxy engine."
---

# System Architecture

OpenCode Router consists of decoupled backend, frontend, proxy, and launcher subsystems:

---

## Subsystem Architecture

```
                      +-----------------------------------------+
                      |         OpenCode Router Server          |
                      |  - Express & SQLite (Port 3000)         |
                      |  - Real-Time SSE Telemetry              |
                      +-------------------+---------------------+
                                          |
                +-------------------------+-------------------------+
                |                                                   |
                v                                                   v
+-------------------------------+                   +-------------------------------+
|     Discovery & Parser        |                   |      Connection Engine        |
| - GitHub Subscriptions        |                   | - Xray-core (User-Space)      |
| - VLESS / VMess / Trojan / SS |                   | - SOCKS5: 127.0.0.1:10808     |
| - SHA-256 Deduplication       |                   | - HTTP:   127.0.0.1:10809     |
+---------------+---------------+                   +---------------+---------------+
                |                                                   |
                +-------------------------+-------------------------+
                                          |
                                          v
                      +-----------------------------------------+
                      |       3-Stage Testing Pipeline          |
                      |  1. TCP Reachability (Ping & RTT)       |
                      |  2. Proxy Egress Handshake (HTTP Probe) |
                      |  3. Real OpenCode Verification Prompt   |
                      +-------------------+---------------------+
                                          |
                                          v
                      +-----------------------------------------+
                      |      Isolated Launcher Execution        |
                      |                                         |
                      |   bin/opencode-vpn                      |
                      |   ├── export http_proxy=127.0.0.1:10809 |
                      |   ├── export all_proxy=socks5://...     |
                      |   └── exec opencode "$@"                |
                      +-----------------------------------------+
```

---

## Component Responsibilities

- **`src/backend/server.ts`**: Express HTTP server providing REST API and Server-Sent Events (SSE) telemetry to the React frontend.
- **`src/backend/discovery/config-fetcher.ts`**: Fetches, Base64-decodes, and caches configurations from curated public subscription endpoints.
- **`src/backend/parser/config-parser.ts`**: Normalizes VLESS, VMess, Trojan, and Shadowsocks URIs; filters unencrypted protocols; computes unique SHA-256 hashes.
- **`src/backend/vpn/vpn-engine.ts`**: Controls Xray child processes with clean daemonization (`detached: true`) and process cleanup.
- **`src/backend/vpn/xray-config-builder.ts`**: Generates multi-inbound client configurations (`10808` SOCKS5, `10809` HTTP) and handles protocol-specific outbound options.
- **`src/backend/tester/latency-tester.ts`**: Measures TCP socket handshake latency and proxy HTTP response time.
- **`src/backend/opencode/opencode-service.ts`**: Launches controlled, non-interactive OpenCode test prompts.
- **`src/backend/opencode/error-classifier.ts`**: Classifies session outputs into `SUCCESS`, `RATE_LIMIT` (IP vs. account), `AUTH_ERROR`, and `NETWORK_ERROR`.
- **`src/backend/orchestrator/connection-orchestrator.ts`**: Core workflow state machine coordinating testing loops, rankings, and failover rotation.
