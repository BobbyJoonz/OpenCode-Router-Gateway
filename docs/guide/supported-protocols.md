---
title: "Supported Anti-Censorship Protocols"
description: "Overview of supported proxy protocols in OpenCode Router: VLESS with Reality, VMess AEAD, Trojan TLS, and Shadowsocks."
---

# Supported Anti-Censorship Protocols

OpenCode Router natively parses, normalizes, and configures four major proxy protocols supported by Xray-core.

---

## 1. VLESS (Recommended)

VLESS is a lightweight, stateless transmission protocol designed for modern anti-censorship routing.

### Supported Security Modes:
- **Reality (XTLS)**: Masquerades traffic as legitimate TLS 1.3 connections to well-known domains (e.g., Cloudflare, Microsoft) without requiring a server certificate.
- **Standard TLS**: Traditional TLS certificate negotiation with configurable server name indicator (SNI).

### Supported Transports:
- **TCP**: Standard stream transport. Supports `xtls-rprx-vision` flow control.
- **WebSocket (`ws`)**: HTTP upgrade tunneling over CDN edge endpoints.
- **gRPC**: Multiplexed RPC streams suitable for high-concurrency environments.

---

## 2. VMess

VMess is the original encryption protocol introduced by V2Ray.

### Supported Features:
- AEAD packet verification.
- WebSocket, HTTP, and TCP transports.
- Configurable `alterId` and security algorithms (`auto`, `aes-128-gcm`, `chacha20-poly1305`).

---

## 3. Trojan

Trojan bypasses deep packet inspection by imitating standard HTTPS traffic over port 443.

### Supported Features:
- Direct TLS handshakes.
- WebSocket and gRPC transport layers.
- SNI spoofing and certificate validation toggles (`allowInsecure`).

---

## 4. Shadowsocks

Shadowsocks provides fast, low-overhead symmetric stream and AEAD encryption.

### Supported Ciphers:
- `aes-256-gcm`
- `aes-128-gcm`
- `chacha20-ietf-poly1305`
- Legacy stream ciphers (where supported by modern Xray-core).

---

## URI Parsing & Normalization

All imported URLs (e.g. `vless://`, `vmess://`, `trojan://`, `ss://`) are normalized by `src/backend/parser/config-parser.ts`:
- Protocol-specific query parameters are parsed into structured JSON.
- Cryptographic SHA-256 hashes are computed for deduplication.
- Unencrypted VLESS links (`security=none`) are discarded automatically to ensure strict encryption standards.
