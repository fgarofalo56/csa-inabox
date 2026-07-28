# Workspace Monitoring — from install to live platform telemetry

Install `app-workspace-monitoring` and get the **Azure-native parity for Microsoft
Fabric workspace monitoring**: a read-only ADX telemetry database fed by Azure Monitor
diagnostic settings, plus a six-tile Real-Time Dashboard — with **no Fabric capacity or
workspace anywhere in the path**. **~20 minutes.**

!!! abstract "The pipeline you end up with"
    ```
    Azure Monitor diagnostic settings (every Loom resource)
      -> Log Analytics workspace
      -> [optional] data export -> Event Hubs -> ADX
      -> read-only Workspace Monitoring ADX database (loomdb_workspace_monitor)
      -> Workspace Monitoring Real-Time Dashboard
    ```

## Prerequisites

| You need | Why | If it is missing |
| --- | --- | --- |
| A Loom workspace | Apps install into a workspace | [Tutorial 01 — First workspace](../01-first-workspace.md) |
| `LOOM_KUSTO_CLUSTER_URI` **and** `LOOM_KUSTO_CLUSTER_NAME` | Create the monitoring database | *"ADX cluster not configured for workspace monitoring. Set `LOOM_KUSTO_CLUSTER_URI` … and `LOOM_KUSTO_CLUSTER_NAME` …"* |
| Console UAMI with ARM rights on the Kusto cluster + database ingest/admin | Create the DB, create tables, ingest the seed | Verbatim `4xx` from Kusto with the exact authorization problem |
| Monitoring Contributor on the Loom resources | Enable diagnostic settings | The audit step is best-effort and degrades with a note |
| `LOOM_EVENTHUB_NAMESPACE_RESOURCE_ID` (**optional**) | Wire the continuous LAW → Event Hubs → ADX feed | Skipped with a note; the DB and its seeded tables stay fully queryable |

## 1. Install the app

1. Left nav → **Apps** → **Workspace Monitoring** (`/apps/app-workspace-monitoring`).
2. **Install into workspace** → workspace, optional folder (e.g. `Ops`).
3. **Deploy artifacts to live Azure services** → **On**. **Compute** → **Shared**.
4. **Install**.

Database creation on ADX is an **async ARM operation**. If the row comes back
*"Monitoring DB `loomdb_workspace_monitor` creation is still in progress"*, that is
expected — wait a minute and click **Retry**. `createDatabase` is idempotent and the
readiness probe passes once the engine finishes materializing it.

## 2. What gets provisioned

| Item | Provisioner | What it really does |
| --- | --- | --- |
| `Workspace Monitoring DB` (`workspace-monitor`) | `workspaceMonitorProvisioner` | Creates the read-only ADX database `loomdb_workspace_monitor` (override with `LOOM_WORKSPACE_MONITOR_DB`); creates the four tables and two helper functions; **audits every Loom resource and enables the standardized `diag-loom-stdz` diagnostic setting on any that is missing it**; seeds verified sample rows; and — when the Event Hubs namespace id is set — wires the live LAW → Event Hubs → ADX feed |
| `Workspace Monitoring Dashboard` (`kql-dashboard`) | `kqlDashboardProvisioner` | Confirms the ADX data source and binds the six tiles. Because the bundle sets `content.database` explicitly to the monitoring DB, the tiles resolve to the database the monitor item just created — they render real data the moment install returns |

The diagnostic-settings step logs its own arithmetic, e.g.
*"Diagnostic-settings audit: 12/17 Loom resources already route to the Loom LAW;
enabling `diag-loom-stdz` on 5 more."*

## 3. The schema

Four tables:

| Table | Columns |
| --- | --- |
| `ResourceDiagnostics` | `TimeGenerated`, `ResourceId`, `Category`, `OperationName`, `ResultType`, `Caller`, `Properties` (dynamic), `_ResourceId` |
| `ActivityEvents` | `TimeGenerated`, `OperationName`, `ActivityStatus`, `Caller`, `ResourceId`, `ResourceGroup`, `CorrelationId`, `Level`, `Category` |
| `PlatformMetrics` | `TimeGenerated`, `ResourceId`, `MetricName`, `MetricValue`, `UnitName`, `DimensionName`, `DimensionValue` |
| `AppTelemetry` | `TimeGenerated`, `Name`, `ResultCode`, `DurationMs`, `OperationId`, `AppRoleName`, `ItemCount` |

Two helper functions — `RequestRate(window:timespan)` and
`DiagnosticCoverage(window:timespan)` — plus three starter queries:
**Diagnostic coverage (1h)** (`DiagnosticCoverage(1h)`), **Request rate (1h)**
(`RequestRate(1h)`), and **Top failing operations (24h)**.

