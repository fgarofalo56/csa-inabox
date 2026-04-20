---
status: accepted
date: 2026-04-20
deciders: csa-inabox platform team
consulted: security, governance, dev-loop, copilot, bff
informed: all
---

# ADR 0016 — Async `StoreBackend` is canonical; sync layer is transitional

## Context and Problem Statement

ADR-0015 (CSA-0046) shipped the `StoreBackend` Protocol + dual backends
(`SqliteStore` + `PostgresStore`) synchronously because the existing
FastAPI routers were already synchronous and converting them was
called out as a separate workstream:

> Negative: the sync PostgresStore ties the router surface to blocking
> I/O.  A future ADR will evaluate async conversion once router-side
> `await` chains are already justified by other work.  — ADR-0015

That separate workstream is now justified.  Three concrete forces
push the portal into `async def` end-to-end:

1. **Copilot streaming** — `apps/copilot` emits Server-Sent Events
   over long-lived HTTP responses.  Every blocking `store.get(...)`
   on the router thread starves that stream because FastAPI holds
   the event loop while the sync call-site blocks in the
   thread-pool executor.
2. **BFF concurrency** — `routers/auth_bff.py` already runs async
   (ADR-0014).  Having the session store async while the persistence
   store is sync is a confusing dichotomy that regularly trips
   contributors.
3. **Postgres connection efficiency** — SQLAlchemy 2.0's `AsyncEngine`
   + `asyncpg` amortises the AAD token-fetch cost across the pool
   in a way the sync `psycopg` path cannot (the sync engine blocks
   the event loop on every new connection while the AAD token is
   minted).

The question this ADR answers is: *given the async conversion is now
required, do we rip out the sync layer, run a thread-pool bridge, or
keep the sync layer as a transitional compat path?*

## Decision Drivers

- **Non-regressive test suite** — the 150-test suite against the sync
  store must not break during the refactor.
- **Supply-chain hygiene** — no new mandatory deps on `aiosqlite` or
  `sqlalchemy[asyncio]` for SQLite-only deployments.
- **Migration runway** — consumers that import `from
  portal.shared.api.persistence import SqliteStore` outside the tree
  (there are none in this repo today, but the public surface hints at
  future re-use) get at least one minor release to migrate.
- **FastAPI-native concurrency** — no `asyncio.run_in_executor` paper
  bridges.  The routes must be genuinely async end-to-end.
- **Production-grade error surface** — typed exceptions
  (`StoreBackendError`, `StoreConnectionError`,
  `MigrationDigestMismatchError`, `MigrationPartialFailure`) + tenacity
  retries on transient driver errors.
- **Data migration must be first-class** — ADR-0015 explicitly
  deferred the migration CLI; without it, operators cannot move
  production data from SQLite to Postgres.

## Considered Options

1. **AsyncStoreBackend as canonical + sync retained as compat
   (chosen)** — add an async Protocol, async SQLite
   (`aiosqlite`) and async Postgres (`sqlalchemy.ext.asyncio` +
   `asyncpg`) stores, convert the routers to `await`-style via
   FastAPI `Depends`, and leave the sync layer in place — marked
   deprecated in docstrings — for one minor release.
2. **Stay sync forever** — keep `SqliteStore` + `PostgresStore` +
   router code synchronous.  Simpler in the short term; blocks
   Copilot streaming, creates ever-more awkward mixing with the
   already-async BFF path, and bottlenecks Postgres through the
   synchronous driver.
3. **Thread-pool the sync store from async routes** — wrap each
   sync call in `asyncio.to_thread` / `run_in_executor`.  Avoids
   adding async drivers but leaks threads under FastAPI concurrency,
   doubles latency on fast reads, and introduces a second class of
   bug (thread-local connection reuse collisions under load).
4. **Delete the sync layer immediately** — cleanest architecturally
   but any out-of-tree consumer that imports `SqliteStore` would
   break without warning on upgrade.

## Decision Outcome

Chosen: **Option 1 — `AsyncStoreBackend` canonical; sync layer
transitional.**

Concrete layout:

- `portal/shared/api/persistence_async.py` — `AsyncStoreBackend`
  Protocol plus:
  - `AsyncSqliteStore` — `aiosqlite`-backed; preserves WAL, PRAGMAs,
    `BEGIN IMMEDIATE` semantics; `asyncio.Lock` replaces
    `threading.RLock`.
  - `AsyncPostgresStore` — `sqlalchemy.ext.asyncio.AsyncEngine` +
    `asyncpg`; per-URL engine cache; managed-identity token injection
    via `DefaultAzureCredential.aio`; password-callable bridge so
    asyncpg picks up rotating tokens without pool restarts.
  - `build_async_store_backend()` — dispatch on `DATABASE_URL`,
    fails closed on unknown schemes (mirrors sync factory exactly).
  - Typed exceptions + tenacity retries (3 attempts, jittered
    exponential backoff) on transient driver errors.
  - `close_async_engines()` — lifespan shutdown hook disposes the
    engine pool + closes the AAD credential.
- `portal/shared/api/dependencies.py` — singleton async store
  instances wired into FastAPI via `Depends` getters
  (`get_sources_store`, `get_pipelines_store`, `get_runs_store`,
  `get_access_store`, `get_products_store`, `get_quality_store`).
- `portal/shared/api/routers/{access,marketplace,pipelines,sources,stats}.py`
  — every route is `async def`; every persistence call is `await`;
  stores resolved via `Annotated[AsyncStoreBackend,
  Depends(get_*_store)]`.
