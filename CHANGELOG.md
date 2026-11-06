# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [3.0.0] — Service edition (axis C)

Moves the project from "a gateway on one node" to a service with concurrent
egress, money accounting, abuse control, self-serve onboarding, a public status
page, readiness/drain and a legal baseline.

### C1 — multi-instance egress pool
- `src/backend/vpn/egress-pool.ts` + `xray-slot.ts`: N independent Xray processes,
  one node each, on their own loopback ports.
- Watchdog, drain-before-rotate, failover and per-key stickiness.
- `GET /api/egress/status`, `POST /api/egress/ensure|reinit`,
  `POST /api/egress/rotate/:slot`, `POST /api/egress/failover/:slot`.

### C2 — per-key routing
- `api_keys.pool_id`, `sticky`, `preferred_providers`.
- Selector strategies: least-loaded (default), round-robin, random.

### C3 — cost accounting in USD
- `model_prices`, `usage_log.cost_usd`, per-key `spend_cap_usd_daily/monthly`.
- `GET /api/prices`, `PUT /api/prices`, `GET /api/costs`.
- Spend is reserved before forwarding, settled after.

### C4 — abuse detection
- `gateway/abuse.ts` (progressively decaying trust score) and
  `service/abuse-guard.ts` (mounted in front of `/v1`).
- Signals: upstream 429/5xx, duplicate request bodies; logged to `abuse_events`.
- `GET /api/abuse/events`, `POST /api/keys/:id/reset-trust`.

### C5 — self-serve onboarding
- `GET /portal` signup page, `POST /api/signup` (invite + per-IP daily limit),
  `POST /api/invites`, `GET /api/invites`.
- Invite codes stored as SHA-256, shown once.

### C6 — customer-facing observability
- `GET /status` public HTML status page, `GET /api/public/status` JSON.
- `usage_alerts` + `POST /api/alerts/check` for 50/80/100 % thresholds.

### C7 — readiness and draining
- `GET /readyz` (200/503), `POST /api/service/drain`, `POST /api/service/undrain`.

### C8 — legal baseline and data rights
- `legal/TERMS.md`, `legal/PRIVACY.md`, `legal/DPA.md`,
  `legal/DATA-RETENTION.md` (templates with explicit placeholders).
- `GET /api/privacy/export`, `DELETE /api/privacy/erase`.

### Also
- `tools/rotation-experiment/` — reproducible A/B harness for the axis-D question.
- `src/backend/providers/` + `gateway/provider-router.ts` — independent upstream
  providers with priority, cost and provider-level failover.
- `src/backend/tester/freshness.ts` — IP freshness instrumentation.

### Fixed during integration
- `model_prices` column naming aligned (`cost_per_1m_in/out`).
- `??`/`||` precedence bug in the pool size calculation.
- Service settings added to the settings whitelist (they were silently rejected).
- Build is `tsc --noEmit` clean; **53 + 25 = 78** integration assertions green.

### Known limitations (unchanged or newly explicit)
- True HA still needs a shared database; SQLite is single-writer and the RPM
  limiter is per-process.
- Daily quota windows are UTC.
- The pool only helps if you actually have several healthy, clean egress nodes.

---

## [2.0.0] — Gateway edition

Turns the desktop node-finder into a server-side, OpenAI-compatible gateway.

### Added — OpenAI-compatible gateway (`/v1`)

- `POST /v1/chat/completions` with streaming (SSE passthrough) and non-streaming modes.
- `GET /v1/models` proxied from the upstream, with a synthetic fallback list.
- `GET /v1/usage` per-key totals and daily quota state.
- `GET /v1/health` liveness endpoint (no auth, no endpoint disclosure).
- API-key issuance: `sk-or-` + 32 base64url chars, stored as SHA-256 hash with a
  display prefix only. Keys are returned exactly once.
