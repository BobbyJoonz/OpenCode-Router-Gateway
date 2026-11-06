---
title: "How to Use Xray with OpenCode on Ubuntu"
description: "Complete guide to integrating Xray-core with OpenCode on Ubuntu Linux. Generate VLESS Reality client configurations and eliminate DPI throttling."
---

# How to Use Xray with OpenCode on Ubuntu

[Xray-core](https://github.com/XTLS/Xray-core) is one of the most advanced, high-performance network tunneling and anti-censorship engines available for Linux. When combined with [OpenCode](https://github.com/anomaly/opencode), Xray provides resilient, low-latency connectivity to AI model endpoints across restricted networks. This guide explains how Xray-core integrates with OpenCode on **Ubuntu 24.04 LTS (x86_64)**, details client configuration generation, and showcases how [OpenCode Router](https://github.com/EhsanCreator/OpenCode-Router) manages the entire lifecycle automatically.

---

## 1. Why Xray-core for OpenCode?

Traditional VPN protocols (like OpenVPN or basic IPsec) are easily identified and throttled by deep packet inspection (DPI) firewalls. Xray-core offers distinct technical advantages:

- **VLESS with Reality**: Reality eliminates server-side TLS certificate dependencies by masquerading outgoing traffic as legitimate TLS 1.3 handshakes to popular public servers (e.g., Cloudflare, Microsoft, Apple), making DPI fingerprinting virtually impossible.
- **Protocol Flexibility**: Natively supports VLESS, VMess (AEAD), Trojan (TLS), and Shadowsocks.
- **Multiplexing & Low Handshake Latency**: TCP Fast Open and multiplexing minimize round-trip latency when streaming token completions in OpenCode.
- **User-Space Operation**: Can run completely as a standard user process on loopback high ports (`>1024`), requiring zero root privileges.

---

## 2. Architecture: Local Proxy Inbounds to Remote Outbound

When OpenCode Router manages Xray-core for OpenCode, it generates a streamlined client configuration featuring **two local inbounds** and **one selected outbound**:

```
+-------------------------------------------------------------+
|                      Ubuntu 24.04 Host                      |
|                                                             |
|   OpenCode CLI Process                                      |
|   ├── http_proxy=http://127.0.0.1:10809                     |
|   └── all_proxy=socks5://127.0.0.1:10808                    |
|             │                                               |
|             ▼                                               |
|   Xray-Core Engine (Local User-Space Process)               |
|   ├── Inbound 1: SOCKS5 (127.0.0.1:10808)                   |
|   ├── Inbound 2: HTTP   (127.0.0.1:10809)                   |
|   └── Routing: Direct out to Active Candidate               |
+──────────────────────────────┬──────────────────────────────+
                               │ Encrypted Tunnel (VLESS Reality / TLS)
                               ▼
              Remote Proxy Server / Egress Endpoint
                               │
                               ▼
               AI Provider API (e.g. DeepSeek / Anthropic)
```

---

## 3. Generating the Xray Client JSON

The core configuration builder in OpenCode Router (`src/backend/vpn/xray-config-builder.ts`) programmatically generates valid Xray JSON configurations. Below is an annotated structure for a verified **VLESS Reality** node:

```json
{
  "log": {
    "loglevel": "warning"
  },
  "inbounds": [
    {
      "tag": "socks-in",
      "port": 10808,
      "listen": "127.0.0.1",
      "protocol": "socks",
      "settings": {
        "auth": "noauth",
        "udp": true
      }
    },
    {
      "tag": "http-in",
      "port": 10809,
      "listen": "127.0.0.1",
      "protocol": "http",
      "settings": {
        "allowTransparent": false
      }
    }
  ],
  "outbounds": [
    {
      "tag": "proxy",
      "protocol": "vless",
      "settings": {
        "vnext": [
          {
            "address": "198.51.100.42",
            "port": 8443,
            "users": [
              {
                "id": "e4d7a8b9-1234-5678-9abc-def012345678",
                "encryption": "none",
                "flow": "xtls-rprx-vision"
              }
            ]
          }
        ]
      },
      "streamSettings": {
        "network": "tcp",
        "security": "reality",
        "realitySettings": {
          "serverName": "gateway.cloudflare.com",
          "publicKey": "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_=",
          "shortId": "0123456789abcdef",
          "fingerprint": "chrome"
        }
      }
    },
    {
      "tag": "direct",
      "protocol": "freedom"
    }
  ]
}
```

### Key Configuration Directives:
- **`flow: xtls-rprx-vision`**: Restricted strictly to TCP streams; omitted for WebSocket (`ws`) or gRPC transports to avoid protocol mismatches.
- **`fingerprint: chrome`**: Emulates standard Google Chrome TLS client hello extensions to defeat TLS fingerprinting.
- **`allowInsecure`**: Properly parsed and flagged if certificate verification is selectively disabled for test nodes.

---

## 4. How OpenCode Router Automates Xray Management

Manually installing, updating, writing JSON files, and testing Xray endpoints is tedious and prone to configuration syntax errors. [OpenCode Router](https://github.com/EhsanCreator/OpenCode-Router) automates every step:

1. **Automatic Binary Provisioning**: If `bin/xray` is not present, `start.sh` automatically downloads the official release for your architecture (x86_64 or ARM64) and verifies executable permissions.
2. **Safe Daemonization & Lifecycle**: Spawns Xray with detached process handling (`detached: true`, independent log file redirection), ensuring clean shutdowns without orphaned background processes.
3. **Automated End-to-End Validation**:
   - Checks TCP round-trip latency to the remote server.
   - Starts Xray and sends an HTTP probe through port `10809`.
   - Executes `opencode run "Reply with: OK" --pure` through the active proxy to verify prompt completion.
   - If successful, saves state in local SQLite cache.

---

## 5. Frequently Asked Questions (FAQ)

### Do I need to run Xray as root (`sudo`) on Ubuntu?
**No.** Binding to ports `10808` and `10809` does not require root privileges because all port numbers are above `1024`. Running Xray as a standard unprivileged user enhances host security.

### What happens if an active Xray node stops responding during my coding session?
In OpenCode Router's web dashboard (`http://localhost:3000`), simply click **Find Working Connection** (or use the API). The orchestrator tests ranked candidates and switches to a fresh working proxy within seconds.

---

## 6. Related Articles
- [How to Fix OpenCode Network Errors on Linux](fix-opencode-network-errors-linux.md)
- [How to Fix OpenCode HTTP 429 Rate Limit Errors](fix-opencode-http-429-rate-limit.md)
- [How to Configure a Proxy for OpenCode CLI](configure-proxy-opencode-cli.md)
- [OpenCode Proxy vs. System-Wide VPN: Understanding the Differences](opencode-proxy-vs-system-vpn.md)
