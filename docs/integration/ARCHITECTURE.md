# Unified Egress Architecture

```
Client (Windows / Harness / 9Router)
   │  OpenAI-compatible request + Bearer sk-or-…
   ▼
Gateway
   ├── auth + quotas + admission control
   ├── ModelRouter: alias → ordered providers (+ per-provider model)
   ├── ProviderRouter: pick provider, retry policy
   └── UpstreamClient: one request, one egress decision
          │
          ├── egress_mode = pool           → Xray slot (local SOCKS/HTTP inbound)
          ├── egress_mode = premium-http   → premium HTTP proxy (auth)
          └── egress_mode = premium-socks5 → local Xray bridge → premium SOCKS5
```

## Egress types

| Type | Implementation | Credentials |
|---|---|---|
| `pool` | `vpn/egress-pool.ts` → Xray slot (VLESS/VMess/Trojan/SS) | node URI (DB) |
| `premium-http` | `egress/premium-proxy.ts` → `ProxyAgent(http://user:pass@host:8443)` | env only |
| `premium-socks5` | `egress/premium-proxy.ts` → local Xray HTTP→SOCKS5 bridge on `127.0.0.1:12211` | env only |

`undici`'s `ProxyAgent` only speaks HTTP CONNECT, which is why SOCKS5 uses a bridge
instead of a native dispatcher. Nothing leaves the host except through the selected
egress.

## Per-provider selection

`providers.egress_mode` (migration `addColumnTo('providers','egress_mode')`):

```json
{ "name": "premium-http-egress", "egress_mode": "premium-http", ... }
```

A provider that asks for a premium egress but has no configured credentials fails
with `EGRESS_NOT_CONFIGURED` — it never silently falls back to the pool.

## Identity and observability

Every response carries `x-request-id`, `x-model-requested`, `x-model-resolved`,
`x-provider`, `x-provider-id`, `x-egress-node`, `x-attempts`, `x-fallback-used`.
When a premium egress is used, `x-egress-node` shows `premium-http` /
`premium-socks5` instead of a slot index.

## Separation of concerns

- `EgressManager` (pool + premium adapters) only moves bytes.
- Provider/account/model policy lives in the provider router.
- Health of the network (egress) and health of the provider (account) are reported
  separately: `GET /api/egress/status`, `GET /api/egress/premium`, `GET /api/providers`.
