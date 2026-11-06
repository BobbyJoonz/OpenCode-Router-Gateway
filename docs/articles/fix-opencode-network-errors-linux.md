---
title: "How to Fix OpenCode Network Errors on Linux"
description: "Step-by-step technical guide to diagnosing and fixing OpenCode ETIMEDOUT, ECONNRESET, and DNS network errors on Linux with isolated user-space proxies."
---

# How to Fix OpenCode Network Errors on Linux

When working with command-line AI coding tools like [OpenCode](https://github.com/anomaly/opencode) on Linux, network drops, broken TCP sockets, and DNS resolution failures can halt development sessions. This guide explains why OpenCode network errors occur on Linux (verified on **Ubuntu 24.04 LTS x86_64**), provides diagnostic techniques, and details practical solutions including process-isolated proxy routing with [OpenCode Router](https://github.com/EhsanCreator/OpenCode-Router).

---

## 1. Common OpenCode Network Error Symptoms

Terminal error logs from OpenCode generally manifest in three forms:

1. **Socket Connection Timeouts (`ETIMEDOUT`)**:
   ```text
   Error: connect ETIMEDOUT 198.51.100.45:443
   at TCPConnectWrap.afterConnect [as oncomplete] (net.js:1146:16)
   ```
   *Cause*: The target API endpoint or intermediate CDN firewall dropped the initial TCP SYN packet without responding. Often caused by regional network filtering or ISP-level throttling.

2. **Connection Resets & Broken TLS Handshakes (`ECONNRESET`)**:
   ```text
   Error: read ECONNRESET
   at TLSWrap.onStreamRead (internal/stream_base_commons.js:209:20)
   ```
   *Cause*: Deep packet inspection (DPI) or an upstream gateway severed the TLS handshake midway during certificate negotiation.

3. **DNS Lookup Failures (`ENOTFOUND` / `EAI_AGAIN`)**:
   ```text
   Error: getaddrinfo ENOTFOUND api.deepseek.com
   ```
   *Cause*: Local DNS resolver issues or recursive DNS poisoning preventing resolution of AI provider hostnames.

---

## 2. Step-by-Step Diagnostic Workflow

Before applying fixes, run these diagnostic checks in your terminal to isolate the root cause:

### Step 1: Verify Direct Endpoint Reachability
Test whether your host network can reach the provider's HTTPS endpoint over standard port 443:
```bash
# Test raw TCP handshake latency (substitute with your provider endpoint)
curl -Iv --connect-timeout 5 https://api.deepseek.com
```
- If the command hangs at `* Connecting to ...`, your direct network connection is blocked or severely throttled.
- If it connects and completes the TLS handshake (`* SSL connection using TLSv1.3`), the issue may be client-side or related to rate limits.

### Step 2: Check OpenCode Model Configuration
Inspect your active OpenCode configuration:
```bash
cat ~/.config/opencode/opencode.json
```
Verify that the `model` identifier and endpoint URLs are valid and match your intended provider.

### Step 3: Test a Minimal Non-Interactive Prompt
Run a deterministic test with a minimal payload to eliminate prompt rendering delays:
```bash
opencode run "Reply with: OK" --pure
```
If this command exits with a timeout or network error, proceeding with proxy configuration is recommended.

---

## 3. Resolving OpenCode Network Errors via Isolated Proxy

The standard workaround of activating a system-wide VPN is often counterproductive for developers because it redirects all host traffic, terminating active SSH connections, local databases, and development servers.

A superior approach is **process-level proxy routing**: routing OpenCode strictly through a local user-space proxy while leaving the rest of your operating system untouched.

### Method A: Manual Environment Variable Injection
If you already run a local SOCKS5 or HTTP proxy (such as on ports `10808` or `10809`):
```bash
# Inject proxy variables specifically for a single OpenCode execution
http_proxy="http://127.0.0.1:10809" \
https_proxy="http://127.0.0.1:10809" \
all_proxy="socks5://127.0.0.1:10808" \
opencode run "Your prompt here"
```

### Method B: Automated Failover with OpenCode Router
[OpenCode Router](https://github.com/EhsanCreator/OpenCode-Router) automates this entire pipeline:
1. Discovers and normalizes VLESS, VMess, Trojan, and Shadowsocks nodes from verified sources.
2. Performs a 3-stage health probe (TCP reachability -> proxy egress handshake -> real OpenCode test execution).
3. Automatically switches configurations if a node experiences network drops or socket resets.
4. Provides a pre-configured launcher (`bin/opencode-vpn`) that sets local environment variables exclusively for OpenCode:

```bash
# Run through verified low-latency proxy
bin/opencode-vpn run "Explain quicksort in TypeScript" --pure
```

---

## 4. Frequently Asked Questions (FAQ)

### Does OpenCode support SOCKS5 proxies natively?
OpenCode relies on standard Node.js and libuv networking libraries, which respect the environment variables `all_proxy`, `ALL_PROXY`, `http_proxy`, and `https_proxy`. Passing `all_proxy="socks5://127.0.0.1:10808"` routes all TCP traffic through the local SOCKS5 inbound listener.

### Why does OpenCode hang without displaying an error?
By default, command-line AI clients may wait for several minutes for a hanging HTTP stream before timing out. Setting an explicit timeout in your wrapper or using OpenCode Router's latency tester ensures fast-fail detection within 15 seconds.

### Will changing DNS solve OpenCode network errors?
Switching to public DNS resolvers (such as Cloudflare `1.1.1.1` or Google `8.8.8.8`) resolves `ENOTFOUND` errors, but does not resolve TCP blocking or DPI throttling. For connection resets (`ECONNRESET`), encrypted proxy tunnels (such as VLESS with Reality or TLS) are necessary.

---

## 5. Related Articles
- [How to Fix OpenCode HTTP 429 Rate Limit Errors](fix-opencode-http-429-rate-limit.md)
- [How to Configure a Proxy for OpenCode CLI](configure-proxy-opencode-cli.md)
- [How to Use Xray with OpenCode on Ubuntu](use-xray-with-opencode-ubuntu.md)
- [OpenCode Proxy vs. System-Wide VPN: Understanding the Differences](opencode-proxy-vs-system-vpn.md)
