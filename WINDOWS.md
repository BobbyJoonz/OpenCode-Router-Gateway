# Windows Support — OpenCode Router

OpenCode Router was built and verified for Ubuntu 24.04. This document describes the
Windows port that lives on this machine, the upstream bugs that had to be fixed to make it
work at all, and the exact steps to run it.

> Verified on Windows 11 (build 26300), Node v22.16.0, opencode 1.19.5, Xray-core v26.10.31.

---

## 1. Quick start (Windows)

```powershell
cd "D:\AAA\OpenCode Router\repo"

# one-time
npm install
npm run build:frontend

# every time
powershell -ExecutionPolicy Bypass -File .\start.ps1
# → http://localhost:3000
```

`start.ps1` downloads `bin\xray.exe` if missing (falls back to `gh-proxy.com` / `ghfast.top`
mirrors because GitHub is blocked in Iran), builds the frontend if needed, starts the backend
and opens the dashboard.

Manual equivalent:

```powershell
$env:PORT=3000
npx tsx src/backend/server.ts
```

### Using the proxy from OpenCode

```powershell
# interactive
.\bin\opencode-vpn.cmd

# one-shot prompt through the active proxy
.\bin\opencode-vpn.cmd run "Explain TypeScript generics" --pure
```

---

## 2. What was changed for Windows

