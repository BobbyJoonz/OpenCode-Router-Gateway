# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
