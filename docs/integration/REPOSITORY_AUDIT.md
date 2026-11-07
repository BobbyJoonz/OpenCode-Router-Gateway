# Repository Audit — OpenCode Router Gateway + 3 reference projects

Audited on the server (`/tmp/refrepo`) by cloning each repository; findings below are
from the code/README that was actually read, not from reputation.

## 1. OpenCode Router Gateway (ours, `344e367`)

| Feature | Status | Where |
|---|---|---|
| Provider router + failover | Implemented, verified | `gateway/provider-router.ts` |
| Xray engine + pool | Implemented, verified | `vpn/egress-pool.ts`, `vpn/xray-slot.ts` |
| Real egress probe | Implemented, verified | `probeAll()` (`cf5ee56`) |
| Health monitor | Implemented, verified | `tester/health-monitor.ts` |
| SQLite schema + migrations | Implemented, verified | `db/migrations.ts` (`test:fresh` 11/11) |
| API key auth (hashed) | Implemented, verified | `gateway/key-manager.ts` |
| Model routing / aliases | Implemented, verified | `gateway/model-router.ts` |
| SSE streaming + `[DONE]` | Implemented, verified | `openai-router.ts` |
| Error classification | Implemented, verified | `gateway/upstream-errors.ts` |
| Request traceability | Implemented, verified | `x-request-id`, `usage_log` columns |
| Premium HTTP/SOCKS5 egress | Implemented, verified | `egress/premium-proxy.ts` (`344e367`) |
| Management UI | Partial (API complete, dashboard 1.0) | `src/frontend` |

## 2. azrinaldi/opencode-free-bridge — what it actually does

Read: `server.js`, `egress-proxy.js`, `identity.js`, `transport-fingerprint.js`,
`gate-drill.js`, `test/*`, README.

| Capability | Finding | Reuse / Adapt / Reject |
|---|---|---|
| OpenAI-compatible contract | `/v1/models`, `/v1/chat/completions`, `/v1/responses` | **Reuse** (already have) |
| SSE handling | forwards upstream SSE, normalises reasoning tokens | **Adapt** (reasoning_content pass-through) |
| Regression tests | gate-contract, proxy, identity, verify-quick | **Adapt** (ideas, not code) |
| Health endpoint | `/health` with gate rejection state | **Reuse** (we have `/v1/health`, `/readyz`) |
| Timeout handling | per-request timeouts | Already have |
| Egress configuration | single egress proxy | Already have (pool) |
| Secret redaction | no secrets in logs | Already have |
| Model discovery | scrapes `models.opencode.ai/api.json` | **Reject** (not our model source) |
| **CLI identity synthesis** | TLS ClientHello (17 ciphers/12 extensions), UA `opencode/...`, session header, tool named `read` | **Reject** — this is client-identity forgery to pass the free-tier gate; the master prompt forbids it |

**Critical finding:** the free-tier gate rejects Node/OpenSSL fingerprints with
`403 FreeTierError` and expects the OpenCode CLI wire shape. That is why a plain
gateway cannot serve it, independent of the egress IP.

## 3. ebouther/opencode-unlimited-proxy — what it actually does

Read: README, `stack/config.json`, `stack/generate-compose.py`, `docs/free-tier-gates.md`,
`tests/test_dedupe.py`, `tests/test_gate3_tool_rule.py`.

| Capability | Finding | Reuse / Adapt / Reject |
|---|---|---|
| Duplicate egress IP detection | dedupe of WARP exits | **Reuse** (we have distinct-IP accounting in the pool) |
| Egress health monitoring | per-exit health | **Reuse** (real probe) |
| Fault injection | gate probe tests | **Adapt** (test ideas) |
| Session reliability | retries with cooldown | Already have |
| Network observability | per-exit stats | **Adapt** (add egress stats) |
| **WARP / network namespace** | rotates Cloudflare WARP exits with per-/64 egress | **Reject** — changes host networking; prompt forbids it |

**Critical finding:** the free tier meters the **egress block**, so a WARP/rotating
pool removes the block ceiling. This is exactly the premium-proxy use case — but it
still requires the CLI identity shape (see above).

## 4. kirafishy/OCFreeRelay — what it actually does

Read: README, `src/index.ts`, `tests/*`, `scripts/probe-sub.mjs`.

| Capability | Finding | Reuse / Adapt / Reject |
|---|---|---|
| HTTP/SOCKS5 proxy registry | proxy pool bindings | **Reuse** (premium proxy adapter) |
| Subscription importer | not present (single base URL) | Already have |
| Clash/Mihomo compatibility | no | Reject (not needed) |
| Worker isolation | per-key workers | Already have (provider router) |
| Dashboard | admin page for keys/proxies/status | **Adapt** (dashboard is P2) |
| Configuration persistence | `data/settings.json` | Already have (SQLite settings) |
| Health state | per worker | Already have |
| Multi-key sticky until 429 | sticky affinity + rotate + cooldown | **Adapt** (we have sticky + cooldown) |
| **CLI header synthesis** | optional UA/client headers | **Reject** (identity forgery) |

## Conclusion

- The three reference projects exist to pass the **OpenCode free-tier gate**, which
  requires the CLI's TLS fingerprint and wire identity. Reusing that mechanism means
  forging client identity — explicitly forbidden by the task and by provider policy.
- Their genuinely reusable parts (egress health, dedupe, sticky/cooldown, proxy
  registry) are either already present in our gateway or were adopted in `344e367`
  (premium HTTP/SOCKS5 egress with real IP probing).
- OpenCode free-tier access through this gateway is therefore reported as
  **BLOCKED_BY_PROVIDER_POLICY**, not as a gateway defect.
