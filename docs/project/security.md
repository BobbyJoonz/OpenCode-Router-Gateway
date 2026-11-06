---
title: "Security Policy"
description: "Security disclosure policy, supported versions, and vulnerability reporting procedures for OpenCode Router."
---

# Security Policy

## Supported Versions

| Version | Supported Status |
| :--- | :---: |
| 1.0.x | :white_check_mark: Active Support |

---

## Reporting a Vulnerability

The OpenCode Router project takes security and data confidentiality seriously. If you discover a vulnerability or accidental sensitive information exposure, please report it responsibly.

### How to Report
Please **DO NOT** report security vulnerabilities via public GitHub issues.

Instead, please send a private report to:
- **Author**: Ehsan Shahriyari
- **GitHub**: [@EhsanCreator](https://github.com/EhsanCreator)
- **Repository Issues (Security Category)**: Private security advisory channel on GitHub

Please include:
- A description of the vulnerability.
- Steps to reproduce or proof-of-concept code.
- Potential impact and affected components.

We will acknowledge receipt of your report within 48 hours and work on a fix as quickly as possible.

---

## Security Architecture Principles
1. **Loopback-Only Binding by Default**: The backend management server binds strictly to `127.0.0.1` by default. Non-loopback host exposure requires an explicit opt-in (`ALLOW_REMOTE_ACCESS=true`) and emits high-visibility security warnings.
2. **Mandatory Remote Access Authentication**: When remote access is enabled, the backend strictly requires a non-empty `OPENCODE_ROUTER_API_KEY`. Startup is refused if remote exposure is attempted without an API key. All remote `/api/*` requests (read and write) require `Authorization: Bearer <key>`. Tokens are compared in constant time (`crypto.timingSafeEqual`) to prevent timing side channels. API keys are never accepted in URL query parameters and are never echoed in logs or error messages.
3. **Frictionless Local Operation**: Standard local loopback usage (`127.0.0.1`, `localhost`, `::1`) operates frictionlessly without authentication by default, while allowing optional local key enforcement via `ENFORCE_LOCAL_AUTH=true`.
4. **Restricted CORS Policy**: Unrestricted CORS (`*`) is eliminated. CORS headers are restricted to an explicit development allowlist (`localhost:5173`, `127.0.0.1:5173`, `localhost:3000`, `127.0.0.1:3000`). Untrusted external origins receive no CORS authorization headers.
5. **Host Header Validation (DNS Rebinding Protection)**: All incoming HTTP requests are validated against trusted loopback host headers (`localhost`, `127.0.0.1`, `[::1]`). Requests with forged or external domain host headers are rejected with `HTTP 403 Forbidden` (`INVALID_HOST`).
6. **Origin Validation on State-Changing Endpoints (CSRF Defense)**: State-changing HTTP methods (`POST`, `PUT`, `DELETE`, `PATCH`) validate `Origin` and `Referer` headers against the authorized local origin set. Drive-by cross-origin requests from malicious websites are rejected with `HTTP 403 Forbidden` (`UNTRUSTED_ORIGIN`).
7. **Credential & Token Redaction**: Subscription URLs exposed via `/api/sources` automatically redact sensitive query parameters case-insensitively (`token`, `key`, `secret`, `password`, `auth`, `api_key`, `access_token`) and mask userinfo credentials (`***:***@host`). Fetch error message boundaries are sanitized against URL leakage. Diagnostics and logs mask IPv4 and IPv6 address octets (RFC 5737 compliant).
8. **User-Space & Process-Tree Isolation**: Proxy routing is handled via local loopback sockets (`127.0.0.1:10808` SOCKS5 / `10809` HTTP) and dedicated process launchers (`bin/opencode-vpn`), avoiding global operating system or kernel routing modifications.
9. **Strict File Permissions & Symlink Protection**: Generated Xray client configs (`data/active-xray-config.json`), log files, and active connection states are created with restricted user-only permissions (`0600`), and parent data directories are enforced to `0700`. Overwrites explicitly correct pre-existing permissive file modes via `fchmodSync`, and writing through symbolic links is blocked (`lstat` and `O_NOFOLLOW`).
10. **Zero Root Privilege Requirement**: The core application runs entirely with unprivileged standard user permissions and never requires `sudo` for routine proxy routing.

---

## Remote Access Deployment Notes

When deploying OpenCode Router on a remote or headless server:
- Set `OPENCODE_ROUTER_API_KEY` to a cryptographically random secret string.
- Set `ALLOW_REMOTE_ACCESS=true` and `HOST=0.0.0.0` (or the server LAN IP).
- All API requests from remote clients must include the header:
  ```http
  Authorization: Bearer <your-secret-api-key>
  ```
- **Browser Dashboard & SSE Note**: Standard browser `EventSource` does not support custom HTTP headers like `Authorization`. Because OpenCode Router rejects passing API keys through URL query parameters for security reasons, browser dashboards on remote machines should connect through a reverse proxy (e.g. Nginx, Caddy, or an SSH tunnel) that handles authentication or loopback termination. Programmatic API and CLI clients can pass the Bearer token directly.
