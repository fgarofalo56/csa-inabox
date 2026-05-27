# Loom Synapse Serverless SQL Pool — Azure-Studio-parity spec

> Captured 2026-05-26. Source: Synapse Studio Develop hub + Data hub (OPENROWSET / external-table flows) + `apps/fiab-console/lib/editors/synapse-sql-editors.tsx` (`SynapseServerlessSqlPoolEditor`).

## Overview
Synapse Serverless SQL Pool is the on-demand T-SQL engine that ships built-in with every Synapse workspace — no provisioning, no pause/resume, billed per TB processed. It queries Parquet / Delta / CSV directly out of ADLS Gen2 via `OPENROWSET` or via external tables that live in user-created databases on the `master`-rooted serverless endpoint (`{ws}-ondemand.sql.azuresynapse.net`). In the Azure-native data stack it's the cheap lake-query surface that pairs with Dedicated (warehouse) and Spark (notebooks) — and is the closest semantic match to Fabric Warehouse for ad-hoc lake queries.

## Synapse Studio UX

### Develop hub — SQL script tab (Serverless connection)
- **Top toolbar**: connection picker fixed to **Built-in** serverless endpoint, database dropdown (`master` + user DBs), **Run** / **Run selection** / **Cancel**, **Publish**, **Properties**
- **Data processed** indicator (per-query MB scanned — directly tied to billing)
- **Monaco T-SQL editor** with intellisense over the serverless catalog (databases, external tables, views, file-format objects, data-source objects)
- **Results / Messages tabs** — sortable grid, **Export to CSV/JSON**, "data processed = X MB" footer

### Data hub — Linked tab (ADLS browsing)
- ADLS Gen2 account tree → containers → folders → files
- Right-click on a `.parquet` / `.csv` / Delta folder: **New SQL script → Select TOP 100 / Create external table**
  - **Create external table** dialog: target database, target schema, target table name, "Using SQL script" or "Using template" radio — auto-infers schema from file
- **Bulk load** ("Copy into Warehouse") routed to Dedicated, not Serverless

### Data hub — Workspace tab (user databases)
- **SQL databases → {db} → External tables / External resources (data sources, file formats, scoped credentials) / Views / Stored procedures**
- Each external table → right-click → New SQL script → SELECT / CREATE STATISTICS / DROP

### Manage hub — SQL pools blade
- Built-in serverless row, **non-pausable** badge
- **Cost control** icon (hover) — sidebar with **daily / weekly / monthly TB budget** toggles; backed by `sp_set_data_processed_limit`

## What Loom has today (`SynapseServerlessSqlPoolEditor`)
- Fluent UI `ItemEditorChrome` with `SYN_SSQL_RIBBON` (Home → Query group + Cost group; primary action wired)
- **Endpoint badge** — green when `schema.ok`, severe red MessageBar pattern when endpoint env not configured
- **Database picker** as a `Tree` of `sys.databases WHERE database_id > 4` (queried live via `executeQuery(serverlessTarget('master'))`); current selection annotated with `·` glyph; `master` always present
- **Lake tree node** — auto-populated from `LOOM_BRONZE_URL` / `LOOM_SILVER_URL` / `LOOM_GOLD_URL` / `LOOM_LANDING_URL` env (the four medallion ADLS containers the FiaB deployment provisions), each clickable as an OPENROWSET target
- **Sample queries** tree node — server-supplied set: SELECT 1 smoke, `OPENROWSET` over bronze Parquet, `OPENROWSET` over gold Delta — clicking seeds the editor textarea
- **T-SQL textarea** + **Run** button → POST `/api/items/synapse-serverless-sql-pool/[id]/query` with `{sql, database}`
- Real TDS query via shared `synapse-sql-client.ts` (`serverlessTarget(database)`) against `{ws}-ondemand.sql.azuresynapse.net`, AAD-token auth with the workspace UAMI as AAD admin
- **Results grid** (Fluent `Table`) with execution-ms badge, row-count badge, "truncated at 5,000" badge, error MessageBar with SQL error code
- No pause/resume verb (correctly omitted — serverless has none)

