# sql-analytics-endpoint — parity with the Fabric SQL analytics endpoint

Source UI: **Fabric SQL analytics endpoint** — the read-only T-SQL endpoint
automatically provisioned over a Lakehouse's Delta tables
(<https://learn.microsoft.com/fabric/data-engineering/lakehouse-sql-analytics-endpoint>).
Azure-native realization: **Synapse Serverless SQL** (`OPENROWSET` + Delta over
the medallion ADLS Gen2 lake):
<https://learn.microsoft.com/azure/synapse-analytics/sql/develop-openrowset>.
No Microsoft Fabric dependency (`no-fabric-dependency.md`).

> **Scope note:** In Fabric the SQL analytics endpoint is not a standalone item
> — it is the auto-generated T-SQL face of a Lakehouse (and of a Mirrored
> database). Loom realizes it the same way: there is **no standalone
> `sql-analytics-endpoint` editor or catalog entry**. The endpoint is the SQL
> surface of the **lakehouse** editor, backed by its own dedicated SQL route
> (`/api/items/lakehouse/[id]/query`). This doc records the parity of that
> endpoint; the host editor's full parity lives in the lakehouse parity doc.

## Azure/Fabric feature inventory

1. **Auto-provisioned read-only T-SQL endpoint** over the lakehouse Delta tables.
2. **Run T-SQL SELECT** across Delta tables (and raw CSV/Parquet via OPENROWSET).
3. **Cross-item joins** across lakehouses / mirrored databases from one endpoint.
4. **Multi-recordset + messages** result surface (query grid).
5. (Fabric endpoint extras) visual query builder, saved views, endpoint-level SQL security / OneLake identity mode, semantic-model default handoff.

## Loom coverage    (built ✅ / honest-gate ⚠️ / MISSING ❌)

| # | Capability | Status | Notes |
|---|---|---|---|
| 1 | Endpoint over the lakehouse | ✅ | The lakehouse's ADLS Gen2 medallion (bronze/silver/gold/landing) is served by Synapse Serverless (`-ondemand`) — the same backend the Files/Preview tab uses. |
| 2 | Run T-SQL / OPENROWSET | ✅ | `POST /api/items/lakehouse/[id]/query` executes real T-SQL via the Synapse Serverless TDS client (`executeQuery(serverlessTarget(database), sql)`) — no mock data. |
| 3 | Cross-item joins | ✅ | Serverless SQL over the shared lake supports joins across mirror/lakehouse OPENROWSET/Delta paths. |
| 4 | Result grid (recordsets + messages) | ✅ | Route returns the real result set + endpoint FQDN + executedBy. |
| 5 | Visual query builder / saved views / endpoint SQL-security / model handoff | ❌ | Not built at the endpoint level (some overlap exists in the warehouse/lakehouse surfaces). |

## Backend per control

- SQL execution → `app/api/items/lakehouse/[id]/query/route.ts` →
  `synapse-sql-client` (`serverlessTarget`, `executeQuery`,
  `getSynapseSqlSuffix`). Enforces `sql` non-empty and ≤ 64 KB.
- **Honest gate:** if `LOOM_SYNAPSE_WORKSPACE` is unset the route returns 503
  `code: 'synapse_not_configured'` naming the exact env var (the Synapse
  workspace whose `-ondemand` serverless endpoint serves OPENROWSET over the
  medallion lake) plus the required Console UAMI roles (Synapse SQL admin /
  Storage Blob Data Reader) — never a fabricated result (`no-vaporware.md`).
- Historical note in the route: the lakehouse previously POSTed to the wrong
  item type (`synapse-serverless-sql-pool`); this dedicated route is the
  lakehouse's own SQL analytics endpoint.
