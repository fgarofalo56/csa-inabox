# cosmos-gremlin-graph — parity with Azure Cosmos DB for Apache Gremlin (Data Explorer graph view)

Source UI: Azure portal → Cosmos DB account → Data Explorer (graph tab) ·
https://learn.microsoft.com/azure/cosmos-db/gremlin/how-to-write-queries ·
https://learn.microsoft.com/azure/cosmos-db/gremlin/overview

## Azure/Fabric feature inventory
| # | Capability | Source UI |
|---|------------|-----------|
| 1 | Gremlin query editor (free-text traversal) | Data Explorer query bar |
| 2 | Run / Execute traversal | Execute Gremlin button |
| 3 | Graph visualization — vertices + edges rendered as a node-link diagram | Data Explorer graph pane |
| 4 | Result toggle: graph view ↔ raw JSON (GraphSON) | Graph / JSON tabs |
| 5 | Quick `g.V()` / `g.E()` browse | Data Explorer "Execute Gremlin Query" presets |
| 6 | New vertex / new edge | Data Explorer "New Vertex" form |
| 7 | Endpoint / database / graph binding | account connection |
| 8 | Execution profile (RU, fan-out) | `.executionProfile()` |

## Loom coverage
| # | State | Notes |
|---|-------|-------|
| 1 | ✅ built | Monaco editor, `SAMPLE_GREMLIN` seed |
| 2 | ✅ built | Run → POST `/api/items/cosmos-gremlin-graph/[id]/query` |
| 3 | ✅ built | `GremlinViz` → `ForceDirectedGraph` (SVG) renders extracted vertices/edges |
| 4 | ✅ built | Force-directed view + `ResultsPreview` raw JSON shown together |
| 5 | ✅ built | Edges / Vertices ribbon + left-panel buttons load `g.E()` / `g.V()` projections and execute |
| 6 | ⚠️ honest-gate | new vertex/edge are issued as `g.addV()` / `g.addE()` Gremlin via the editor (write traversals run through the same Run path); a dedicated form is not surfaced — addV/addE in the editor is the documented path |
| 7 | ⚠️ honest-gate | endpoint is server-bound (read-only `LOOM_COSMOS_GREMLIN_ENDPOINT`); editing a fake endpoint is forbidden by no-vaporware |
| 8 | ✅ supported | `.executionProfile()` runs through the same Run path (Gremlin passthrough) |

## Backend per control
- Run / Edges / Vertices / addV / addE / executionProfile → `POST /api/items/cosmos-gremlin-graph/[id]/query` → `executeGremlin()` (gremlin npm + AAD/account-key). Returns **503 honest-gate** with the exact env vars (`LOOM_COSMOS_GREMLIN_ENDPOINT`, optional `LOOM_COSMOS_GREMLIN_KEY`, Cosmos Data Contributor role) when the runtime is not provisioned — full UI still renders.
- Graph viz: client-side `extractGraph()` recognises GraphSON vertex/edge shapes.