## Gaps for parity (numbered)
1. **Monaco intellisense** — plain `<textarea>` today; the Develop hub editor has full T-SQL intellisense over OPENROWSET + external-table catalog
2. **Multi-tab editor** — one query window per editor instance
3. **Run selection** — entire textarea runs; no shift-select-and-run
4. **Data-processed indicator** — Studio shows MB-per-query in the footer; Loom shows execution time but not bytes scanned. `sys.dm_external_data_processed` would surface this
5. **Cost control sidebar** — Loom ribbon declares "Bytes processed" and "Cost cap" actions but there is no UI panel wired to `sp_set_data_processed_limit` / `sys.configurations`
6. **External-table catalog tree** — Loom shows user databases as flat names, not the External tables / Views / File formats / Data sources hierarchy
7. **ADLS-file right-click → create external table** — Studio's killer ergonomics for serverless; Loom's lake tree shows the four medallion roots but no per-file browse + `CREATE EXTERNAL TABLE` wizard
8. **Results export** to CSV/JSON
9. **Schema inference helper** — Studio offers `sp_describe_first_result_set` integration to refine column types before persisting an external table
10. **Database-scoped credentials editor** — managing `CREDENTIAL` / `DATA SOURCE` / `FILE FORMAT` objects via UI (Loom requires hand-written DDL)

## Backend mapping
| Capability | Backend module | Notes |
|---|---|---|
| T-SQL query | `lib/azure/synapse-sql-client.ts` (`executeQuery`, `serverlessTarget(database)`) | TDS via `mssql`, AAD scope `https://database.windows.net/.default`, server `{ws}-ondemand.sql.azuresynapse.net` |
| Schema / lake tree | `app/api/items/synapse-serverless-sql-pool/[id]/schema/route.ts` | `SELECT name FROM sys.databases WHERE database_id > 4` for user DBs; medallion containers from `LOOM_BRONZE_URL` env etc; sample SQL hard-coded server-side |
| Run query | `app/api/items/synapse-serverless-sql-pool/[id]/query/route.ts` | Routes through the same TDS path; `database` body field selects the target DB |
| Cost control (not wired) | T-SQL via existing client: `EXEC sp_set_data_processed_limit @type='daily', @limit_tb=N` | Read-back: `SELECT * FROM sys.configurations WHERE name LIKE 'Data processed %'` |
| Data-processed (not wired) | `SELECT * FROM sys.dm_external_data_processed` | One-row DMV; could lazy-load in result footer per query |

## Required Azure resources
- Azure Synapse Analytics workspace (the built-in serverless endpoint is automatic per workspace; no separate resource)
- Workspace UAMI set as **AAD admin** on the workspace (for query auth) — `Microsoft.Synapse/workspaces/administrators`
- `Storage Blob Data Contributor` (or finer-grained ACLs) on the four medallion ADLS containers for the UAMI
- Private endpoint to `{ws}-ondemand.sql.azuresynapse.net` on the spoke VNet
- Env: `LOOM_SYNAPSE_WORKSPACE`, `LOOM_BRONZE_URL`, `LOOM_SILVER_URL`, `LOOM_GOLD_URL`, `LOOM_LANDING_URL`
- Bicep already wires the workspace + ADLS containers + role assignments in `platform/fiab/bicep/modules/synapse/*.bicep` and `platform/fiab/bicep/modules/storage/*.bicep`

## Estimated effort to close remaining gaps
- Items 1–3 (Monaco + multi-tab + Run selection): **0.5 session** — shared component will close both Dedicated and Serverless gaps together
- Items 4, 5 (data-processed footer + cost-cap sidebar): **0.5 session** — both are existing T-SQL surfaces; the sidebar form maps 1:1 to `sp_set_data_processed_limit`
- Item 6 (full external-table catalog tree): **0.5 session** — new BFF route querying `sys.external_tables`, `sys.views`, `sys.external_data_sources`, `sys.external_file_formats`
- Items 7, 9, 10 (ADLS-file → create-external-table wizard + scoped-credential editor): **1 session** — needs ADLS Gen2 list-paths API integration + schema inference call

**Total to A+**: ~2.5 sessions, of which ~1 session is shared with the Dedicated spec (Monaco editor). Today's grade is honest A — the primary action (Run T-SQL on `{ws}-ondemand` against real ADLS) works end-to-end with real lake URIs and real OPENROWSET samples; remaining work is convenience and cost-governance polish.
