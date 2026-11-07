# Provider Test Results

Gateway `344e367` · staging `127.0.0.1:3010` for suites, working `100.91.206.72:3011`
for live requests.

## Regression suites (staging)

| Suite | Passed | Failed |
|---|---|---|
| service | 25 | 0 |
| routing | 32 | 0 |
| gateway | 53 | 0 |
| ops | 32 | 0 |
| anthropic | 33 | 0 |
| retention | 13 | 0 |
| tpm/rpm | 24 | 0 |
| map-reduce | 25 | 0 |
| fresh-db | 11 | 0 |
| side-effects | 1 | 0 |
| **total** | **249** | **0** |

## Provider routing

| ID | Test | Result | Evidence |
|---|---|---|---|
| P01 | valid model → correct provider | **PASS** | `x-provider: 9router-fallback` |
| P02 | invalid model → no wrong provider | **PASS** | 404/429 passthrough, no substitution without trace |
| P03 | disabled provider gets no traffic | **PASS** | providers 9/13 disabled → only 10 served |
| P04 | bad credential → 401/403 | **PASS** | 401 returned, no retry storm |
| P05 | network failure → failover per policy | **PASS** | `x-attempts: 2` |
| P06 | fallback off → no other provider | **PASS** | single-provider test returned the provider's own error |
| P07 | fallback on → final provider logged | **PASS** | `x-provider`, `usage_log.provider_id` |
| P08 | alias cannot silently become another model | **PASS with caveat** | substitution is visible via `x-model-resolved` + `fallback_used`; strict mode not yet enforced |
| P09 | no provider for model → explicit error | **PASS** | `model_not_available` |
| P10 | `/v1/models` does not advertise unusable models | **PARTIAL** | catalogue is the upstream's real list; per-model usability is not probed |

## Real provider (authorised)

| ID | Test | Result | Evidence |
|---|---|---|---|
| R01 | non-stream completion | **PASS** | marker `FINAL-8F2B1D` returned |
| R02 | streaming completion | **PASS** | `delta.content` + usage + `[DONE]` |
| R03 | usage accounting | **PASS** | `usage_log` tokens 2144 |
| R04 | trace identity | **PASS** | request id, requested/resolved model, provider, egress, attempts |
| R05 | premium HTTP egress | **PASS** | origin `192.177.183.130` |
| R06 | premium SOCKS5 egress | **PASS** | origin `195.63.23.110` |

## OpenCode free tier

| ID | Test | Result | Evidence |
|---|---|---|---|
| F01 | free model catalogue | **PASS** | 10 free ids from `opencode.ai/zen/v1/models` |
| F02 | official CLI v2.2.6 free model | **FAIL (external)** | `Free usage limit reached. Connect a provider or subscribe to OpenCode Go` |
| F03 | direct API with Zen keys | **FAIL (external)** | `429 FreeUsageLimitError`, `Retry-After ≈ 59310 s`, identical from every egress IP and both keys |
| F04 | 403 FreeTierError classification | **PASS (classification)** | classified as provider policy, not a proxy error |
| F05 | no useless retries on quota | **PASS** | quota does not rotate egress |
| F06 | no mock answer under a free model name | **PASS** | substitution is explicit in headers |
| F07 | CLI success via another provider not counted as free | **PASS** | reported as authorised-provider success |

**Conclusion:** OpenCode free-tier access from a third-party gateway is
`BLOCKED_BY_PROVIDER_POLICY`. Reference projects confirm the gate inspects the CLI
wire identity (TLS fingerprint, UA, session, tool shape); forging that is out of
scope and forbidden. The gateway is fully functional with authorised providers.
