# Architecture

```
Windows / Harness / 9Router
        │  OpenAI-compatible: POST /v1/chat/completions  (Bearer sk-or-…)
        ▼
Gateway (:3011 on Tailscale, :3010 loopback staging)
  ├── security guard: bind host, Host allow-list, CORS, body limit
  ├── auth: hashed API keys, RPM/TPM/daily-token/spend caps
  ├── model router: alias → ordered providers + per-provider upstream model
  ├── provider router: priority/health selection, failover on rate-limit/quota/5xx/network
  ├── upstream client: undici, proxy per slot, loopback bypass
  └── accounting: usage_log (request id, requested/resolved model, provider, egress, attempts)
        │
        ▼
Egress pool (N Xray slots)
  slot i: SOCKS pool_base+2i, HTTP pool_base+2i+1, own process, own node
  real probe every N seconds → probeOk/probeStatus/probeLatencyMs
        │
        ▼
VLESS / VMess / Trojan / SS node → exit IP (DE, TR, …)
        │
        ▼
Authorised upstream (OpenCode Zen / 9Router / any OpenAI-compatible provider)
```

## Ports

| Instance | HTTP | Egress slots |
|---|---|---|
| working (`opencode-router-local`) | `100.91.206.72:3011` | 12000-12003 |
| staging (`opencode-router`) | `127.0.0.1:3010` | 12100-12103 |

## Data

- SQLite `data/opencode-vpn.db` (WAL, synchronous=NORMAL, busy_timeout 5s).
- `usage_log` is the single accounting choke point; retention prunes it.
- Prometheus text metrics at `/metrics` (management surface).

## Boundaries

- `/v1/*` = client surface (gateway keys).
- `/api/*` = management (loopback trusted, or Bearer `OPENCODE_ROUTER_API_KEY`).
- Xray ports are loopback-only; never exposed.
