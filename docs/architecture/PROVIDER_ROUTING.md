# Provider Routing

## Selection order

1. `ModelRouter.plan(requestedModel)` resolves an alias to an ordered provider list
   and a per-provider upstream model (`model_routes`).
2. If the request names `provider/model`, that provider is pinned (`x-provider`).
3. `ProviderSelector.candidates()` filters: enabled, key present, not cooling down,
   TPM/RPM budget available; then orders by policy (`priority` | `cost` | `round_robin`).
4. `ProviderRouter.forward()` tries providers up to `gateway_max_provider_attempts`.

## Error policy (classifier: `gateway/upstream-errors.ts`)

| Upstream result | Kind | Try next provider | Rotate egress |
|---|---|---|---|
| 429 with quota wording | `quota` | **yes** | no |
| 429 (rate limit) | `rate_limit` | **yes** | yes |
| 401/403 | `auth` | no | no |
| 400/404 model missing | `model_missing` | yes | no |
| 5xx | `server` | yes | yes |
| network / timeout | `network` | yes | yes |
| context length | `context_length` | no | no |
| content filter | `content_filter` | no | no |

A quota error never rotates the egress IP: a new IP cannot reset an account limit
(verified: identical `Retry-After` from every exit IP).

## No silent substitution

Every response carries:

```
x-request-id: 3bf25c90-…
x-model-requested: deepseek-v4.1-flash-free
x-model-resolved: ag/gemini-3.8-flash
x-provider: 9router-fallback
x-provider-id: 10
x-egress-node: 1
x-attempts: 2
x-fallback-used: 1
```

and the same fields are stored in `usage_log` (`requested_model`, `resolved_model`,
`request_id`, `attempts`, `fallback_used`). A client can always tell which model and
provider actually answered.

## Configuration

| Setting | Meaning |
|---|---|
| `gateway_max_provider_attempts` | max providers per request (default 3) |
| `gateway_upstream_timeout_seconds` | per-attempt timeout (60 in production) |
| `egress_policy` | sticky / round_robin / least_loaded / random |
| `gateway_require_model_route` | reject unknown models instead of falling back |
