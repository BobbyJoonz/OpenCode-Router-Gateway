# Data retention and deletion

This document states what the gateway stores, for how long, and how to delete it.
It must stay consistent with `PRIVACY.md`.

## 1. Stored data

| Table | Contents | Default retention |
|---|---|---|
| `api_keys` | key hash, prefix, name, email, limits, counters | until the key is deleted |
| `usage_log` | model, token counts, `cost_usd`, status, latency, egress node id, timestamp | **90 days** |
| `abuse_events` | key id, IP, reason, score | **30 days** |
| `signup_invites` | code hash, label, uses, expiry | 1 year |
| `usage_alerts` | per-key thresholds and last-fired timestamps | until the key is deleted |
| `test_history`, `configs`, `sources` | network node metadata, **not personal data** | 90 days |
| Application logs | request id, timings, error codes (no content) | 14 days |

Prompt and completion **content is never persisted**.

## 2. Automatic cleanup

The intended production setup runs a nightly job:

```sql
DELETE FROM usage_log    WHERE created_at < datetime('now', '-90 days');
DELETE FROM abuse_events WHERE created_at < datetime('now', '-30 days');
DELETE FROM test_history WHERE timestamp  < datetime('now', '-90 days');
```

Run it through the API or directly against the database during a maintenance
window; SQLite makes this a fast, non-blocking delete for these volumes.

## 3. On-request deletion (GDPR Art. 17)

```bash
# export everything held about a key
curl -s "http://127.0.0.1:3000/api/privacy/export?key_id=12" | jq .

# erase the key and all of its metadata
curl -s -X DELETE "http://127.0.0.1:3000/api/privacy/erase?key_id=12" | jq .
```

Erase removes: the key row, its usage rows, its alerts, and its abuse events.
It returns the number of rows deleted so the action is auditable.

## 4. Backups

Backups of `data/` inherit the retention of the data they contain. Documented
target: **35 days** of rolling backups; a deletion request must be reflected in
backups within that window.

## 5. Incident response

1. Contain (revoke affected keys, rotate provider credentials).
2. Assess scope using `abuse_events` and `usage_log`.
3. Notify affected controllers within 48 hours (see `DPA.md` §4.5).
4. Record the incident and the remediation.
