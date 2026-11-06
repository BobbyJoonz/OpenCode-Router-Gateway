# Routing: which model, which provider, which egress IP

There are **two independent routing layers**. Confusing them is the most common
mistake, so they are documented separately.

```
client request { model: "fast" }
        │
        ▼
┌─────────────────────────────┐
│ 1. MODEL ROUTING            │  alias -> (provider, upstream model name)
│    model_routes             │  fallback order = route priority
└─────────────┬───────────────┘
              ▼
┌─────────────────────────────┐
│ 2. PROVIDER POLICY          │  priority | cost | round_robin
│    (only when no route)     │  failover on 5xx / network / 404
└─────────────┬───────────────┘
              ▼
┌─────────────────────────────┐
│ 3. EGRESS SWITCHING         │  sticky | round_robin | least_loaded | random
│    egress_policy            │  failover on death, rotate on 429
└─────────────────────────────┘
```

---

## 1. Model selection

### Aliases

A route maps a **public alias** to a provider and the model name that provider
expects:

```bash
curl -X POST http://127.0.0.1:3000/api/models -H 'content-type: application/json' -d '{
  "alias": "fast",
  "providerId": 1,
  "upstreamModel": "gpt-4o-mini",
  "priority": 1
}'

curl -X POST http://127.0.0.1:3000/api/models -H 'content-type: application/json' -d '{
  "alias": "fast",
  "providerId": 2,
  "upstreamModel": "openai/gpt-4o-mini",
  "priority": 2
}'
```

A client then sends `{"model":"fast"}` and gets:

- provider 1 first, with the body rewritten to `model: gpt-4o-mini`
- on **404** (that provider does not host it), provider 2, rewritten to
  `openai/gpt-4o-mini`
- on **5xx / timeout / network error**, the next provider as well

`GET /v1/models` lists the aliases, so clients discover them automatically.

### Strict mode

| `gateway_require_model_route` | Behaviour for an unrouted model |
|---|---|
| `false` (default) | passthrough: sent unchanged to the policy-selected provider |
| `true` | `404 model_not_found` — no accidental cross-provider calls |

### Why aliases and not raw model names

Raw names break as soon as two providers name the same model differently, or when
one provider is removed. An alias is stable for the client; the operator changes
targets underneath.

---

## 2. Provider policy

Setting: `gateway_provider_policy`

| Value | Order |
|---|---|
| `priority` (default) | lowest `priority` number first |
| `cost` | cheapest input price first, priority as tie-break |
| `round_robin` | rotate through the healthy set |

**When it switches provider:**

| Event | Action |
|---|---|
| HTTP 5xx | next provider (if any) |
| network error / timeout | next provider |
| HTTP 404 **and** a model route is active | next mapped provider |
| HTTP 429 | returned to caller — caller rotates the **egress**, not the provider |
| HTTP 401 / 403 | returned as-is; never rotate (auth is not a network problem) |

---

## 3. Egress switching

Setting: `egress_policy`

| Value | Selection rule |
|---|---|
| `sticky` (default) | each API key is pinned to one slot; new keys get the least-loaded slot |
| `least_loaded` | slot with the fewest in-flight requests, ties broken by oldest |
| `round_robin` | every acquire advances a cursor across ready slots |
| `random` | uniform random over ready slots |

**When it switches slot:**

| Trigger | Mechanism |
|---|---|
| Slot process died / tunnel probe failed | watchdog → `failoverSlot` → next candidate, in-flight streams drain |
| HTTP 429 from upstream and `gateway_rotate_on_429=true` | caller → `penalize(slot)` → retry on another slot (once) |
| Manual | `POST /api/egress/rotate/:slot`, `POST /api/egress/failover/:slot` |
| No ready slot | `acquire` runs `ensureAll()`; if still none → `503 no_egress_node` |
| Sticky key's slot leaves the ready set | next acquire re-pins to another slot |

**What does NOT switch:** HTTP 401/403 (auth), 4xx client errors, and a single
failed request with `gateway_rotate_on_429=false`.

---

## 4. Inspecting the current state

```bash
curl -s http://127.0.0.1:3000/api/models      | jq .routes
curl -s http://127.0.0.1:3000/api/providers   | jq .routing
curl -s http://127.0.0.1:3000/api/egress/status | jq '{policy, capacity, ready, size}'
```

`/api/egress/status` reports `policy`, `capacity` (`full|reduced|none`) and the
per-slot `totalRequests` — enough to verify that `round_robin` actually spreads
traffic.

---

## 5. Recommended configurations

| Scenario | model routes | provider policy | egress policy |
|---|---|---|---|
| Personal, one provider | none | `priority` | `sticky` |
| Team, one provider | aliases for stable names | `priority` | `sticky` |
| Team, free + paid providers | aliases → free first, paid second | `priority` | `sticky` |
| Many short requests | none | `priority` | `round_robin` |
| Latency-sensitive | aliases to the fast provider | `cost` or `priority` | `least_loaded` |

---

## 6. Limitations

- One alias can point at many providers, but there is **no per-request provider
  choice** from the client — the route order decides.
- `kind` is effectively OpenAI-shaped only; Anthropic-style upstreams need a
  translation adapter (not implemented).
- The egress policy is global, not per key. A future `key.egress_policy` column
  would allow per-tenant policies.
