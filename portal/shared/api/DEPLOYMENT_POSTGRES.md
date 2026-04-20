# Portal persistence — Postgres cutover

This document covers the runtime and deployment steps for moving the
CSA-in-a-Box portal backend from its default SQLite persistence to
Azure Database for PostgreSQL Flexible Server (CSA-0046 / AQ-0016).

SQLite is preserved as the default for local development, demo, and
ephemeral CI — no action is required to keep running that path.  Only
staging and production environments need to perform this cutover.

## Architecture

```
portal.shared.api.routers.*        (sync call sites — unchanged)
            │
            ▼
portal.shared.api.persistence.StoreBackend   (Protocol)
            │
            ├── SqliteStore            (default — file-backed)
            └── PostgresStore          (SQLAlchemy + psycopg v3)
                        │
                        └── Azure Database for PostgreSQL Flexible Server
                            (managed identity via DefaultAzureCredential)
```

Backend selection happens once at module load in each router via
`persistence_factory.build_store_backend(filename, settings)`.
The factory inspects `settings.DATABASE_URL`:

- empty / `sqlite://...` → `SqliteStore`
- `postgresql://...`, `postgresql+asyncpg://...`, `postgresql+psycopg://...`
  → `PostgresStore`
- anything else → `ValueError` (fails closed at startup)

## Environment variables

| Variable                          | Required?             | Example                                                                                                         |
| --------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                    | Postgres only         | `postgresql://portal-mi@csa-pg-prod.postgres.database.azure.com:5432/portal?sslmode=require`                    |
| `POSTGRES_USE_MANAGED_IDENTITY`   | Postgres, recommended | `true`                                                                                                          |
| `POSTGRES_SSL_MODE`               | Postgres              | `require` (default) or `verify-full`                                                                            |
| `POSTGRES_HOST` / `POSTGRES_DB`   | optional              | legacy per-component override for templates that pre-date `DATABASE_URL`                                        |
| `DATA_DIR`                        | SQLite only           | `./data`                                                                                                        |

When `POSTGRES_USE_MANAGED_IDENTITY=true`, any password embedded in
`DATABASE_URL` is ignored — `DefaultAzureCredential` supplies a fresh
AAD token per new pool connection, scoped to
`https://ossrdbms-aad.database.windows.net/.default`, cached for the
duration of its lifetime minus a 5-minute refresh buffer.

## One-time Azure setup (managed identity)

1. Create (or reuse) a user-assigned managed identity in the same
   subscription as the portal App Service / Container App.
2. Enable Microsoft Entra authentication on the Flex Server and add
   the identity as an Entra administrator:
   ```bash
   az postgres flexible-server ad-admin create \
     --resource-group <rg> \
     --server-name <csa-pg-prod> \
     --display-name csa-portal-mi \
     --object-id <identity-object-id> \
     --type ServicePrincipal
   ```
3. Connect once using an Entra admin to create a role mapped to the
   identity and grant privileges:
   ```sql
   SELECT * FROM pgaadauth_create_principal('csa-portal-mi', false, false);
   GRANT CONNECT ON DATABASE portal TO "csa-portal-mi";
   GRANT USAGE  ON SCHEMA public    TO "csa-portal-mi";
   GRANT ALL    ON SCHEMA public    TO "csa-portal-mi";
   ```
4. Assign the identity to the portal compute resource and set the
   env vars above.  No password is needed in the URL.

## Apply schema migrations

Alembic migrations live under `portal/shared/api/alembic/`.  The
initial revision (`0001_initial_schema.py`) creates one table per
logical store (`sources`, `pipelines`, `pipeline_runs`,
`access_requests`, `marketplace_products`, `marketplace_quality`),
each with `id TEXT PRIMARY KEY` and a `data JSONB` column.

Run against the target environment:

```bash
# Staging / production
export DATABASE_URL="postgresql://csa-portal-mi@csa-pg-stg.postgres.database.azure.com:5432/portal?sslmode=require"
export POSTGRES_USE_MANAGED_IDENTITY=true

alembic -c portal/shared/api/alembic.ini upgrade head
```

Override the URL without exporting to the app process via
`ALEMBIC_DATABASE_URL` — useful in CI when the runner needs a one-off
connection string.

To generate a new revision:

```bash
alembic -c portal/shared/api/alembic.ini revision \
  -m "describe your schema change"
```

## Install the runtime extra

The Postgres dependencies live under an optional `postgres` extra so
SQLite deployments stay lean:

```bash
pip install -e '.[portal,postgres]'
```

`postgres` pulls in SQLAlchemy 2.x, psycopg v3, alembic, and
azure-identity.

## Migrating existing SQLite data

Records are schema-identical (id/data blob), so a one-shot copy
is straightforward:

```python
from portal.shared.api.config import settings
from portal.shared.api.persistence import SqliteStore
from portal.shared.api.persistence_postgres import PostgresStore

for filename in (
    "sources.json", "pipelines.json", "pipeline_runs.json",
    "access_requests.json", "marketplace_products.json",
    "marketplace_quality.json",
):
    src = SqliteStore(filename, data_dir=settings.DATA_DIR)
    dst = PostgresStore(
        filename,
        database_url=settings.DATABASE_URL,
        use_managed_identity=settings.POSTGRES_USE_MANAGED_IDENTITY,
    )
    for row in src.list():
        dst.add(row)
```

Run this once after `alembic upgrade head` and before traffic is
cut over.  The idempotent `INSERT ... ON CONFLICT DO UPDATE` path
makes the copy safely re-runnable.

## Rollback

Revert `DATABASE_URL` to empty (or a `sqlite:///...` URL) and restart
the portal backend.  The SQLite file under `DATA_DIR` is untouched
by the Postgres path, so no data is lost.  Schema migrations are
additive in revision `0001` — no destructive downgrade is required
for rollback.
