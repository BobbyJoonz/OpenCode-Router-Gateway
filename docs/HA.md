# High availability — what this architecture can and cannot do

Read this before promising an SLA.

## The honest constraint

The gateway stores everything in **one SQLite file**. SQLite allows **one writer at
a time**. That is fine for a single host and for the two supported scenarios
(personal and small team), but it is *not* a multi-writer database, so the gateway
cannot be scaled horizontally without replacing the storage layer.

Two things are therefore delivered here:

1. **HA-lite (available today)** — one active writer + continuous WAL replication
   to object storage, with a documented failover procedure. RPO ≈ 1 s, RTO ≈ 1–3 min.
2. **A clear path to real HA (not implemented)** — replace `better-sqlite3` with
   Postgres. The exact refactor is listed at the end.

## HA-lite

### Topology

```
          ┌──────────────┐        WAL stream        ┌──────────────────┐
 clients ─►  gateway A   │ ───────────────────────► │  object storage  │
          │  (active)    │                          │  (S3 / B2 / minio)│
          └──────────────┘                          └────────┬─────────┘
                   ▲                                          │ restore
                   │ failover (DNS / Caddy / LB)              ▼
          ┌──────────────┐                          ┌──────────────────┐
          │  gateway B   │ ◄────────────────────────│  cold standby    │
          │  (standby)   │      litestream restore  └──────────────────┘
          └──────────────┘
```

### Enable replication

`deploy/litestream.yml` is included. Run it as a sidecar next to the gateway:

```bash
docker compose -f deploy/docker-compose.yml --profile ha up -d
```

Environment for the replicator:

| Variable | Meaning |
|---|---|
| `LITESTREAM_BUCKET` | bucket name |
| `LITESTREAM_REGION` | region |
| `LITESTREAM_ENDPOINT` | S3-compatible endpoint (minio, Backblaze, R2) |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | credentials |

Verify:

```bash
docker exec orgw-litestream litestream snapshots /app/data/opencode-vpn.db
```

### Failover runbook

1. **Confirm the active node is dead** (not a network partition):
   `curl -fsS https://gateway.example.com/readyz` from two networks.
2. **Stop the old writer** (never run two writers against one replica):
   `systemctl stop opencode-router` or `docker stop orgw`.
3. **Restore the latest replica** on the standby host:
   ```bash
   litestream restore -o /opt/opencode-router/data/opencode-vpn.db \
     s3://$LITESTREAM_BUCKET/opencode-router
   ```
4. **Start the gateway** on the standby: `systemctl start opencode-router`.
5. **Gate on readiness**: `npm run doctor:live` must print READY.
6. **Move traffic**: update DNS / LB to the standby.
7. **Keep the old node offline** until its data directory is wiped and it is
   re-provisioned as the new standby.

Expected: **RPO ≈ 1 s** (WAL shipping interval), **RTO ≈ 1–3 min** (manual steps).

### What HA-lite does not protect against

- A bad deploy that corrupts data on both sides.
- Sustained write throughput beyond what one SQLite writer can absorb.
- More than one active instance (two writers will corrupt the replica).

## Real HA — the Postgres path (not implemented)

The storage layer is synchronous (`better-sqlite3` returns values directly), so a
Postgres port is not a driver swap. The work is:

1. Introduce a `Database` interface (`query`, `execute`, `transaction`) and make
   every call site `await` it — `db.prepare(...).run/get/all` appears in ~15 files.
2. Replace `better-sqlite3` with `pg` + a connection pool; move `PRAGMA` settings to
   Postgres equivalents (`synchronous_commit`, `statement_timeout`).
3. Replace SQLite-only SQL: `datetime('now', '-90 days')` → `now() - interval '90 days'`;
   `INSERT OR IGNORE` → `ON CONFLICT DO NOTHING`; `AUTOINCREMENT` → `GENERATED ... AS IDENTITY`.
4. Move in-process state that must be shared to Redis or Postgres:
   rate-limit windows, concurrency counters, TPM windows, egress sticky map.
5. Make the egress pool per-instance (it already is), and have each instance
   advertise its slots so the load balancer can prefer healthy ones.

Until that is done, run **one writer** and use HA-lite.

## Cluster mode (throughput, not HA)

`npm run start:cluster` forks N workers sharing the listening socket. It raises
throughput on a multi-core host, but:

- per-process limits become per-worker (divide your configured limits by N), and
- management endpoints that mutate the engine should target a single worker.

Cluster mode does **not** improve availability: all workers share one host and one
database.