- `portal/shared/api/main.py` — lifespan calls async `seed_demo_*`
  coroutines on startup and `close_async_engines()` on shutdown.
- `scripts/migrate_portal_persistence.py` — standalone CLI that
  walks every portal store (or a `--tables` subset), reads via the
  async SQLite/Postgres store, writes via `INSERT ... ON CONFLICT
  DO NOTHING`, computes sha256 row digests, and emits a structured
  report.  Dry-run mode available.  Exit codes document every
  failure class.
- Sync layer (`persistence.py`, `persistence_postgres.py`,
  `persistence_factory.py`) retained with deprecated-in-docstring
  markers.  To be removed in the next minor release (**CSA-0046 v3**)
  after tenant teams have had one release to migrate.

## Consequences

- Positive: FastAPI routes now participate in the async event loop
  end-to-end; Copilot SSE streams and BFF session flows no longer
  compete with blocking persistence calls.
- Positive: Postgres under load benefits from the asyncpg pool
  (shared across all six stores) + non-blocking AAD token refresh.
- Positive: first-class migration CLI closes the CSA-0046 deferred
  item; operators can now migrate SQLite → Postgres with a single
  command + verified row digests.
- Positive: explicit typed exceptions make test assertions crisp and
  let operators distinguish "database unreachable" from "row-level
  digest mismatch" in alerting.
- Negative: dual layer doubles the store surface.  Mitigated by the
  deprecation timeline and by having the async and sync stores share
  the same physical table schema (both the SQLite and Postgres
  layouts are unchanged from ADR-0015).
- Negative: `aiosqlite` + `sqlalchemy[asyncio]` + `asyncpg` now
  carry the full async stack; install size for the `postgres` extra
  grows by ~4 MB.  Acceptable for production but the sync-SQLite-only
  dev-loop (`pip install -e .[portal]`) remains slim because the
  async SQLite dep lives under the `postgres` extra too.
- Negative: aiosqlite opens a background executor thread per
  connection.  In the FastAPI process this is a non-issue (one
  connection per store, reused for the life of the process), but
  tests that spin up fresh stores every test must close them
  explicitly.  `conftest.py` uses the sync compat layer for that
  path to avoid a per-test `asyncio.run`.

## Pros and Cons of the Options

### Option 1 — Async canonical + sync compat (chosen)

- Pros: covers the whole codebase in one pass, no stranded behaviour,
  consumers get a one-release deprecation window, migration CLI is
  the natural end-to-end smoke test of the async surface.
- Cons: dual layer to maintain for one release; CI test matrix
  slightly larger.

### Option 2 — Stay sync

- Pros: zero refactor effort.
- Cons: blocks Copilot streaming + BFF concurrency + async Postgres;
  technical debt compounds.

### Option 3 — Thread-pool the sync store

- Pros: no new async drivers; minimal code churn on the sync store.
- Cons: leaks executor threads under FastAPI concurrency; doubles
  latency for fast reads; breaks the `BEGIN IMMEDIATE` serialisation
  guarantee when the threaded wrapper deadlocks with
  `_WRITE_LOCK`.  Rejected.

### Option 4 — Delete sync layer

- Pros: cleanest endpoint.
- Cons: breaks any out-of-tree consumer without a deprecation window.
  Rejected pending at least one transitional release.

## Migration + deprecation timeline

| Release | Action |
|---------|--------|
| CSA-0046 v2 (this ADR) | Async canonical.  Sync layer retained + deprecated docstrings.  Migration CLI shipped. |
| CSA-0046 v3 (next minor) | Sync layer removed from `portal.shared.api.persistence` + `persistence_postgres`.  `build_store_backend` removed.  `dependencies.py` becomes the only public store entry-point. |

Data migration between SQLite and Postgres is performed with
`scripts/migrate_portal_persistence.py`.  The script is idempotent
(`ON CONFLICT DO NOTHING`) and non-destructive (never writes to the
source), so rollback is "drop the target tables and re-run" — the
script documents this in its docstring.

## Validation

We will know this decision is right if:

- `python -m pytest portal/shared/tests/` passes unchanged for the
  existing 150-test sync-exercising suite + the new
  `test_async_persistence.py` and `test_migration_cli.py` tests.
- `python scripts/migrate_portal_persistence.py --help` prints usage
  and exits cleanly.
- A full end-to-end migration of a seeded SQLite portal into a
  fresh Postgres Flexible Server using the CLI completes with
  `digest_mismatches=0` on every table.
- Under load, P95 latency on `/api/v1/sources` drops vs the sync
  baseline because `await` on the async Postgres driver is
  non-blocking.
- Copilot SSE streams no longer show gaps when the portal is under
  persistence load (the original driver for this ADR).

## References

- Decision tree: n/a.
- Related code:
  - `portal/shared/api/persistence_async.py`
  - `portal/shared/api/dependencies.py`
  - `portal/shared/api/routers/*.py`
  - `portal/shared/api/main.py`
  - `scripts/migrate_portal_persistence.py`
  - `portal/shared/tests/test_async_persistence.py`
  - `portal/shared/tests/test_migration_cli.py`
- Framework controls: NIST 800-53 **AC-3** (access enforcement —
  async route scoping preserved verbatim), **AU-3** (content of audit
  records — audit emissions still run inside the request scope),
  **CP-9** (inherited from ADR-0015's Postgres choice), **SC-28**
  (encryption at rest — unchanged), **IA-2** (passwordless auth —
  `DefaultAzureCredential.aio` supplies MI tokens).
- Preceding ADR: 0015 (Postgres portal persistence — explicitly
  deferred this work).
- Discussion: CSA-0046 follow-on.
