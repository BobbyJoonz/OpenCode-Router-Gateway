# Roadmap — what separates "ready" from "product"

The readiness gate for the two supported scenarios is in
[READINESS.md](READINESS.md). This file lists everything *beyond* that gate.

Status legend: ✅ done · 🟡 partial · ⬜ not started

---

## Axis D — validity of the premise (the binding constraint)

| Phase | Goal | Status |
|---|---|---|
| D1 | Rotation experiment: does IP rotation actually reset the rate limit? | 🟡 harness done, **real-mode run not executed** |
| D2 | IP freshness instrumentation (`requests_before_429`, `freshness_score`) | ✅ |
| D3 | Own clean IP inventory (≥ 50 dedicated IPs) | ⬜ |
| D4 | Independent providers (free / cheap / primary) with failover | ✅ |
| D5 | Cost model + spend caps in dollars | ✅ |

**Kill criterion:** if the real-mode D1 run shows clean rotation beating a pinned IP
by less than 1.5×, the "rate-limit bypass" premise is refuted and the project should
be positioned as a multi-provider router instead.

Run it with a real key:

```bash
npx tsx tools/rotation-experiment/run.ts --mode real \
  --base-url https://api.openai.com/v1 --model gpt-4o-mini \
  --requests 200 --windows 3 \
  --arm-a-proxy http://vps-1:8080 \
  --arm-b-file clean-proxies.txt \
  --arm-c-file public-proxies.txt
```

---

## Axis C — product / service

| Phase | Goal | Status |
|---|---|---|
| C1 | Multi-slot egress pool | ✅ |
| C2 | Per-key routing policy and stickiness | ✅ |
| C3 | Money: prices, spend caps, usage cost | ✅ |
| C4 | Abuse detection and throttling | ✅ |
| C5 | Self-serve onboarding | 🟡 API-level; no portal UI |
| C6 | Customer observability (status page, alerts) | ✅ |
| C7 | High availability (2+ instances, shared state) | ⬜ SQLite is single-writer |
| C8 | Legal baseline (ToS / Privacy / DPA / retention) | ✅ documents; not legally reviewed |

---

## Axis B — personal reliability

| Phase | Goal | Status |
|---|---|---|
| B1 | Automatic failover of a dead slot | ✅ |
| B2 | Rotation without cutting in-flight streams | ✅ (drain) |
| B3 | Per-client stickiness | ✅ |
| B4 | Diagnostic UX (why did a node fail?) | 🟡 status endpoints + doctor |
| B5 | Packaging (one-command install, Windows) | 🟡 scripts exist; not verified on clean hosts |
| B6 | Extra import formats (Clash, sing-box) | 🟡 structured importers; not exhaustive |

---

## Axis A — engineering

| Phase | Goal | Status |
|---|---|---|
| A1 | CI on every PR (3 OS, typecheck, all suites) | ⬜ no test workflow yet |
| A2 | Graceful shutdown and lifecycle | ✅ |
| A3 | Observability (structured logs, metrics, tracing) | 🟡 metrics in pool status; no Prometheus/OTel |
| A4 | Real-provider contract test | ✅ `npm run test:provider` (requires a key) |
| A5 | Load and soak tests | 🟡 k6 script added; not run |
| A6 | Package boundaries (engine / gateway / dashboard) | 🟡 single tree, `tools/` added |

---

## Recommended order

1. **D1 real run** — one hour, decides everything else.
2. **A1 + A5** — CI and a real load run; cheap, prevents regressions.
3. **C7** — only if you intend to serve more than one host.
4. **D3** — only if D1 is a GO.
