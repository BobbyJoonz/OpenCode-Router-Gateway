# GitHub Repository Optimization & Metadata Guide: OpenCode Router

**Project**: OpenCode Router  
**Repository**: [https://github.com/EhsanCreator/OpenCode-Router](https://github.com/EhsanCreator/OpenCode-Router)  
**Author**: Ehsan Shahriyari ([@EhsanCreator](https://github.com/EhsanCreator))  
**Target Release**: v1.0.0  
**Verified Platform**: Ubuntu 24.04 LTS (64-bit x86_64)  

---

## 1. Overview & Operational Rule

This document defines the exact metadata configuration recommended for the GitHub repository settings. 

> [!IMPORTANT]
> **Safety Directive**: In compliance with user instructions, these changes are **prepared for review and approval only**. No remote GitHub API requests, settings changes, or release publications will be executed without explicit authorization.

---

## 2. Repository Description

### Recommended Description
```text
Automated proxy discovery, testing, and intelligent routing for OpenCode. Fix connectivity issues and IP-based rate limits with Xray/V2Ray on Linux.
```

### Technical Accuracy Audit of the Description
Every phrase in the recommended description has been audited against the actual source code:

1. **"Automated proxy discovery"**: Verified in `src/backend/discovery/config-fetcher.ts`, which fetches, decodes, and deduplicates publicly shared configuration URLs from GitHub repositories.
2. **"testing"**: Verified in `src/backend/tester/latency-tester.ts` and `src/backend/opencode/opencode-service.ts`, executing deterministic TCP reachability, proxy handshakes, and actual OpenCode test prompts.
3. **"and intelligent routing for OpenCode"**: Verified in `src/backend/orchestrator/connection-orchestrator.ts` and `src/backend/opencode/error-classifier.ts`, which ranks nodes, classifies errors, and isolates traffic routing strictly to OpenCode via `bin/opencode-vpn`.
4. **"Fix connectivity issues and IP-based rate limits"**: Verified in `src/backend/opencode/error-classifier.ts` (`isRateLimit`), which differentiates between IP-based throttles (triggering automatic node rotation) and account exhaustion.
5. **"with Xray/V2Ray on Linux"**: Verified in `src/backend/vpn/vpn-engine.ts` and `src/backend/vpn/xray-config-builder.ts`, managing native Xray-core instances on Ubuntu 24.04 LTS.

- **Character Count**: 153 characters (optimal: fits GitHub's 350-character limit and avoids truncation in Google SERP snippets under 160 characters).

---

## 3. GitHub Topics Selection & Ranking

GitHub Topics enhance repository discoverability in GitHub Explore, topical search queries (`topic:opencode`), and recommendation feeds.

### Curated Topics List (Max 20 permitted, 15 prioritized):

| Topic | Relevance & Category | Why It Matters for Discoverability |
| :--- | :--- | :--- |
| `opencode` | Core Target Tool | Primary tag for developers searching specifically for OpenCode ecosystem tools. |
| `opencode-ai` | Ecosystem / Domain | Captures variations of OpenCode AI assistant searches. |
| `ai-coding-assistant` | Category | Broader taxonomy tag for AI-assisted programming tools. |
| `xray` | Core Technology | Reaches developers looking for headless Xray-core integrations on Linux. |
| `v2ray` | Core Protocol / Ecosystem | Primary search tag for V2Ray subscriptions and client implementations. |
| `proxy` | Functional Category | Standard networking category for proxy and routing applications. |
| `socks5` | Protocol | Specific technical tag for local SOCKS5 proxy listeners (`127.0.0.1:10808`). |
| `rate-limit` | Problem Solved | Reaches developers troubleshooting API throttling and HTTP 429 errors. |
| `vless` | Protocol | Connects with users seeking modern VLESS Reality and TLS proxy configs. |
| `vmess` | Protocol | Connects with users seeking VMess protocol support. |
| `developer-tools` | Category | General open-source utility classification. |
| `ubuntu` | Target Platform | Targets Ubuntu Linux developers requiring desktop-compatible tooling. |
| `linux` | Target Platform | Broader operating system categorization. |
| `typescript` | Tech Stack | Identifies the codebase language for developers and contributors. |
| `react` | Tech Stack | Highlights the modern React 19 web GUI dashboard. |

---

## 4. Repository Metadata Configuration

When configuring the repository via GitHub's Web UI (or GitHub CLI `gh repo edit`), use the following verified values:

- **Website URL**: `https://github.com/EhsanCreator/OpenCode-Router#readme` (or future documentation URL)
- **Include in home page**:
  - [x] Releases
  - [x] Packages
  - [x] Environments
- **Social Preview Image**:
  - Image file: A 1280x640px PNG banner based on `docs/images/dashboard.png` with a clean dark-slate gradient frame, project title ("OpenCode Router v1.0.0"), subtitle ("Automated Proxy Discovery & Rate-Limit Router for OpenCode"), and author badge ("by Ehsan Shahriyari").
  - Aspect ratio: 2:1 (standard Open Graph / GitHub social card specification).

---

## 5. GitHub Release v1.0.0 Draft

Below is the complete, formatted release description prepared for the GitHub release page when approved:

```markdown
# OpenCode Router v1.0.0 — Initial Public Release

We are excited to announce the initial public release (**v1.0.0**) of **OpenCode Router**, an automated proxy discovery, testing, and intelligent routing application built specifically for OpenCode on Ubuntu Linux.

### 🌟 What is OpenCode Router?
OpenCode Router solves connectivity barriers, regional blocks, and IP-level HTTP 429 rate limits for OpenCode users. Instead of running system-wide VPNs that disrupt local development environments, SSH sessions, and background tunnels, OpenCode Router operates an unprivileged local user-space proxy and isolates traffic routing strictly to OpenCode.

### 🚀 Key Capabilities
- **Automated Configuration Discovery**: Crawls and parses public configurations from curated GitHub subscription repositories.
- **Multi-Protocol Engine**: Full native support for VLESS (Reality, TLS, WebSocket, gRPC), VMess, Trojan, and Shadowsocks.
- **Deterministic 3-Stage Pipeline**: Verifies remote TCP handshake latency, local proxy egress reflection, and executes a real test prompt through the installed OpenCode binary.
- **Intelligent Error Classifier**: Accurately differentiates IP-based rate limits (which trigger automatic node rotation) from account-level quota exhaustion and authentication failures.
- **Dedicated Isolated Launcher (`bin/opencode-vpn`)**: Routes OpenCode through `127.0.0.1:10808` (SOCKS5) and `127.0.0.1:10809` (HTTP) without altering OS-level routing or `/etc/resolv.conf`.
- **Zero-Root Security Architecture**: Runs entirely as a standard unprivileged user on high loopback ports.
- **Modern React Dashboard**: Real-time telemetry streamed via Server-Sent Events (SSE).

### 🖥️ Verified Platform Compatibility
- **Officially Verified & Tested**: Ubuntu 24.04 LTS (64-bit x86_64)
- **Node.js**: v18.0.0 or later
- **Dependencies**: `curl`, `unzip`, OpenCode CLI

### ⚠️ Important Limitations
- OpenCode Router rotates IP addresses to resolve IP-based rate limits and regional network blocks. It **cannot** bypass account-level token exhaustion, expired subscriptions, or invalid provider API keys.
- Does not modify or provide system-wide VPN tunnels; it is strictly an application-specific proxy router.

### 📦 Quick Start
```bash
git clone https://github.com/EhsanCreator/OpenCode-Router.git
cd OpenCode-Router
npm install
./start.sh
```

**Full Documentation & Troubleshooting**: [README.md](https://github.com/EhsanCreator/OpenCode-Router#readme)  
**Author**: Ehsan Shahriyari ([@EhsanCreator](https://github.com/EhsanCreator))
```
