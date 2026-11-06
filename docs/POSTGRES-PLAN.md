# Postgres / real HA — what it actually takes

This document exists because "add Postgres" sounds like a driver swap and is not
one. Read it before promising an SLA.

## Current state (honest)

| Fact | Consequence |
|---|---|
| Storage is `better-sqlite3` — **synchronous** API | every query returns a value directly; there is no `await` |
| ~15 modules call `db.prepare(...).run/get/all` | each call site must become `await` |
| SQLite-specific SQL | `datetime('now','-90 days')`, `INSERT OR IGNORE`, `AUTOINCREMENT`, `PRAGMA` |
| In-process state | rate-limit windows, concurrency counters, TPM/RPM windows, sticky egress map |
| One writer | two instances would corrupt the data |
| Single file | backup = copy; HA = WAL replication (Litestream) |

**What you have today:** HA-lite. `deploy/litestream.yml` streams the WAL to object
storage (`sync-interval: 1s`), and `docs/HA.md` has the failover runbook.
RPO ≈ 1 s, RTO ≈ 1–3 min, manual.

## The phased plan

Effort assumes one experienced developer, focused, with tests.

| Phase | Work | Effort | Risk |
|---|---|---|---|
| 1 | **Storage interface**: `query/execute/transaction` + SQLite adapter; no behaviour change | 1–2 d | low |
| 2 | **Async conversion**: make every call site `await`; the compiler finds them all | 3–5 d | medium |
| 3 | **SQL dialect port**: `now() - interval`, `ON CONFLICT`, identity columns, `pg` pool settings | 2–3 d | medium |
| 4 | **Shared state**: move rate limit / concurrency / TPM / sticky to Redis or Postgres | 2–3 d | medium |
| 5 | **Migrations**: numbered SQL files + a version table (replaces `PRAGMA user_version`) | 1–2 d | low |
| 6 | **Backfill + cutover**: export SQLite → Postgres, verify row counts and checksums, dual-run | 2–4 d | high |
| 7 | **HA topology**: primary + replica, PgBouncer, health checks, automated failover | 2–3 d | high |
| | **Total** | **~2–3 weeks** | |

Phase 1 is the only safe first step, and it is valuable on its own: it makes the
storage boundary explicit and lets the gateway be tested against an in-memory
implementation.

## When Postgres is worth it

| You need | Use |
|---|---|
| one server, personal / small team | **SQLite + HA-lite** (current) |
| a few thousand requests/second | **cluster mode** (current) — quotas become per-worker |
| multiple servers, zero-downtime deploys, SLA | **Postgres + Redis** (this plan) |
| multi-region | Postgres + read replicas + external LB |

## What must NOT be done

- Running two gateway instances against one SQLite file. WAL tolerates concurrent
  writers only within one host, and the second instance will corrupt the replica.
- Pointing Litestream at a database another process is restoring.
- "Trying Postgres" on the production volume without a tested export/import.

## Practical decision

If the goal is **"the service should not go down for hours"**, HA-lite + a
monitored health check already covers it. If the goal is **"no single point of
failure and no maintenance window"**, Postgres is required and should be planned
as its own project, not a patch on top of this one.
