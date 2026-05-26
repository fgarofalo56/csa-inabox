# Loom Azure SQL Database Editor — Azure-portal parity spec

> Captured 2026-05-26. Source: Microsoft Learn `azure-sql/database/query-editor`, `connect-query-portal`, `monitor-tune-overview`, `automated-backups-overview`, `auditing-overview`, `threat-detection-overview`, `active-geo-replication-overview`, `database-advisor-implement-performance-recommendations`. Item: `azure-sql-database` → `apps/fiab-console/lib/editors/azure-sql-editors.tsx::AzureSqlDatabaseEditor`.

## Overview
`Microsoft.Sql/servers/databases` is a single user database under a logical server (DTU or vCore, serverless or provisioned, Hyperscale or General Purpose or Business Critical). The portal surfaces a Query editor (preview), service-tier / compute scaling, automatic-tuning + Database Advisor + Query Performance Insight, point-in-time restore + long-term retention, database-scope auditing + Defender, database-scope private link + connection strings, and the Fabric mirroring + geo-replication relationships.

## Azure portal UI inventory

### Resource menu
- **Overview** — DB name + parent server FQDN, status, pricing tier, location, connection strings, compute utilization tile, storage tile, Intelligent Performance tile, replicas tile
- **Activity log**, **Access control (IAM)**, **Tags**, **Diagnose and solve problems**
- **Query editor (preview)** — Monaco T-SQL editor with sign-in via SQL auth or Microsoft Entra; result grid + messages tab; Save Query / Open Query (.sql); Login as SQL or AAD user
- **Settings**
  - **Configure** — service tier change (DTU ↔ vCore, Hyperscale ↔ GP ↔ BC), vCore / DTU slider, max storage, zone-redundant toggle, backup-storage redundancy, read-scale-out toggle, maintenance window
  - **Connection strings** — ADO.NET, JDBC, ODBC, PHP, Go templates
  - **Geo-Replication** (legacy view), **Properties**, **Locks**
- **Data management**
  - **Replicas** — Create replica wizard (target subscription / RG / server / region / SKU / elastic pool), forced failover, stop replication
  - **Fabric mirroring** — toggle Fabric mirror, status, lag metric
  - **Connections (preview)** — outbound connection inventory
  - **Sync to other databases (preview)** — Data Sync hub/member config
- **Security**
  - **Microsoft Defender for Cloud** — Defender for SQL DB-scope view + alerts
  - **Identity** — DB does not have its own MI (server does); shown for reference
  - **Auditing** — DB-scope policy (storage / LA / EH sinks, action groups)
  - **Dynamic Data Masking** — masking rules on columns
  - **Transparent data encryption** — DB-scope override (Service-managed or KV CMK)
  - **Ledger** — append-only ledger tables + database digest config
  - **Data Discovery & Classification** — sensitivity labels + recommendations report
- **Intelligent Performance**
  - **Performance overview** — top resource consumers tile, recommendations tile, automatic tuning tile, queries by DTU/CPU
  - **Performance recommendations** — Database Advisor list (create-index, drop-index, parameterize, schema issues) with Apply
  - **Query Performance Insight** — top CPU / IO / log-write queries with drill-down to query text + plan
  - **Automatic tuning** — toggle FORCE_LAST_GOOD_PLAN, CREATE_INDEX, DROP_INDEX inheritance from server vs. override
- **Monitoring** — Metrics, Diagnostic settings, Alerts, Insights (database watcher)
- **Automation** — Tasks (preview), Export template, **Restore** (PITR + LTR + geo-restore)

### Top command bar
- **Copy**, **Restore**, **Export** (BACPAC), **Set server firewall**, **Delete**, **Connect** (opens SSMS/ADS deep link), **Open in SSMS Web (preview)**, **Refresh**, **Feedback**

## What Loom has
- `AzureSqlDatabaseEditor` with four tabs:
  - **Query** — Server + Database inputs, textarea T-SQL editor, Run button → `POST /api/items/azure-sql-database/[id]/query` (real TDS via AAD MI; renders `ResultsPanel`).
  - **Mirroring** — Toggle button → `POST /api/items/azure-sql-database/[id]/mirroring` (gated on `LOOM_AZURE_SQL_MIRRORING_LIVE=true`).
  - **Replication** — placeholder MessageBar pointing at `POST /api/items/azure-sql-database/[id]/replication` (form deferred).
  - **SQL 2025** — Probe-engine button → `POST /api/items/azure-sql-database/[id]/sql2025-features` (returns `SERVERPROPERTY('ProductVersion')`).
