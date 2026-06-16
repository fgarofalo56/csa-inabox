# mirrored-databricks — parity with Fabric Mirrored Azure Databricks Catalog

Source UI: Microsoft Fabric — "Mirrored Azure Databricks Catalog" item ·
https://learn.microsoft.com/fabric/database/mirrored-database/azure-databricks ·
Databricks Unity Catalog REST ·
https://learn.microsoft.com/azure/databricks/dev-tools/api/

A Fabric Mirrored Azure Databricks Catalog mounts a Databricks Unity Catalog so
its tables are queryable in the lakehouse/warehouse SQL endpoint without copying
data. Per no-fabric-dependency.md Loom realizes this **Azure-native**: the UC
tables are Delta files already in ADLS Gen2, and the "mount" is a paired Synapse
Serverless SQL endpoint that reads them in place (OPENROWSET FORMAT='delta') — no
Microsoft Fabric / OneLake.

## Azure/Fabric feature inventory
| # | Capability | Source UI |
|---|------------|-----------|
| 1 | Mount/select a Unity Catalog | create dialog |
| 2 | Browse catalog schemas | Catalog tab |
| 3 | Browse tables in a schema | Tables tab |
| 4 | **Pair a SQL analytics endpoint** (catalog becomes queryable) | auto on mirror |
| 5 | Surface the SQL endpoint + database to query | SQL endpoint affordance |
| 6 | Settings (catalog/host), delete | settings |
| 7 | OneLake security | security tab |

## Loom coverage
| # | State | Notes |
|---|-------|-------|
| 1 | ✅ built | Create dialog → POST `/api/items/mirrored-databricks` (validates UC + pairs the endpoint, see #4) |
| 2 | ✅ built | Catalog tab → `/[id]/catalog` (UC `/schemas` REST) |
| 3 | ✅ built | Tables tab → `/[id]/catalog?schema=` (UC `/tables` REST) |
| 4 | ✅ built | **(audit H8 fix)** create resolves the catalog's queryable Delta tables (`resolveUcMirrorTables`) and pairs a `synapse-serverless-sql-pool` that builds one `OPENROWSET(...FORMAT='delta')` view per UC table over its own abfss storage location. Same on the install path via `ITEM_PAIRING_RULES['mirrored-databricks']` + `mirroredDatabricksProvisioner` |
| 5 | ✅ built | SQL endpoint tab → `/[id]/sql-endpoint` shows the paired endpoint + per-mirror database (`loom_dbxmirror_<name>`) + view count, with a copy-able OPENROWSET query hint |
| 6 | ✅ built | Settings tab (catalog/host edit, delete) |
| 7 | ✅ built | OneLake security tab |

Honest-gates (no silent config-doc-only success): create returns `pairing.gate`
naming the exact requirement when `LOOM_DATABRICKS_HOSTNAME` is unset
(`NO_DATABRICKS`), the catalog has no queryable Delta tables (`NO_TABLES`), or
`LOOM_SYNAPSE_WORKSPACE` is unset (`NO_SYNAPSE`). The mirror is still created but
the editor shows the gate, not a fake success.

## Backend per control
- Create + pair → POST `/api/items/mirrored-databricks`:
  - `resolveUcMirrorTables(catalog)` — UC `/schemas` + `/tables` (+ `getUcTable` for `storage_location`); keeps Delta tables with a resolvable ADLS location.
  - `createOwnedItem('synapse-serverless-sql-pool', { content:{ databricksMirrorItemId, ucCatalogName, ucTables } })` + `synapseSqlPoolProvisioner` → per-mirror DB, WorkspaceIdentity (workspace MSI) credential, one EXTERNAL DATA SOURCE per storage-account root, one Delta OPENROWSET view per table, `SELECT TOP 10` receipt.
- SQL endpoint → GET `/[id]/sql-endpoint` (Cosmos read of the mirror's recorded pairing + a live query for the paired item).
- Schemas/tables → GET `/[id]/catalog` (Databricks UC REST 2.1).
- Query the mounted catalog: connect any T-SQL client to the Synapse Serverless `-ondemand` endpoint, `USE [loom_dbxmirror_<name>]`, `SELECT * FROM [dbo].[<schema>_<table>]`.
