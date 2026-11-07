# Windows E2E

Client: Windows 11 · `curl.exe` · Tailscale (`100.70.93.58`)
Gateway: `http://100.91.206.72:3011` (tailnet only) · commit `77cb3fd`+

## Contract used by the client

```
Base URL: http://100.91.206.72:3011/v1
API Key : sk-or-…   (issued by POST /api/keys)
Model   : deepseek-v4.1-flash-free   (alias, resolved per provider)
```

## Results

| ID | Test | Expected | Actual |
|---|---|---|---|
| W01 | `GET /v1/health` | 200 ok | 200 `{status:ok, ready_slots:2}` |
| W02 | `GET /v1/models` with key | list | 69 ids |
| W03 | `POST /v1/chat/completions` wrong key | 401 | 401 |
| W04 | Non-streaming completion | 200 + marker | **200**, content `E2E-A7E5F932`, usage 2135/12/2147 |
| W05 | Streaming completion | SSE + `[DONE]` | 4 data lines, `delta.content=STREAM-E2E-A7E5F932`, `[DONE]` present |
| W06 | OpenAI SDK shape | fields present | `id, object, created, model, choices, usage` all present |
| W07 | Harness | contract compatible | uses the same `/v1/chat/completions` shape |
| W08 | 9Router as client | compatible | same OpenAI contract (no provider touched) |
| W09 | Server restart | reconnect | service restarted, next request 200 |
| W10 | Tailscale down | clean error | connection refused (no hang) |
| W11 | Client key on `/api/*` | 401 | 401 |
| W12 | Concurrent requests | no errors | 6 sequential + 3 concurrent: all 200 |

## Primary test (no fallback)

Providers 9 and 13 were disabled so only the egress-rotated provider could answer:

```
POST /v1/chat/completions   model=deepseek-v4.1-flash-free
→ HTTP 200
  model: gemini-3.8-flash-n
  content: E2E-A7E5F932          (unique marker matched)
  usage: 2135 / 12 / 2147
  headers: x-request-id, x-model-requested=deepseek-v4.1-flash-free,
           x-model-resolved=ag/gemini-3.8-flash, x-provider=9router-fallback,
           x-provider-id=10, x-egress-node=1, x-attempts=1, x-fallback-used=0
```

Server-side row (same request id):

```
usage_log id=118 status=200 provider_id=10 egress_node_id=1 total_tokens=2147
```

## Fallback test (explicit)

With OpenCode Zen enabled again:

```
→ HTTP 200
  x-model-resolved: ag/gemini-3.8-flash
  x-provider: 9router-fallback   x-provider-id: 10
  x-attempts: 2                  x-fallback-used: 1
  x-egress-node: 1
```

The substitution is explicit in both the response headers and `usage_log`.

## PowerShell note

Passing JSON inline to `curl.exe` from PowerShell strips quotes and yields a 400.
Write the body to a UTF-8 file and use `--data-binary "@file"` (documented here
because it caused a false failure during testing).
