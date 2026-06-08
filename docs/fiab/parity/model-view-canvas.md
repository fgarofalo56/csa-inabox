# model-view-canvas — parity with the Fabric / Power BI Model view

Source UI:
- Power BI Desktop / Fabric semantic-model **Model view** — table cards on a
  canvas, relationship lines with cardinality + cross-filter direction, and the
  Measures pane (https://learn.microsoft.com/power-bi/transform-model/desktop-relationship-view).
- Synapse Dedicated SQL pool relationships (informational) and inline
  table-valued functions (https://learn.microsoft.com/azure/synapse-analytics/sql-data-warehouse/sql-data-warehouse-tables-constraints).
- Databricks Unity Catalog informational primary/foreign keys
  (https://learn.microsoft.com/azure/databricks/tables/constraints).

**No Power BI / Fabric dependency.** The Model view renders fully with
`LOOM_DEFAULT_FABRIC_WORKSPACE` unset; relationships + measures are persisted
Azure-native and materialized on the warehouse backends.

## Azure/Fabric feature inventory → Loom coverage

| Capability (source UI) | Loom coverage | Backend per control |
|---|---|---|
| Draggable table cards on a canvas | ✅ `ModelViewCanvas` (`@xyflow/react`), grid auto-layout, drag to reposition | live `sys.tables`+`sys.columns` (Synapse) / `SHOW TABLES`+`DESCRIBE TABLE` (DBX) |
| Primary-key columns flagged | ✅ key icon + bold on PK columns | `sys.indexes is_primary_key` (Synapse) / `information_schema … PRIMARY KEY` (DBX) |
| Create relationship by dragging key→key | ✅ column-level connect handles → Create-relationship dialog | POST `/model`: Cosmos (Synapse) / `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY` (DBX UC) |
| Cardinality (1:*, *:1, 1:1, *:*) | ✅ dropdown in dialog, drawn as `1 — *` edge label | persisted on `state.model.relationships[].cardinality` |
| Cross-filter direction (single / both) | ✅ dropdown, `⇄` shown on edge label | persisted on `state.model.relationships[].crossFilter` |
| Active / inactive relationship | ✅ switch; inactive edges render dashed + dimmed | persisted `…active` |
| Delete relationship | ✅ click an edge → confirm | DELETE `/model?relId=`; DBX also `DROP CONSTRAINT IF EXISTS` |
| Relationships read back on reload | ✅ GET merges Cosmos + live UC FK reads | GET `/model` |
| Measures pane | ✅ Measures table (name, kind, definition, Use-in-query) | GET `/model` (Cosmos measures merged with live `sys.sql_modules` TVFs) |
| New measure (DAX-like editor) | ✅ Monaco editor dialog; Synapse = real inline TVF, DBX = Loom metadata CTE | POST `/model?kind=measure`: `CREATE OR ALTER FUNCTION … RETURNS TABLE` (Synapse) / Cosmos (DBX) |
| Use a measure in a query | ✅ "Use in query" loads usage SQL into the Query tab | function call (Synapse) / `WITH … AS (…)` CTE (DBX) |
| Auto-layout / zoom-to-fit / minimap | ✅ toolbar + React Flow controls | n/a (client) |
| Model mode switcher | ✅ Query / Model `TabList` in WarehouseEditor, SynapseDedicatedSqlPoolEditor, DatabricksSqlWarehouseEditor | n/a |

Honest gate (⚠️): when the backing compute is offline (pool Paused / warehouse
Stopped, or no catalog+schema selected for DBX) the canvas still renders from
persisted metadata and shows a Fluent `MessageBar intent="warning"` naming the
action to take. Live tables + relationship/measure writes require the compute
Online — an Azure infra gate, never a Fabric one.

Zero ❌, zero stub banners.

## Files

- UI: `apps/fiab-console/lib/editors/components/model-view-canvas.tsx`
- BFF: `apps/fiab-console/app/api/items/warehouse/[id]/model/route.ts`,
  `…/synapse-dedicated-sql-pool/[id]/model/route.ts`,
  `…/databricks-sql-warehouse/[id]/model/route.ts`
- Shared: `app/api/items/_lib/model-store.ts`, `app/api/items/_lib/synapse-model.ts`
- Wired into: `phase3-editors.tsx` (WarehouseEditor), `synapse-sql-editors.tsx`,
  `databricks-editors.tsx`

## Persistence

`item.state.model = { relationships: [...], measures: [...] }` on the existing
`items` Cosmos container (PK `/workspaceId`). No new container, no new env var,
no Bicep change — the route reuses `LOOM_SYNAPSE_WORKSPACE` /
`LOOM_SYNAPSE_DEDICATED_POOL` / `LOOM_DATABRICKS_HOSTNAME` /
`LOOM_COSMOS_ENDPOINT` already wired in `admin-plane/main.bicep`.

## Verification

`vitest` — `app/api/items/__tests__/model-routes.test.ts` (12) +
`app/api/items/_lib/__tests__/model-store.test.ts` (8): relationship POST
persists to Cosmos and re-GET reads it back; Synapse measure POST issues
`CREATE OR ALTER FUNCTION`; DBX relationship POST issues `ALTER TABLE … ADD
CONSTRAINT`; GET renders (computeReady=false + notice) when compute is offline.
`tsc --noEmit` clean.
