# CSA Loom — Audit Wave 1: Kill live-route vaporware

Source: `docs/fiab/prp/AUDIT-2026-06-10.md`. These are workspace-level **panes**
reachable in production that render hard-coded constants with no backend — direct
`no-vaporware.md` violations. Each must become real-backend (or be removed in
favor of the real editor surface), with Fluent v9 + Loom tokens, `LoomDataTable`
(sortable/filterable), real empty/loading/error states, and NO mock arrays. Honor
no-fabric-dependency (Azure-native default works with `LOOM_DEFAULT_FABRIC_WORKSPACE`
unset). Each task: implement end-to-end (UI → BFF route → real Azure client),
verify, open a PR.

## Tasks

### audit-T01 — Monitor hub: real activity feed
- **goal:** Replace `lib/panes/monitor-hub.tsx:18` `const ROWS=[...]` (6 fake activities) with a real fetch to a BFF route backed by Azure Monitor / Log Analytics KQL (pipeline/job/refresh run history). Render in `LoomDataTable` (sort + filter). Implement the "Schedule failures" tab against real data or remove it. No mock arrays, no dead tabs.
- **files:** `apps/fiab-console/lib/panes/monitor-hub.tsx`, `apps/fiab-console/app/api/monitor/activities/route.ts` (new), `apps/fiab-console/lib/azure/monitor-client.ts`
- **verify:** tsc clean on touched files; `next build` exit 0; route returns real data or an honest MessageBar gate naming the env var/role.

### audit-T02 — OneLake catalog: live items + workspace tree
- **goal:** Replace `lib/panes/onelake-catalog.tsx:20` `const ITEMS=[...]` (fake owners) with a real catalog query (AI Search loom-items index / Cosmos). Build the workspace tree dynamically from the API. Make the Govern tab live. Azure-native default (no Fabric/OneLake REST on the default path).
- **files:** `apps/fiab-console/lib/panes/onelake-catalog.tsx`, `apps/fiab-console/app/api/onelake/catalog/route.ts` (new or reuse existing search route), relevant `lib/azure/*` client
- **verify:** tsc/next build clean; live items render or honest gate.

### audit-T03 — Activator pane: persist rules to Azure Monitor
- **goal:** Wire `lib/panes/activator.tsx:70` `seedRules` (useState) to the real Azure Monitor scheduled-query-alert backend — create/edit/enable/disable all persist and reflect live state. Use `LoomDataTable`. Implement the Objects and Action-history tabs against real data. (The per-item `ActivatorEditor` from PR #847 is already real — reuse its client.)
- **files:** `apps/fiab-console/lib/panes/activator.tsx`, `apps/fiab-console/app/api/activator/**`, `apps/fiab-console/lib/azure/monitor-client.ts`
- **verify:** create/toggle a rule round-trips to Azure Monitor; tsc/next build clean.

### audit-T04 — Warehouse route: real surface
- **goal:** `app/warehouse/page.tsx:2` imports the stub `WarehousePane` (raw `<table>`, dead Explain-plan/History tabs, plain Textarea). Either point `/warehouse` at the real warehouse editor surface, or rebuild the pane with `MonacoTextarea` (T-SQL), `LoomDataTable` results grid, working Explain-plan + History tabs, and a real Synapse Serverless / Databricks SQL query backend. Errors as Fluent `MessageBar`.
- **files:** `apps/fiab-console/app/warehouse/page.tsx`, the WarehousePane component, `apps/fiab-console/lib/azure/synapse-sql-client.ts`
- **verify:** a query executes against the real backend and renders rows; tsc/next build clean.

### audit-T05 — Real-Time Hub pane: live sources + wired cards
- **goal:** Replace `lib/panes/real-time-hub.tsx:17` static `SOURCES` with a real fetch of available streaming sources (Event Hubs / IoT Hub / Kafka subscription enumeration). Wire each card's click to open the eventstream editor for that source. Add a proper empty-search state. (RTI hub editor PR #852 is separate/real — reuse its client.)
- **files:** `apps/fiab-console/lib/panes/real-time-hub.tsx`, `apps/fiab-console/app/api/real-time-hub/sources/route.ts` (new), `apps/fiab-console/lib/azure/eventhubs-client.ts`
- **verify:** sources load from real subscription query; card opens editor; tsc/next build clean.

### audit-T06 — Semantic-model pane: real or removed
- **goal:** `lib/panes/semantic-model.tsx:44` `initialTables` is hardcoded and the Deploy button has no onClick. Prefer removing the workspace pane in favor of the real `SemanticModelEditor` item surface (PR #971+); if the pane must stay, wire `initialTables` to a real AAS/XMLA refresh-config fetch and give Deploy a real handler. No hardcoded tables, no dead button.
- **files:** `apps/fiab-console/lib/panes/semantic-model.tsx`, routing, `apps/fiab-console/lib/azure/aas-client.ts`
- **verify:** either the pane is gone and the route uses the real editor, or it fetches real config + Deploy works; tsc/next build clean.

### audit-T07 — Remove dead deployment-pipelines stub pane
- **goal:** `lib/panes/deployment-pipelines.tsx:16` is a dead stub (`STAGES` hardcoded) — the `/deployment-pipelines` route already uses the real `lib/components/deployment/deployment-pipelines-pane.tsx`. Delete the dead stub file and confirm no import references it, to prevent accidental routing to vaporware.
- **files:** `apps/fiab-console/lib/panes/deployment-pipelines.tsx` (delete), grep for references
- **verify:** no imports of the deleted file; tsc/next build clean.
