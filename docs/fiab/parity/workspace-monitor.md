# workspace-monitor — parity with Fabric workspace monitoring

Source UI: **Fabric workspace monitoring** — a read-only monitoring **Eventhouse**
(KQL database) holding a workspace's own usage / performance telemetry
(<https://learn.microsoft.com/fabric/fundamentals/workspace-monitoring-overview>).
Azure-native realization: a **read-only Azure Data Explorer (ADX) database** on
the shared Loom ADX cluster, fed by **Azure Monitor diagnostic settings → Log
Analytics → (data-export) → ADX**. No Microsoft Fabric dependency
(`no-fabric-dependency.md`). Grounding:
<https://learn.microsoft.com/azure/azure-monitor/logs/logs-data-export>,
<https://learn.microsoft.com/azure/azure-monitor/essentials/diagnostic-settings>,
<https://learn.microsoft.com/azure/data-explorer/create-event-hubs-connection>.

Editor: shared `EventhouseEditor`
(`apps/fiab-console/lib/editors/phase3-editors.tsx`) pointed at the monitoring
ADX database, plus the bundled **Workspace Monitoring Dashboard** app
(`lib/apps/content-bundles/app-workspace-monitoring.ts`). Provisioner:
`lib/install/provisioners/workspace-monitor.ts`. Catalog:
`fabric-item-types.ts` slug `workspace-monitor` (restType `Eventhouse`,
category **Real-Time Intelligence**).

## Azure/Fabric feature inventory

1. **Provision a read-only monitoring database** for the workspace.
2. **Auto-collect platform telemetry** (operations, usage, performance, errors) into it.
3. **Query the telemetry with KQL** (queryset / functions).
4. **Prebuilt monitoring dashboard** over the telemetry (coverage, request rate, failure %, errors).
5. **Continuous live ingestion** of new telemetry.
6. (Fabric extras) per-workspace scoping model, retention config, built-in report templates per workload.

## Loom coverage    (built ✅ / honest-gate ⚠️ / MISSING ❌)

| # | Capability | Status | Notes |
|---|---|---|---|
| 1 | Provision monitoring DB | ✅ | Provisioner creates a read-only ADX database (long hot cache + soft-delete) via `kusto-client.createDatabase`. |
| 2 | Collect platform telemetry | ✅ | Audits diagnostic-settings coverage across every Loom resource (`monitor-client.getDiagnosticsCoverage`) and enables the standardized `diag-loom-stdz` setting on any resource missing it; seeds 4 tables (ResourceDiagnostics, ActivityEvents, PlatformMetrics, AppTelemetry) with real platform-shaped rows so dashboards render immediately. Install receipt carries live `diagnosticCoveredCount / diagnosticTotalCount`. |
| 3 | Query with KQL | ✅ | EventhouseEditor KQL surface + create-or-alter `WorkspaceMonitor` helper functions (RequestRate, DiagnosticCoverage). |
| 4 | Prebuilt dashboard | ✅ | Bundled **Workspace Monitoring Dashboard** renders diagnostic coverage, request rate, failure %, resource errors over the ADX data. |
| 5 | Continuous live ingestion | ⚠️ | Optional: when `LOOM_EVENTHUB_NAMESPACE_RESOURCE_ID` is set, a Log Analytics data-export rule streams AzureDiagnostics/AzureActivity/AzureMetrics/AppRequests through Event Hubs into ADX. When unset the step is skipped honestly — the seeded tables stay fully queryable. |
| 6 | Per-workspace retention/report templates | ❌ | Retention is a single DB policy; per-workload report templates not built. |

## Backend per control

- Provisioning → `lib/install/provisioners/workspace-monitor.ts`:
  gate on `LOOM_KUSTO_CLUSTER_URI` → diagnostics audit/enable
  (`monitor-client`) → `kusto-client.createDatabase` → seed tables + rows →
  create-or-alter KQL functions → optional live LAW→EventHub→ADX feed.
- Query / editor surface → `EventhouseEditor` over `/api/items/eventhouse/**`
  (database, ingest, policies, continuous-export) against the monitoring DB.
- Dashboard → `app-workspace-monitoring.ts` content bundle (KQL tiles over ADX).
- **Honest gates:** missing `LOOM_KUSTO_CLUSTER_URI` blocks provisioning with a
  precise ADX infra gate; missing `LOOM_EVENTHUB_NAMESPACE_RESOURCE_ID` skips
  only the live feed (seeded data remains queryable) — no mocks
  (`no-vaporware.md`).
