# Privacy Policy

**Effective date:** _[YYYY-MM-DD]_
**Data controller:** _[Legal entity, address, privacy contact email]_

> Template. Replace placeholders and have it reviewed before launch.

## 1. What we collect

| Category | Data | Purpose | Retention |
|---|---|---|---|
| Account | key prefix (not the key), display name, optional email | identify the account | until deletion |
| Authentication | SHA-256 hash of the API key | verify requests | until deletion |
| Usage metadata | model, prompt/completion/total token counts, cost in USD, HTTP status, latency, egress node id, timestamp | billing, quotas, abuse prevention | 90 days (configurable) |
| Abuse signals | key id, IP address, reason, score | fraud and abuse prevention | 30 days |
| Operational logs | request id, timings, errors (no message content) | reliability | 14 days |

## 2. What we do **not** collect

- **We do not store prompt or completion content.** The gateway streams requests
  to the upstream provider and records only metadata (token counts and status).
- We do not sell personal data.
- We do not use your data to train models.

## 3. Legal bases (GDPR Art. 6)

- **Contract** — providing the Service and billing.
- **Legitimate interests** — abuse prevention, security, service reliability
  (Art. 6(1)(f)), balanced against your rights.
- **Legal obligation** — where we must retain records.

## 4. Processors and transfers

Requests are forwarded to upstream model providers: _[list providers]_. Data may
be processed outside your country. Transfers rely on _[SCCs / adequacy decision]_.

## 5. Your rights

You have the right to access, rectify, erase, restrict, port, and object. Use:

- `GET /api/privacy/export?key_id=<id>` — export account + usage metadata as JSON
- `DELETE /api/privacy/erase?key_id=<id>` — erase the account and its metadata

Requests are honoured within 30 days. You may also lodge a complaint with your
supervisory authority.

## 6. Security

Keys are stored as SHA-256 hashes; plaintext keys are never persisted. Transport
is encrypted with TLS. Access to the management API is restricted to loopback.

## 7. Children

The Service is not directed to anyone under 18.

## 8. Changes

Material changes will be announced at least 14 days in advance on the status page.
