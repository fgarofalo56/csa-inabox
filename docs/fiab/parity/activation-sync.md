# activation-sync — parity with reverse-ETL / data-activation (Census / Hightouch class; Dataverse Web API Upsert)

Source UI: There is no 1:1 Microsoft Fabric object for reverse ETL — Fabric moves
data IN (pipelines, dataflows, mirroring). Activation (reverse ETL) is the
outbound twin: it pushes a **modeled** dataset OUT to operational systems. The
grounding surfaces are the operational-write APIs Loom targets:

- Dataverse Web API **Upsert** (create-or-update by alternate key) —
  https://learn.microsoft.com/power-apps/developer/data-platform/webapi/update-delete-entities-using-web-api#upsert-a-record
- Delta **Change Data Feed** (the incremental engine) —
  https://learn.microsoft.com/azure/databricks/delta/delta-change-data-feed
- Event Grid custom-topic publish (CloudEvents v1.0), Service Bus data-plane send.

## Feature inventory (what a data-activation surface must do)

1. Pick a **source** (a modeled table / model / audience-segment).
2. Pick a **destination** (a CRM/marketing/ops system) + the object/table.
3. **Map** source columns → destination fields (incl. the unique key).
4. **Full** sync (whole source) and **incremental** sync (only changed rows).
5. **Idempotent** writes (upsert by key; deletes propagate).
6. **Run history** with row counts + errors.
7. **Scheduling** — run on a schedule or on **data change**.
8. **Alerting** on failure.

## Loom coverage

| # | Capability | Status | Notes |
|---|------------|--------|-------|
| 1 | Source picker (table / model / audience) | ✅ built | Lake browser (no freeform path); `SourcePicker` over `/api/items/dataset/browse`. |
| 2 | Destination picker | ✅ built | Dataverse (live env + table dropdowns via BAP/Dataverse), webhook, Event Grid, Service Bus. |
| 3 | Field mapping (dropdowns both sides) + key | ✅ built | Source columns from DuckDB `delta_scan`; Dataverse fields from `EntityDefinitions/Attributes`. No freeform. |
| 4 | Full + incremental (Delta CDF) | ✅ built | `sync-engine` full = `delta_scan`; incremental = transaction-log CDF plan → `read_parquet` of cdc/add files. |
| 5 | Idempotent upserts + deletes | ✅ built | Dataverse `PATCH entityset(key='v')` upsert; CDF `delete` → `DELETE` (404-tolerant). Non-Dataverse carry `<item>:<key>:<version>` dedup id. |
| 6 | Run history | ✅ built | Bounded, persisted in the item doc; `Runs` tab + `/runs` route. |
| 7 | Scheduling by data change | ✅ built | Rides N5 software-defined-asset triggers: `activation-sync` materializer kind + one-click **Bind data-change trigger** (no parallel scheduler). |
| 8 | Failure alerting | ✅ built | O1 `dispatchAlert` (P2) on a failed run. |

Zero ❌.

## Backend per control

| Control | Backend |
|---------|---------|
| Source browse / columns | ADLS Gen2 `listPaths` + DuckDB `delta_scan` (in-boundary serving tier). |
| Dataverse env / table / field pickers | BAP admin API + Dataverse Web API (`getEnvironment` / `listTables` / `getTableSchema`), S2S SP. |
| Full read | DuckDB `delta_scan` over the source Delta table. |
| Incremental read | Delta `_delta_log` CDF plan (`cdf-planner`) → DuckDB `read_parquet` of the change files. |
| Dataverse write | `PATCH`/`DELETE` `…/api/data/v9.2/<set>(<key>='v')` (idempotent upsert). |
| Webhook / Event Grid / Service Bus | HTTPS POST / CloudEvents publish / SB data-plane send (UAMI Entra auth, keyless). |
| Trigger bind | `saveAssetPolicy` (asset sidecar, `mode:auto` + activation-sync materializer). |
| Alert | `lib/azure/alert-dispatch.dispatchAlert`. |

## No-Fabric-dependency

Runs entirely on Azure-native backends with `LOOM_DEFAULT_FABRIC_WORKSPACE`
unset: ADLS Gen2 + DuckDB read the lake; Dataverse S2S, Event Grid, Service Bus,
and a plain webhook are the destinations. No `api.fabric.microsoft.com` /
`onelake` / Power BI host on any code path.

## Sovereign / IL5

The webhook, Event Grid, and Service Bus destinations target in-boundary
endpoints and run disconnected in an air-gapped IL5 boundary; the lake read and
CDF planning are fully in-boundary. Dataverse/Dynamics is a SaaS destination —
honest-gated (`dataverseConfigGate` + a 401/403 remediation hint), never required
for the item to exist or for the in-boundary destinations to run.
