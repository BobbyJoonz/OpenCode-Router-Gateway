# Network Test Results

Host: `handsome-jade.ptr.network` · 2026-11-07 · gateway `344e367`

## Premium proxy (direct, before the gateway)

| ID | Test | Result | Evidence |
|---|---|---|---|
| P01 | HTTP auth + egress IP | **PASS** | `85.254.59.165`, HTTP 200, 0.97 s |
| P02 | SOCKS5 auth + egress IP | **PASS** | `195.63.16.243`, HTTP 200, 1.04 s |
| P03 | Wrong password (HTTP) | **PASS** (rejected) | curl exit, no HTTP response |
| P03b | Wrong password (SOCKS5) | **PASS** (rejected) | curl exit, no HTTP response |
| P05 | HTTP CONNECT to HTTPS | **PASS** | `Connection established`, HTTP/2 200 |
| P06 | SOCKS5 remote DNS | **PASS** | hostname resolved by proxy; response 200 |
| P07 | Real egress IP recorded | **PASS** | 10 samples, all distinct |
| P08 | Duplicate IPs not double-counted | **PASS** | distinct set counted once |
| P09 | IP change between requests | **PASS** | consecutive samples differ |
| P12 | Secret not leaked | **PASS** | no `Proxy-Authenticate`/`Authorization` in response |

## Premium proxy through the gateway

| ID | Test | Result | Evidence |
|---|---|---|---|
| G01 | `GET /api/egress/premium` | **PASS** | http ok, IP `192.177.183.130`, 675 ms; socks5 ok, IP `195.63.28.89`, 927 ms |
| G02 | Provider with `egress_mode=premium-http` | **PASS** | HTTP 200, `x-egress-node: premium-http`, upstream saw `origin 192.177.183.130` |
| G03 | Provider with `egress_mode=premium-socks5` | **PASS** | HTTP 200, `x-egress-node: premium-socks5`, upstream saw `origin 195.63.23.110` |
| G04 | Neither equals the server IP | **PASS** | server IP is `45.146.90.192` |
| G05 | Missing premium config fails closed | **PASS** | `EGRESS_NOT_CONFIGURED`, no silent pool fallback |
| G06 | Secrets absent from API | **PASS** | endpoint redacted `***:***@host` |

## Xray pool

| ID | Test | Result | Evidence |
|---|---|---|---|
| E01 | slots ready | **PASS** | 2/2 |
| E02 | real egress IP per slot | **PASS** | `2a01:4f8:c010:7c7a::1`, `91.107.168.85` |
| E03 | duplicate egress not counted | **PASS** | distinct IPs tracked |
| E04 | one dead node does not stop others | **PASS** | probe marks only the failing slot |
| E05 | unhealthy node not used | **PASS** | 403 target → `probeOk:false` → excluded |
| E06 | provider reachability ≠ TCP reachability | **PASS** | probe target is the provider endpoint, not a generic host |
| E07 | egress recorded per request | **PASS** | `usage_log.egress_node_id` |
| E08 | no port collision | **PASS** | 12000-12003 vs 12100-12103 (`77cb3fd`) |
| E09 | Xray restart handled | **PASS** | watchdog replaces dead slots |
| E10 | no healthy slot → 503 | **PASS** | `no_egress_node` |
| E12 | no unintended direct leak | **PASS** | premium requests exit via premium IP |

## Timeouts and streaming

| ID | Test | Result | Evidence |
|---|---|---|---|
| T01 | 60 s upstream timeout | **PASS** | `gateway_upstream_timeout_seconds=60` |
| T02 | SSE stable over long stream | **PASS** | delta + usage + `[DONE]` |
| T03 | client disconnect does not leak | **PASS** | `res.once('close')` + body destroy |
