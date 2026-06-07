# eventhouse-overview — parity with Fabric RTI Eventhouse "System overview"

Source UI: https://learn.microsoft.com/fabric/real-time-intelligence/manage-monitor-eventhouse
            https://learn.microsoft.com/fabric/real-time-intelligence/manage-monitor-database
            https://learn.microsoft.com/azure/data-explorer/check-cluster-health
Editor: `apps/fiab-console/lib/editors/phase3-editors.tsx` → `EventhouseEditor` (System overview tab) + `EventhouseOverviewPanel`
Routes: `apps/fiab-console/app/api/items/eventhouse/[id]/overview/route.ts`
        `apps/fiab-console/app/api/items/eventhouse/[id]/journal/route.ts`
Backend: shared Loom ADX cluster (`kusto-client.ts`) + Azure Monitor metrics (`monitor-client.ts`).
No Microsoft Fabric / Power BI dependency — Azure-native default (see `.claude/rules/no-fabric-dependency.md`).

## Fabric/ADX feature inventory (grounded in Learn)

The Fabric Eventhouse **system overview** is a dashboard of cluster + database
telemetry: health/state, storage (original / compressed / cache), per-database
storage, a time-range selector, ingestion and query activity, the most-queried
databases / users, and the schema-change history.

| Capability | Source behavior | Backing command / metric |
| --- | --- | --- |
| State / health indicator | Healthy / Unhealthy + node + extent counts | `.show diagnostics` (`IsHealthy`, `MachinesTotal/Offline`, `ExtentsTotal`, `IsScaleOutRequired`) |
| Storage — original (uncompressed) | Total uncompressed data size | `.show diagnostics` `TotalOriginalDataSize` |
| Storage — compressed (on disk) | Total extent (compressed+index) size + compression ratio | `.show diagnostics` `TotalExtentSize` |
| Storage — hot cache (SSD) | Hot-cached bytes | `.show database <db> details` `HotExtentSize` summed |
| Per-database storage | Size contribution per database | `.show database <db> details` per db |
| Ingestion capacity | Concurrent ingestion slots total/consumed/remaining | `.show capacity ingestions` |
| Time-range filter (1H/1D/7D/30D) | Scopes activity panels | KQL `ago()` + Monitor `timespan` |
| Ingestion activity | In-progress, success rate, volume, latency | `.show diagnostics` + Monitor `IngestionVolumeInMB`, `IngestionLatencyInSeconds` |
| Query activity | Avg query duration, throttling | Monitor `QueryDuration`, `TotalNumberOfThrottledCommands/Queries` |
| Top databases by query count | Most-queried DBs in window | `.show queries | summarize count() by Database | take 10` |
| Top users by query count | Heaviest callers in window | `.show queries | summarize count() by User | take 5` |
| Schema-change log | Metadata-operation journal | `.show journal` |

## Loom coverage

| Inventory row | State | Notes |
| --- | --- | --- |
| State / health indicator | ✅ built | `Badge` success/danger + node/extent caption; scale-out hint |
| Storage — original | ✅ built | `EhStatTile` from `diagnostics.totalOriginalDataSizeBytes` |
| Storage — compressed + ratio | ✅ built | `EhStatTile` + `original/extent` compression ratio |
| Storage — hot cache | ✅ built | summed `hotDataSizeBytes` across `databases[]` |
| Per-database storage chart | ✅ built | `ResultChart kind="bar"` (compressed MB per db, top 20) |
| Ingestion capacity | ✅ built | `.show capacity ingestions` consumed/total/remaining tile |
| Time-range filter | ✅ built | 1H/1D/7D/30D button strip → re-fetches `/overview` + drives Monitor window |
| Ingestion activity | ✅ built | in-progress + success-rate + Monitor volume/latency tiles |
| Query activity | ✅ built | Monitor query-duration + throttled commands/queries tiles |
| Top databases grid | ✅ built | Fluent `Table`, top-10 from `.show queries` |
| Top users grid | ✅ built | Fluent `Table`, top-5 from `.show queries` |
| Schema-change log | ✅ built | Fluent `Table` over `.show journal` (newest-first, 50 rows) |
| Azure Monitor metrics | ⚠️ honest-gate | when the cluster ARM coords are unset, or RBAC/Gov-ARM blocks the call, `monitorGate` MessageBar names the exact env var / role; KQL-sourced panels still render |

Zero ❌, zero stub banners.

## Backend per control

| Control | Backend call |
| --- | --- |
| State indicator, storage tiles | `executeMgmtCommand('NetDefaultDB', '.show diagnostics')` |
| Ingestion capacity tile | `executeMgmtCommand('NetDefaultDB', '.show capacity ingestions')` |
| Per-db storage chart | `getDatabaseDetails(db)` fanned over `listDatabases()` |
| Top databases / users grids | `executeMgmtCommand('NetDefaultDB', '.show queries | summarize …')` |
| Ingestion/query Monitor tiles | `fetchMetrics({ resourceId, metricNames, timespan, aggregation })` (Average + Total) |
| Schema-change log | `executeMgmtCommand('NetDefaultDB', '.show journal | take N')` |

## Per-cloud notes

- **Commercial**: cluster URI `https://<name>.<region>.kusto.windows.net`; Monitor via `management.azure.com` (Metrics API `2023-10-01`). All `.show` commands available. No gaps.
- **GCC / GCC-High / IL5**: ADX data-plane commands work unchanged (cluster URI injected by bicep at the correct Gov host). `monitor-client.ts` currently hardcodes `management.azure.com`, so Monitor metrics may 404 in Gov clouds — the overview route catches this and surfaces an honest `monitorGate` rather than failing; the diagnostics/capacity/queries/journal panels still render. ADX is available at IL5; the commands used are read-only metadata (no tenant/PII data).

## Bicep / bootstrap sync

No new Azure resources, env vars, or role assignments. Already wired:
`LOOM_KUSTO_CLUSTER_URI/NAME/RG` + `LOOM_SUBSCRIPTION_ID`
(`platform/fiab/bicep/modules/admin-plane/main.bicep` lines 719, 829–831);
ADX `diagnosticSettings` with `AllMetrics`
(`platform/fiab/bicep/modules/admin-plane/adx-cluster.bicep`); the Console UAMI
holds `AllDatabasesAdmin` on the cluster (for `.show`) and `Monitoring Reader`
at subscription scope (for Monitor metrics).
