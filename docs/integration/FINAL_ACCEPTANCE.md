# Final Acceptance — Premium Egress Integration

- **Commit:** `344e367` (code) + this documentation commit
- **Host:** `handsome-jade.ptr.network` · gateway `100.91.206.72:3011` (tailnet)
- **Date:** 2026-11-07

## Feature table

| Feature | Implemented | Test Executed | Result | Evidence | Remaining Risk |
|---|---|---|---|---|---|
| Premium HTTP proxy (auth) | Yes | Yes | **PASS** | egress `85.254.59.165`; gateway `192.177.183.130` | proxy operator availability |
| Premium SOCKS5 proxy (auth) | Yes (Xray bridge) | Yes | **PASS** | egress `195.63.16.243`; gateway `195.63.28.89`; provider `195.63.23.110` | bridge process supervision |
| Per-provider egress selection | Yes | Yes | **PASS** | `providers.egress_mode`, `x-egress-node` | strict mode not enforced |
| Fail-closed when premium unconfigured | Yes | Yes | **PASS** | `EGRESS_NOT_CONFIGURED` | — |
| Secret redaction | Yes | Yes | **PASS** | `***:***@host` in API | env compromise |
| Egress IP probing | Yes | Yes | **PASS** | `/api/egress/premium` | public echo dependency |
| Xray pool (VLESS) | Existing | Yes | **PASS** | 2/2 slots, distinct IPs | node churn |
| Real per-slot probe | Existing | Yes | **PASS** | 403 target excluded | — |
| Provider routing + failover | Existing | Yes | **PASS** | `x-attempts: 2` | — |
| Model traceability | Yes | Yes | **PASS** | headers + `usage_log` | strict model mode pending |
| Strict model mode | No | — | **BLOCKED/UNTESTED** | — | needs explicit product decision |
| SSE streaming | Existing | Yes | **PASS** | delta + `[DONE]` | — |
| Tool calling | Passthrough | No | **UNTESTED** | — | no test exists |
| OpenCode free tier via gateway | No | Yes | **BLOCKED_BY_PROVIDER_POLICY** | `429 FreeUsageLimitError`; gate requires CLI identity | policy, not code |
| OpenCode free tier via official CLI v2.2.6 | Installed | Yes | **FAIL (external)** | `Free usage limit reached` | account/credential |
| Windows E2E | Yes | Yes | **PASS** | W01–W12 | Harness session not driven |
| Regression suites | Yes | Yes | **PASS** | 249 assertions, 0 failures | — |
| Dashboard for premium egress | No | — | **BLOCKED/UNTESTED** | API only | frontend work |

## Definition of done

| # | Requirement | Status |
|---|---|---|
| 1 | Production gateway unharmed | PASS (both instances healthy) |
| 2 | Regression tests without failure | PASS (249/0) |
| 3 | Premium HTTP works | PASS |
| 4 | Premium SOCKS5 works | PASS |
| 5 | At least one real V2Ray config verified | PASS (2 slots, real HTTPS probe) |
| 6 | Subscription import secure | PASS (existing controls) |
| 7 | Egress IP recorded accurately | PASS |
| 8 | Duplicate IPs not counted as separate paths | PASS |
| 9 | Streaming stable | PASS |
| 10 | Tool calling really tested | **UNTESTED** |
| 11 | Model integrity | PARTIAL (visible, not enforced) |
| 12 | Unauthorised providers not reported as success | PASS |
| 13 | Secret leakage zero | PASS |
| 14 | Restart/recovery without corruption | PASS |
| 15 | Windows connection | PASS |
| 16 | Real test results recorded | PASS |

## Explicit non-claims

- No claim that OpenCode free-tier quota can be increased by changing the egress IP.
  Measurements show an account-scoped timer; the gate also inspects the client wire
  identity, which this gateway deliberately does not forge.
- No claim of long-term uptime/SLA from a short observation window.
- No claim that the premium proxy provides N independent IPs; only observed distinct
  IPs are reported.

## How to use

```
Base URL: http://100.91.206.72:3011/v1
API Key : (gateway key from /root/opencode-router-access.txt)
Model   : any id from GET /v1/models
```

Premium egress is selected per provider:

```bash
curl -X POST http://100.91.206.72:3011/api/providers -H "authorization: Bearer <mgmt>" \
  -H 'content-type: application/json' \
  -d '{"name":"premium-http","base_url":"https://api.example.com/v1","key_env":"MY_KEY",
       "model":"model-x","egress_mode":"premium-http"}'
```
