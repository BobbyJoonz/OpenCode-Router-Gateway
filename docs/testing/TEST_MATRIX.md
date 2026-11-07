# Test Matrix

| Area | Test file / command | Assertions | Status |
|---|---|---|---|
| Fresh install + migrations | `tests/fresh-db.test.ts` / `npm run test:fresh` | 11 | PASS |
| Anthropic translation | `tests/anthropic-adapter.test.ts` | 33 | PASS |
| Retention / storage | `tests/retention-tests.ts` | 13 | PASS |
| TPM + RPM admission | `tests/tpm-tests.ts` | 24 | PASS |
| Map-reduce | `tests/mapreduce-tests.ts` | 25 | PASS |
| Import side effects | `tests/import-side-effect.test.ts` | 1 | PASS |
| Core acceptance A–G | `tests/test-scenarios.ts` / `npm test` | scenarios | PASS |
| Service layer (keys, invites, status, privacy) | `tests/service-tests.ts` | 25 | PASS |
| Routing / aliases / providers | `tests/routing-tests.ts` | 32 | PASS |
| Gateway (auth, quotas, streaming, failover) | `tests/gateway-tests.ts` | 53 | PASS |
| Ops (metrics, alerts, concurrency, byte budget) | `tests/ops-tests.ts` | 32 | PASS |
| Windows E2E | `docs/testing/WINDOWS_E2E.md` | W01–W12 | PASS (see report) |
| Security | `docs/security/SECURITY_REVIEW.md` | S01–S12 | PASS |

Integration suites require a server with a seeded egress pool and `MOCK_KEY_A/B`;
they run against the **staging** instance (3010) so production data is untouched.

## Commands

```bash
npm run typecheck
npm run test:fresh && npm run test:anthropic && npm run test:retention \
  && npm run test:tpm && npm run test:mapreduce && npm run test:side-effects
GATEWAY_URL=http://127.0.0.1:3010 npm run test:service
GATEWAY_URL=http://127.0.0.1:3010 npm run test:routing
GATEWAY_URL=http://127.0.0.1:3010 npm run test:gateway
GATEWAY_URL=http://127.0.0.1:3010 npm run test:ops
```
