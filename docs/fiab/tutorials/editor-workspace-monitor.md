# Tutorial: Workspace monitoring editor

> CSA Loom `workspace-monitor` — the Azure-native parity for Fabric's
> monitoring Eventhouse: a read-only **ADX database** of platform
> usage/performance telemetry, fed by Azure Monitor diagnostic settings. **No
> Microsoft Fabric required.**

## What it is

Workspace monitoring is a read-only Azure Data Explorer database on the shared
Loom ADX cluster that holds the platform's own usage and performance telemetry.
Diagnostic settings on every Loom resource route logs + metrics to Log
Analytics; a data-export rule streams them to ADX so operators can query and
dashboard them with KQL.

## When to use it

- You operate a Loom tenant and need to see request rates, failures, and
  diagnostic coverage across the platform's own resources.
- You want platform telemetry queryable with KQL and pinned to Real-Time
  dashboards, not locked in a portal blade.

## Step-by-step in Loom

1. **Provision the monitoring DB.** Installing the **Workspace Monitoring** app
   creates the read-only ADX database (`ResourceDiagnostics`, `ActivityEvents`,
   `PlatformMetrics`, `AppTelemetry`) and enables `diag-loom-stdz` on any
   resource missing it.
2. **Wire the live feed.** Set `LOOM_EVENTHUB_NAMESPACE_RESOURCE_ID` to stream
   AzureDiagnostics / AzureActivity / AzureMetrics / AppRequests through Event
   Hubs into ADX continuously. Until then the seeded tables stay fully
   queryable.
3. **Query with KQL.** Use the WorkspaceMonitor functions (`RequestRate`,
   `DiagnosticCoverage`) or open a KQL queryset to explore the telemetry.
4. **Open the dashboard.** The bundled Workspace Monitoring Dashboard renders
   diagnostic coverage, request rate, failure %, and resource errors over the
   live ADX data.

## The Azure backend it rides on

- **Store:** a read-only ADX database on the shared Loom cluster.
- **Feed:** Azure Monitor diagnostic settings → Log Analytics → data-export →
  Event Hubs → ADX.

## No Fabric required

The monitoring Eventhouse parity is 100% ADX + Azure Monitor; no Fabric
capacity or workspace is involved.

## Learn more

- Log Analytics data export:
  <https://learn.microsoft.com/azure/azure-monitor/logs/logs-data-export>