## 4. Seeded data

The provisioner ingests **verified sample rows** into the four tables so the dashboard
is not empty on first open. They are real ingested rows, not a mocked grid — and they
are quickly outnumbered by live telemetry once diagnostic settings start flowing.

## 5. First meaningful task — find something real in your own platform

1. Open **`Workspace Monitoring Dashboard`**. Six tiles:

   | Tile | Viz | Query shape |
   | --- | --- | --- |
   | Resources reporting (1h) | card | `ResourceDiagnostics \| summarize dcount(_ResourceId)` |
   | Failed requests % (1h) | card | `AppTelemetry` — `countif(ResultCode !startswith '2')` over `sum(ItemCount)` |
   | Activity events by category (24h) | bar | `ActivityEvents \| summarize count() by Category` |
   | API request rate (1h) | timechart | `AppTelemetry \| summarize sum(ItemCount) by bin(TimeGenerated, 5m), AppRoleName` |
   | Resource errors by category (24h) | pie | `ResourceDiagnostics \| where ResultType == 'Failed'` |
   | Container Apps CPU (1h) | timechart | `PlatformMetrics \| where MetricName == 'UsageNanoCores'` |

2. Open **`Workspace Monitoring DB`** and run the starter query
   **Diagnostic coverage (1h)** — `DiagnosticCoverage(1h)`. This tells you how much of
   your estate is actually reporting. **If coverage is below 100%, that is the finding**:
   the resources that are dark are the ones you will have no evidence for during an
   incident or an audit.
3. Run **Top failing operations (24h)**:

   ```kusto
   ResourceDiagnostics
   | where TimeGenerated > ago(24h) and ResultType == 'Failed'
   | summarize failures = count() by OperationName, Category
   | order by failures desc
   ```

   Take the top row and pivot: filter `ActivityEvents` on the same `ResourceId` and
   `CorrelationId` window to see who did what around the failure.
4. Turn on the **live feed**: set `LOOM_EVENTHUB_NAMESPACE_RESOURCE_ID` and re-run the
   install. A Log Analytics **data-export** rule then streams `AzureDiagnostics`,
   `AzureActivity`, `AzureMetrics`, and `AppRequests` through Event Hubs into ADX
   continuously — that is what turns a seeded demo into an operations tool.

## 6. Verify it worked

- **Install dialog**: the monitor row is `created`, its step log names the database and
  reports the diagnostic-settings audit counts; the dashboard row reports
  `6/6 tile(s) bound to ADX <cluster> / loomdb_workspace_monitor`.
- **ADX**: `loomdb_workspace_monitor` exists with the four tables and two functions.
- **Dashboard**: all six tiles render (seeded rows at minimum).
- **`DiagnosticCoverage(1h)`** returns a resource count > 0.
- After enabling the live feed, `ResourceDiagnostics | where TimeGenerated > ago(15m)`
  returns rows with real resource ids from your estate.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| "ADX cluster not configured for workspace monitoring" | Kusto variables unset | Set `LOOM_KUSTO_CLUSTER_URI` and `LOOM_KUSTO_CLUSTER_NAME`, restart the revision, **Retry** |
| "creation is still in progress (async ARM op)" | ADX is materializing the DB | Wait ~1 minute, click **Retry** — it is idempotent |
| `Kusto 4xx: ARM not authorized to create the monitoring database` | UAMI lacks cluster rights | Grant the Console UAMI Contributor on the Kusto cluster |
| `Kusto 4xx: not authorized to .create table` / `to ingest` | UAMI lacks database rights | Grant Database Admin (or Ingestor for ingest) on `loomdb_workspace_monitor` |
| Tiles render but only seeded rows | The live feed is not wired | Set `LOOM_EVENTHUB_NAMESPACE_RESOURCE_ID` and re-run |
| Coverage stays low after install | The audit could not enable diagnostics on some resources | Grant Monitoring Contributor on the affected resources and re-run |

## Cleanup

Delete both items, or the workspace. **The ADX database, its tables, the diagnostic
settings, and any data-export rule persist** — remove them in Azure if you want them
gone. Leaving diagnostic settings on is usually the right call.

## What's next

- [FinOps Cost Optimizer](finops-cost.md) — pair platform utilization with billing.
- [FedRAMP Compliance Tracker](fedramp-tracker.md) — this database is where AU (audit)
  family evidence comes from.
- [Editor guide — Workspace monitor](../editor-workspace-monitor.md).
