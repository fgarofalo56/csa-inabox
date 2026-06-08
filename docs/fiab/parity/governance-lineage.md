# governance-lineage — parity with Microsoft Purview Data Map lineage

**Source UI:** Microsoft Purview portal → **Data Map → asset → Lineage** graph.
Grounded in Microsoft Learn:
- https://learn.microsoft.com/purview/concept-data-lineage
- https://learn.microsoft.com/purview/catalog-lineage-user-guide

**Loom surface:** `app/governance/lineage/page.tsx` (+ `GovernanceShell`, SVG
canvas).

## No-Fabric / no-Purview reality

The lineage graph is **derived live from typed references inside each item's
Cosmos `state`** (`lakehouseId`, `warehouseId`, `datasetId`, `sourceItemId`,
`reportId`, `modelId`, `kqlDatabaseId`, `pipelineId`, …) — **no Purview Atlas
required**. When a Purview account is bound, Atlas lineage edges merge in and the
`source` badge flips to `purview`; until then `source: cosmos` and the full
canvas renders.

## Inventory → Loom coverage → backend per control

| Purview Data Map lineage capability | Loom control | Backend per control | Status |
|---|---|---|---|
| Asset-to-asset lineage graph (nodes + directional edges) | SVG canvas with layered (rank) layout, type-coloured node cards, Bezier arrows | `GET /api/governance/lineage` → Cosmos `workspace-items` typed-reference edges | ✅ BUILT |
| Filter / search the graph | Filter `Input` by name / type / workspace (prunes nodes + dangling edges) | client filter over the loaded graph | ✅ BUILT |
| Focus / scope to one asset's lineage | `?focusId=` → connected-component (transitive up+down) scope + "Focused" badge + "Show all" | client BFS over edges; deep-linked from catalog "View lineage" | ✅ BUILT |
| Select a node → upstream / downstream detail | click node → detail pane listing Upstream (feeds this) + Downstream (depends on this) with the linking key (`via`) | derived from `/api/governance/lineage` edges | ✅ BUILT |
| Open the selected asset's editor | "Open editor" → `/items/{type}/{id}` | client route | ✅ BUILT |
| Edge provenance (why two assets are linked) | edge `<title>` tooltip + `via` key in detail rows | Cosmos reference key that produced the edge | ✅ BUILT |
| Node-type legend | colour legend (lakehouse / warehouse / notebook / pipeline / semantic-model / report / …) | static legend mapped to node colours | ✅ BUILT |
| Refresh | "Refresh" rebuilds the graph | re-invokes `/api/governance/lineage` | ✅ BUILT |
| Purview Atlas physical lineage merge | merged edges + `source: purview` badge when bound | `getLineageSubgraph` (Atlas `/datamap/api/atlas/v2/lineage/{guid}`) | ⚠️ honest-gate (Atlas leg; Cosmos default renders fully) |

**Legend:** ✅ BUILT = real control + real backend today. ⚠️ honest-gate =
optional Purview Atlas enrichment; the Azure-native Cosmos graph is the default
and never blocks. No MISSING rows.

## Grade

**A** — interactive lineage canvas with filter, focus-scope, up/downstream
detail and node-to-editor navigation, all on a real Cosmos-derived graph;
Purview Atlas is an optional merge, not a dependency.
