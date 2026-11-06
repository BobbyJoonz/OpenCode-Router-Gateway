# External Discovery & Promotion Strategy: OpenCode Router

**Project**: OpenCode Router  
**Author**: Ehsan Shahriyari ([@EhsanCreator](https://github.com/EhsanCreator))  
**Target Release**: v1.0.0  
**Verified Platform**: Ubuntu 24.04 LTS (64-bit x86_64)  

---

## 1. Ethical Growth & Distribution Principles

OpenCode Router is an open-source utility built to solve genuine developer network problems. Our distribution strategy adheres strictly to white-hat, developer-first principles:

- **Zero Spam or Bot Submissions**: No automated postings, artificial accounts, purchased upvotes, or fake testimonials.
- **Value-First Engagement**: Postings and discussions must directly answer real technical questions (e.g., resolving HTTP 429, routing CLI tools through SOCKS5 without root).
- **Transparency**: Clear disclosure of project scope, limitations (IP vs account-level limits), and open-source licensing (MIT).

> [!IMPORTANT]
> **Safety Directive**: All promotional materials and platform profiles below are **prepared drafts**. No accounts will be created and no submissions will be broadcast without explicit user authorization.

---

## 2. Platform Directory & Outreach Analysis

| Platform / Venue | Direct URL | Submission Rules & Guidelines | Approach & Angle | Target Audience | Backlink Type |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Reddit: r/commandline** | `https://www.reddit.com/r/commandline/` | Self-promotion permitted if relevant to CLI software; must share code and participate in comments. | Share as an open-source CLI proxy wrapper for terminal AI agents. Focus on `bin/opencode-vpn`. | Terminal power users, CLI tool developers | `rel="nofollow"` |
| **Reddit: r/Ubuntu** | `https://www.reddit.com/r/Ubuntu/` | Must be relevant to Ubuntu desktop/server. No commercial spam. | Share desktop launcher integration and testing on Ubuntu 24.04 LTS. | Ubuntu developers and administrators | `rel="nofollow"` |
| **Reddit: r/LocalLLaMA** | `https://www.reddit.com/r/LocalLLaMA/` | Allows discussion of AI tools, coding assistants, and local inference wrappers. | Discuss mitigating free-tier API rate limits and network routing for AI coding assistants. | AI engineers, LLM power users | `rel="nofollow"` |
| **Hacker News (Show HN)** | `https://news.ycombinator.com/showhn.html` | Must link directly to working code; title must begin with `Show HN:`. No marketing fluff; author must be in comments. | Focus on the architecture: running Xray-core in unprivileged user space to proxy CLI agents without system TUN hijacking. | Software engineers, systems programmers, hackers | `rel="nofollow"` (Dofollow on high-engagement submissions) |
| **Product Hunt** | `https://www.producthunt.com/` | Requires maker account; media gallery, tagline, and launch comment. | Launch as a developer productivity tool that eliminates rate limits and network drops for OpenCode. | Tech adopters, makers, developers | `rel="nofollow"` |
| **AlternativeTo** | `https://alternativeto.net/software/add/` | User-submitted database; moderators review descriptions and licenses. | Submit as an open-source alternative to full VPN clients for developers who only need CLI tool proxying. | Developers seeking lightweight routing tools | `rel="nofollow"` |
| **Awesome Lists: awesome-xray** | GitHub Pull Request | Project must be active open source, well-documented, and demonstrate novel Xray integration. | Submit PR adding OpenCode Router under "Applications / Integrations". | Network engineers, anti-censorship community | Dofollow on GitHub markdown |
| **Awesome Lists: awesome-linux-software** | GitHub Pull Request | Software must be native Linux, open source, and actively maintained. | Submit PR under "Development / Networking Tools". | Linux developers | Dofollow on GitHub markdown |
| **LibHunt (Linux / Node)** | `https://www.libhunt.com/` | Automated GitHub indexing based on repository activity and topic tags. | Triggered organically once repository gains initial stars and topics (`opencode`, `xray`, `rate-limit`). | Open-source software evaluators | Dofollow |

---

## 3. Ready-to-Use Promotional Drafts

### Draft 1: Reddit Project Introduction (For r/commandline or r/Ubuntu)

**Title**: 
OpenCode Router: Automated proxy discovery and isolated routing for OpenCode on Ubuntu (no root needed)

**Post Body**:
```markdown
Hey everyone,

If you use OpenCode (or similar CLI AI coding assistants) on Linux, you've probably hit annoying network drops, ISP throttling, or HTTP 429 rate limits on shared API endpoints.

The traditional fix is turning on a system-wide VPN, but that often breaks local development: it drops active SSH sessions, hijacks DNS, and routes your local web servers and Docker containers through the VPN tunnel.

I built **OpenCode Router** to solve this with application-specific isolation:
- Crawls and tests public V2Ray/Xray configurations (VLESS Reality, VMess, Trojan, Shadowsocks).
- Runs a deterministic 3-stage validation pipeline (TCP ping -> proxy egress probe -> real OpenCode test prompt).
- Differentiates between IP-based rate limits (auto-switches to a fresh node) and account-level quota limits (halts rotation to avoid wasted cycles).
- Runs 100% in user space on high loopback ports (10808/10809) — no sudo or root privileges required.
- Provides a dedicated launcher wrapper (`bin/opencode-vpn`) that sets proxy environment variables strictly for OpenCode, leaving your browser, terminal, and SSH untouched.
- Includes a React 19 web dashboard for real-time telemetry and manual testing.

Tested and verified on Ubuntu 24.04 LTS (x86_64).

GitHub: https://github.com/EhsanCreator/OpenCode-Router
License: MIT

Feedback and contributions welcome!
```

---

### Draft 2: Hacker News (Show HN)

**Title**:
Show HN: OpenCode Router – Automated proxy and rate-limit router for OpenCode on Linux

**URL**: `https://github.com/EhsanCreator/OpenCode-Router`

**Initial Maker Comment**:
```text
Hi HN,

I built OpenCode Router (https://github.com/EhsanCreator/OpenCode-Router) to solve a specific annoyance: terminal AI coding assistants failing due to regional censorship or IP-level HTTP 429 rate limits.

Standard VPN clients create system-wide TUN adapters, which hijack the default route (0.0.0.0/0). This routinely breaks local microservices on localhost, severs active SSH sessions, and risks DNS leaks.

Instead of global interception, OpenCode Router uses unprivileged user-space proxying:
1. It manages an internal headless Xray-core instance listening on 127.0.0.1:10808 (SOCKS5) and 10809 (HTTP).
2. It parses public VLESS (with Reality), VMess, Trojan, and Shadowsocks nodes and runs a 3-stage test: raw TCP RTT, proxy HTTP reflection, and an actual execution test through the installed OpenCode binary (`opencode run "..." --pure`).
3. An error classifier categorizes failures: if a provider returns HTTP 429 due to IP throttling, it rotates nodes; if the error is an account quota exhaustion or 401 auth error, it stops rotation immediately.
4. A small Bash wrapper (`bin/opencode-vpn`) sets http_proxy and all_proxy strictly for the sub-process environment and executes OpenCode without modifying host system routing.

The stack is TypeScript, Express, SQLite, and React 19 on the frontend. Tested on Ubuntu 24.04 LTS.

Code is completely open source under MIT. Would appreciate any feedback on the architecture or error-classification heuristics!
```

---

### Draft 3: Product Hunt Product Listing

- **Name**: OpenCode Router
- **Tagline**: Automated proxy discovery & rate-limit router for OpenCode on Linux
- **Description**:
  OpenCode Router eliminates connection timeouts and IP-based rate limits for OpenCode users. It automatically discovers, tests, and locks into verified V2Ray/Xray proxy configurations in unprivileged user space. With its dedicated launcher wrapper, only OpenCode traffic is proxied—leaving your local web servers, Docker containers, and SSH sessions completely untouched.
- **Pricing**: Free & Open Source (MIT)
- **First Comment by Maker**:
  "As developers using AI coding assistants in terminal workflows, network timeouts and HTTP 429 throttles kill productivity. Traditional VPNs break local developer setups. We built OpenCode Router to provide targeted, automated failover routing exclusively for OpenCode without needing root privileges. We'd love your thoughts!"

---

### Draft 4: Short Social Media Announcement (Twitter/X, Mastodon, LinkedIn)

```text
🚀 OpenCode Router v1.0.0 is out!

Fix OpenCode network drops & IP-based HTTP 429 rate limits on Linux with automated Xray/V2Ray proxy routing:

✅ Automated multi-protocol discovery (VLESS Reality/TLS, VMess, Trojan)
✅ Real 3-stage prompt verification pipeline
✅ 100% process-isolated (zero system TUN disruption)
✅ Runs without root privileges

Open Source (MIT): https://github.com/EhsanCreator/OpenCode-Router
```

---

### Draft 5: Open-Source Directory Submission (LibHunt / AlternativeTo)

- **Product Name**: OpenCode Router
- **Website / Repo**: `https://github.com/EhsanCreator/OpenCode-Router`
- **Short Description**: An automated proxy discovery and intelligent rate-limit routing manager for OpenCode on Ubuntu Linux.
- **Long Description**: OpenCode Router resolves network connectivity issues, regional blocks, and IP-based rate limits for command-line AI coding tools. By operating Xray-core in user-space proxy mode and wrapping executions in a dedicated launcher script, OpenCode Router routes AI requests through low-latency encrypted nodes without altering system routing tables or interfering with other development tools. Includes automated node discovery from GitHub, deterministic 3-stage testing, intelligent error classification, and a modern React dashboard.
