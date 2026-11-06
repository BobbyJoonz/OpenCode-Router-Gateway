# Readiness guide — the two supported scenarios

This project is certified for exactly two operating modes. Anything beyond them
(public service, paid multi-tenant, HA cluster) needs the phases listed in
`docs/ROADMAP.md` and is **not** covered here.

---

## Scenario A — Personal use (one machine, private subscription, a few hundred requests/day)

### What "ready" means

| Requirement | Target | How it is verified |
|---|---|---|
| Egress pool | all slots ready | `npm run doctor` → `egress_pool  N/N slots ready` |
| Node inventory | ≥ 5 working nodes from **your own** subscription | `npm run doctor` → `working` count |
| Xray binary | present and runnable | `doctor` → `xray` check |
| Upstream | configured with your key | `doctor` → `upstream_config` |
| Live chain | one real completion succeeds | `npm run doctor:live` |
| Backup | a verified snapshot exists | `npm run backup` → `verify: OK` |

### Checklist

```bash
# 1. install
npm install && npm run build:frontend

# 2. configure
cp .env.example .env
#   GATEWAY_UPSTREAM_BASE_URL=https://api.openai.com/v1
#   GATEWAY_UPSTREAM_API_KEY=sk-...
#   GATEWAY_UPSTREAM_MODEL=gpt-4o-mini

# 3. start
npm start

# 4. import YOUR subscription (not the seeded public lists)
curl -X POST http://127.0.0.1:3000/api/sources \
     -H 'content-type: application/json' \
     -d '{"name":"mine","url":"https://your-provider/sub"}'
curl -X POST http://127.0.0.1:3000/api/sources/refresh-all

# 5. screen and verify
curl -X POST http://127.0.0.1:3000/api/configs/prescreen
curl -X POST http://127.0.0.1:3000/api/workflow/start -H 'content-type: application/json' -d '{}'

# 6. bring the pool to full capacity
curl -X POST http://127.0.0.1:3000/api/egress/ensure

# 7. gate on readiness
npm run doctor:live      # must print READY with a live call
```

Then create one key and point your client at it:

```bash
curl -X POST http://127.0.0.1:3000/api/keys \
     -H 'content-type: application/json' -d '{"name":"laptop","rpmLimit":60}'
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:3000/v1", api_key="sk-or-...")
```

### Daily habits

- `npm run backup` once a day (keeps the last 10, verified).
- `npm run doctor` after every machine restart.
- If `doctor` says `reduced` or `none`: `POST /api/egress/ensure`, then refresh
  the subscription and re-run the workflow.

### Known limits in this mode

- One machine, one SQLite file. Do not run two instances against the same data dir.
- A dead node mid-stream cuts that one stream; the next request goes to a healthy slot.
- Public free subscriptions are not supported at this quality bar — use your own.

---

## Scenario B — Small internal team (own provider key, a handful of users)

Everything from Scenario A, plus the items below.

### What "ready" means

| Requirement | Target | How it is verified |
|---|---|---|
| Real-provider contract | non-stream + stream + usage + 4xx all pass | `npm run test:provider` (with `PROVIDER_TEST_*`) |
| Multi-user isolation | per-key quotas and spend caps enforced | `npm run test:service` |
| Concurrency | 50 concurrent requests, zero 5xx | load test (§ below) |
| Cost accounting | `cost_usd > 0` recorded per request | `sqlite3 … "SELECT SUM(cost_usd) FROM usage_log"` |
| Remote access | management API never public | Caddyfile: `/api/*` localhost only |
| Recovery | server restarts cleanly, pool self-heals | `systemctl restart` + `doctor` |

### Checklist (on top of Scenario A)

```bash
# 1. prove the real provider contract (the only test a mock cannot replace)
PROVIDER_TEST_BASE_URL=https://api.openai.com/v1 \
PROVIDER_TEST_API_KEY=sk-... \
PROVIDER_TEST_MODEL=gpt-4o-mini \
npm run test:provider

# 2. seed prices so spend caps actually work
#    (a model missing from model_prices records cost_usd = 0)
curl -s http://127.0.0.1:3000/api/prices

# 3. one key per person, with caps
curl -X POST http://127.0.0.1:3000/api/keys -H 'content-type: application/json' \
  -d '{"name":"alice","rpmLimit":120,"dailyTokenLimit":2000000,"spendCapUsdDaily":5}'

# 4. expose only /v1 through TLS
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo DOMAIN=api.example.com systemctl reload caddy
```

### Concurrency check

```bash
# 50 concurrent requests for 10 minutes; watch for 5xx and pool churn
k6 run tools/load/k6-gateway.js \
  -e BASE_URL=https://api.example.com/v1 \
  -e API_KEY=sk-or-... \
  -e MODEL=gpt-4o-mini
```

Acceptance: `http_req_failed < 0.1%`, no slot stuck, memory growth < 5%.

### Operating rules for a team

1. **Never expose `/api/*`.** It can mint keys and stop the engine. The provided
   Caddyfile enforces loopback-only access; reach it via SSH tunnel.
2. **One key per person**, always with an RPM limit and a spend cap.
3. **Back up daily** and before every upgrade: `npm run backup`.
4. **Watch `capacity`** in `/api/egress/status`; `reduced` means fewer egress IPs
   than configured — fix before it becomes `none`.
5. **Rotate keys** when someone leaves: `DELETE /api/keys/:id`.
6. **Re-run `test:provider`** after changing provider, model or region.

### Known limits in this mode

- Single-process SQLite: one host only. Two instances require the Postgres work in
  `docs/ROADMAP.md` (not implemented).
- No self-serve portal; keys are issued through the management API.
- Spend caps are only as accurate as `model_prices`.

---

## What is explicitly NOT supported

| Use case | Why | Required work |
|---|---|---|
| Public / paid API service | no HA, no billing, no abuse SLA | ROADMAP phases C7, D5 |
| Many simultaneous tenants | single SQLite writer | Postgres + stateless gateway |
| Public free subscriptions at volume | measured 10–20% liveness, shared exit IPs | dedicated IP inventory (D3) |
| Anthropic-shaped upstreams | no request/response translation | provider adapters |
| Windows as a server | supported for personal use only | systemd-equivalent service |

---

## One-line readiness gate

```bash
npm run doctor:live && echo "CERTIFIED READY" || echo "NOT READY"
```
