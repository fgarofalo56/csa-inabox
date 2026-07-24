# lineage — column-level lineage UI: table→column fan-out + impact analysis (L5)

**Item:** loom-next-level §L (lineage depth) — **L5**
**Surface:** every host of the shared React-Flow `LineageCanvas`
(`lib/components/catalog/lineage-canvas.tsx`):
- Unified Catalog → asset **Lineage** tab (`/catalog/[source]/[id]`, `LineagePanel`)
- **/catalog/lineage** federated resolver (`LineageGraph` — upgraded by L5 from
  the read-only radial SVG to the shared canvas)
- `/governance/lineage`, `/thread`, the item Lineage drawer (inherit the L5
  layer automatically; they simply have no column-grain nodes until a column
  source feeds their graph)

**Source UIs (parity targets):**
- Databricks **Catalog Explorer → Lineage graph, column-level lineage** —
  "To view column-level lineage, click a column in the graph to show links to
  related columns … clicking on the `revenue` column shows the upstream columns
  from which the column was derived."
  https://learn.microsoft.com/azure/databricks/data-governance/unity-catalog/data-lineage#view-lineage-in-catalog-explorer
- Databricks **impact analysis** framing — "Before changing or deleting a table
  or column, identify the downstream tables, jobs, and dashboards that depend
  on it." https://learn.microsoft.com/azure/databricks/data-governance/unity-catalog/data-lineage
- Microsoft **Purview portal → Lineage tab** column mapping ("Switch to column
  lineage" on a process node) —
  https://learn.microsoft.com/purview/data-gov-classic-lineage-user-guide

**Data:** renders the L1 unified column model ONLY — synthetic
`col:<table>::<column>` nodes + `kind:'column'` edges produced by
`synthesizeColumnGraph` (`lib/azure/unified-lineage.ts`) from the real backends:
Databricks `system.access.column_lineage` (default-ON when
`LOOM_DATABRICKS_LINEAGE_WAREHOUSE_ID` is wired, L7), Weave
`ThreadEdge.columnMappings` (L2/L3 ingest), and the Purview `columnMapping`
facet (L4). No backend was added or changed by L5 beyond carrying the declared
`transform` expression onto the synthesized edge. Azure-native default, no
Fabric dependency (`no-fabric-dependency`).

## Source-UI feature inventory → Loom coverage

| # | Capability (source UI) | Source | Loom coverage |
|---|---|---|---|
| 1 | Table-grain lineage graph, left→right upstream/downstream read | Databricks / Purview | ✅ pre-existing `LineageCanvas` (layered longest-path layout) |
| 2 | Expand a table node to reveal its columns (fan-out) | Databricks ("+ icon on a node reveals more"), Purview column view | ✅ hover/selection-revealed chevron on table nodes (`lineage-col-toggle-*`) toggles the `col:` children grouped via `parentTableId`; toolbar **Columns** button expands/collapses ALL fan-outs |
| 3 | Column→column edges drawn distinctly from table edges | Databricks column lineage | ✅ `kind:'column'` edges render thinner with an emerald tint (vs brand-blue table edges), smaller arrowheads |
| 4 | Click a column → highlight related upstream/downstream columns | Databricks ("click a column … shows the upstream columns from which it was derived") | ✅ column selection walks `kind:'column'` edges ONLY (both directions) and highlights the chain; owning tables stay lit for context |
| 5 | Impact analysis: what breaks downstream if this column changes | Databricks impact-analysis use case | ✅ toolbar **Impact** mode → a selected column highlights ONLY its downstream column chain; detail panel shows downstream count badges (direct / transitive), per-column rows grouped with owning table, hop distances |
| 6 | Per-connection transformation detail (Lineage details panel / Purview columnMapping) | Databricks edge details, Purview | ✅ the declared `transform` expression (e.g. `UPPER(x)`) renders on direct-hop rows in the column detail panel (carried from `ColumnGraphMember.transform` → edge) |
| 7 | Upstream contributors list for a column | Databricks | ✅ "Upstream columns" section in the column detail panel with transforms + hop distances |
| 8 | Jump/focus from a listed column to its node on the canvas | Databricks (click node in panel) | ✅ chain rows and the "Column of" table row are click-to-focus (`focusOn`) when the node is visible |
| 9 | Column view toggle at the surface level | Databricks "See column lineage", Purview "Switch to column lineage" | ✅ `LineagePanel` "Column-level lineage" switch (unified path — UC + Weave + Purview facets); `/catalog/lineage` "Column lineage" switch (always fetches `?columns=true`, toggle controls rendering) |
| 10 | Honest empty state when no column lineage exists | (Loom bar — `no-vaporware`) | ✅ "No column-level lineage captured yet…" hint naming the real feeders (UC system tables / OpenLineage Spark / Weave transforms); never a red banner on a clean asset (ux-baseline first-open-clean). Not an infra gate — no env var is missing; the L1 model is default-ON |
| 11 | Zoom / fit / minimap / resizable canvas | both | ✅ pre-existing `CanvasRightRail` + `ResizableCanvasRegion` (`storageKey="catalog-lineage"`, G3) — column mode inherits it |
| 12 | Kill-switch | (Loom bar — FLAG0) | ✅ `l5-column-lineage-ui` runtime flag (default-ON fail-open) reverts every canvas to the pre-L5 table grain |

**Zero ❌.** Node compactness: column chips are 176px, single-row, one accent
(3px emerald bar); the expand affordance is hover/selection-revealed; all badge
rows in the detail panel use `flexWrap` + `minWidth:0` + truncation.

## Backend per control

| Control | Backend call |
|---|---|
| Column nodes/edges (unified path) | `GET /api/catalog/lineage/item?…&merge=true&columns=true` → `getUnifiedLineage` → UC `system.access.column_lineage` (Databricks SQL warehouse) + Cosmos `thread-edges.columnMappings` + Purview Atlas `columnMapping` (L4) |
| Column nodes/edges (/catalog/lineage) | `GET /api/catalog/lineage?…&columns=true` → `getColumnLineageSystemTables` (UC) / Purview columnEdges; the canvas derives `col:` nodes from the canonical edge endpoints |
| Impact analysis panel | client-side BFS over the fetched `kind:'column'` edges (no extra request — the graph IS the impact model, matching how Databricks walks its already-loaded graph) |
| Expand / Columns / Impact toggles | pure client state over real fetched data |

## Verification

- Unit: `lib/components/catalog/__tests__/lineage-column-model.test.ts`
  (visibility, impact walk + transforms, `col:` parsing/derivation, fan-out
  layout) and `lineage-canvas-columns.test.tsx` (render: clean first open,
  fan-out, impact panel, kill-switch OFF).
- Playwright minted-session walk: `tests/e2e/lineage-columns.spec.ts`
  (clean render always; full column fan-out + impact click-walk when
  `LOOM_E2E_UC_TABLE`/`LOOM_E2E_UC_HOST` name a real asset).
- G1 in-browser E2E receipt (dark+light screenshots, narrow-width badge pass,
  first-open-clean pass): attach to the integration PR per `ux-baseline`.

Related parity docs: `unified-lineage.md` (the L-series merge engine),
`column-lineage-purview.md` (L4 push/read), `column-lineage-adf.md` (L3),
`governance-lineage.md`, `thread-lineage.md`.
