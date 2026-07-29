# Tutorial: DuckLake catalog editor

> CSA Loom `ducklake-catalog` editor — **Preview lab**. A Postgres-backed
> lakehouse-metadata catalog offered **alongside** the Iceberg REST Catalog: the
> DuckDB serving tier `ATTACH`es the DuckLake store and reads your Delta /
> Parquet data in place on your own ADLS Gen2. Azure-native + OSS — **no
> Microsoft Fabric**.

## What it is

Most lakehouse catalogs keep table metadata as a tree of metadata files next to
the data. DuckLake keeps it in a **SQL database** (Postgres) instead: table
identities, schemas, and snapshot pointers become ordinary rows, so catalog
operations are transactional and queryable with SQL. The data itself never
moves — it stays as Delta / Parquet on your ADLS Gen2, and the DuckDB tier reads
it in place.

This is a **Preview lab** tagged as such in the header. It is an *alternative*
to, not a replacement for, the Iceberg REST Catalog — pick whichever matches the
engine mix you have to serve. Both are Azure-native and OSS, and neither needs
Microsoft Fabric.

## When to use it

- Your engines can `ATTACH` a DuckLake catalog and you want catalog metadata in
  a database you can query, back up, and audit like any other Postgres table.
- You are evaluating catalog options next to the Iceberg REST Catalog.
- For broad external-engine interop (Spark, Trino, Snowflake, Flink), the
  **Iceberg REST Catalog** on the Lakehouse **Interop** tab remains the default
  recommendation.

## Step-by-step in Loom

1. **Create the item.** **+ New item → DuckLake catalog**. The editor opens at
   `/items/ducklake-catalog/<id>` with a **Preview** badge and, once wired, a
   badge naming the attached catalog.
2. **Read the Learn popover.** The header popover explains the trade-off in one
   paragraph — SQL-database catalog vs metadata-file tree — and when to prefer
   the Iceberg REST Catalog instead.
3. **Browse the tables.** On open the editor calls `GET /api/ducklake/catalog`,
   which `ATTACH`es the DuckLake Postgres store **on the DuckDB tier** and reads
   `information_schema`. The result renders as a real table listing of
   `schema` / `name` — never a fabricated list. Every read (success or failure)
   is audited with the caller's principal and the row count.
4. **Register tables.** The catalog surface is **read-only**. Tables appear here
   once they are registered into the DuckLake Postgres store by the engine that
   owns them; the editor then lists them on the next refresh.

## The Azure backend it rides on

- **Catalog store:** a **Postgres** database addressed by
  `LOOM_DUCKLAKE_CATALOG_URL`. Deployed by default with the platform
  (`platform/fiab/bicep/modules/data-plane/ducklake-catalog-postgres.bicep` — a
  private-endpoint-only Azure Database for PostgreSQL flexible server,
  `Standard_B1ms`); the connection string is written to the Loom Key Vault and
  bound to the Console as a secretRef, never as a plain env var.
- **Query engine:** the **DuckDB serving tier** (`LOOM_DUCKDB_URL`) — the same
  Container App SQL Lab uses — which performs the `ATTACH` and the
  `information_schema` read.
- **Data:** Delta / Parquet on your own **ADLS Gen2**, read in place.
- **Audit:** each `catalog.list` operation writes an audited access row.

## Honest gates

| Condition | What you see | Exact remediation |
|---|---|---|
| `LOOM_DUCKLAKE_CATALOG_URL` unset | Guided empty state + Fix-it card (warning, never red on first open) | Bicep wires this by default in **both** clouds — PostgreSQL Flexible Server is an Azure Government service ([Learn: supported regions](https://learn.microsoft.com/azure/postgresql/overview#azure-regions)), so `gcc-high.bicepparam` and `il5.bicepparam` both default `postgresQuotaAvailable` to `true`. It is unset only when an operator deliberately sets `LOOM_POSTGRES_QUOTA_AVAILABLE=false` (a **subscription** quota restriction, not a regional gap — request an increase at <https://aka.ms/postgres-request-quota-increase>, then unset it), or when you point the var at your own server. The Iceberg REST Catalog and every other surface are unaffected |
| DuckDB tier missing (upstream 503) | Fix-it card naming the missing variable | The N2 DuckDB serving tier is also deployed by default (`admin-plane/main.bicep` → `duckdbTierActive`), so this too should not appear on a normal install. If it does, the `loom-duckdb` image is almost certainly not in the deployment's ACR. **The tag the template pulls is `appImageTags.duckdb` (`LOOM_DUCKDB_TAG`, default `v0.1`)** — run `full-app-deploy-commercial.yml` (Commercial, `tag` input defaults to the same `v0.1`) or `gov-provision-dataplane-images.yml` (GCC-High / IL5, `image_tag` input defaults to the same `v0.1`). Both Gov deploy lanes now image-preflight that exact tag (`scripts/ci/assert-acr-image-tags.sh`) and refuse to deploy over a live estate without it |
| Catalog wired but unreachable | *"The DuckLake catalog did not answer"* empty state carrying the upstream reason | Check Postgres reachability / firewall from the DuckDB tier |
| Wired and reachable, no tables | *"No tables in the DuckLake catalog yet"* | Register a Delta/Parquet table into the DuckLake store |
| `n8-ducklake-catalog` flag off | Guided "turned off" notice; the Iceberg REST Catalog, the `/api/ducklake/**` routes and every other editor keep working | Re-enable the flag in **Admin → Runtime flags** |

## No Fabric required

Postgres + Container Apps + ADLS Gen2. No Fabric capacity, workspace, OneLake
path, or Power BI workspace is involved.

## Learn more

- SQL Lab editor tutorial: `editor-sql-lab.md`
- Lakehouse editor tutorial (Interop tab / Iceberg REST Catalog):
  `editor-lakehouse.md`
- S3-compatible gateway lab: `editor-s3-gateway.md`
