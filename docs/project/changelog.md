---
title: "Changelog"
description: "Version history and release notes for OpenCode Router v1.0.0, covering multi-protocol support, telemetry, and isolation."
---

# Changelog

All notable changes to the **OpenCode Router** project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.0] - 2026-11-04

### Added
- **Automated VPN Auto-Switching Workflow**: One-click discovery, verification, and activation of optimal V2Ray/Xray proxy configurations specifically for OpenCode.
- **Multi-Protocol Parser & Validator**: Full support for VLESS (Reality, TLS, TCP, WebSocket, gRPC), VMess, Trojan, and Shadowsocks URI formats with protocol-level parameter sanitization.
- **Deterministic 3-Stage Testing Pipeline**:
  - Stage 1: TCP port reachability check with millisecond timeout.
  - Stage 2: User-space proxy handshake and egress verification probe.
  - Stage 3: Direct model execution test using the installed OpenCode binary (`bin/opencode-vpn run "Reply with: OK" --pure`).
- **Intelligent Error Classifier**: Accurately differentiates IP-based rate limits (429, cloud blocks) from user authentication failures (401, invalid API keys) to avoid endless rotation on credential errors.
- **Dedicated OpenCode Launcher (`bin/opencode-vpn`)**: Injects proxy environment variables (`http_proxy`, `https_proxy`, `all_proxy`) strictly into the OpenCode process tree, completely preserving the host operating system's global network routing.
- **Modern Responsive React Dashboard**: Built with Vite, Tailwind CSS, Lucide icons, and real-time Server-Sent Events (SSE) telemetry.
- **Least-Privilege Security Model**: Optional setup script (`scripts/setup-privileges.sh`) configuring Linux `cap_net_admin` capabilities and tightly scoped sudoers rules for headless Ubuntu servers.
- **Desktop Launcher Generator (`scripts/create-desktop-launcher.sh`)**: Integrates OpenCode Router directly into Ubuntu's application menu and desktop.
- **Comprehensive Test Suite**: Automated scenarios covering protocol parsing, Xray client generation, process cleanup, rate-limit classification, and non-disruptive routing.

### Security & Privacy
- Zero tracking, analytics, or telemetry sent to third parties.
- Full local SQLite storage with sensitive connection credentials excluded from version control.
- Isolated process execution ensuring no interference with existing system tunnels or adapters.
