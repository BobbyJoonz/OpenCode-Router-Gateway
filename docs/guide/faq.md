---
title: "Frequently Asked Questions (FAQ)"
description: "Answers to common questions about OpenCode Router, rate limits, model token budgets, and system VPN coexistence."
---

# Frequently Asked Questions (FAQ)

### What is OpenCode Router?
OpenCode Router is an automated proxy discovery, testing, and intelligent routing application built specifically for [OpenCode](https://github.com/anomaly/opencode) on Linux. It resolves regional network blocks and IP-based rate limits by rotating through verified V2Ray/Xray proxy nodes.

### Can OpenCode Router give me free unlimited tokens?
**No.** OpenCode Router is a network routing and proxy management tool. It cannot alter or bypass provider billing systems, token caps, or subscription expiration dates. It bypasses IP-based throttling and regional ISP blocks.

### Does OpenCode Router encrypt all my internet traffic?
**No.** OpenCode Router intentionally encrypts and routes **only OpenCode traffic**. Your web browser, terminal commands, SSH sessions, and system updates continue using your direct, fast host internet connection.

### Can I run OpenCode Router alongside another VPN?
**Yes.** Because OpenCode Router runs in user space on loopback ports (`127.0.0.1:10808`/`10809`) without touching kernel routing tables, it coexists harmoniously with any existing network setup, company VPN, or tunnel.

### Does it require root (`sudo`) permissions?
**No.** Binding to ports `10808` and `10809` does not require root privileges. The application runs entirely within your standard user account.

### How quickly does it switch nodes when rate-limited?
The orchestrator typically completes the 3-stage validation pipeline (TCP ping, proxy HTTP handshake, and actual OpenCode prompt execution) within **8 to 15 seconds** before locking into a new working node.

### How do I use it with the OpenCode CLI?
Run OpenCode through the provided launcher wrapper:
```bash
bin/opencode-vpn run "Explain binary search in TypeScript"
```
Or create a system-wide symlink in `~/.local/bin/opencode-vpn`.
