# Proxy Support Matrix

Measured on the server (2026-11-07) with `curl` and through the gateway.

| Type | Configured | Test | Result | Evidence |
|---|---|---|---|---|
| DIRECT (server IP) | — | `api.ipify.org` | PASS | `45.146.90.192` |
| Premium HTTP proxy (auth) | `PREMIUM_HTTP_PROXY_URL` | egress IP | **PASS** | `85.254.59.165` (direct curl), `192.177.183.130` (gateway) |
| Premium SOCKS5 proxy (auth) | `PREMIUM_SOCKS5_PROXY_URL` | egress IP | **PASS** | `195.63.16.243` (curl), `195.63.28.89` (gateway), `195.63.23.110` (provider e2e) |
| HTTP CONNECT to HTTPS | — | CONNECT | PASS | `HTTP/1.1 200 Connection established` |
| SOCKS5 remote DNS | — | `--socks5-hostname` | PASS | resolves via proxy, no local leak observed |
| Wrong password (HTTP) | — | auth | PASS (rejected) | connection fails, no request forwarded |
| Wrong password (SOCKS5) | — | auth | PASS (rejected) | connection fails |
| Rotation (per connection) | — | 10 requests | **PASS** | 10 distinct IPs across HTTP+SOCKS5 samples |
| Secret redaction | — | API response | PASS | endpoint shows `***:***@host` |
| Xray VLESS node | pool | real HTTPS | PASS | egress probe 200 in ~1s |
| Xray SOCKS/HTTP inbound | pool | proxy use | PASS | slots 12000-12003 |
| SOCKS5 bridge (local Xray) | — | probe | PASS | listens `127.0.0.1:12211` |

## Rotation sample

```
http  1: 195.63.16.132    socks 1: 195.63.27.62
http  2: 67.227.94.233    socks 2: 195.63.17.16
http  3: 195.63.17.242    socks 3: 217.181.81.239
http  4: 195.63.19.76     socks 4: 161.123.131.56
http  5: 195.63.0.199     socks 5: 217.181.83.123
```

Ten requests produced ten distinct exit IPs. The proxy rotates per connection; we do
**not** count one endpoint as many independent proxies — the count above is of
observed IPs.

## Not supported (honest)

| Type | Status | Reason |
|---|---|---|
| VMess / Trojan / Shadowsocks via premium proxy | BLOCKED | the premium service exposes HTTP + SOCKS5 only |
| Clash/Mihomo YAML import | BLOCKED | not implemented; subscription parser handles URI lists |
| Direct mode per provider | UNTESTED | `egress_mode` supports pool + premium only |
