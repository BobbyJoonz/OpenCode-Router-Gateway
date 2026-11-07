# Windows E2E

Client: Windows 11, `curl.exe`, Tailscale (`100.70.93.58`).
Gateway: `http://100.91.206.72:3011` (tailnet only), commit `344e367`.

## Contract

```
Base URL : http://100.91.206.72:3011/v1
API Key  : sk-or-…  (issued by POST /api/keys)
Model    : any id from GET /v1/models
```

## Results

| ID | Test | Expected | Actual |
|---|---|---|---|
| W01 | `GET /v1/health` | 200 | 200 `{status:ok, ready_slots:2}` |
| W02 | `GET /v1/models` with key | list | 69 ids (10 free-looking) |
| W03 | wrong key | 401 | 401 |
| W04 | non-stream completion | 200 + marker | **200**, content = unique marker |
| W05 | streaming completion | SSE + `[DONE]` | 4 data lines, delta content, `[DONE]` |
| W06 | OpenAI SDK field shape | present | `id, object, created, model, choices, usage` |
| W07 | Harness contract | compatible | same `/v1/chat/completions` shape (not driven here) |
| W08 | 9Router as client | compatible | same contract; providers untouched |
| W09 | server restart | reconnect | service restarted, next request 200 |
| W10 | Tailscale down | clean error | connection refused, no hang |
| W11 | client key on `/api/*` | 401 | 401 |
| W12 | concurrency | no errors | 6 sequential + 3 concurrent: all 200 |

## Trace evidence (non-stream, real request)

```
HTTP 200
x-request-id:      378c0f3e-fd16-46aa-84dc-549767c32f86
x-model-requested: deepseek-v4.1-flash-free
x-model-resolved:  ag/gemini-3.8-flash
x-provider:        9router-fallback   (id 10)
x-egress-node:     1
x-attempts:        2
x-fallback-used:   1
usage_log id=122:  provider_id=10 egress_node_id=1 attempts=2 fallback_used=1 tokens=2144
```

## Premium egress from Windows

Not driven from Windows directly (the premium proxy is selected per provider on the
server); verified server-side and through the gateway (`NETWORK_TEST_RESULTS.md` G02,
G03). A Windows client benefits automatically when it requests an alias mapped to a
premium-egress provider.

## PowerShell note

Inline JSON to `curl.exe` is mangled by PowerShell quoting and produces `400`.
Always write the body to a UTF-8 file and use `--data-binary "@file"`.
