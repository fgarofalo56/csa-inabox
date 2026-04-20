---
status: accepted
date: 2026-04-20
deciders: csa-inabox platform team
consulted: security, governance, dev-loop, finops
informed: all
---

# ADR 0015 — Portal persistence: StoreBackend protocol with SQLite (dev) + Postgres Flexible Server (prod)

## Context and Problem Statement

The CSA-in-a-Box portal (`portal/shared/api/`) persists source
registrations, pipelines, access requests, and marketplace entries as
JSON-blob rows in a single SQLite file under `./data/portal.db`.
CSA-0046 identified this as unfit for staging or production:

- **No HA**: a single writer on a mounted PVC is a single point of
  failure in AKS/Container Apps.
- **No PITR**: SQLite has no point-in-time recovery story; a corrupt
  file is a lost portal.
- **No multi-replica scale-out**: WAL mode permits one writer, which
  gates the portal's horizontal-scale story behind a migration.
- **FedRAMP gap**: CP-9 (backups), SC-28 (encryption-at-rest with a
  customer-managed key), and AU-9 (audit-record protection) cannot be
  inherited from PVC storage classes.

ADR 0009 already recorded the strategic choice (SQLite dev → Postgres
prod).  This ADR records the *implementation* chosen after AQ-0016 was
approved: a `StoreBackend` Protocol with two concrete drivers, selected
at runtime from `DATABASE_URL`, plus Alembic migrations so staging and
production schema evolve via the same workflow.

## Decision Drivers

- **Zero-install dev loop** — `pip install -e .[portal]` + `uvicorn`
  must still work offline.  Postgres stays optional.
- **Managed identity in production** — no passwords in the AKS secret
  or Key Vault; AAD tokens flow from `DefaultAzureCredential`.
- **Router stability** — the existing sync router surface
  (`store.add(...)`, `store.update(...)`) should not require an async
  rewrite.  Async is a separate workstream.
- **One migration workflow** — Alembic applies cleanly to both SQLite
  (CI smoke) and Postgres (staging, prod).
- **Supply-chain hygiene** — new deps are opt-in via a `postgres`
  extra so SQLite-only deployments don't pull SQLAlchemy or asyncpg
  into their image.

## Considered Options

1. **StoreBackend Protocol + SQLite and Postgres drivers + Alembic
   (chosen)** — runtime dispatch on `DATABASE_URL`, shared
   engine/pool across store instances, managed-identity token
   injection via SQLAlchemy's `do_connect` event.
2. **SQLite + PVC only** (short-term PVC-fix) — keeps the dev loop
   simple but solves nothing for HA or FedRAMP; rejected as
   production-grade per AQ-0016.
3. **Azure Cosmos DB (NoSQL)** — multi-region, schemaless, managed
   identity supported; but the portal's data model is relational
   (FKs between sources, products, access requests) and Cosmos RU-s
   pricing is ~10× overspend for ~10 MB of structured metadata.
   Rejected as "wrong shape".
4. **Direct `asyncpg` without SQLAlchemy** — saves one dep and a bit
   of runtime overhead; loses Alembic (which requires SQLAlchemy),
   connection pooling, and dialect-aware DDL.  Rejected to preserve
   the migration story.
5. **Azure SQL Database** — Microsoft-native, T-SQL, but weaker JSON
   story than Postgres JSONB and a different driver (pyodbc) from
   everything else in the repo.  Rejected to keep ORM consistency.

## Decision Outcome

Chosen: **Option 1 — `StoreBackend` Protocol + SQLite (`SqliteStore`)
+ Postgres (`PostgresStore`) + Alembic**.

Concrete layout:

- `portal/shared/api/persistence.py` — `StoreBackend` Protocol plus
  the historical sync `SqliteStore` (WAL-mode, per-store cached
  connection, `BEGIN IMMEDIATE` for RMW cycles).
- `portal/shared/api/persistence_postgres.py` — `PostgresStore`
  backed by SQLAlchemy 2.0 + `psycopg` v3.  Managed-identity token
  injection via the `do_connect` event; tokens cached with a 5-minute
  refresh margin against `https://ossrdbms-aad.database.windows.net/.default`.
  `asyncpg` is declared in the extra for future async engine use.
- `portal/shared/api/persistence_factory.py` — `build_store_backend()`
  dispatches on `DATABASE_URL` scheme (sqlite / postgresql), fails
  closed on unknown schemes, and imports `persistence_postgres`
  lazily so the extra is only required where Postgres is used.
- `portal/shared/api/alembic/` — env.py resolves `DATABASE_URL` from
  settings at runtime, coerces async drivers to sync for migration
  runs, and reuses the same managed-identity token provider.
  Revision `0001_initial_schema.py` creates six JSON-blob tables
  (`sources`, `pipelines`, `pipeline_runs`, `access_requests`,
  `marketplace_products`, `marketplace_quality`) with dialect-aware
  JSON/JSONB column types.
- `pyproject.toml` — new `postgres` optional extra adds
  `sqlalchemy[asyncio]`, `asyncpg`, `psycopg[binary]`, `alembic`,
  `azure-identity`.

Routers call `build_store_backend("sources.json", settings)` instead
of `SqliteStore("sources.json")`.  The Protocol guarantees the method
surface is identical so no router logic changes.

## Consequences

- Positive: single code path for staging and production — no
  "SQLite on dev, hand-written psycopg on prod" divergence.
- Positive: managed identity everywhere in Azure; zero long-lived
  passwords in secret stores.
- Positive: JSONB in production gives a path to indexed queries
  (e.g. `(data->>'status')` on access requests) without a schema
  rewrite.
