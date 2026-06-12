# CSA Loom — Weave Epic

The **Weave** is the CSA Loom thread that delivers Azure-native, sovereign-ready
equivalents of best-in-class proprietary analytics platforms. Each weave thread
achieves **1:1 usable feature parity** using Azure + OSS backends — **never** by
requiring Microsoft Fabric, Power BI, or a proprietary license
(`.claude/rules/no-fabric-dependency.md`, `ui-parity.md`, `no-vaporware.md`).

## Threads

### Tapestry — investigative graph (Palantir Gotham equivalent)

**Status: shipped (audit-t53).**

Tapestry is an investigative link-analysis + geospatial + timeline workspace —
the Azure-native answer to Gotham-class investigation. It composes three
coordinated panes over the **same materialized `Node_*` / `Edge_*` ADX tables**
the graph editors already query (one engine, no duplication):

| Pane | Engine | Route |
|---|---|---|
| **Link** | ADX `make-graph` + `graph-match` / `graph-shortest-paths` / `graph-mark-components` | `POST /api/items/tapestry/[id]/link` |
| **Geo** | ADX node lat/lon → GeoJSON FeatureCollection → `GeoJsonMap` (+ optional live Azure Maps raster) | `POST /api/items/tapestry/[id]/geo` |
| **Timeline** | ADX `summarize count() by bin(ts, window), edgeLabel` over `Edge_*` | `POST /api/items/tapestry/[id]/timeline` |

**Cross-filter:** clicking a node in the Link canvas sets a shared seed id the
Geo + Timeline panes inherit.

**Acceptance:** run link / geo / timeline analysis over real data. Met via
`POST /api/admin/load-sample-data?kind=investigation`, which materializes a real
investigation (people, orgs, locations, events with timestamps + coordinates;
Knows/MemberOf/LocatedAt/Attended edges). With ADX unconfigured, every pane
returns an honest **503** naming `LOOM_KUSTO_CLUSTER_URI` — never a Fabric gate.

**Azure-native + sovereign:**
- Link + timeline (ADX graph operators) are GA in **every** Azure cloud; the
  cluster URI is sovereign-aware.
- Geo renders keyless everywhere; the live Azure Maps raster basemap is an
  Azure-side upgrade in Commercial / GCC (Maps is unavailable in GCC-High / IL5,
  where the vector overlay still renders — no regression).
- **No Microsoft Fabric dependency.** Fabric Graph remains opt-in elsewhere and
  is never on Tapestry's path.

**Key files:**
- Editor: `apps/fiab-console/lib/editors/tapestry-editor.tsx`
- BFF routes: `apps/fiab-console/app/api/items/tapestry/[id]/{link,geo,timeline}/route.ts`
- Shared KQL builders: `apps/fiab-console/lib/azure/tapestry-graph.ts`
- Sample data: `apps/fiab-console/app/api/admin/load-sample-data/route.ts` (`kind=investigation`)
- Viz (reused): `lib/components/graph/force-directed-graph.tsx`, `lib/components/graph/geojson-map.tsx`, `lib/components/adx/kusto-results-grid.tsx`
- Catalog: `apps/fiab-console/lib/catalog/fabric-item-types.ts` (`slug: 'tapestry'`)
- Registry: `apps/fiab-console/lib/editors/registry.ts`
- UAT: `apps/fiab-console/e2e/pp-ml-geo-graph.uat.ts` (`{ type: 'tapestry', family: 'graph' }`)
- Parity doc: `docs/fiab/parity/tapestry.md`
- Bootstrap: `docs/fiab/v3-tenant-bootstrap.md` (#tapestry-investigative-graph)

## Future weave threads

Additional Gotham/Foundry/Palantir-class and proprietary-analytics equivalents
are tracked under the Palantir-class migration surfaces already in the catalog
(`workshop-app`, `slate-app`, `ontology-sdk`, `release-environment`,
`health-check`, `aip-logic`) and grow this epic as they land.
