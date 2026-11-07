# Security Review

Scope: gateway on `100.91.206.72:3011` (tailnet) and staging on `127.0.0.1:3010`.
All tests were non-destructive and used test keys.

## Results

| ID | Test | Expected | Actual |
|---|---|---|---|
| S01 | Request without API key | 401 | 401 |
| S02 | Request with invalid key | 401 | 401 |
| S03 | Revoked key | 401 | 401 (before revoke: 200) |
| S04 | Client key on `/api/*` | 401 | 401 |
| S05 | Management key on `/api/*` | 200 | 200 |
| S06 | Host header `evil.com` | 403 | 403 |
| S07 | Malformed JSON body | 400 | 400 |
| S08 | 9 MB body (limit 8 MB) | 413 | 413 |
| S09 | Upstream API key in `GET /api/settings` | absent | absent (env-only) |
| S10 | Webhook URL in settings | redacted | `***` when set |
| S11 | API key storage | hashed | `key_hash` + `key_prefix` only |
| S12 | File permissions | 600 | `.env` 600, DB 600, access file 600 |
| S13 | Prompt text in `usage_log` | absent | columns hold metadata only |
| S14 | Xray ports exposed | loopback only | `127.0.0.1:1200x` |
| S15 | Public internet exposure | none | binds tailnet IP / loopback |

## Controls present

- Bind-host validation: non-loopback bind requires `OPENCODE_ROUTER_API_KEY`
  (the service refuses to start otherwise).
- Host allow-list (DNS-rebinding protection) and CORS origin allow-list.
- Body-size limit on `/v1` (8 MB default) and global 10 MB.
- Constant-time key comparison; keys stored hashed.
- Admission control: concurrency cap, in-flight byte budget, per-slot cap.
- Management surface separated from the client surface.
- Settings redaction for the upstream URL and the alert webhook.

## Residual risks

| Risk | Note |
|---|---|
| Tailnet is a shared trust boundary | any tailnet device can reach the port; the API key is the only gate |
| Quick Cloudflare tunnel | ephemeral third-party endpoint used as an upstream, not as a public entry point |
| Secrets in environment | provider keys live in `.env` (600); a root compromise exposes them |
| No rate limit on `/api/*` | management API is loopback/tailnet only; add a limiter if exposed further |
