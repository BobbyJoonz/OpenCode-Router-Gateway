# Final Acceptance Report — OpenCode Router Gateway

- **Final commit:** `77cb3fd` + traceability commit (see git log)
- **Host:** `handsome-jade.ptr.network` (Ubuntu 24.04.4, 2 vCPU, 3.9 GB)
- **Working instance:** `http://100.91.206.72:3011` (Tailscale only)
- **Staging instance:** `http://127.0.0.1:3010` (loopback only)
- **Date:** 2026-11-07

## Definition of DONE — status

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 1 | Fresh install without errors | **PASS** | `test:fresh` 11/11; fresh host started |
| 2 | Existing DB upgrades without data loss | **PASS** | idempotent migrations; repair blocks for both price-column revisions |
| 3 | Real API key issued | **PASS** | `POST /api/keys` → `sk-or-…`; hashed at rest |
| 4 | Base URL reachable from Windows | **PASS** | tailnet `100.91.206.72:3011`, W01–W12 |
| 5 | `/v1/models` returns real models | **PASS** | 69 ids (upstream catalogue merged) |
| 6 | Real non-streaming works | **PASS** | marker `E2E-A7E5F932` returned, usage 2135/12/2147 |
| 7 | Real streaming works | **PASS** | delta content + usage + `[DONE]` |
| 8 | Correct provider/model identity | **PASS** | `x-model-requested/resolved/provider/egress` + `usage_log` |
| 9 | Errors are precise and traceable | **PASS** | classifier + `x-request-id` + error column |
| 10 | No silent fallback | **PASS** | `x-fallback-used`, `attempts`, resolved model in headers |
| 11 | Egress proxy healthy and stable | **PASS** | real probe; 403 target excluded; 2 slots distinct IPs |
| 12 | Quotas respected | **PASS** | `test:tpm` 24/24; spend caps; `Retry-After` honoured |
| 13 | Recovers after restart | **PASS** | systemd restart → ready in 2 s |
| 14 | Admin API stays private | **PASS** | 401 without Bearer; loopback/tailnet only |
| 15 | Critical tests pass | **PASS** | 249 assertions, 0 failures |
| 16 | Executable report with evidence | **PASS** | this file + `docs/testing/*` |

## Test totals

| Suite | Passed |
|---|---|
| fresh-db | 11 |
| anthropic | 33 |
| retention | 13 |
| tpm/rpm | 24 |
| map-reduce | 25 |
| side-effects | 1 |
| service | 25 |
| routing | 32 |
| gateway | 53 |
| ops | 32 |
| **total** | **249** |

Typecheck: 0 errors. Build: 0 errors.

## Real E2E (Windows → gateway → egress → provider → Windows)

```
requested: deepseek-v4.1-flash-free
HTTP 200 · model gemini-3.8-flash-n · content E2E-A7E5F932 (unique marker)
x-request-id 3bf25c90-… · x-provider 9router-fallback · x-egress-node 1
usage_log: provider_id=10 egress_node_id=1 status=200 tokens=2147
```

Fallback case (OpenCode Zen 429 → second provider):
```
HTTP 200 · x-attempts 2 · x-fallback-used 1 · x-model-resolved ag/gemini-3.8-flash
```

## OpenCode free-tier access — external limitation

| Path | Result | Classification |
|---|---|---|
| Official OpenCode CLI | 0 credentials on the server; free models require login | **Blocked** (no authorised credential) |
| Direct API with Zen keys | `429 FreeUsageLimitError`, `Retry-After ≈ 59310 s`, **identical from every exit IP and both keys** | **Blocked by provider restriction** (account-scoped) |
| Third-party gateway | not attempted for bypassing; gateway uses an authorised upstream | — |

No claim is made that changing the egress IP resets the free quota; the measurements
show it does not. The gateway is proven with an authorised provider instead.

## Changed files (this audit)

- `src/backend/vpn/egress-pool.ts` — base-port tracking + real probe (earlier commit)
- `src/backend/vpn/xray-slot.ts` — probe state
- `src/backend/gateway/upstream-errors.ts` — 429 failover (earlier commit)
- `src/backend/gateway/openai-router.ts` — request id, trace headers, trace fields
- `src/backend/gateway/key-manager.ts` — trace columns
- `src/backend/db/migrations.ts` — trace columns
- `docs/**` — this documentation set

## Unproven / not tested

| Item | Reason |
|---|---|
| Tool calling | no tool-calling test exists; upstream passthrough only |
| Harness real session | Harness was not driven end-to-end here; contract is the same `/v1/chat/completions` |
| Long-term uptime / SLA | single short observation window |
| 9Router production stability | quick tunnel is ephemeral |
| Multi-process cluster quotas | per-process state; documented limitation |

## How to connect

```
Base URL: http://100.91.206.72:3011/v1
API Key : (gateway key, /root/opencode-router-access.txt)
Model   : deepseek-v4.1-flash-free  (or any id from /v1/models)
```

Management API needs `Authorization: Bearer <management key>`.

## Restart / rollback

See `docs/operations/DEPLOYMENT.md` and `docs/operations/ROLLBACK.md`.
