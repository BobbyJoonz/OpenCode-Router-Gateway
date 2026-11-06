---
title: "Proxy Architecture & Traffic Flow"
description: "In-depth guide to split-tunnel architecture, process-level isolation, and dual SOCKS5/HTTP inbounds in OpenCode Router."
---

# Proxy Architecture & Traffic Flow

This guide explains how OpenCode Router routes application traffic, isolates processes, and maintains system network stability.

---

## High-Level Topology

```
+-------------------------------------------------------------+
|                      Ubuntu 24.04 Host                      |
|                                                             |
|   Standard Tools (Browser, SSH, Docker, System Updates)     |
|   └── Direct Host Network (Default Gateway, Untouched)       |
|                                                             |
|   OpenCode Process (via bin/opencode-vpn)                   |
|   ├── export http_proxy=http://127.0.0.1:10809              |
|   └── export all_proxy=socks5://127.0.0.1:10808             |
|             │                                               |
|             ▼                                               |
|   Xray-Core (Unprivileged User-Space Process)               |
|   ├── SOCKS5 Inbound: 127.0.0.1:10808                       |
|   ├── HTTP Inbound:   127.0.0.1:10809                       |
|   └── Active Outbound Tunnel (VLESS Reality / TLS / etc.)   |
+──────────────────────────────┬──────────────────────────────+
                               │ Encrypted Protocol Stream
                               ▼
               Verified Remote Proxy Endpoint
                               │
                               ▼
                Target AI Provider API Gateway
```

---

## The 3-Stage Testing Pipeline

Before any proxy configuration is marked "working" and locked into the active launcher, it must complete three sequential validation stages:

### Stage 1: Fast TCP Ping & Handshake
- Opens a raw TCP socket to the candidate's remote IP and port.
- Measures socket round-trip time (RTT) with an explicit 1500ms timeout.
- Filters out offline or unresponsive servers instantly before launching heavier proxy processes.

### Stage 2: Local Proxy Egress Handshake
- Generates a custom Xray client configuration with loopback inbounds (`10808`/`10809`) and the candidate outbound.
- Spawns Xray-core in user space.
- Sends an HTTP probe request through `http://127.0.0.1:10809` to verify egress connectivity and measure response latency.

### Stage 3: Real OpenCode Prompt Verification
- Executes a non-interactive test prompt through the proxy:
  ```bash
  opencode run "Reply with: OK" --pure
  ```
- Evaluates the process exit code, response string, and error stream using the built-in Error Classifier.
- If the model returns the completion successfully, the connection is locked as active and saved to `data/active-connection.json`.

---

## Intelligent Error Classification

When a candidate fails, the Error Classifier (`src/backend/opencode/error-classifier.ts`) determines the next action:

- **`SUCCESS`**: Test passed; orchestrator locks the node and stops testing.
- **`RATE_LIMIT (IP-based)`**: Target endpoint returned HTTP 429 due to IP throttling; orchestrator automatically advances to the next candidate node.
- **`RATE_LIMIT (Account-level)`**: Payload contains `insufficient_quota` or token exhaustion; orchestrator halts rotation to avoid useless switching cycles.
- **`AUTH_ERROR`**: Invalid API keys in OpenCode configuration; halts rotation immediately and alerts the user.
- **`NETWORK_ERROR`**: Handshake drops, TLS resets, or timeout; orchestrator rotates to the next node.
