# OpenCode Router Gateway

<div align="center">

![Version](https://img.shields.io/badge/version-2.1.0-emerald.svg)
![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)
![API](https://img.shields.io/badge/API-OpenAI--compatible-purple.svg)
![Tests](https://img.shields.io/badge/tests-275%20passing-success.svg)
![Coverage](https://img.shields.io/badge/coverage-82%25%20lines-brightgreen.svg)

**An OpenAI-compatible API gateway whose egress IP rotates.**

Serves `/v1/chat/completions` and `/v1/models` with `sk-or-...` keys, quotas and
per-request accounting â€” while every upstream call is tunnelled through a pool of
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
10. [Testing and CI](#10-testing-and-ci)
11. [Observability](#11-observability)
12. [Lifecycle and graceful shutdown](#12-lifecycle-and-graceful-shutdown)
13. [Architecture boundaries](#13-architecture-boundaries)
14. [Known limitations](#14-known-limitations)
15. [Relationship to the upstream project](#15-relationship-to-the-upstream-project)
16. [License](#16-license)

---

## 1. What this is (and what it is not)

This project turns [OpenCode Router](https://github.com/EhsanCreator/OpenCode-Router)
â€” a desktop tool that finds a working proxy node for the OpenCode CLI â€” into a
**server-side gateway** that any OpenAI-compatible client can use.

```
your laptop / Cursor / 9Router / any OpenAI SDK
        â”‚   Authorization: Bearer sk-or-...
        â”‚   POST https://your-server/v1/chat/completions
        â–¼
â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
â”‚  OpenCode Router Gateway                     â”‚
â”‚  â€¢ API keys, quotas, usage accounting        â”‚
â”‚  â€¢ node pre-screen + health scoring          â”‚
â”‚  â€¢ 429-aware egress rotation                 â”‚
â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
                â”‚  through the local Xray inbound
                â–¼
        rotating Xray node  â”€â”€â–º  the real provider
```

**It is not a source of model access.** The gateway forwards to a provider you
already have credentials for (`GATEWAY_UPSTREAM_API_KEY`). A proxy changes your
*egress IP*; it does not create an account, a quota or an API key at the provider.
If you point it at an upstream you have no right to use, that is on you.

**It is not a multi-tenant platform (yet).** The egress engine runs a *single*
active node at a time, so concurrent clients share one exit IP. See
[Â§11](#11-known-limitations) for what that means in practice.

---

## 2. Architecture

```
â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
â”‚ Express backend (port 3000, loopback by default)                      â”‚
â”‚                                                                       â”‚
â”‚  /v1/*   â”€â”€â–º gateway router      â”€â”                                   â”‚
â”‚             â€¢ key auth            â”‚                                   â”‚
â”‚             â€¢ rate limit          â”‚   undici ProxyAgent               â”‚
â”‚             â€¢ quota               â”œâ”€â”€â–º http://127.0.0.1:10809 (Xray)  â”‚
â”‚             â€¢ SSE passthrough     â”‚                                   â”‚
â”‚             â€¢ usage accounting   â”€â”˜                                   â”‚
â”‚                                                                       â”‚
â”‚  /api/*  â”€â”€â–º management API (loopback only)                           â”‚
â”‚             â€¢ configs / sources / workflow                            â”‚
â”‚             â€¢ pre-screen, health, egress groups                       â”‚
â”‚             â€¢ API keys, settings, diagnostics                         â”‚
â”‚                                                                       â”‚
â”‚  Background jobs                                                      â”‚
â”‚             â€¢ BulkPrescreener  (TCP fan-out, 200 sockets)             â”‚
â”‚             â€¢ HealthMonitor    (ephemeral Xray probes, EWMA score)    â”‚
â”‚             â€¢ VpnEngine        (the serving Xray process)             â”‚
â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
                â”‚
                â–¼
        Xray-core  â”€â”€â–º  VLESS / VMess / Trojan / Shadowsocks node
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

### Phase 1 â€” node intelligence

| Feature | Endpoint | Effect |
|---|---|---|
| Bulk TCP pre-screen | `POST /api/configs/prescreen` | 3 853 nodes screened in **25.3 s** (200 sockets in flight); only survivors reach the expensive stages |
| Background health monitor | `GET /api/nodes/health`, `POST /api/health/check-now` | EWMA health score per node; dead nodes leave rotation after 2 consecutive failures |
| Egress IP grouping | `GET /api/egress/groups` | reveals that "13 nodes" is often **one server** on 13 ports |
| Persisted probe results | `tcp_alive`, `tcp_latency_ms`, `egress_ip`, `health_score` on `configs` | ranking can prefer proven endpoints |

### Phase 3 â€” OpenAI-compatible gateway

| Feature | Details |
|---|---|
| `POST /v1/chat/completions` | streaming and non-streaming |
| `GET /v1/models` | proxied from the upstream, synthetic fallback |
| `GET /v1/usage` | per-key request/token totals |
| API keys | `sk-or-` + 32 chars, **SHA-256 at rest**, prefix only for display |
| Limits | per-key RPM sliding window + daily token quota |
| Accounting | `usage_log` per request: model, tokens, status, latency, egress node |
| Error mapping | `429` â†’ rotate egress and retry once; `401/403` â†’ never rotate; `5xx` â†’ optional rotate; `4xx` â†’ pass through |
| Timeouts | configurable, hard `AbortController` cap |

### Phase 0 / 4 â€” deployment

`deploy/Dockerfile` (multi-stage, non-root), `deploy/docker-compose.yml`,
`deploy/Caddyfile` (public `/v1` only, `/api` localhost-only),
`deploy/opencode-router.service` (systemd, hardened), `deploy/install.sh`
(idempotent bare-metal installer with mirror fallback for Xray).

### Phase A — hardening (2.1)

| Area | What landed | Verification |
|---|---|---|
| CI/CD | GitHub Actions matrix (ubuntu/windows/macos × node 20/22), lint, boundaries, unit, integration, lifecycle, load smoke, coverage, `npm audit` | `.github/workflows/ci.yml` |
| Lifecycle | SIGTERM/SIGINT ? reject new work (503) ? drain in-flight ? close SSE ? stop Xray ? checkpoint SQLite ? exit 0 | `tests/lifecycle-integration.ts` (8 checks, incl. no-orphan PID check) |
| Observability | pino JSON logs with `request_id`/`key_id`/`node_id` + redaction, Prometheus `/metrics`, opt-in OTLP tracing | `tests/unit/observability.test.ts` |
| Contract | OpenAI-compatible schema validators; fixture mode always, live-provider mode in the nightly workflow | `tests/contract/upstream-contract.ts` |
| Load & soak | autocannon harness with p95/error budgets, soak harness sampling RSS from `/metrics` | `tools/load-run.mjs`, `tools/soak.mjs` |
| Boundaries | Layer rules (engine / gateway / observability) enforced with a zero-dependency checker; OpenCode CLI no longer loaded on the gateway path | `tools/check-boundaries.ts` |
| Quality | Biome lint + format, c8 coverage gates (80% lines / 85% functions / 70% branches), 275 unit tests | `npm run verify` |
### Inherited fixes from the 1.x line

* Xray â‰¥ v26 removed `tlsSettings.allowInsecure`; the builder no longer emits it
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
| `GATEWAY_UPSTREAM_BASE_URL` | â€” | e.g. `https://api.openai.com/v1` |
| `GATEWAY_UPSTREAM_API_KEY` | â€” | your real provider key (**env only**, never stored in the DB) |
| `GATEWAY_UPSTREAM_MODEL` | â€” | model id advertised by `/v1/models` |
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
| `gateway_upstream_base_url` | â€” | upstream base URL |
| `gateway_upstream_model` | â€” | advertised model |
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

### 6.1 Gateway (`/v1`) â€” OpenAI-compatible

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

### 6.2 Management (`/api`) â€” loopback only

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
| Upstream credentials | environment only â€” never written to SQLite, never logged |
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

Measured: **3 853 nodes â†’ 25.3 s, 763 alive (19.8 %)** with `concurrency=200`,
`timeout=1500 ms`. Feeding only survivors to the state machine is the single
biggest win over the original design.

### Watch the health monitor

```bash
curl -s http://127.0.0.1:3000/api/nodes/health | jq '.monitor'
```

Nodes decay: a public node that answered in 6 s was timing out 15 minutes later.
`health_score` is an EWMA (Î± = 0.3); two consecutive failures remove a node from
rotation until the next workflow re-tests it.

### Rotation behaviour

```
429 from upstream â”€â”€â–º rotate to next healthiest node â”€â”€â–º retry once
401/403           â”€â”€â–º pass through (auth is not an IP problem)
5xx               â”€â”€â–º pass through unless gateway_rotate_on_5xx=true
timeout / network â”€â”€â–º rotate â”€â”€â–º retry once â”€â”€â–º 502
```

### Quotas and accounting

```bash
curl -s http://127.0.0.1:3000/v1/usage -H "Authorization: Bearer sk-or-..."
sqlite3 data/opencode-vpn.db "SELECT key_id, COUNT(*), SUM(total_tokens) FROM usage_log GROUP BY key_id;"
```

`usage_log` keeps model, token counts, status code, latency and the egress node
for every request â€” enough to answer "how many GB did this cost me?".

---

## 10. Testing and CI

### 10.1 Commands

```bash
npm run typecheck         # tsc --noEmit (backend + tests)
npm run lint              # Biome lint
npm run format:check      # Biome format check
npm run check:boundaries  # no circular imports, no forbidden layer edges
npm run test:unit         # 275 node:test unit tests
npm run test:contract     # OpenAI schema contract (fixture mode)
npm test                  # original acceptance + security suites
npm run test:gateway:ci   # 53-assertion HTTP integration suite (spawns a server)
npm run test:lifecycle    # graceful shutdown + no-orphan checks
npm run load              # autocannon load with p95/error budgets
npm run soak              # repeated load with RSS sampling
npm run coverage          # c8 with enforced thresholds
npm run verify            # everything above, in order
```

### 10.2 Measured results (this machine)

| Suite | Tests | Result |
|---|---:|---|
| Unit (`tests/unit`) | 275 | 274 pass, 1 skipped (symlink requires Windows Developer Mode) |
| Gateway integration | 53 | all pass |
| Lifecycle integration | 8 | all pass (process exits 0, no Xray orphan) |
| Contract (fixture) | 8 | all pass |
| Original acceptance + security | 9 suites | all pass |

**Coverage** (c8, backend modules): **82.19 % lines, 75.17 % branches, 92.15 % functions**.
Thresholds enforced in CI: 80 / 70 / 85.

**Load** (50 connections, 20 s, loopback mock upstream â€” measures gateway overhead only):

```
requests 14112 Â· rps 706 Â· p50 67 ms Â· p95 113 ms Â· p99 130 ms
non-2xx 0 Â· errors 0 Â· timeouts 0
```

**Soak** (30 connections, 1.5 min short run; nightly runs 30 min):

```
requests 43323 Â· errors 0 Â· RSS 201.9 MB â†’ 206.6 MB (+2.33 %, budget 5 %)
```

A full 72-hour soak is not run in this repository; the nightly workflow runs
30 minutes and uploads `load/last-soak-result.json`.

### 10.3 CI

- `.github/workflows/ci.yml` â€” matrix of ubuntu / windows / macos Ã— node 20 / 22:
  typecheck â†’ lint â†’ boundaries â†’ format â†’ unit â†’ acceptance/security â†’ gateway
  integration â†’ lifecycle â†’ load smoke â†’ coverage â†’ artifact upload.
  A second job runs `npm audit --audit-level=high`.
- `.github/workflows/nightly.yml` â€” live upstream contract (when
  `CONTRACT_BASE_URL` / `CONTRACT_API_KEY` secrets exist) and a 30-minute soak.

---

## 11. Observability

### Logs

Structured JSON on stdout (`pino`), one line per request:

```json
{"level":"info","time":"...","service":"opencode-router-gateway","event":"http_request",
 "request_id":"...","method":"POST","route":"/v1/chat/completions","status":200,
 "duration_ms":412,"key_id":3,"node_id":5097}
```

`request_id` is taken from a well-formed `X-Request-Id` header or generated, and
echoed back on the response. Authorization headers, API keys and passwords are
redacted centrally.

### Metrics

`GET /metrics` (management auth) exposes Prometheus metrics:

| Metric | Type | Meaning |
|---|---|---|
| `orgw_http_requests_total{method,route,status}` | counter | request volume |
| `orgw_http_request_duration_seconds` | histogram | latency (p50/p95/p99) |
| `orgw_inflight_requests` | gauge | concurrent requests |
| `orgw_gateway_requests_total{outcome,stream}` | counter | completion outcomes |
| `orgw_egress_rotations_total` | counter | node rotations |
| `orgw_upstream_rate_limits_total` | counter | upstream 429s |
| `orgw_tokens_total{kind}` | counter | prompt/completion/total tokens |
| `orgw_node_health_score{node_id}` | gauge | EWMA health per node |
| `orgw_prescreen_running`, `orgw_health_check_running` | gauge | background jobs |
| `orgw_process_*` | default | RSS, CPU, event-loop lag |

### Tracing

Opt-in and zero-cost by default:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318/v1/traces npm start
```

Each upstream call becomes an `upstream.chat_completions` span carrying model,
stream flag and upstream URL. The SDK is imported lazily, so a missing collector
can never break startup.

---

## 12. Lifecycle and graceful shutdown

```
SIGTERM / SIGINT / POST /api/admin/shutdown
   â”‚
   â”œâ”€ flip to "shutting down"  â†’ new requests get 503 shutting_down
   â”œâ”€ pre hooks                â†’ close SSE clients, stop pre-screen + health monitor
   â”œâ”€ server.close()           â†’ stop accepting connections
   â”œâ”€ drain                    â†’ wait for in-flight requests (bounded, default 15 s)
   â”œâ”€ post hooks               â†’ stop Xray (force-kill tree), close undici agents, flush OTLP
   â””â”€ WAL checkpoint + exit 0
```

`POST /api/admin/shutdown` accepts `{"drainDelayMs": 0..10000}` so the same path
can be exercised on Windows (where Node cannot emulate SIGTERM) and in tests.
The lifecycle suite asserts: 202 response, 503 during drain, open SSE does not
block exit, exit code 0, and the Xray child PID is gone afterwards.

---

## 13. Architecture boundaries

Three layers, enforced in CI by `tools/check-boundaries.ts` (no external deps):

```
observability  â† leaf: logging, metrics, tracing, lifecycle
engine         â† vpn, tester, parser, discovery, db, security, opencode, orchestrator
gateway        â† OpenAI-compatible surface (depends on engine + observability)
```

Rules:
1. no circular imports anywhere under `src/backend`;
2. `gateway/**` must not import `opencode/**` or `orchestrator/**` â€” the gateway
   has to run on a server without the OpenCode CLI installed;
3. `observability/**` must not import `gateway/`, `vpn/`, `tester/` or
   `orchestrator/`.

Current status: `scanned 30 files, 65 internal edges â€” no cycles, no forbidden edges`.
`OpenCodeService` is now lazy, so `/v1/*` and `/api/status` work with no
`opencode` binary present.

---

## 14. Known limitations

1. **Single egress node.** `VpnEngine` is a singleton: one Xray process, one exit
   IP. Many concurrent clients share it. A multi-instance pool is the natural next
   step and is **not** implemented here.
2. **Rotation is serialized.** A 429 triggers one rotation at a time; requests
   arriving during a rotation wait for it.
3. **Branch coverage is 75 %.** Lines/functions exceed the 80 % target, branches
   do not yet; the weakest modules are `vpn-engine.ts` (47 %) and
   `ephemeral-tunnel.ts` (69 %), which need a fake Xray binary to exercise fully.
4. **No live upstream test in this repository.** Contract tests run in fixture
   mode by default; live mode needs `CONTRACT_*` secrets and is wired into the
   nightly workflow only.
5. **No 72-hour soak.** The nightly runs 30 minutes.
6. **No cost accounting.** Token counts are recorded, prices per model are not.
7. **Free public nodes rot fast.** Even with screening and health scoring, expect
   a meaningful failure rate with public subscriptions.
8. **Daily quota is UTC-based** (`datetime('now', 'start of day')`).
9. **Single-process SQLite.** Fine for one gateway process; do not run two writers
   against the same file.

---

## 15. Relationship to the upstream project

This is a derivative work built on
[EhsanCreator/OpenCode-Router](https://github.com/EhsanCreator/OpenCode-Router)
(MIT). It keeps the original dashboard, config parser, Xray builder and workflow
engine, fixes several bugs that prevented end-to-end operation, and adds the
gateway, pre-screen, health, observability and lifecycle subsystems described
above.

Upstream credits: **Ehsan Shahriyari**. See [WINDOWS.md](WINDOWS.md) for the
Windows port notes and the detailed bug analysis.

---

## 16. License

MIT â€” see [LICENSE](LICENSE).