| File | Change |
| :--- | :--- |
| `package.json` | Pinned `better-sqlite3` to `12.6.2` — v13 has no Windows prebuilt for Node 22 and node-gyp needs Visual Studio. |
| `src/backend/vpn/vpn-engine.ts` | Uses `bin/xray.exe` on win32 (+ `XRAY_BIN` env override); reliable process termination via `taskkill /PID /T /F` because `child.kill()` silently fails on detached Windows children; `isProcessAlive()` helper. |
| `src/backend/opencode/opencode-service.ts` | Cross-platform binary discovery (`OPENCODE_BIN`, npm's real `opencode.exe`, `where`); generates `bin/opencode-vpn.cmd` on Windows; reads proxy ports from DB settings instead of hardcoding 10808/10809. |
| `src/backend/security/file-guard.ts` | `fchmodSync` wrapped in try/catch (no POSIX bits on NTFS). |
| `src/backend/security/privilege-wizard.ts` | `getcap` / `/etc/sudoers.d` checks skipped on Windows; `bin/xray.exe` path. |
| `start.ps1` | New Windows launcher (mirrors `start.sh`). |
| `tests/*` | POSIX-only assertions (0700/0600 modes, symlink creation) skipped on Windows; launcher test updated for the SOCKS5 change. |

---

## 3. Upstream bugs found while getting a real end-to-end run

These are **not** Windows-specific — they affect the Linux build too.

### 3.1 `allowInsecure` is rejected by Xray-core v26 (blocks every TLS node)

`xray-config-builder.ts` emitted `tlsSettings.allowInsecure`. Xray ≥ v26 removed the field:

```
Failed to build TLS config. > The feature "allowInsecure" has been removed and migrated to
"pinnedPeerCertSha256"(pcs) and "verifyPeerCertByName"(vcn).
```

The whole config is refused, so **no TLS/Reality node can ever start**. `start.sh` pins
`Xray v26.10.31`, i.e. the shipped project is broken against its own pinned Xray.
Fix: the field is now omitted. Consequence: nodes that relied on skipping certificate
verification will fail the TLS handshake.

### 3.2 OpenCode's LLM runtime breaks with an HTTP(S) proxy — SOCKS5 is required

This is the single most important finding. With `http_proxy` / `https_proxy` set,
`opencode run` fails instantly:

```
stream error ... AI_APICallError: Cannot connect to API: ECONNREFUSED
```

while `opencode models` and plain `curl` through the same HTTP proxy work fine.
With `ALL_PROXY=socks5://127.0.0.1:<port>` the completion succeeds.

The project injected **both** `http_proxy` and `all_proxy`, so the HTTP proxy variable
poisoned the verification step and every candidate looked broken.
Fix: the verification process and both launchers now expose **only** SOCKS5 (`ALL_PROXY`)
and explicitly clear the HTTP proxy variables.

### 3.3 Success path crashed on a SQL double-quoted string

`connection-orchestrator.ts`:

```ts
last_status = "working"
```

Modern SQLite (better-sqlite3 v12+) disables double-quoted string literals, so this is parsed
as a column reference:

```
no such column: "working" - should this be a string literal in single-quotes?
```

The OpenCode verification had already succeeded, then the bookkeeping crashed and the workflow
reported `failed`. Fixed to single quotes.

### 3.4 Candidate ranking tests the wrong 25 nodes

`CandidateRanker` orders untested nodes by `id ASC`. The first 25 ids all come from one
subscription (`ermaozi`), and in a live measurement only **15.6 %** of the 3 825 discovered
nodes were TCP-reachable at all. The default `max_test_attempts = 25` therefore usually
exhausts without ever touching a healthy node. Recommendation: pre-screen TCP reachability
in bulk (200 concurrent sockets takes ~25 s for 3 825 nodes) and feed only survivors to the
state machine.

### 3.5 Discovery cannot bootstrap itself behind a firewall

`config-fetcher.ts` calls `fetch(url)` with no proxy/dispatcher support, and the seeded
sources are `raw.githubusercontent.com`. In Iran that host is unreachable, so discovery
returns 0 configs while the UI only shows "No candidate configurations available".
Workaround used here: replace each source URL with `https://gh-proxy.com/<original>` via
`POST /api/sources`. A proper fix is an `undici.ProxyAgent` dispatcher driven by an env var.

### 3.6 Default ports collide with v2rayN

v2rayN ships with local SOCKS/HTTP inbounds on `10808`/`10809` — exactly OpenCode Router's
defaults. `xray` then dies with `bind: Only one usage of each socket address`.
On this machine the settings were moved to `11808`/`11809`:

```js
// data/opencode-vpn.db, table settings
socks_port = 11808
http_port  = 11809
```

The launcher now reads these values from the DB, so it stays in sync.

---

### 3.7 WebSocket nodes fail because the default ALPN advertises `h2`

`xray-config-builder.ts` defaulted every TLS node to `alpn: ['h2', 'http/1.1']`.
WebSocket rides on HTTP/1.1, so CDN front-ends (Cloudflare) negotiate HTTP/2 and the
WebSocket upgrade then dies — the node looks dead even though TCP is fine.

Measured on a real batch: **0 of 9** Cloudflare `ws+tls` nodes worked before the fix,
**3 healthy + 5 with a working tunnel** after it. Fix: `defaultAlpn(network)` returns
`['http/1.1']` for `ws`, `['h2','http/1.1']` otherwise.

### 3.8 The OpenCode verification timeout was hardcoded to 15 s

`POST /api/configs/test-single` and `POST /api/vpn/test-current` both passed a literal `15`
while `opencode_timeout_seconds` (default 20) existed in settings and was only honoured by
the orchestrator. Free nodes are often slow enough to exceed 15 s: raising the setting to
30 s turned 5 more "failed" nodes into healthy ones. Both endpoints now read the setting.

---

## 4. Adding V2Ray configurations

Three input formats are now supported:

| Input | Supported | Where |
| :--- | :---: | :--- |
| Share links `vless://` `vmess://` `trojan://` `ss://` | ✅ | Sources → Refresh, or Configs → paste |
| Custom subscription URL (base64 or plain) | ✅ | Dashboard → Sources → Add Source |
| Full Xray/V2Ray client `config.json` | ✅ (new) | Configs → paste JSON, or `POST /api/configs/import` |
| `hysteria2://` `tuic://` `wireguard://` | ❌ | Xray-core has no such outbound; needs a different engine |

`src/backend/parser/xray-json-importer.ts` converts every proxy outbound of a client
`config.json` (vless / vmess / trojan / shadowsocks) into the internal config shape.
`freedom`, `blackhole` and `dns` outbounds are ignored. Both a single config object and an
array of configs are accepted.

Example:

```powershell
$json = Get-Content .\my-v2ray-config.json -Raw
Invoke-RestMethod -Uri http://127.0.0.1:3000/api/configs/import -Method Post `
  -ContentType 'application/json' `
  -Body (@{ rawText = $json; name = 'my config' } | ConvertTo-Json)
```

---

## 5. Verified result on this machine

```
tcp:      reachable, 91 ms
proxy:    success, 289 ms, egress IP 5.78.50.216 (direct IP 2.176.*.*)
opencode: SUCCESS — "OpenCode session established successfully."

workflow: phase=success
          Working connection activated: 🆔ar14n24b 🔒 VL-TCP- ❔ XX 115ms

launcher: .\bin\opencode-vpn.cmd run "..." → LAUNCHER_OK in 5.3 s
tests:    ALL ACCEPTANCE SCENARIOS (A - G) PASSED
```

---

## 6. Known limitations

- Free public nodes are mostly dead: 15.6 % TCP-reachable, and far fewer complete a TLS
  handshake. Expect to need a large, fresh subscription.
- `opencode run` through a slow free node can exceed the 15–18 s verification timeout.
- Account-level quota (`insufficient_quota`) cannot be fixed by switching IPs.
- NTFS cannot enforce 0600/0700; the app relies on the per-user profile for isolation.
