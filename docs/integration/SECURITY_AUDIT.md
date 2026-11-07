# Security Audit — premium egress integration

Scope: gateway `344e367` on `100.91.206.72:3011` (tailnet) and staging `127.0.0.1:3010`.
No destructive test was run against production data.

## Secret handling

| Control | Result | Evidence |
|---|---|---|
| Premium credentials stored in env only | PASS | `PREMIUM_HTTP_PROXY_URL`, `PREMIUM_SOCKS5_PROXY_URL` in `.env` (600) |
| Never stored in SQLite | PASS | no proxy URL in any table |
| Never returned by API | PASS | `/api/egress/premium` returns `http://***:***@host:8443/` |
| Never in logs | PASS | adapter logs kind + egress IP only |
| Bridge config file permissions | PASS | `data/premium-socks-bridge.json` mode 600 |
| API keys hashed | PASS | `api_keys.key_hash` + prefix only |

## Authentication / isolation

| Test | Expected | Actual |
|---|---|---|
| Missing API key on `/v1` | 401 | 401 |
| Invalid key | 401 | 401 |
| Revoked key | 401 | 401 |
| Client key on `/api/*` | 401 | 401 |
| Management key on `/api/*` | 200 | 200 |
| Host header `evil.com` | 403 | 403 |
| 9 MB body | 413 | 413 |
| Malformed JSON | 400 | 400 |

## SSRF / open relay

| Control | Result |
|---|---|
| Provider base URL is operator-configured (not client-controlled) | PASS |
| Premium proxy is outbound-only (no inbound listener) | PASS |
| SOCKS5 bridge binds `127.0.0.1` only | PASS (`ss -ltn` shows 127.0.0.1:12211) |
| No client-supplied URL is fetched by the gateway | PASS |
| Subscription import restricted to configured sources | PASS (existing control) |

## Residual risks

| Risk | Severity | Note |
|---|---|---|
| Tailnet is a shared trust boundary | Medium | API key is the only gate; keep the tailnet private |
| Proxy credentials in `.env` | Medium | root compromise exposes them; rotate via the provider |
| No rate limit on `/api/*` | Low | loopback/tailnet only |
| `X-Powered-By: Express` header | Low | cosmetic fingerprinting |
| SOCKS5 bridge is a local Xray process | Low | loopback only, replaced on failure |
