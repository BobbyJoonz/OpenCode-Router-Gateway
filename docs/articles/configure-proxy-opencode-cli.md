---
title: "How to Configure a Proxy for OpenCode CLI"
description: "Learn how to configure HTTP and SOCKS5 proxies for OpenCode CLI on Linux using environment variables, remote DNS resolution, and isolated launchers."
---

# How to Configure a Proxy for OpenCode CLI

Configuring network proxies for command-line AI coding tools on Linux requires precision. Unlike desktop web browsers that provide intuitive graphical proxy menus, terminal tools like [OpenCode](https://github.com/anomaly/opencode) rely on standard POSIX environment variables. This guide explains how to properly configure HTTP and SOCKS5 proxies for OpenCode on Linux (verified on **Ubuntu 24.04 LTS x86_64**), avoid common misconfigurations, and utilize the process-isolated wrapper provided by [OpenCode Router](https://github.com/EhsanCreator/OpenCode-Router).

---

## 1. How OpenCode Processes Proxy Settings

OpenCode is built on a Node.js runtime and utilizes standard HTTP/HTTPS agent clients. When issuing network requests to model providers (such as streaming chat completions or fetching tokens), the runtime checks four standard environment variables in order:

1. `https_proxy` / `HTTPS_PROXY`: Used for outgoing secure HTTPS connections.
2. `http_proxy` / `HTTP_PROXY`: Used for standard HTTP requests.
3. `all_proxy` / `ALL_PROXY`: Used as a universal catch-all for TCP and SOCKS5 traffic.
4. `no_proxy` / `NO_PROXY`: Comma-separated list of hostnames/IPs that must bypass the proxy (e.g., `localhost,127.0.0.1`).

---

## 2. Manual Configuration Options

### Option A: Per-Command Execution (Recommended for One-Off Tests)
The safest way to run OpenCode through a proxy without altering your current terminal session is to prefix the execution directly:

```bash
# Using a local HTTP proxy (e.g. port 10809)
http_proxy="http://127.0.0.1:10809" https_proxy="http://127.0.0.1:10809" opencode

# Using a local SOCKS5 proxy (e.g. port 10808)
all_proxy="socks5://127.0.0.1:10808" ALL_PROXY="socks5://127.0.0.1:10808" opencode
```

### Option B: SOCKS5 with Remote DNS Resolution (`socks5h://`)
If your local DNS resolver is poisoned or throttled, passing `socks5://` may still leak DNS queries locally. To force DNS resolution through the remote proxy endpoint, use the `socks5h://` protocol scheme:
```bash
export all_proxy="socks5h://127.0.0.1:10808"
export ALL_PROXY="socks5h://127.0.0.1:10808"
opencode run "Verify connectivity" --pure
```

### Common Pitfall: Exporting Proxies in `~/.bashrc`
> [!WARNING]
> Adding `export http_proxy=...` to your `~/.bashrc` or `/etc/environment` affects **every tool in your shell**, including `git`, `curl`, `apt`, and `docker`. If the local proxy process stops running, commands like `git pull` or `apt update` will suddenly fail with `Connection refused`. Keep proxy exports scoped exclusively to OpenCode.

---

## 3. The Isolated Launcher Wrapper Pattern

To achieve 100% process isolation without polluting the shell environment, [OpenCode Router](https://github.com/EhsanCreator/OpenCode-Router) implements a dedicated launcher script at `bin/opencode-vpn`.

### How the Launcher Works
The launcher inspects standard environment overrides, binds proxy variables strictly to the sub-process environment, locates the real OpenCode binary, and replaces the shell with `exec`:

```bash
#!/usr/bin/env bash
# Dedicated OpenCode Proxy Launcher
# Injects proxy settings strictly for OpenCode without system-wide routing changes.

HTTP_PORT="${OPENCODE_HTTP_PROXY_PORT:-10809}"
SOCKS_PORT="${OPENCODE_SOCKS_PROXY_PORT:-10808}"

export http_proxy="http://127.0.0.1:${HTTP_PORT}"
export https_proxy="http://127.0.0.1:${HTTP_PORT}"
export HTTP_PROXY="http://127.0.0.1:${HTTP_PORT}"
export HTTPS_PROXY="http://127.0.0.1:${HTTP_PORT}"
export all_proxy="socks5://127.0.0.1:${SOCKS_PORT}"
export ALL_PROXY="socks5://127.0.0.1:${SOCKS_PORT}"

OPENCODE_BIN="/usr/local/bin/opencode"
if [ ! -x "$OPENCODE_BIN" ]; then
  OPENCODE_BIN=$(which opencode 2>/dev/null || echo "opencode")
fi

exec "$OPENCODE_BIN" "$@"
```

### Usage Examples with `opencode-vpn`

```bash
# 1. Interactive terminal session through active proxy
bin/opencode-vpn

# 2. Non-interactive prompt execution
bin/opencode-vpn run "Write a TypeScript debounce function"

# 3. Pure machine-readable response
bin/opencode-vpn run "What is 100 divided by 4? Answer in one number." --pure
```

### Making the Launcher System-Wide
To access `opencode-vpn` from any folder without typing the full repository path:
```bash
mkdir -p ~/.local/bin
ln -sf "$(pwd)/bin/opencode-vpn" ~/.local/bin/opencode-vpn
```
Ensure `~/.local/bin` is in your `$PATH`.

---

## 4. Troubleshooting Proxy Connectivity

If OpenCode fails to connect through your proxy, test each tier systematically:

### Test 1: Verify the Local Proxy Port is Listening
Check if your local proxy engine (e.g., Xray-core) is actually bound and listening:
```bash
ss -tulpn | grep -E "10808|10809"
```
You should observe listeners on `127.0.0.1:10808` (SOCKS5) and `127.0.0.1:10809` (HTTP).

### Test 2: Probe Egress via Curl
Test whether HTTP requests pass successfully through the proxy and inspect your egress IP:
```bash
curl -x http://127.0.0.1:10809 -s https://api.ipify.org
```
If this returns your proxy endpoint's remote IP address, the proxy tunnel is healthy.

---

## 5. Frequently Asked Questions (FAQ)

### Can I specify username and password authentication for SOCKS5?
Yes. If your proxy requires authentication, format the URL as:
```bash
export all_proxy="socks5://user:password@127.0.0.1:10808"
```
*Note: OpenCode Router automatically configures unauthenticated local loopback listeners on `127.0.0.1`, which are accessible only to processes running on your local machine.*

### Why does OpenCode ignore my proxy when running with `sudo`?
Commands executed with `sudo` strip environment variables by default for security (`env_reset`). Do not run OpenCode with `sudo`. OpenCode and OpenCode Router operate entirely within standard unprivileged user space.

---

## 6. Related Articles
- [How to Fix OpenCode Network Errors on Linux](fix-opencode-network-errors-linux.md)
- [How to Fix OpenCode HTTP 429 Rate Limit Errors](fix-opencode-http-429-rate-limit.md)
- [How to Use Xray with OpenCode on Ubuntu](use-xray-with-opencode-ubuntu.md)
- [OpenCode Proxy vs. System-Wide VPN: Understanding the Differences](opencode-proxy-vs-system-vpn.md)
