# Egress Pool

Each slot is an independent Xray process with its own SOCKS/HTTP inbound and its own
node. Slots are loopback-only; clients never reach them directly.

## Slot lifecycle

```
pickCandidate() → startSlot() → ready → acquire() → track() → release()
                        ↑                                   │
                        └── rotateSlot() ← penalize() ←──────┘
```

- **Candidate tiers:** working → TCP-alive → untested → any (never dead-end).
- **Watchdog:** replaces slots whose process or ports vanished.
- **Memory guard:** refuses to spawn another Xray when RSS exceeds `pool_max_rss_mb`.

## Ports

`pool_base_port + 2i` (SOCKS) and `pool_base_port + 2i + 1` (HTTP).
Changing `pool_base_port` recreates the slots (commit `77cb3fd`). Two instances on
one host **must** use different bases — the staging instance uses 12100, the working
one 12000.

## Real probe (commit `cf5ee56`)

`probeAll()` issues a real HTTP GET through every slot to `egress_probe_url`
(production: `https://opencode.ai/zen/v1/models`).

| Result | Meaning |
|---|---|
| 2xx / 3xx / 4xx (except 403) | the IP reached the target |
| 403 | Cloudflare / WAF block — not usable |
| 5xx / timeout / reset | node is dead for this target |

`acquire()` only returns slots whose `probeOk !== false`; if none passed it falls
back to the full ready set so the pool never dead-ends.

Settings: `egress_probe_url`, `egress_probe_timeout_ms`,
`egress_probe_interval_seconds` (300 in production), `egress_probe_rotate_on_fail`.

## Node health is not provider health

A node can be alive and reach Cloudflare but be blocked by a specific provider.
The probe target must therefore be the provider the gateway actually uses.
