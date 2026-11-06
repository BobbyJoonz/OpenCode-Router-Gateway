---
title: "How to Fix OpenCode HTTP 429 Rate Limit Errors"
description: "Understand HTTP 429 errors in OpenCode. Distinguish IP-based gateway throttling from account quota limits, and configure automated proxy rotation."
---

# How to Fix OpenCode HTTP 429 Rate Limit Errors

When utilizing [OpenCode](https://github.com/anomaly/opencode) for AI-assisted coding on Linux, encountering an **HTTP 429 Too Many Requests** error is one of the most frustrating interruptions. This technical guide explains the underlying mechanisms of HTTP 429 errors, provides clear diagnostic rules to distinguish **IP-based rate limits** from **account-level quota exhaustion**, and explains how [OpenCode Router](https://github.com/EhsanCreator/OpenCode-Router) intelligently handles automated failover.

---

## 1. What Causes HTTP 429 in OpenCode?

HTTP status code `429 Too Many Requests` indicates that the client has sent too many requests in a given amount of time ("rate limiting"). However, in the context of LLM API gateways and coding assistants, rate limits stem from two fundamentally different origins:

```
                          HTTP 429 Error Occurs
                                    |
            +-----------------------+-----------------------+
            |                                               |
            v                                               v
[Origin A: IP-Based Gate Limit]           [Origin B: Account Quota Exhaustion]
- Enforced by Cloudflare / API Gateway     - Enforced by AI Provider Billing System
- Keyed to: Client Public IP Address       - Keyed to: API Key / User Token Account
- Common on: Free-tier / Shared Endpoints  - Common on: Paid Tier / Token-Capped Plans
- Solvable by changing Egress IP: YES      - Solvable by changing Egress IP: NO
```

### Origin A: IP-Based Gateway Throttling
Public and free-tier LLM endpoints (e.g., shared endpoints hosted by platforms or CDN edge nodes) enforce strict per-IP rate limits to prevent denial-of-service and scraping. If your ISP assigns a shared egress IP (CGNAT) or multiple developers in your network share an egress point, your requests may trigger an IP-level rate limit even if your personal usage was minimal.

### Origin B: Account-Level / Token-Quota Exhaustion
Commercial providers (such as Anthropic, OpenAI, or DeepSeek API) meter usage based on **Tokens Per Minute (TPM)**, **Requests Per Minute (RPM)**, or overall monthly credit balances. When your API key exhausts its allowed quota:
- The server responds with `429 Too Many Requests`.
- The response payload contains messages such as `"insufficient_quota"`, `"monthly limit exceeded"`, or `"token budget exhausted"`.
- **Changing your IP address will NOT resolve this error**, because the restriction is bound to your authentication key, not your network address.

---

## 2. Diagnosing Your Rate-Limit Type

To determine whether an IP rotation will solve your issue, inspect the error payload returned by OpenCode:

### Test Case 1: Checking Raw API Response
Execute your prompt with verbose debugging:
```bash
DEBUG=* opencode run "Hello" 2>&1 | grep -i "429" -A 5 -B 2
```

### Interpretation Matrix

| Response Payload / Body Indicator | Rate-Limit Category | Solvable by IP Rotation? |
| :--- | :--- | :---: |
| `Rate limit reached for IP` | IP-Based Gateway Limit | **Yes** |
| `Too many requests from this address` | CDN Edge Throttling | **Yes** |
| `Cloudflare 1015: You are being rate limited` | CDN Edge Throttling | **Yes** |
| `insufficient_quota` | Account / Token Quota | **No** (Requires billing top-up) |
| `exceeded your current quota` | Account / Token Quota | **No** (Requires billing top-up) |
| `invalid_api_key` | Authentication Failure | **No** (Requires valid credential) |

---

## 3. How OpenCode Router Handles HTTP 429 Errors

[OpenCode Router](https://github.com/EhsanCreator/OpenCode-Router) contains a dedicated **Error Classification Engine** (`src/backend/opencode/error-classifier.ts`) designed specifically to avoid useless rotation loops.

### The Deterministic Decision Pipeline

1. **Detection**: When an OpenCode verification prompt or live session exits with a failure, the engine inspects both the process exit code and the stderr/stdout string buffer.
2. **Classification**:
   - If the error matches account-level tokens (`insufficient_quota`, `credit exhausted`, `invalid_api_key`), the orchestrator **halts rotation immediately** and informs the developer:
     ```text
     [Classification] Account quota exhausted or authentication failure.
     Halting rotation. IP change cannot resolve account billing limits.
     ```
   - If the error matches an IP-based throttle or network drop, the orchestrator classifies it as `RATE_LIMIT (IP-based)` and automatically activates the next highest-ranked proxy node.
3. **Seamless Activation**: The new node is started in Xray-core, verified via egress reflection probe, and locked into `bin/opencode-vpn`.

```bash
# Verify connection through the newly rotated IP node
bin/opencode-vpn run "What is 2+2? Answer in one word." --pure
```

---

## 4. Practical Workarounds for Account Quota Limits

If your rate limit is account-level rather than IP-based:
1. **Reduce Prompt Context**: Avoid piping entire giant repositories into a single prompt. Use targeted line ranges and concise queries.
2. **Switch Models**: OpenCode supports switching models via configuration. If your primary model is throttled, switch to a backup model in `~/.config/opencode/opencode.json`:
   ```json
   {
     "defaultModel": "opencode/deepseek-v4.1-flash-free"
   }
   ```
3. **Add Multiple API Keys**: Configure fallback provider keys in OpenCode's configuration.

---

## 5. Frequently Asked Questions (FAQ)

### Can OpenCode Router give me free unlimited tokens?
**No.** OpenCode Router is an intelligent network routing and proxy manager, not a token bypass tool. It routes network traffic to bypass regional ISP blocks and IP-based rate limiting on public endpoints. It cannot alter or bypass provider billing systems.

### How quickly does OpenCode Router switch nodes when rate-limited?
The automated testing and failover cycle typically evaluates TCP handshake latency, proxy handshake, and verification prompt completion within **8 to 15 seconds** before locking into a working node.

---

## 6. Related Articles
- [How to Fix OpenCode Network Errors on Linux](fix-opencode-network-errors-linux.md)
- [How to Configure a Proxy for OpenCode CLI](configure-proxy-opencode-cli.md)
- [How to Use Xray with OpenCode on Ubuntu](use-xray-with-opencode-ubuntu.md)
- [OpenCode Proxy vs. System-Wide VPN: Understanding the Differences](opencode-proxy-vs-system-vpn.md)
