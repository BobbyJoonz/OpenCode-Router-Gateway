---
title: "Configuration Guide"
description: "Configure runtime parameters, inbound proxy ports, test timeouts, candidate limits, and subscription sources for OpenCode Router."
---

# Configuration Guide

OpenCode Router is pre-configured to work out of the box with zero manual parameter setup. However, power users can customize runtime ports, timeouts, and paths using environment variables or a `.env` file.

---

## Environment Variables Template

Copy the provided template to create a local configuration file:
```bash
cp .env.example .env
```

### Available Configuration Directives

| Variable | Default Value | Description |
| :--- | :---: | :--- |
| `PORT` | `3000` | Port for the Express API server and Web GUI dashboard. |
| `OPENCODE_HTTP_PROXY_PORT` | `10809` | Local HTTP proxy inbound listener port for Xray-core. |
| `OPENCODE_SOCKS_PROXY_PORT` | `10808` | Local SOCKS5 proxy inbound listener port for Xray-core. |
| `OPENCODE_BIN` | Auto-detected | Custom path to the OpenCode binary (e.g. `/usr/local/bin/opencode`). |
| `MAX_TEST_ATTEMPTS` | `25` | Maximum number of candidate proxy nodes tested in a single workflow run. |
| `OPENCODE_TIMEOUT_SECONDS` | `18` | Maximum timeout in seconds for the OpenCode prompt verification probe. |

---

## Custom Inbound Ports Example

If port `10808` or `10809` conflicts with existing developer services on your machine, adjust them in `.env`:

```bash
PORT=3000
OPENCODE_HTTP_PROXY_PORT=19909
OPENCODE_SOCKS_PROXY_PORT=19908
MAX_TEST_ATTEMPTS=30
OPENCODE_TIMEOUT_SECONDS=15
```

When custom ports are set, the launcher wrapper (`bin/opencode-vpn`) automatically reads `OPENCODE_HTTP_PROXY_PORT` and `OPENCODE_SOCKS_PROXY_PORT` and maps traffic accordingly.

---

## Subscription Source Management

By default, OpenCode Router aggregates configurations from curated public GitHub subscription endpoints. You can add or remove sources directly from the web dashboard:

1. Click the database icon in the top navigation bar to open **Manage Subscription Sources**.
2. Add your custom subscription URL or raw configuration link.
3. Click **Refresh All Sources** to fetch, decode, deduplicate, and cache nodes into the local SQLite database.
