# Baseline Audit — OpenCode Router Gateway

- **Commit audited:** `77cb3fd` (plus the traceability change committed right after this audit)
- **Host:** `handsome-jade.ptr.network` · Ubuntu 24.04.4 · 2 vCPU · 3.9 GB RAM
- **Date:** 2026-11-07 (UTC)
- **Method:** read-only inspection + live probes. No claim below is based on a file name alone.

## 1. Environment at audit time

| Item | Value |
|---|---|
| Running services (systemd) | 60 (2 are ours: `opencode-router`, `opencode-router-local`) |
| Docker containers | 8 (none touched) |
| Tailscale | `100.91.206.72` (server), `100.70.93.58` (Windows, active) |
| Disk | 34G/40G used, **4.8 GB free (88%)** |
| Memory | 3.9 GB total, ~837 MB available |
| Gateway instances | 3010 = staging (loopback), 3011 = working (Tailscale) |
| Xray | v26.10.31, 2 slots per instance |

## 2. Repository state

Both instances are clean checkouts of `main` at the audited commit, tracking
`https://github.com/BobbyJoonz/OpenCode-Router-Gateway.git`.

## 3. Feature status (verified against code and live behaviour)

| # | Feature | Status | Evidence |
|---|---|---|---|
| 1 | Gateway API (`/v1/*`) | **Implemented and Verified** | live 200s from Windows; suites |
| 2 | Provider registry + router | **Implemented and Verified** | providers 9/10/13; failover test |
| 3 | Model discovery + aliases | **Implemented and Verified** | `/v1/models` = 69 ids; routes table |
| 4 | Multi-egress Xray pool | **Implemented and Verified** | 2 slots, distinct exit IPs |
| 5 | Health monitoring + real probe | **Implemented and Verified** | `probeAll()`, 403 target → excluded |
| 6 | Retry / timeout / failover | **Implemented and Verified** | `x-attempts: 2`, fallback flag |
| 7 | API key authentication | **Implemented and Verified** | 401 wrong/revoked; hashed storage |
| 8 | RPM/TPM + daily quotas | **Implemented and Verified** | `tests/tpm-tests.ts` 24/24 |
| 9 | Cost accounting | **Implemented and Verified** | `usage_log.cost_usd`; `model_prices` fixed |
| 10 | SSE streaming | **Implemented and Verified** | delta + usage + `[DONE]` |
| 11 | Tool calling | **Implemented (passthrough) / Untested** | no tool-calling test exists |
| 12 | Database migration | **Implemented and Verified** | `test:fresh` 11/11 |
| 13 | Windows client compatibility | **Implemented and Verified** | W01–W12 below |
| 14 | Tailscale access | **Implemented and Verified** | bound to tailnet IP + Bearer |
| 15 | Security isolation | **Implemented and Verified** | 403 host, 401 admin, 413 body |
| 16 | Deployment / recovery | **Implemented and Verified** | systemd enabled, restart tested |
| 17 | Logs / observability | **Implemented and Verified** | `/metrics`, usage trace columns |
| 18 | Tests / CI | **Implemented and Verified** | 248 assertions, CI workflow |

## 4. Findings fixed during this audit

| Severity | Finding | Fix |
|---|---|---|
| P1 | Two instances collided on egress ports 12000-12003 | `pool_base_port` change now recreates slots (`77cb3fd`); staging moved to 12100-12103 |
| P0 | Model substitution was silent (`deepseek…-free` answered by `gemini…`) | response headers `x-model-requested`/`x-model-resolved`/`x-provider`/`x-egress-node`/`x-attempts`/`x-fallback-used` + trace columns in `usage_log` |
| P1 | 429 never failed over to another provider | `rate_limit`/`quota` → `retryProvider: true` (`4992e43`) |
| P1 | Streaming had no `[DONE]` when upstream omits it | synthesised (`f6632cb`) |
| P1 | `/v1/models` returned a synthetic list | upstream catalogue merged (`f6632cb`) |
| P0 | Fresh install crashed (`model_prices`) | created in service-migrations (`c99732c`) |
| P0 | `EROFS` on launcher under `ProtectSystem=strict` | `OPENCODE_LAUNCHER_DIR` (`c99732c`) |
| P0 | `npm ci` failed (lockfile out of sync) | lockfile regenerated (`c99732c`) |
| P1 | Cost columns mismatch → 500 on every completion | canonical columns + backfill (`aa09cfd`) |
| P1 | Pool "ready" meant process alive, not reachable | real per-slot probe + filtering (`cf5ee56`) |

## 5. Open limitations (external, not gateway bugs)

| Limitation | Classification |
|---|---|
| OpenCode Zen free models: `429 FreeUsageLimitError`, `Retry-After ≈ 16-18h`, identical from every IP | **Blocked by provider restriction** (account-scoped) |
| OpenCode CLI built-in free models need a login; server has `0 credentials` | **Blocked** (no authorised credential) |
| 9Router quick Cloudflare tunnel URL is ephemeral | **Operational limitation** |
| Most 9Router upstream providers are disabled (`isActive=0`) | **External configuration** |
