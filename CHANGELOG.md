# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [2.1.0] — Hardening (Axis A)

Production-hardening pass: CI, lifecycle, observability, contract tests, load/soak
and enforced architecture boundaries. No behaviour change to the public API.

### Added — CI/CD and quality gates

- `.github/workflows/ci.yml`: matrix of ubuntu/windows/macos × Node 20/22 running
  typecheck, Biome lint, format check, boundary check, unit tests, acceptance and
  security suites, gateway integration, lifecycle, load smoke and coverage, plus
  a separate `npm audit --audit-level=high` job.
- `.github/workflows/nightly.yml`: live upstream contract checks (when
  `CONTRACT_*` secrets exist) and a 30-minute soak with artifact upload.
- Biome (lint + format) replaces ESLint/Prettier — typescript-eslint does not
  support the TypeScript 7 toolchain used here.
- c8 coverage with enforced thresholds: 80 % lines, 85 % functions, 80 %
  statements, 70 % branches. Measured: **82.19 / 92.15 / 82.19 / 75.17**.

### Added — graceful lifecycle

- `src/backend/lifecycle.ts`: shutdown phases (reject → pre hooks → close listener
  → drain → post hooks → WAL checkpoint → exit), signal handlers, bounded drain,
  `uncaughtException`/`unhandledRejection` handling.
- `POST /api/admin/shutdown` (management auth) with `drainDelayMs`, so the same
  path is testable on Windows where SIGTERM cannot be emulated.
- Requests arriving during drain receive `503 shutting_down`; SSE clients are
  closed so they cannot block exit; the Xray child is force-terminated.

### Added — observability

- `src/backend/observability/logger.ts`: pino JSON logs with central redaction.
- `src/backend/observability/request-context.ts`: AsyncLocalStorage request id,
  `X-Request-Id` propagation, per-request log line with key/node/provider ids.
- `src/backend/observability/metrics.ts`: Prometheus registry and `GET /metrics`
  (request rate, latency histogram, in-flight, rotations, upstream 429s, tokens,
  node health, background jobs).
- `src/backend/observability/tracing.ts`: opt-in OTLP tracing via
  `OTEL_EXPORTER_OTLP_ENDPOINT`, lazy SDK import, `upstream.chat_completions`
  spans.

### Added — contract, load and soak

- `tests/contract/upstream-contract.ts`: OpenAI-compatible schema validators with
  fixture mode (always) and live-provider mode (nightly, secrets-gated).
- `tools/load-run.mjs`: autocannon harness with p95 and error budgets; writes
  `load/last-load-result.json`. Measured: 706 rps, p95 113 ms, p99 130 ms,
  0 errors over 14 112 requests.
- `tools/soak.mjs`: repeated load cycles sampling RSS from `/metrics`; fails when
  growth exceeds the budget. Short run measured +2.33 % RSS over 43 323 requests.

### Added — architecture boundaries

- `tools/check-boundaries.ts`: zero-dependency import graph checker enforcing no
  cycles and no forbidden layer edges (gateway must not import opencode/
  orchestrator; observability must stay a leaf).
- `OpenCodeService` is now lazy, so the gateway and `/api/status` work on a host
  without the OpenCode CLI installed.

### Added — test infrastructure

- `DATA_DIR` support (`src/backend/paths.ts`), so tests and operators can relocate
  SQLite, probe configs and the active Xray config.
- 275 unit tests (`node:test`) across parser, Xray builder, JSON importer, error
  classifier/mapper, egress filter, key manager, database/migrations, bulk
  pre-screen, candidate ranker, health monitor, latency tester, security guards,
  lifecycle, observability, engine failure paths and in-process gateway HTTP.
- `tests/lifecycle-integration.ts`: 8 checks including a real no-orphan PID check.

### Fixed

- **Streaming response leak**: after a client aborted mid-stream the response
  object never ended, keeping the socket open (server shutdown could hang for
  minutes). The stream finally-block now ends the response.
- **Synchronous spawn failure**: `spawn()` throwing (EFTYPE/EACCES on Windows)
  made `VpnEngine.start()` reject instead of resolving `false`.
- Engine selection no longer picks loopback addresses as egress nodes.
- `test-scenarios` no longer leaves a `127.0.0.1` "working" node in the database.

### Changed

- `npm run verify` runs the whole chain; `test:all` replaced by it.
- README restructured with testing/observability/lifecycle/boundary sections.

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