- Per-key sliding-window RPM limiting and daily token quotas.
- Per-request accounting in `usage_log`: model, prompt/completion/total tokens,
  status code, latency, upstream URL, egress node.
- Error mapping: `429` → rotate egress and retry once; `401/403` → pass through
  without rotating; `5xx` → optional rotate; `4xx` → pass through.
- Hard upstream timeouts with `AbortController`.
- `stream_options.include_usage` injection so streaming requests are accounted.

### Added — node intelligence

- **Bulk TCP pre-screener** (`BulkPrescreener`): bounded socket fan-out
  (200 concurrent by default). Measured 3 853 nodes in **25.3 s**.
  Endpoints: `POST /api/configs/prescreen`, `GET /api/prescreen/status`,
  `POST /api/prescreen/abort`.
- **Background health monitor** (`HealthMonitor`): EWMA health score per node,
  dead nodes leave rotation after two consecutive failures. Probes run in a
  throwaway Xray instance on ephemeral ports so the serving tunnel is never
  disturbed. Endpoints: `GET /api/nodes/health`, `POST /api/health/check-now`.
- **Egress IP grouping**: `GET /api/egress/groups` exposes when many "nodes" are
  really one server on many ports.
- New `configs` columns: `tcp_alive`, `tcp_latency_ms`, `egress_ip`,
  `health_score`, `last_health_check`, `bandwidth_bytes`, `prescreen_at`.

### Added — operations and deployment

- `GET`/`PUT /api/settings` with a whitelisted, redacting settings API.
- `deploy/Dockerfile` (multi-stage, non-root, healthcheck, mirror-able Xray download).
- `deploy/docker-compose.yml` publishing on loopback only.
- `deploy/Caddyfile` exposing only `/v1/*` publicly; `/api/*` restricted to loopback.
- `deploy/opencode-router.service` hardened systemd unit.
- `deploy/install.sh` idempotent bare-metal installer with `XRAY_BASE` mirror support.
- `tests/gateway-tests.ts`: 53-assertion integration suite with a mock upstream.

### Fixed — bugs inherited from 1.x

- **Xray ≥ v26 rejected every TLS config** because the builder emitted the removed
  `tlsSettings.allowInsecure` field.
- **OpenCode's LLM runtime failed with `ECONNREFUSED`** whenever an HTTP proxy was
  exported; the launcher and verification now use SOCKS5 only.
- **Success path crashed** on `last_status = "working"` (double-quoted SQL literal
  rejected by modern SQLite).
- **`details_json` of `null` crashed the engine** (`Cannot read properties of null
  (reading 'sni')`). Parsing is now defensive at both the engine and builder.
- **Windows**: `xray.exe` resolution, `taskkill /F` cleanup for detached children,
  `.cmd` launcher, `better-sqlite3` pinned to a version with prebuilds.
- **Port collision with v2rayN** on 10808/10809 is documented and configurable.
- Test suite no longer leaves a `127.0.0.1` "working" node in the production
  database (it used to poison egress rotation).

### Security

- Loopback/link-local addresses are never selected as egress nodes.
- Unknown and disabled API keys return an identical `401` (no key enumeration).
- Management API redacts upstream credentials in every response.
- Request bodies are limited by body-parser on actual received bytes.
- Probe config files are written with the hardened `safeWriteSensitiveFile` and
  swept on startup.

### Changed

- `better-sqlite3` pinned to `12.6.2` (Windows prebuilds for Node 22).
- `tsconfig.json` now type-checks backend + tests only (`npm run typecheck`).
- `npm run test:all` runs typecheck, acceptance/security suites and the gateway suite.

### Known limitations

- Single egress node (one Xray process): concurrent clients share one exit IP.
- Rotation is serialized; requests wait during a rotation.
- No price/cost modelling.
- Daily quota resets at 00:00 UTC.

---

## [1.0.0]

Initial OpenCode Router release (upstream): proxy discovery, three-stage testing,
Xray-based local proxy, React dashboard.
