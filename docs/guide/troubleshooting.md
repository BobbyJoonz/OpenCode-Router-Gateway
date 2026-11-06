---
title: "Troubleshooting Guide"
description: "Actionable solutions for port conflicts, authentication failures, proxy latency spikes, and zombie process cleanup in OpenCode Router."
---

# Troubleshooting Guide

This guide provides actionable solutions for common issues encountered when running OpenCode Router.

---

## 1. Quick Diagnostic Table

| Symptom | Probable Cause | Actionable Solution |
| :--- | :--- | :--- |
| `curl: (7) Failed to connect to 127.0.0.1:10809` | Proxy engine is idle or stopped. | Open `http://localhost:3000` and click **Find Working Connection**. |
| `Error: connect ETIMEDOUT` | Candidate node remote IP is unreachable. | The orchestrator will automatically fail over; or click **Refresh Nodes**. |
| `HTTP 429: insufficient_quota` | Account-level token budget exhausted. | Top up your provider API credits. IP switching cannot fix account balance limits. |
| `Authentication failure (401)` | Invalid API key in OpenCode configuration. | Verify your API key in `~/.config/opencode/opencode.json`. |
| Port 3000 already in use | Another service is using port 3000. | Start with custom port: `PORT=3001 ./start.sh`. |
| OpenCode command hangs | Process awaiting response without timeout. | Verify active proxy with `curl -x http://127.0.0.1:10809 https://api.ipify.org`. |

---

## 2. In-Depth Diagnostic Steps

### Test 1: Verify Local Proxy Listeners
Check whether Xray-core is listening on local loopback ports:
```bash
ss -tulpn | grep -E "10808|10809"
```
Expected output:
```text
tcp  LISTEN 0  128  127.0.0.1:10808  0.0.0.0:*
tcp  LISTEN 0  128  127.0.0.1:10809  0.0.0.0:*
```

### Test 2: Probe Proxy Egress IP
Verify that outbound HTTP traffic is passing through the local proxy:
```bash
curl -x http://127.0.0.1:10809 -s https://api.ipify.org
```
If this command returns an external IP address, the proxy tunnel is healthy.

### Test 3: Test OpenCode Minimal Prompt
Run OpenCode directly through the dedicated launcher:
```bash
bin/opencode-vpn run "Reply with: OK" --pure
```
If this prints `OK`, your OpenCode CLI integration is fully operational.

---

## 3. Detailed Troubleshooting Articles
For specialized guides addressing specific errors, read:
- [How to Fix OpenCode Network Errors on Linux](/articles/fix-opencode-network-errors-linux)
- [How to Fix OpenCode HTTP 429 Rate Limit Errors](/articles/fix-opencode-http-429-rate-limit)
- [How to Configure a Proxy for OpenCode CLI](/articles/configure-proxy-opencode-cli)
- [How to Use Xray with OpenCode on Ubuntu](/articles/use-xray-with-opencode-ubuntu)
- [OpenCode Proxy vs System-Wide VPN](/articles/opencode-proxy-vs-system-vpn)
