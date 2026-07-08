# dataflow — parity with Fabric Dataflow Gen2 (Power Query Online)

Source UI: Fabric → Data Factory → Dataflow Gen2 (Power Query Online editor)
(https://learn.microsoft.com/fabric/data-factory/dataflows-gen2-overview,
https://learn.microsoft.com/fabric/data-factory/dataflow-gen2-data-destinations-and-managed-settings,
https://learn.microsoft.com/fabric/data-factory/create-first-dataflow-gen2).

Azure-native backend (per `no-fabric-dependency.md`): **no Fabric.** Authored
Power Query (M / mashup) is saved to Cosmos and, on Run, compiled into an **ADF
WranglingDataFlow** that executes on ADF Spark and writes the output query to the
chosen ADLS Gen2 / Azure SQL destination. This is the only backend — the editor
renders fully and Runs against Azure with no Fabric capacity or workspace. The
"workspace" selector is the Loom (Cosmos) workspace the dataflow item lives in,
not a Fabric workspace.

## Fabric Dataflow Gen2 editor inventory (grounded in Learn)

The real Power Query Online / Dataflow Gen2 editor exposes:

1. **Get data** — connect to a source (Azure SQL, ADLS Gen2, files, SharePoint,
   Snowflake, …), pick tables, import.
2. **Power Query ribbon** — Home, Transform, Add column, View, Add query tabs;
   300+ built-in transforms (filter rows, sort, group by, split/merge columns,
   change type, replace values, pivot/unpivot, extract, format text,
   aggregate, …).
3. **Queries pane** (left) + **Diagram view** + **Data preview grid** +
   **Applied steps / Query settings** (right).
4. **Column profile / data profiling** (column quality, distribution, profile).
5. **Data destination** — set per tabular query (Azure SQL, ADLS Gen2, Lakehouse,
   Warehouse, KQL, SQL DB, Snowflake, SharePoint) with Append/Replace update
   method + schema mode; set via ribbon, query settings, or diagram view.
6. **Staging** toggle per query; **Publish**; **Refresh / Schedule refresh**;
   monitoring / refresh history.
7. **Manage parameters**; **Save & run**.

## Loom coverage

| Fabric capability | Loom coverage | Backend (real REST) |
| --- | --- | --- |
| Workspace + dataflow picker, create | ✅ built — Loom workspace select + list/create | `GET /api/loom/workspaces`, `GET/POST /api/items/dataflow` |
| Load / open dataflow definition (M parts) | ✅ built — parses `definition.parts`, extracts `mashup.pq` | `GET /api/items/dataflow/[id]` |
| **Power Query authoring** — ribbon Home/Transform/Add column/View/Add query | ✅ built — `PowerQueryHost` (queries pane, data preview grid, applied steps) | client model → M script |
| 300+ transforms (filter, sort, group by, split/merge, change type, replace, extract, text-format, aggregate) | ✅ built — `pq-transform-dialogs` (equals/greater/less/null operators, type coercion, split by delimiter/positions/first-last/range/before-after-delimiter, upper/lower/trim/clean/capitalize, count/sum/min/max/avg aggregates) | applied steps → M |
| **Diagram view** | ✅ built — `PowerQueryHost` diagram + `mapping-dataflow-designer` for MDF | client |
| **Column profile / data profiling** | ✅ built — `data-profiling.tsx` (column profile) | client over preview sample |
| **Data destination** picker (ADLS / Azure SQL, Append/Replace) | ✅ built — `DestinationPicker` → `DataflowSink` persisted with the query | `PUT /api/items/dataflow/[id]` (`sink`) |
| Manage parameters | ✅ built — `manage-parameters.tsx` | round-trips in definition |
| Save (+Ctrl+S) | ✅ built | `PUT /api/items/dataflow/[id]` (definition + sink) |
| **Save & run / Refresh** → executes on Azure | ✅ built — Run compiles M → ADF WranglingDataFlow, dispatches, returns runId | `POST /api/items/dataflow/[id]/refresh` (ADF Spark) |
| M / script view | ✅ built — `MonacoTextarea` script tab | client |
| Dataflow **Copilot** (NL transform assist) | ✅ built — `DataflowCopilotPane` | AOAI-backed |
| Mapping data flow (Spark MDF) authoring | ✅ built — `mapping-dataflow-editor` + `/api/adf/dataflows/*` (debug) | `GET/PUT /api/adf/dataflows/[name]`, `.../debug` |
| ADF / ADLS not configured | ⚠️ honest-gate — `/api/items/dataflow/config` reports `adfConfigured`/`adlsConfigured`; MessageBar names the missing env var; editor still renders | n/a |

Zero ❌. Zero stub banners. No `api.fabric.microsoft.com` /
`DataflowStaging` Fabric artifacts on the default path — staging + compute are
ADF Spark + ADLS.

## Backend per control

- Config probe: `/api/items/dataflow/config` (backend, adfConfigured, adlsConfigured).
- List / create: `/api/items/dataflow` (GET/POST).
- Load / save / delete: `/api/items/dataflow/[id]` (GET/PUT/DELETE; definition parts + sink).
- Run / refresh: `/api/items/dataflow/[id]/refresh` (POST → ADF WranglingDataFlow run, returns runId + output query + pipeline name).
- Mapping data flow: `/api/adf/dataflows`, `/api/adf/dataflows/[name]`, `/api/adf/dataflows/[name]/debug`.
- Copilot: dataflow copilot pane (AOAI orchestrator).
