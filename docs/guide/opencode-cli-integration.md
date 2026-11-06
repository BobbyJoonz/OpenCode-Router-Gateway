---
title: "OpenCode CLI Integration"
description: "How OpenCode Router seamlessly integrates with OpenCode CLI via bin/opencode-vpn without modifying system routing tables."
---

# OpenCode CLI Integration

OpenCode Router provides a dedicated launcher wrapper (`bin/opencode-vpn`) that isolates proxy routing strictly to the OpenCode process tree.

---

## Why Use the Dedicated Launcher?

When using command-line tools with proxies on Linux, standard recommendations advise exporting proxy variables in `~/.bashrc`:
```bash
# NOT RECOMMENDED in global profile
export http_proxy=http://127.0.0.1:10809
export all_proxy=socks5://127.0.0.1:10808
```

### Problems with Global Exports:
- **Service Breakage**: If the local proxy process terminates, subsequent terminal commands (`curl`, `git pull`, `apt update`, `docker pull`) fail immediately with `Connection refused`.
- **Latency Penalties**: High-bandwidth background tools get routed through public proxy nodes unnecessarily.
- **SSH Lockouts**: Remote session environment variables can disrupt cloud bastion forwarding.

---

## The `opencode-vpn` Pattern

The launcher wrapper (`bin/opencode-vpn`) sets proxy variables strictly for the spawned sub-shell:

```bash
#!/usr/bin/env bash
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

---

## Command Usage Examples

### 1. Interactive Terminal Session
Launch OpenCode in interactive coding assistant mode:
```bash
bin/opencode-vpn
```

### 2. Non-Interactive Command Execution
Pass prompts directly for single-line terminal execution:
```bash
bin/opencode-vpn run "Write a TypeScript debounce function"
```

### 3. Pure Output Formatting
Retrieve pure machine-readable answers suitable for piping into shell scripts:
```bash
bin/opencode-vpn run "What is 2+2? Answer in one word." --pure
```

---

## Global Alias Setup

To access `opencode-vpn` from any folder without specifying the repository directory:
```bash
mkdir -p ~/.local/bin
ln -sf "$(pwd)/bin/opencode-vpn" ~/.local/bin/opencode-vpn
```
Ensure `~/.local/bin` is in your shell `$PATH`.
