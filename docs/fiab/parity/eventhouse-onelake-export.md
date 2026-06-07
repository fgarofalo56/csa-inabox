# eventhouse-onelake-export — parity with Fabric Eventhouse "OneLake availability"

Source UI: Microsoft Fabric → Eventhouse / KQL database → **Manage → OneLake
availability** (toggle that mirrors KQL tables into OneLake as Delta for
Spark / Power BI consumption).
- https://learn.microsoft.com/fabric/real-time-intelligence/event-house-onelake-availability
- ADX continuous export (the Azure-native mechanism behind it):
  - https://learn.microsoft.com/kusto/management/data-export/continuous-export
  - https://learn.microsoft.com/kusto/management/data-export/create-alter-continuous
  - https://learn.microsoft.com/kusto/management/external-tables-delta-lake
  - https://learn.microsoft.com/kusto/management/data-export/continuous-export-with-managed-identity

Backend: the deployment shared **Azure Data Explorer (ADX)** cluster via the
Kusto management endpoint (`/v1/rest/mgmt`). The eventhouse item type is
ADX-backed (per `no-fabric-dependency.md`: kql-database / eventhouse →
**Azure Data Explorer cluster**). **No real Microsoft Fabric / OneLake
catalog dependency** — Delta files land in ADLS Gen2 the operator already owns.

## What this replaces

Before this change the eventhouse "OneLake availability" ribbon entry opened
the Data policies dialog and flipped a `Switch` whose only outcome was a
structured note: *"OneLake availability requires a Fabric-managed eventhouse
(set LOOM_KUSTO_FABRIC_MANAGED=true)."* That is a Fabric hard-dependency and a
dead control on the Azure-native path — a `no-fabric-dependency.md` violation.

Now the ribbon entry **Export to OneLake/ADLS** opens a dedicated dialog that
configures a real ADX **continuous-export** job writing **Delta** files to ADLS
Gen2 — the same logical outcome as Fabric's OneLake availability, achieved
Azure-native with zero Fabric workspace.

## Fabric / ADX feature inventory (grounded in Learn)

- **Pick the KQL database** the mirror/export belongs to. → built ✅ (database
  cards; the selected DB scopes the dialog).
- **Choose the source table(s)** to make available as Delta. → built ✅ (source
  table input; `over (T)` marks it a fact table → only new rows each run).
- **Delta-Parquet output** consumable by Spark / Power BI. → built ✅ (external
  table `kind=delta`).
- **Destination storage** (OneLake in Fabric / ADLS Gen2 here): account +
  container + path. → built ✅ (account input defaulting to the deployment
  account; container `Select` populated live from `GET .../continuous-export`
  → `listContainers()`; path input). Sovereign-cloud-correct DFS suffix via
  `cloud-endpoints.getDfsSuffix()`.
- **Refresh cadence / interval.** → built ✅ (`intervalBetweenRuns` select:
  5m / 15m / 30m / 1h / 6h / 24h).
- **Managed-identity auth to storage** (no keys). → built ✅ (`;impersonate`
  connection string + `managedIdentity=system`; cluster system-assigned MI
  granted Storage Blob Data Contributor in `adx-cluster.bicep`).
- **See existing exports + last-run status.** → built ✅ (active-exports list
  from `.show continuous-exports`, showing name → external table + last run
  result).
- **Infra not yet provisioned.** → honest-gate ⚠️ (when `LOOM_RTI_EXPORT_ADLS`
  is unset POST returns `code:'no_adls_config'` and the dialog renders a
  warning MessageBar naming the env var + bicep param; the full dialog surface
  still renders).

Zero ❌, zero stub banners.

## Loom coverage / backend per control

| Control | Backend |
|---------|---------|
| Source table | `over (["<table>"])` in `.create-or-alter continuous-export` |
| Export name | continuous-export job name (`.create-or-alter continuous-export ["<name>"]`) |
| ADLS account | `LOOM_RTI_EXPORT_ADLS` default; overridable per-job |
| Container picker | `GET /api/items/eventhouse/[id]/continuous-export` → `listContainers()` (ADLS Gen2 `exists()` probe) |
| Path | abfss root path inside the container |
| Interval | `with (intervalBetweenRuns=<ts>, managedIdentity=system)` |
| Create export | POST → `.create-or-alter external table … kind=delta (h@'abfss://…;impersonate')` then `.create-or-alter continuous-export …` |
| Active exports list | `.show continuous-exports` via `listContinuousExports()` |

## Verification (real-data E2E)

1. With `LOOM_RTI_EXPORT_ADLS` set, open an eventhouse → select a KQL database
   → **Manage → Export to OneLake/ADLS** → pick a source table, container,
   path, interval → **Create export**.
2. POST returns `{ ok:true, abfssPath, receipt:'<abfss>/_delta_log/', verify }`.
3. `.show continuous-export ["<name>"]` shows the job with a last-run success
   once the interval elapses (visible in the dialog's Active exports list).
4. List the ADLS Gen2 container at the abfss path — Delta Parquet files +
   `_delta_log/` are present. Capture the ABFS path listing as the receipt.
5. With `LOOM_RTI_EXPORT_ADLS` UNSET the dialog still renders and POST surfaces
   the honest `no_adls_config` warning MessageBar — no Fabric error, no crash.
