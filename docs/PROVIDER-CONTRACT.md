# Real-provider contract test — how to close gap #2

Everything else in this repository is validated against a **mock**. This is the
only suite that talks to a real provider through a real egress slot, and it is
what turns "should work" into "does work".

## Run it

```bash
PROVIDER_TEST_BASE_URL=https://api.openai.com/v1 \
PROVIDER_TEST_API_KEY=sk-... \
PROVIDER_TEST_MODEL=gpt-4o-mini \
npm run test:provider
```

Any OpenAI-compatible endpoint works (OpenAI, Groq, Together, OpenRouter, a local
vLLM, …). Without the variables the suite prints `SKIP` and exits 0, so it never
breaks a normal CI run.

### What it costs

One non-streaming call with `max_tokens: 16`, one tiny streaming call, one bad-model
call and one `GET /models`. On `gpt-4o-mini` this is a fraction of a cent.

## What it proves

| Check | Why it matters |
|---|---|
| egress slot starts and is acquired | the Xray path works with this machine's binary |
| `GET /models` → 2xx JSON | base URL, auth header and proxy chain are correct |
| `POST /chat/completions` → 2xx with `choices[0].message` | the core contract |
| `usage.prompt_tokens` present | token quotas can be enforced |
| stream emits `data:` and `[DONE]` | SSE framing matches what clients expect |
| stream contains `"usage"` | **the critical one** — providers that ignore `stream_options.include_usage` break streaming quotas |
| bad model returns 4xx with a recognizable error | body-aware error classification works against a real provider |

## Reading failures

| Symptom | Meaning |
|---|---|
| `egress slot started` fails | no configs in `data/`, or `bin/xray` missing/unrunnable |
| `GET /models` 401/403 | key or base URL wrong |
| `stream reports usage` fails | that provider does not honour `stream_options.include_usage`; streaming requests will not count tokens |
| everything 2xx but usage is 0 | provider returns usage only on non-streaming; use the non-stream path or another provider |

## In CI

`.github/workflows/ci.yml` has a manual `provider-contract` job. Add three
repository secrets and run it from the Actions tab:

- `PROVIDER_TEST_BASE_URL`
- `PROVIDER_TEST_API_KEY`
- `PROVIDER_TEST_MODEL`

Run it **after** any change to `gateway/`, `providers/` or `vpn/`, and once before
you announce the service.