- Real TDS query path works end-to-end with MI tokens.

## Gaps for parity
1. **Schema / object browser** — Tables, Views, Stored procedures, Functions, Synonyms tree on the left, populated from `INFORMATION_SCHEMA` + `sys.objects`. Right-click → Select top 1000 / Script as / Edit.
2. **Multi-tab query editor + saved queries** — today only one `<textarea>`; portal supports tabs + Save Query / Open Query.
3. **Results grid features** — column types in header, sort/filter, export to CSV/JSON, messages tab separate from results.
4. **Replicas form** — pick target subscription/RG/server/region/SKU, optionally elastic pool; render the geo-replica list with Forced failover + Stop replication actions (replace the placeholder MessageBar).
5. **Database Advisor + Query Performance Insight** — list `databaseAdvisors/recommendedActions` with Apply / Discard, render top-N queries from `queryStore`/QPI REST.
6. **Automatic tuning** — read/write `Microsoft.Sql/servers/databases/automaticTuning` (FORCE_LAST_GOOD_PLAN, CREATE_INDEX, DROP_INDEX) with desired state vs. inherited.
7. **Auditing (DB-scope)** — `databases/auditingSettings`.
8. **Defender for SQL alerts (DB-scope)** — `databases/securityAlertPolicies` + recent alerts from Defender.
9. **Dynamic Data Masking + Data Classification + Ledger** — `dataMaskingPolicies`, `sensitivityLabels`, `ledgerDigestUploads`.
10. **Backup / restore** — list PITR window + LTR backups (`longTermRetentionBackups`), point-in-time restore form, geo-restore, copy-database.
11. **Configure (scale)** — change SKU / tier / max-size via PUT on the database resource (DTU ↔ vCore ↔ Hyperscale).
12. **Connection strings tab** — render ADO.NET/JDBC/ODBC templates with server FQDN + db name pre-filled.

## Backend mapping
- T-SQL surfaces (query editor, schema browser, masking rules, ledger digest config, classification labels): TDS over MI token (already wired in `/api/items/azure-sql-database/[id]/query`).
- ARM control-plane surfaces (replicas, auditing, Defender, advisor/QPI, automatic tuning, scale, backup/restore): Azure ARM REST against `Microsoft.Sql/servers/databases/*`.
- Suggested new BFF routes:
  - `POST /api/items/azure-sql-database/[id]/schema` — `INFORMATION_SCHEMA.TABLES/COLUMNS` + `sys.procedures` tree
  - `POST /api/items/azure-sql-database/[id]/advisors` — list `recommendedActions` + apply/discard
  - `POST /api/items/azure-sql-database/[id]/qpi` — top-N queries from QPI
  - `POST /api/items/azure-sql-database/[id]/auto-tuning` — GET/PUT `automaticTuning`
  - `POST /api/items/azure-sql-database/[id]/auditing` — `auditingSettings`
  - `POST /api/items/azure-sql-database/[id]/masking` — `dataMaskingPolicies` + rules (or TDS `ALTER COLUMN ADD MASKED`)
  - `POST /api/items/azure-sql-database/[id]/classification` — `sensitivityLabels`
  - `POST /api/items/azure-sql-database/[id]/backups` — list PITR/LTR + restore
  - `POST /api/items/azure-sql-database/[id]/scale` — PUT database resource SKU
  - `POST /api/items/azure-sql-database/[id]/connection-strings` — local render (no backend call)

## Required Azure resources
- Loom MI must hold `SQL DB Contributor` (scale, replicas, backups, restore, advisor apply), `SQL Security Manager` (auditing, classification, Defender), and be the AAD admin (or member of the AAD admin group) on the parent server for TDS surfaces.
- Auditing storage account, Defender VA storage, and Log Analytics workspace as already wired in `platform/fiab/bicep/modules/observability/*`. No net-new infra.

## Estimated effort
4 sessions: (1) schema browser + multi-tab editor + result-grid polish; (2) replicas + backups/restore + scale (control-plane); (3) advisor + QPI + automatic tuning; (4) auditing + Defender + masking + classification + ledger.
