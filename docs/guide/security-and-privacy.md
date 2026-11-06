---
title: "Security and Privacy Architecture"
description: "Security model of OpenCode Router: unprivileged execution, zero system TUN tampering, and RFC 5737 data sanitization."
---

# Security and Privacy Architecture

OpenCode Router is designed following the principle of least privilege, strict process isolation, and local-first data privacy.

---

## 1. Zero Root Privileges Required

Standard VPN software requires root (`sudo`) permissions to create network adapters (`tun0`, `tap0`) and alter kernel routing tables (`ip route replace default ...`).

OpenCode Router operates **completely in unprivileged user space**:
- Binds exclusively to loopback high ports (`127.0.0.1:10808` SOCKS5, `10809` HTTP). High ports (`>1024`) do not require root access on Linux.
- Spawns Xray-core as a child process of the running user.
- **Never prompts for your Ubuntu sudo password during normal operation.**

---

## 2. No System-Wide Routing Alterations

OpenCode Router intentionally avoids modifying global network configuration:
- Does NOT edit `/etc/resolv.conf`.
- Does NOT alter iptables, nftables, or UFW rules.
- Does NOT change the system default gateway.

**Benefit**: Active SSH sessions, local database servers, Docker bridge networks, and browser tabs remain on your direct host network with zero disruption.

---

## 3. Local-First Data Storage & Zero Telemetry

- **No Remote Telemetry**: OpenCode Router transmits zero analytics, tracking scripts, or usage metrics to external servers.
- **Excluded Sensitive Data**: All proxy configurations, connection logs, and SQLite database files reside exclusively in the local `data/` directory.
- **Git Protection**: Strict rules in `.gitignore` ensure that database files, logs, and connection exports are never committed to version control.
- **RFC 5737 Compliance**: All example IP addresses in public documentation and code samples use reserved documentation IP ranges (`198.51.100.0/24`, `192.0.2.0/24`, `203.0.113.0/24`).

---

## 4. Local API Hardening & Remote Access Protection

The Express management backend incorporates comprehensive defensive protections:
- **Default Loopback Binding**: Binds strictly to `127.0.0.1` by default. Non-loopback network exposure requires explicit opt-in (`ALLOW_REMOTE_ACCESS=true`).
- **Mandatory Remote Authentication**: Binding to a non-loopback interface strictly requires setting `OPENCODE_ROUTER_API_KEY`. The server will refuse startup if remote binding is configured without an API key. Remote requests require the `Authorization: Bearer <key>` header, compared using constant-time algorithms (`crypto.timingSafeEqual`). API keys are never accepted in query parameters.
- **Frictionless Local Execution**: Standard local loopback usage (`127.0.0.1`) requires no API key by default, maintaining zero friction for local CLI and dashboard workflows.
- **Restricted CORS Policy**: Unrestricted CORS is eliminated. Only local development origins (`localhost:5173`, `127.0.0.1:5173`, `localhost:3000`, `127.0.0.1:3000`) are authorized.
- **Host Header Validation**: Rejects requests targeting external hostnames or DNS rebinding domains with `HTTP 403 Forbidden`.
- **CSRF & State-Changing Guard**: Validates `Origin` and `Referer` headers on all state-changing endpoints (`POST`, `DELETE`), preventing malicious websites from triggering actions via a user's browser.
- **Sensitive Token Redaction**: Sources endpoints and error reports automatically redact private query tokens case-insensitively (`token`, `key`, `secret`, `password`, `auth`, `api_key`, `access_token`) and sanitize user credentials in URLs (`***:***@host`).
- **Restricted File Permissions & Symlink Defense**: Active Xray configuration files, logs, and connection states are saved with user-only permissions (`0600`), and parent data directories are enforced to `0700`. Overwrites explicitly correct pre-existing permissive permissions, and writing through symbolic links is blocked (`lstat` and `O_NOFOLLOW`).

---

## 5. Optional Least-Privilege Network Capabilities

If raw packet routing or custom network binding is desired on headless Ubuntu servers, `scripts/setup-privileges.sh` applies the Linux capability model:
```bash
sudo setcap 'cap_net_admin,cap_net_bind_service=+ep' bin/xray
```
This grants isolated network socket administration strictly to the Xray binary without granting broad root permissions to the user account.
