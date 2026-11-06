---
layout: home

hero:
  name: "OpenCode Router"
  text: "Intelligent Proxy & Rate-Limit Router for OpenCode"
  tagline: "Automated proxy discovery, testing, and intelligent routing for OpenCode. Fix connectivity issues and IP-based rate limits with Xray/V2Ray on Linux."
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: Technical Articles
      link: /articles/fix-opencode-network-errors-linux
    - theme: alt
      text: View on GitHub
      link: https://github.com/EhsanCreator/OpenCode-Router

features:
  - icon: ⚡
    title: Automated Node Discovery
    details: Continuously crawls, parses, and normalizes public VLESS, VMess, Trojan, and Shadowsocks proxy nodes from curated GitHub subscriptions.
  - icon: 🎯
    title: 3-Stage Prompt Verification
    details: Executes real multi-stage health probes (TCP ping, proxy HTTP handshake, and actual OpenCode test prompt execution) before locking into a working node.
  - icon: 🛡️
    title: 100% Process Isolation
    details: Routes OpenCode strictly through loopback ports (10808 SOCKS5 / 10809 HTTP) via bin/opencode-vpn without hijacking system-wide routing or SSH.
  - icon: 🧠
    title: Intelligent Error Classifier
    details: Differentiates IP-based HTTP 429 throttles (triggering automatic rotation) from account token exhaustion, avoiding endless wasted cycles.
  - icon: 🔒
    title: Zero-Root Security
    details: Operates entirely as a standard unprivileged user on high ports (>1024). Never prompts for your sudo password during daily use.
  - icon: 📊
    title: Modern Telemetry Dashboard
    details: Real-time telemetry streamed via Server-Sent Events (SSE), search filters, latency charts, and one-click connection switching.
---

## Verified Platform Compatibility

::: tip Primary Tested Environment
**Ubuntu 24.04 LTS (64-bit x86_64)** is the primary development and officially verified platform for OpenCode Router. All unit tests, process isolation, and CLI wrappers are confirmed functional.
:::

## Product Preview

UI screenshots will be added after the project provides a reproducible synthetic demo dataset.

## Quick Installation

```bash
# 1. Clone repository
git clone https://github.com/EhsanCreator/OpenCode-Router.git
cd OpenCode-Router

# 2. Install dependencies
npm install

# 3. Launch application
./start.sh
```

## Community & Author

OpenCode Router is created and maintained by **Ehsan Shahriyari** ([@EhsanCreator](https://github.com/EhsanCreator)) and distributed under the [MIT License](https://github.com/EhsanCreator/OpenCode-Router/blob/main/LICENSE).
