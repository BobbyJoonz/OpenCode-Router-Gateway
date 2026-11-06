# OpenCode Router Gateway

<div align="center">

![Version](https://img.shields.io/badge/version-2.0.0-emerald.svg)
![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)
![API](https://img.shields.io/badge/API-OpenAI--compatible-purple.svg)
![Tests](https://img.shields.io/badge/integration%20tests-51%20passing-success.svg)

**An OpenAI-compatible API gateway whose egress IP rotates.**

Serves `/v1/chat/completions` and `/v1/models` with `sk-or-...` keys, quotas and
per-request accounting — while every upstream call is tunnelled through a pool of
Xray nodes that are pre-screened, health-scored and rotated automatically.

</div>

---

## Table of contents

1. [What this is (and what it is not)](#1-what-this-is-and-what-it-is-not)
2. [Architecture](#2-architecture)
3. [What was added in 2.0](#3-what-was-added-in-20)
4. [Quick start](#4-quick-start)
5. [Configuration](#5-configuration)
6. [API reference](#6-api-reference)
7. [Deployment and TLS](#7-deployment-and-tls)
8. [Security model](#8-security-model)
9. [Operations guide](#9-operations-guide)
10. [Testing](#10-testing)
11. [Known limitations](#11-known-limitations)
12. [Relationship to the upstream project](#12-relationship-to-the-upstream-project)
13. [License](#13-license)

---

## 1. What this is (and what it is not)

This project turns [OpenCode Router](https://github.com/EhsanCreator/OpenCode-Router)
— a desktop tool that finds a working proxy node for the OpenCode CLI — into a
**server-side gateway** that any OpenAI-compatible client can use.

```
your laptop / Cursor / 9Router / any OpenAI SDK
        │   Authorization: Bearer sk-or-...
        │   POST https://your-server/v1/chat/completions
        ▼
┌──────────────────────────────────────────────┐
│  OpenCode Router Gateway                     │
│  • API keys, quotas, usage accounting        │
│  • node pre-screen + health scoring          │
│  • 429-aware egress rotation                 │
└───────────────┬──────────────────────────────┘
                │  through the local Xray inbound
                ▼
        rotating Xray node  ──►  the real provider
```

**It is not a source of model access.** The gateway forwards to a provider you
already have credentials for (`GATEWAY_UPSTREAM_API_KEY`). A proxy changes your
*egress IP*; it does not create an account, a quota or an API key at the provider.
If you point it at an upstream you have no right to use, that is on you.

**It is not a multi-tenant platform (yet).** The egress engine runs a *single*
active node at a time, so concurrent clients share one exit IP. See
[§11](#11-known-limitations) for what that means in practice.

---

## 2. Architecture

```
┌───────────────────────────────────────────────────────────────────────┐
│ Express backend (port 3000, loopback by default)                      │
│                                                                       │
│  /v1/*   ──► gateway router      ─┐                                   │
│             • key auth            │                                   │
│             • rate limit          │   undici ProxyAgent               │
│             • quota               ├──► http://127.0.0.1:10809 (Xray)  │
│             • SSE passthrough     │                                   │
│             • usage accounting   ─┘                                   │
│                                                                       │
│  /api/*  ──► management API (loopback only)                           │
│             • configs / sources / workflow                            │
│             • pre-screen, health, egress groups                       │
│             • API keys, settings, diagnostics                         │
│                                                                       │
│  Background jobs                                                      │
│             • BulkPrescreener  (TCP fan-out, 200 sockets)             │
│             • HealthMonitor    (ephemeral Xray probes, EWMA score)    │
│             • VpnEngine        (the serving Xray process)             │
└───────────────────────────────────────────────────────────────────────┘
                │
                ▼
        Xray-core  ──►  VLESS / VMess / Trojan / Shadowsocks node
```

Three ports matter:

| Port | Owner | Purpose |
|---:|---|---|
| `3000` | Express | dashboard + management API + `/v1` |
| `10809` | Xray | HTTP inbound used by the gateway upstream client |
| `10808` | Xray | SOCKS5 inbound used by the OpenCode CLI launcher |

The health monitor probes on `11818/11819` so it never disturbs the serving node.

---

## 3. What was added in 2.0

### Phase 1 — node intelligence

| Feature | Endpoint | Effect |
|---|---|---|
| Bulk TCP pre-screen | `POST /api/configs/prescreen` | 3 853 nodes screened in **25.3 s** (200 sockets in flight); only survivors reach the expensive stages |
| Background health monitor | `GET /api/nodes/health`, `POST /api/health/check-now` | EWMA health score per node; dead nodes leave rotation after 2 consecutive failures |
| Egress IP grouping | `GET /api/egress/groups` | reveals that "13 nodes" is often **one server** on 13 ports |
| Persisted probe results | `tcp_alive`, `tcp_latency_ms`, `egress_ip`, `health_score` on `configs` | ranking can prefer proven endpoints |

### Phase 3 — OpenAI-compatible gateway

| Feature | Details |
|---|---|
| `POST /v1/chat/completions` | streaming and non-streaming |
| `GET /v1/models` | proxied from the upstream, synthetic fallback |
| `GET /v1/usage` | per-key request/token totals |
| API keys | `sk-or-` + 32 chars, **SHA-256 at rest**, prefix only for display |
| Limits | per-key RPM sliding window + daily token quota |
| Accounting | `usage_log` per request: model, tokens, status, latency, egress node |
| Error mapping | `429` → rotate egress and retry once; `401/403` → never rotate; `5xx` → optional rotate; `4xx` → pass through |
| Timeouts | configurable, hard `AbortController` cap |

### Phase 0 / 4 — deployment

`deploy/Dockerfile` (multi-stage, non-root), `deploy/docker-compose.yml`,
`deploy/Caddyfile` (public `/v1` only, `/api` localhost-only),
`deploy/opencode-router.service` (systemd, hardened), `deploy/install.sh`
(idempotent bare-metal installer with mirror fallback for Xray).

### Inherited fixes from the 1.x line

* Xray ≥ v26 removed `tlsSettings.allowInsecure`; the builder no longer emits it
  (previously **every** TLS node failed to start).
* OpenCode's LLM runtime returns `ECONNREFUSED` when an HTTP proxy is exported;
  the launcher and verification now use **SOCKS5 only**.
* The success path crashed on `last_status = "working"` (double-quoted SQL string
  literal). Fixed to single quotes.
* Windows support: `xray.exe` resolution, `taskkill /F` process cleanup,
  `.cmd` launcher, `better-sqlite3` pinned to a version with prebuilds.

---

## 4. Quick start

### 4.1 Docker (recommended for a server)

```bash
git clone https://github.com/BobbyJoonz/OpenCode-Router-Gateway.git
cd OpenCode-Router-Gateway

cp .env.example .env
#   set GATEWAY_UPSTREAM_BASE_URL and GATEWAY_UPSTREAM_API_KEY

docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml logs -f gateway
```

The container publishes on `127.0.0.1:3000` only. Put Caddy in front for TLS.

### 4.2 Bare metal (Debian/Ubuntu)

```bash
sudo ./deploy/install.sh
sudo nano /opt/opencode-router/.env     # upstream URL + key
sudo systemctl restart opencode-router
```

If `github.com` is unreachable from the host, point the installer at a mirror:

```bash
sudo XRAY_BASE=https://gh-proxy.com/https://github.com ./deploy/install.sh
```

### 4.3 Local development (Windows / macOS / Linux)

```bash
npm install
npm run build:frontend
npm start                 # http://localhost:3000
```

On Windows, `start.ps1` downloads `bin/xray.exe` and opens the dashboard.

### 4.4 First run

```bash
# 1. discover and screen nodes
curl -s -X POST http://127.0.0.1:3000/api/sources/refresh-all
curl -s -X POST http://127.0.0.1:3000/api/configs/prescreen

# 2. let the workflow pick and verify one
curl -s -X POST http://127.0.0.1:3000/api/workflow/start -H 'content-type: application/json' -d '{}'

# 3. switch the gateway on
curl -s -X PUT http://127.0.0.1:3000/api/settings \
     -H 'content-type: application/json' \
     -d '{"gateway_enabled":"true"}'

# 4. issue a client key
curl -s -X POST http://127.0.0.1:3000/api/keys \
     -H 'content-type: application/json' \
     -d '{"name":"laptop","rpmLimit":120,"dailyTokenLimit":500000}'
```

Then from any OpenAI client:

```bash
curl -s http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-or-..." \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hello"}]}'
```

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:3000/v1", api_key="sk-or-...")
print(client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "hello"}],
).choices[0].message.content)
```

---

## 5. Configuration

### 5.1 Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | backend port |
| `OPENCODE_SOCKS_PROXY_PORT` | `10808` | Xray SOCKS5 inbound |
| `OPENCODE_HTTP_PROXY_PORT` | `10809` | Xray HTTP inbound |
| `OPENCODE_BIN` | auto | path to the OpenCode CLI |
| `XRAY_BIN` | `./bin/xray` | path to the Xray binary |
| `MAX_TEST_ATTEMPTS` | `25` | candidates per workflow run |
| `OPENCODE_TIMEOUT_SECONDS` | `20` | verification prompt timeout |
| `ALLOW_REMOTE_ACCESS` | unset | allow a non-loopback bind (requires the key below) |
| `OPENCODE_ROUTER_API_KEY` | unset | Bearer token for the **management** API when remote |
| `GATEWAY_UPSTREAM_BASE_URL` | — | e.g. `https://api.openai.com/v1` |
| `GATEWAY_UPSTREAM_API_KEY` | — | your real provider key (**env only**, never stored in the DB) |
| `GATEWAY_UPSTREAM_MODEL` | — | model id advertised by `/v1/models` |
| `XRAY_BASE` | `https://github.com` | mirror for the Xray download |

### 5.2 Runtime settings

Stored in SQLite and changeable without a restart:

```bash
curl -s http://127.0.0.1:3000/api/settings
curl -s -X PUT http://127.0.0.1:3000/api/settings \
     -H 'content-type: application/json' \
     -d '{"gateway_rotate_on_429":"true","health_check_interval_seconds":"600"}'
```

| Key | Default | Meaning |
|---|---|---|
| `gateway_enabled` | `false` | master switch for `/v1` |
| `gateway_upstream_base_url` | — | upstream base URL |
| `gateway_upstream_model` | — | advertised model |
| `gateway_upstream_timeout_seconds` | `120` | upstream hard timeout |
| `gateway_max_body_bytes` | `8388608` | request size cap |
| `gateway_rotate_on_429` | `true` | rotate egress on HTTP 429 |
| `gateway_rotate_on_5xx` | `false` | rotate egress on HTTP 5xx |
| `gateway_upstream_bypass_proxy_loopback` | `true` | loopback upstreams skip the tunnel |
| `prescreen_concurrency` | `200` | sockets in flight |
| `prescreen_timeout_ms` | `1500` | per-socket timeout |
| `health_check_enabled` | `true` | background monitor |
| `health_check_interval_seconds` | `300` | monitor cadence |
| `health_check_batch` | `8` | nodes per tick |
| `health_check_ports_base` | `11818` | probe ports (base, base+1) |

Unknown keys are rejected; `gateway_upstream_base_url` is redacted on read.

---

## 6. API reference

### 6.1 Gateway (`/v1`) — OpenAI-compatible

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/v1/health` | none | liveness, active node, config flags |
| `GET` | `/v1/models` | key | proxied upstream, synthetic fallback |
| `POST` | `/v1/chat/completions` | key | `stream: true` supported |
| `GET` | `/v1/usage` | key | this key's totals and daily quota |

Errors use the OpenAI envelope:

```json
{ "error": { "message": "...", "type": "invalid_request_error", "param": null, "code": "invalid_api_key" } }
```

| Status | Code | When |
|---|---|---|
| 401 | `missing_api_key` / `invalid_api_key` | bad or absent bearer |
| 403 | `api_key_disabled` | key revoked |
| 413 | `request_too_large` | over `gateway_max_body_bytes` |
| 429 | `rate_limit_exceeded` / `daily_quota_exceeded` | per-key limits |
| 502 | `upstream_unreachable` | tunnel or upstream failure |
| 503 | `gateway_disabled` / `no_egress_node` | switch off, or no working node |

### 6.2 Management (`/api`) — loopback only

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/status` | engine state + node counts |
| `POST` | `/api/workflow/start` \| `/stop` | full find-and-verify run |
| `POST` | `/api/vpn/disconnect` \| `/test-current` | engine control |
| `GET` | `/api/configs` | paginated nodes (now includes `tcp_alive`, `health_score`, `egress_ip`) |
| `POST` | `/api/configs/test-single` \| `/:id/activate` \| `/import` | per-node operations |
| `POST` | `/api/configs/prescreen` | start bulk TCP screen |
| `GET` | `/api/prescreen/status` | progress + last runs |
| `POST` | `/api/prescreen/abort` | cancel |
| `GET` | `/api/nodes/health` | monitor state + top nodes |
| `POST` | `/api/health/check-now` | force one batch |
| `GET` | `/api/egress/groups` | distinct exit IPs |
| `GET`/`POST` | `/api/keys` | list / create (`sk-or-...` shown once) |
| `PATCH`/`DELETE` | `/api/keys/:id` | enable/disable, revoke |
| `GET` | `/api/gateway/status` | upstream + usage summary |
| `GET`/`PUT` | `/api/settings` | whitelisted runtime settings |
| `GET` | `/api/events` | SSE progress stream |
| `GET` | `/api/diagnostics` | OpenCode detection, history |

---

## 7. Deployment and TLS

### 7.1 Caddy (public `/v1`, private `/api`)

```bash
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo DOMAIN=api.example.com systemctl reload caddy
```

The Caddyfile exposes **only** `/v1/*` publicly; `/api/*` is restricted to
loopback. Reach the dashboard through an SSH tunnel:

```bash
ssh -L 3000:127.0.0.1:3000 user@your-server
```

### 7.2 Cloudflare Tunnel (no open inbound ports)

```bash
cloudflared tunnel --url http://127.0.0.1:3000
```

Then restrict the tunnel's public hostname to `/v1/*` in the Cloudflare dashboard.

### 7.3 systemd

```bash
sudo cp deploy/opencode-router.service /etc/systemd/system/
sudo systemctl enable --now opencode-router
journalctl -u opencode-router -f
```

The unit runs as the unprivileged `opencode` user with `ProtectSystem=strict`,
`PrivateTmp`, `NoNewPrivileges` and write access limited to `data/`.

---

## 8. Security model

| Layer | Control |
|---|---|
| Management API | loopback by default; remote bind requires `ALLOW_REMOTE_ACCESS=true` **and** `OPENCODE_ROUTER_API_KEY`; constant-time comparison |
| Gateway API | `sk-or-` keys, SHA-256 at rest, prefix-only display, enable/disable/revoke |
| Request size | `gateway_max_body_bytes` (413) |
| Host/CSRF | Host-header validation and origin checks on state-changing calls |
| Upstream credentials | environment only — never written to SQLite, never logged |
| Secrets in logs | upstream URL is redacted when read back; subscription URLs sanitized |
| Process isolation | unprivileged user, no TUN, no iptables, loopback-only inbounds |
| TLS | terminate with Caddy / Cloudflare; never publish port 3000 directly |

**Never** expose `/api/*` to the internet: it can start/stop the engine and mint
keys. The provided Caddyfile enforces this.

---

## 9. Operations guide

### Pre-screen before every hunt

```bash
curl -X POST http://127.0.0.1:3000/api/configs/prescreen \
     -H 'content-type: application/json' -d '{"onlyUnhealthy":true}'
```

Measured: **3 853 nodes → 25.3 s, 763 alive (19.8 %)** with `concurrency=200`,
`timeout=1500 ms`. Feeding only survivors to the state machine is the single
biggest win over the original design.

### Watch the health monitor

```bash
curl -s http://127.0.0.1:3000/api/nodes/health | jq '.monitor'
```

Nodes decay: a public node that answered in 6 s was timing out 15 minutes later.
`health_score` is an EWMA (α = 0.3); two consecutive failures remove a node from
rotation until the next workflow re-tests it.

### Rotation behaviour

```
429 from upstream ──► rotate to next healthiest node ──► retry once
401/403           ──► pass through (auth is not an IP problem)
5xx               ──► pass through unless gateway_rotate_on_5xx=true
timeout / network ──► rotate ──► retry once ──► 502
```

### Quotas and accounting

```bash
curl -s http://127.0.0.1:3000/v1/usage -H "Authorization: Bearer sk-or-..."
sqlite3 data/opencode-vpn.db "SELECT key_id, COUNT(*), SUM(total_tokens) FROM usage_log GROUP BY key_id;"
```

`usage_log` keeps model, token counts, status code, latency and the egress node
for every request — enough to answer "how many GB did this cost me?".

---

## 10. Testing

```bash
npm run typecheck        # tsc --noEmit, backend + tests
npm test                 # original acceptance + security suites
npm run test:gateway     # 51-assertion integration suite (needs a running server)
npm run test:all         # all of the above
```

`tests/gateway-tests.ts` spins up a mock OpenAI upstream and exercises the real
HTTP path: auth (missing/invalid/disabled/non-bearer), validation (messages,
model type, oversized body), model listing, non-streaming, SSE streaming and
usage capture, upstream 400/401/429/500 passthrough, timeout → 502, RPM limiting,
daily quota, usage accounting, client abort mid-stream, bulk pre-screen (including
the concurrent-run 409), health endpoint, and a **proof that traffic really goes
through Xray** (a loopback upstream is unreachable when the bypass is disabled).

Result on this machine: **51 passed, 0 failed**.

---

## 11. Known limitations

1. **Single egress node.** `VpnEngine` is a singleton: one Xray process, one exit
   IP. Many concurrent clients share it and a slow node becomes everyone's
   bottleneck. A multi-instance pool (`xray-pool` + per-key node selection) is the
   natural next step and is **not** implemented here.
2. **Rotation is serialized.** A 429 triggers one rotation at a time; requests
   arriving during a rotation wait for it.
3. **No cost accounting.** Token counts are recorded, but prices per model are
   not modelled.
4. **No streaming usage guarantee.** Token usage is scraped from the final SSE
   chunk when the provider sends one; otherwise the request is recorded with 0
   tokens.
5. **Free public nodes rot fast.** Even with screening and health scoring, expect
   a meaningful failure rate with public subscriptions. Use a private
   subscription for anything beyond experimentation.
6. **Daily quota is UTC-based** (`datetime('now', 'start of day')`).
7. **Single-node SQLite.** Fine for one gateway process; do not run two writers
   against the same file.

---

## 12. Relationship to the upstream project

This is a derivative work built on
[EhsanCreator/OpenCode-Router](https://github.com/EhsanCreator/OpenCode-Router)
(MIT). It keeps the original dashboard, config parser, Xray builder and workflow
engine, fixes several bugs that prevented end-to-end operation, and adds the
gateway, pre-screen and health subsystems described above.

Upstream credits: **Ehsan Shahriyari**. See [WINDOWS.md](WINDOWS.md) for the
Windows port notes and the detailed bug analysis.

---

## 13. License

MIT — see [LICENSE](LICENSE).