- Positive: Alembic handles both SQLite (CI smoke tests) and
  Postgres (staging / prod) via dialect-aware DDL.
- Positive: the `postgres` extra keeps the dev-loop install slim —
  SQLAlchemy + asyncpg + psycopg stay out of SQLite-only deployments.
- Negative: two drivers double the test matrix.  Integration tests
  against real Postgres are required — SQLite-only CI will miss
  dialect-specific bugs (ON CONFLICT, JSONB type coercion).
- Negative: the sync PostgresStore ties the router surface to
  blocking I/O.  A future ADR will evaluate async conversion once
  router-side `await` chains are already justified by other work.
- Negative: the managed-identity path depends on `DefaultAzureCredential`
  resolving an identity; misconfigured AKS workload identity or
  missing ``AZURE_CLIENT_ID`` envvar presents as a 3-5 second token
  timeout at first connection.  Runbook documentation is required.
- Neutral: Alembic revisions live under `portal/shared/api/alembic/`
  rather than the repo root `alembic/`, keeping the portal's state
  store isolated from any future platform-wide migration tree.

## Pros and Cons of the Options

### Option 1 — Protocol + dual driver + Alembic
- Pros: covers dev and prod with one code path, managed identity
  built in, Alembic migrations dialect-aware.
- Cons: dual driver (psycopg for sync, asyncpg for future async)
  doubles the test matrix; `DefaultAzureCredential` timeout is a
  first-connection cliff.

### Option 2 — SQLite + PVC only
- Pros: zero new dependencies; no driver matrix.
- Cons: no HA, no PITR, no FedRAMP inheritance; rejected by
  AQ-0016.

### Option 3 — Cosmos DB
- Pros: multi-region writes, schemaless, managed identity.
- Cons: wrong shape for relational portal data; RU-s pricing is a
  ~10× overspend for ~10 MB of metadata.

### Option 4 — Direct asyncpg
- Pros: saves SQLAlchemy + Alembic deps; lower latency.
- Cons: no migration story; has to hand-roll connection pooling
  and DDL per dialect.

### Option 5 — Azure SQL Database
- Pros: Microsoft-native, strong Azure integration.
- Cons: pyodbc is an outlier in the repo; weaker JSON support than
  Postgres JSONB; no free local equivalent.

## Migration plan

Data migration is **deferred** — this ADR delivers the dual-backend
runtime only.  The production cutover runbook (to be authored as part
of the CSA-0046 Phase 2 deployment task) will follow this checklist:

1. **Pre-cutover**: in staging, run
   `alembic -c portal/shared/api/alembic.ini upgrade head` against
   the Postgres Flexible Server.  Confirm all six tables exist and
   are empty.
2. **Data export**: emit each SQLite store as JSON using
   `store.list()` on a staging portal with production-equivalent
   data.
3. **Data import**: re-insert via `PostgresStore.add()` — the
   SQLite and Postgres row layouts are identical (`id TEXT` +
   `data JSONB`) so no field-level transformation is needed.
4. **Dual-write window (optional)**: none planned.  The portal is
   not write-heavy; a 5-minute read-only window during cutover is
   acceptable.
5. **Switch `DATABASE_URL`**: update the AKS/Container Apps
   environment variable to point at the Postgres Flexible Server;
   restart the portal.  Managed identity picks up the bearer token
   on the first connection.
6. **Verify**: portal health check (`/api/v1/health`) confirms the
   store is reachable.  React frontend sanity checks exercise each
   router.
7. **Archive the SQLite file** to the tenant's Azure Storage
   account with retention aligned to CP-9.

A standalone data-migration script is **out of scope for this ADR**
and will land in CSA-0046 Phase 2.

## Validation

We will know this decision is right if:

- `pip install -e .[portal]` continues to give a working dev portal
  without `postgres` installed.
- `pip install -e .[portal,postgres]` + `alembic upgrade head`
  against a Postgres Flexible Server instance brings the schema
  up on first run.
- `POSTGRES_USE_MANAGED_IDENTITY=true` with a correctly configured
  AKS workload identity authenticates without any passwords in
  the deployment manifest.
- The existing SQLite-backed portal test suite (`portal/shared/tests/`)
  continues to pass unchanged after the StoreBackend refactor.

## References

- Decision tree: n/a (runtime backend selection; see portal README).
- Related code:
  - `portal/shared/api/persistence.py`
  - `portal/shared/api/persistence_postgres.py`
  - `portal/shared/api/persistence_factory.py`
  - `portal/shared/api/config.py`
  - `portal/shared/api/main.py`
  - `portal/shared/api/alembic/env.py`
  - `portal/shared/api/alembic/versions/0001_initial_schema.py`
  - Router wiring:
    `portal/shared/api/routers/{sources,pipelines,access,marketplace}.py`
- Framework controls: NIST 800-53 **CP-9** (PITR backups — Flexible
  Server PITR is FedRAMP-inheritable), **SC-28** (encryption at rest
  via CMK on the storage account hosting the Flexible Server),
  **AU-9** (audit record protection — log flows to Log Analytics),
  **AC-2** (account management — portal identities federated with
  Entra ID + managed identity for data-plane auth),
  **IA-2** (passwordless authentication — bearer tokens, not
  passwords). See `governance/compliance/nist-800-53-rev5.yaml`.
- HIPAA Security Rule: §164.312(a)(2)(iv) (encryption and decryption
  at rest); §164.312(d) (person-or-entity authentication — managed
  identity). See `governance/compliance/hipaa-security-rule.yaml`.
- Preceding ADR: 0009 (strategic choice of Postgres Flexible Server
  for production).
- Approval record: AQ-0016.
- Discussion: CSA-0046.
