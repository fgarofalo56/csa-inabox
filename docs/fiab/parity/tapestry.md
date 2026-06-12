# tapestry — parity with Palantir Gotham (investigative graph)

Source UI: Palantir Gotham investigative workspace (link analysis + map + timeline).
Azure-native equivalent built entirely on ADX graph semantics + Azure Maps — no
Microsoft Fabric, no Palantir license.

Grounding (Microsoft Learn):
- KQL graph semantics overview (LPG, time-based + geospatial analysis): https://learn.microsoft.com/azure/data-explorer/kusto/query/graph-semantics-overview
- graph-match operator (pattern + variable-length paths): https://learn.microsoft.com/azure/data-explorer/kusto/query/graph-match-operator
- graph-operators (shortest-paths, mark-components, to-table): https://learn.microsoft.com/azure/data-explorer/kusto/query/graph-operators
- Azure Maps Web SDK bubble/heatmap layers + static raster: https://learn.microsoft.com/azure/azure-maps/

## Gotham feature inventory → Loom coverage

| Gotham capability | Loom Tapestry coverage | Backend per control |
|---|---|---|
| Link analysis — entity/relationship graph canvas | ✅ Link tab, force-directed canvas | `POST /api/items/tapestry/[id]/link` → ADX `make-graph` + `graph-match` |
| Path finding between two entities | ✅ Analysis = "Shortest path (source → target)" | `graph-shortest-paths (a)-[e*1..n]->(b)` |
| Cluster / community detection | ✅ Analysis = "Connected components" | `graph-mark-components` |
| N-hop neighborhood expansion from a seed | ✅ Analysis = "Neighborhood (N-hop from seed)" | `graph-match (a)-[e*1..n]->(b) where a.id == seed` |
| Pattern match (typed, hop-bounded) | ✅ Analysis = "Pattern match", hops + node-label controls | `graph-match` with `where` label filter |
| Geospatial map of entities | ✅ Geo tab, GeoJSON FeatureCollection | `POST /api/items/tapestry/[id]/geo` → ADX node lat/lon projection → `GeoJsonMap` |
| Live basemap tiles | ⚠️ honest-gate — live Azure Maps raster when `NEXT_PUBLIC_LOOM_AZURE_MAPS_KEY` set; keyless SVG overlay otherwise (GCC-High/IL5) | Azure Maps static raster (client key) |
| Timeline / temporal analysis | ✅ Timeline tab, binned event counts by relationship | `POST /api/items/tapestry/[id]/timeline` → `summarize count() by bin(ts, window), edgeLabel` |
| Cross-filter (select on one view filters the others) | ✅ click a graph node → sets shared seed id inherited by Geo + Timeline runs | client state |
| Investigation persistence | ✅ item persists via Cosmos item state (ItemEditorChrome) | `/api/cosmos-items/tapestry/[id]` |
| Honest infra gate when graph engine absent | ✅ 503 MessageBar naming `LOOM_KUSTO_CLUSTER_URI` | `kustoConfigGate()` |

Zero ❌. The only ⚠️ is the live raster basemap, which is an Azure-side gate
(Maps not available in GCC-High/IL5), and the geo panel still fully renders the
vector overlay there — no regression.

## Per-cloud behavior

| Boundary | Link + Timeline (ADX) | Geo live raster | Tapestry |
|---|---|---|---|
| Commercial / GCC | ✅ | ✅ (Maps deployed) | Full |
| GCC-High / IL5 | ✅ | ⚠️ keyless SVG fallback | Link + timeline full; geo vector-only |

ADX graph operators are GA in every Azure cloud and the cluster URI is
sovereign-aware (`cloud-endpoints.kustoClusterUri()`), so the investigation
engine is fully sovereign. Fabric Graph remains opt-in elsewhere and is never on
Tapestry's path.

## Validation (real-data E2E)

1. `POST /api/admin/load-sample-data?kind=investigation` → materializes
   `Node_Person/Node_Org/Node_Location/Node_Event` + `Edge_Knows/Edge_MemberOf/Edge_LocatedAt/Edge_Attended`.
2. Link tab → Run (Pattern match, hops=2) → force-directed graph of the people /
   orgs / locations / events.
3. Geo tab → Plot → 6+ located points (DC/NYC/London/Paris/Stockholm).
4. Timeline tab → Run (Daily) → per-bucket counts by relationship (Knows /
   Attended / LocatedAt / MemberOf).
