# metric-views — parity with Unity Catalog Metric Views (+ Iceberg/UniForm, Genie deltas)

Covers Wave-10 Databricks-parity items DBX-6 (UC Metric Views), DBX-5 (Data
Agent Genie deltas) and DBX-11 (Managed Iceberg + UniForm).

Source UI:
- UC Metric Views: https://learn.microsoft.com/azure/databricks/business-semantics/metric-views/create
- Managed Iceberg / UniForm: https://learn.microsoft.com/azure/databricks/delta/uniform
- Genie: https://learn.microsoft.com/azure/databricks/genie/

## DBX-6 — Metric Views

Governed, reusable KPI definitions (dimensions + measures over a fact table).
**Azure-native default** = the Loom semantic layer; **Databricks UC metric view**
= opt-in when a workspace is bound. No hard Databricks dependency.

| Capability (Databricks) | Loom coverage | Backend per control |
|---|---|---|
| Define dimensions (name + expression) | ✅ typed row builder (no JSON) | pure compiler `lib/sql/metric-view-builders.ts` |
| Define measures (aggregation + expression, incl. Custom) | ✅ dropdown aggregation + expression field | `compileMetricViewSelect` / `compileMeasureDax` / `buildMetricViewYaml` |
| Base filter | ✅ typed predicate field | compiler `filter:` |
| Preview compiled SQL / DDL | ✅ read-only code preview | `/api/semantic-model/metric-view` (compile) · `/api/databricks/unity-catalog/metric-views` (create preview) |
| Run / real aggregate rows (default) | ✅ GROUP BY SELECT on Synapse Dedicated | `POST /api/semantic-model/metric-view` action `run` → `executeQuery` |
| Save as governed measure (default) | ✅ DAX measure per measure (Loom tabular layer) | `compileMeasureDax` → semantic-model XMLA measure PUT |
| Create UC metric view (opt-in) | ✅ `CREATE … WITH METRICS LANGUAGE YAML AS $$…$$` | `createUcMetricView` → `executeStatement` |
| Query with `MEASURE()` (opt-in) | ✅ `SELECT dim, MEASURE(m) … GROUP BY dim` | `queryUcMetricView` → `executeStatement` |

Honest gates: Synapse not configured → MessageBar naming `LOOM_SYNAPSE_WORKSPACE`
/ `LOOM_SYNAPSE_DEDICATED_POOL`; Databricks unbound or Gov boundary → MessageBar
naming `LOOM_DATABRICKS_HOSTNAME` / the DBR-17.3 requirement. UI: a **Metrics**
tab on the semantic-model editor (`MetricViewBuilder`). Bicep: none (reuses the
warehouse pool + the bound Databricks workspace).

## DBX-5 — Data Agent Genie deltas (two only; the A-grade agent is unchanged)

| Delta | Loom coverage | Backend |
|---|---|---|
| Metric-view grounding source | ✅ `metric-view` source type; grounds on governed measures | `data-agent-execute.ts` runs the model SQL read-only on Synapse Dedicated; `metricViewGroundingText` builds the governed grounding |
| "Open in Databricks Genie" deep link | ✅ renders only when a workspace host is bound | `databricksGenieUrl(host)` over `/api/databricks/workspace` |

## DBX-11 — Managed Iceberg + UniForm

Additive table-format selector on the UC create-table dialog.

| Capability | Loom coverage | Backend |
|---|---|---|
| Table format: Delta / Delta+UniForm-Iceberg / Managed Iceberg | ✅ dropdown | `buildCreateTableFormatDdl` |
| Deletion vectors toggle | ✅ switch (Delta-family) | `delta.enableDeletionVectors` TBLPROPERTIES |
| Row lineage toggle | ✅ switch (Delta-family) | `delta.enableRowTracking` TBLPROPERTIES |
| Create | ✅ real DDL on a warehouse | `POST /api/databricks/unity-catalog/tables` mode `ddl` → `createUcTableWithFormat` → `executeStatement` |

Plain Delta with no toggles keeps the existing REST create path; UniForm /
Iceberg / any toggle route through SQL DDL (needs a warehouse — honest gate when
none is bound). Bicep: none.
