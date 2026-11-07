# Troubleshooting

## Startup

| Symptom | Cause | Fix |
|---|---|---|
| `SqliteError: no such table: model_prices` | pre-`c99732c` build on a fresh DB | upgrade to `c99732c`+ |
| `EROFS ... /bin/opencode-vpn` | launcher written into read-only `bin/` | set `OPENCODE_LAUNCHER_DIR=data/bin` (unit does) |
| `EADDRINUSE` on 12000+ | two instances share `pool_base_port` | give each instance its own base (`77cb3fd`) |
| `npm ci` EUSAGE | lockfile out of sync | `npm install` then commit the lock |

## Routing

| Symptom | Cause | Fix |
|---|---|---|
| `429` returned immediately, no failover | pre-`4992e43` classifier | upgrade |
| `x-model-resolved` differs from requested | alias maps to a provider-specific model | expected; visible in headers |
| `503 no_egress_node` | no slot passed the real probe | `POST /api/egress/probe`, check `probeOk` |
| `502 UPSTREAM_TIMEOUT` | slow tunnel / node | raise `gateway_upstream_timeout_seconds`; keep a fallback provider |

## Streaming

| Symptom | Cause | Fix |
|---|---|---|
| SDK hangs at end of stream | upstream omitted `[DONE]` | fixed in `f6632cb` |
| empty stream | upstream returned a non-SSE body | check `x-model-resolved` / provider |

## Access

| Symptom | Cause | Fix |
|---|---|---|
| `ssh -L` fails: `administratively prohibited` | server `AllowTcpForwarding no` | use Tailscale binding (as deployed) |
| `401` on `/api/*` | management requires `OPENCODE_ROUTER_API_KEY` | send `Authorization: Bearer <mgmt>` |
| `403` on every request | Host header not in allow-list | use the bind host / tailnet IP |

## Windows

| Symptom | Cause | Fix |
|---|---|---|
| `400 Bad Request` with an HTML body | PowerShell stripped JSON quotes | write body to a file, `--data-binary @file` |
| connection timeout | gateway bound to loopback only | bind the tailnet IP + set the API key |

## Diagnostics

```bash
systemctl status opencode-router-local
journalctl -u opencode-router-local -n 100 --no-pager
curl -s http://100.91.206.72:3011/v1/health
curl -s http://100.91.206.72:3011/api/doctor -H "authorization: Bearer <mgmt>"
curl -s http://100.91.206.72:3011/api/egress/status -H "authorization: Bearer <mgmt>"
```
