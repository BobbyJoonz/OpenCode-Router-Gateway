# Keyword Research & Search Intent Mapping: OpenCode Router

**Project**: OpenCode Router  
**Author**: Ehsan Shahriyari ([@EhsanCreator](https://github.com/EhsanCreator))  
**Target Release**: v1.0.0  
**Verified Platform**: Ubuntu 24.04 LTS (64-bit x86_64)  

---

## 1. Methodology & Data Disclosure

Search query analysis for specialized developer tools requires identifying the precise vocabulary used by programmers experiencing runtime failures.

> [!IMPORTANT]
> **Data Integrity Disclosure**: Public search-volume databases (e.g., Ahrefs, SEMrush) do not provide granular, statistically reliable volume for niche open-source CLI keywords. The keywords and search intents documented in this research are derived from observed developer inquiries, terminal error logs, GitHub issue patterns, and technical community discussions, **not fabricated traffic estimates or synthetic search volumes**.

---

## 2. Search Intent Taxonomy

Developers searching for proxy and connectivity solutions for AI coding tools fall into three distinct intent categories:

1. **Troubleshooting Intent (Error-Driven)**: The developer's session failed with a specific error code (e.g., `429 Too Many Requests`, `ETIMEDOUT`, `ECONNREFUSED`). They want a direct, working fix immediately.
2. **Configuration Intent (Task-Driven)**: The developer works behind an enterprise firewall or in a regionally restricted location and needs to know how to pass proxy flags (`http_proxy`, `all_proxy`, SOCKS5) to OpenCode without breaking their OS network.
3. **Architectural & Comparative Intent (Evaluation-Driven)**: The developer wants to understand how application-level proxy routing differs from system-wide TUN clients and why user-space isolation is safer.

---

## 3. Primary Keywords Analysis

| Keyword | Search Intent | Relevance to Project | Does OpenCode Router Solve This? | Target Content Location | Priority |
| :--- | :--- | :--- | :--- | :--- | :---: |
| **OpenCode proxy** | Configuration / Troubleshooting | High | **Yes**: Automates discovery, local proxy binding, and transparent launcher injection. | `README.md`, `docs/articles/configure-proxy-opencode-cli.md` | **High** |
| **OpenCode rate limit** | Troubleshooting | High | **Yes (IP-based)**: Automatically switches to a fresh egress IP when public/free-tier endpoints rate-limit the current IP address. | `README.md`, `docs/articles/fix-opencode-http-429-rate-limit.md` | **High** |
| **OpenCode HTTP 429** | Troubleshooting | High | **Partially**: Differentiates between IP-based rate limits (solvable via node rotation) and account token exhaustion (which requires user balance top-up). | `docs/articles/fix-opencode-http-429-rate-limit.md` | **High** |
| **OpenCode network error** | Troubleshooting | High | **Yes**: Detects handshake timeouts, broken TLS pipes, and unreachable endpoints, seamlessly rotating to a verified node. | `docs/articles/fix-opencode-network-errors-linux.md` | **High** |
| **OpenCode proxy Linux** | Configuration | High | **Yes**: Designed specifically for Linux (Ubuntu 24.04 LTS), using native bash launchers and standard environment variables. | `README.md`, `docs/articles/configure-proxy-opencode-cli.md` | **High** |
| **OpenCode Xray** | Integration | High | **Yes**: Runs Xray-core in unprivileged local proxy mode with multi-protocol support (VLESS, VMess, Trojan, SS). | `docs/articles/use-xray-with-opencode-ubuntu.md` | **High** |
| **OpenCode V2Ray** | Integration | High | **Yes**: Compatible with V2Ray subscription endpoints and core protocol formats. | `docs/articles/use-xray-with-opencode-ubuntu.md` | **High** |
| **OpenCode Ubuntu** | Platform Configuration | High | **Yes**: Tested and verified on Ubuntu 24.04 LTS (x86_64) with native desktop integration script. | `README.md`, `scripts/create-desktop-launcher.sh` | **High** |
| **OpenCode CLI proxy** | Configuration | High | **Yes**: Provides dedicated `bin/opencode-vpn` executable that wraps CLI calls transparently. | `README.md`, `docs/articles/configure-proxy-opencode-cli.md` | **High** |
| **OpenCode connection issues** | Troubleshooting | High | **Yes**: 3-stage validation pipeline verifies TCP reachability, proxy handshakes, and actual LLM completions. | `docs/articles/fix-opencode-network-errors-linux.md` | **High** |
| **OpenCode rate limit fix** | Troubleshooting | High | **Yes**: Automatic failover state machine rotates nodes until a responsive connection is confirmed. | `docs/articles/fix-opencode-http-429-rate-limit.md` | **High** |
| **AI coding assistant proxy** | Discovery / Architectural | Medium | **Yes**: The architecture demonstrates how command-line AI coding tools can be proxied without system-wide VPN disruption. | `README.md`, `docs/articles/opencode-proxy-vs-system-vpn.md` | **Medium** |
| **SOCKS5 proxy for OpenCode** | Configuration | High | **Yes**: Exposes a local SOCKS5 listener (`127.0.0.1:10808`) specifically mapped to OpenCode via `all_proxy`. | `docs/articles/configure-proxy-opencode-cli.md` | **Medium** |
| **Xray proxy Linux** | Configuration / Integration | Medium | **Yes**: Manages headless Xray-core lifecycle, config generation, and non-root execution. | `docs/articles/use-xray-with-opencode-ubuntu.md` | **Medium** |
| **OpenCode intelligent proxy routing** | Architectural | High | **Yes**: Connection orchestrator ranks nodes by latency, tests them deterministically, and classifies errors. | `README.md`, `docs/SEO_AUDIT.md` | **Medium** |

---

## 4. Long-Tail Problem Keywords

Long-tail keywords capture developers who paste exact error snippets from their terminals into Google or GitHub search:

| Long-Tail Keyword | Developer Context | Project Solution | Target Article | Priority |
| :--- | :--- | :--- | :--- | :---: |
| `"opencode 429 Too Many Requests"` | AI provider throttles frequent interactive requests. | Automatic rotation to a fresh egress IP from public node pool. | `fix-opencode-http-429-rate-limit.md` | **High** |
| `"opencode failed to connect to api"` | Regional censorship or DNS poisoning drops endpoint connection. | Multi-protocol Xray tunneling (VLESS Reality/TLS) bypassing blocks. | `fix-opencode-network-errors-linux.md` | **High** |
| `"how to route opencode through socks5"` | User wants proxy support without changing global Linux settings. | Dedicated launcher script `bin/opencode-vpn` setting environment variables per process. | `configure-proxy-opencode-cli.md` | **High** |
| `"opencode proxy without root linux"` | User lacks sudo privileges on shared development server. | Runs on unprivileged loopback ports (`10808`/`10809`), zero sudo needed. | `opencode-proxy-vs-system-vpn.md` | **Medium** |
| `"difference between vpn and opencode proxy"` | User wants to keep local SSH, database, and browser connections normal. | Isolated user-space proxying vs global TUN adapter redirection. | `opencode-proxy-vs-system-vpn.md` | **Medium** |
| `"run xray core for single application ubuntu"` | Developer wants application-level traffic forwarding via Xray. | Automated JSON config generation with targeted local inbounds. | `use-xray-with-opencode-ubuntu.md` | **Medium** |
| `"opencode timeout error on ubuntu 24.04"` | Default timeouts cause silent terminal hangs during prompt execution. | Deterministic latency tester verifying end-to-end prompt response before locking node. | `fix-opencode-network-errors-linux.md` | **High** |
| `"vless reality proxy for opencode"` | Modern anti-censorship protocol configuration for OpenCode. | Native parsing and outbound generation for VLESS Reality nodes. | `use-xray-with-opencode-ubuntu.md` | **Medium** |

---

## 5. Keyword Mapping & Content Strategy

To avoid keyword cannibalization (multiple pages competing for the same phrase and diluting rank), each keyword group is assigned a primary canonical destination:

```
[Repository Root: README.md]
├── Primary: OpenCode proxy, OpenCode Router, OpenCode rate limit, OpenCode Ubuntu
└── Focus: Overall architecture, quickstart, automated workflow, installation

[Article 1: fix-opencode-network-errors-linux.md]
├── Primary: OpenCode network error, OpenCode connection issues, OpenCode timeout error
└── Focus: Handshake failures, TLS drops, DNS resolution, diagnostics

[Article 2: fix-opencode-http-429-rate-limit.md]
├── Primary: OpenCode HTTP 429, OpenCode rate limit fix, provider rate limit
└── Focus: IP-level rate limits vs account quota exhaustion, failover rotation

[Article 3: configure-proxy-opencode-cli.md]
├── Primary: OpenCode CLI proxy, SOCKS5 proxy for OpenCode, opencode http_proxy
└── Focus: Environment variables, launcher wrapper script, process isolation

[Article 4: use-xray-with-opencode-ubuntu.md]
├── Primary: OpenCode Xray, OpenCode V2Ray, Xray proxy Linux, VLESS Reality
└── Focus: Core integration, config generation, multi-protocol inbound/outbound

[Article 5: opencode-proxy-vs-system-vpn.md]
├── Primary: OpenCode VPN, AI coding assistant proxy, proxy vs VPN Linux
└── Focus: TUN hijacking vs user-space loopback sockets, least privilege
```

---

## 6. Implementation Guidelines

1. **Natural Linguistic Integration**: Keywords must be placed naturally in titles, H2/H3 subheadings, code comments, and explanatory paragraphs.
2. **Zero Keyword Stuffing**: Overusing exact-match phrases degrades technical credibility and triggers search engine penalties.
3. **Honest Limitations**: Never promise that rotating IPs will resolve account-level quota exhaustion or invalid API keys. Technical honesty builds developer trust and reduces bounce rates.
