# Test Results

- **Commit:** `77cb3fd` (+ traceability commit)
- **Host:** staging instance `127.0.0.1:3010`, Node v22.23.1
- **Date:** 2026-11-07

## Suites

| Suite | Command | Passed | Failed |
|---|---|---|---|
| typecheck | `npx tsc --noEmit` | 0 errors | 0 |
| fresh install | `tsx tests/fresh-db.test.ts` | 11 | 0 |
| anthropic | `tsx tests/anthropic-adapter.test.ts` | 33 | 0 |
| retention | `tsx tests/retention-tests.ts` | 13 | 0 |
| tpm/rpm | `tsx tests/tpm-tests.ts` | 24 | 0 |
| map-reduce | `tsx tests/mapreduce-tests.ts` | 25 | 0 |
| side effects | `tsx tests/import-side-effect.test.ts` | 1 | 0 |
| service | `GATEWAY_URL=… tsx tests/service-tests.ts` | 25 | 0 |
| routing | `GATEWAY_URL=… tsx tests/routing-tests.ts` | 32 | 0 |
| gateway | `GATEWAY_URL=… tsx tests/gateway-tests.ts` | 53 | 0 |
| ops | `GATEWAY_URL=… tsx tests/ops-tests.ts` | 32 | 0 |
| **total** | | **249** | **0** |

## Live checks

| Check | Result |
|---|---|
| `/v1/health` | 200 `{status:ok, ready_slots:2}` |
| `/v1/models` with key | 69 model ids |
| `/v1/models` wrong key | 401 |
| `/metrics` | Prometheus text, no NaN/undefined |
| Egress probe (OpenCode target) | slot0 200/1011 ms · slot1 200/1062 ms |
| Egress probe (403 target) | both `probeOk:false` → excluded |
| Slot exit IPs | `2a01:4f8:c010:7c7a::1` (DE) · `91.107.168.85` (DE) |
| Port collision | none after `77cb3fd` (12000-12003 vs 12100-12103) |

## Failures encountered and resolved during the audit

| # | Failure | Root cause | Resolution |
|---|---|---|---|
| 1 | two instances shared egress ports | `init()` ignored `pool_base_port` changes | base-port tracking (`77cb3fd`) |
| 2 | silent model substitution | no request/resolved trace | headers + `usage_log` columns |
| 3 | 429 did not fail over | classifier said `retryProvider:false` | `4992e43` |
| 4 | streaming lacked `[DONE]` | upstream omits it | synthesised (`f6632cb`) |
| 5 | `/v1/models` synthetic | upstream skipped without provider rows | fetch catalogue (`f6632cb`) |
| 6 | `500` on completion | `cost_per_1m_in` column mismatch | canonical columns (`aa09cfd`) |
| 7 | fresh install crash | `model_prices` never created | `c99732c` |
| 8 | `EROFS` launcher | wrote into read-only `bin/` | `OPENCODE_LAUNCHER_DIR` |
| 9 | `npm ci` failure | lockfile out of sync | regenerated |
| 10 | shallow pool health | process/port only | real probe (`cf5ee56`) |

No unresolved test failure remains in the deterministic suites.
