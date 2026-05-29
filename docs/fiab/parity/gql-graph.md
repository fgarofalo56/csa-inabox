# gql-graph — parity with ISO GQL / Fabric Graph query UI

Source UI: Microsoft Fabric Graph (GQL-style pattern matching, shortest path) ·
https://learn.microsoft.com/fabric/graph/overview · ISO/IEC 39075:2024 GQL

## Azure/Fabric feature inventory
| # | Capability | Source UI |
|---|------------|-----------|
| 1 | GQL query editor | Fabric Graph query bar |
| 2 | Execute query | Run |
| 3 | Backend selection (Fabric Graph / translate) | engine |
| 4 | Results: graph viz or grid | result pane |
| 5 | Native/translated query inspection | view query |
| 6 | Save query | save |

## Loom coverage
| # | State | Notes |
|---|-------|-------|
| 1 | ✅ built | Monaco, `SAMPLE_GQL` seed |
| 2 | ✅ built | Run dispatches per backend |
| 3 | ✅ built | dropdown: Fabric Graph REST (preview gate) / Cosmos-Gremlin translate / persist-only |
| 4 | ✅ built | `ForceDirectedGraph` renders results when nodes detected + raw JSON |
| 5 | ✅ built | Translated Gremlin shown in `<pre>` (`result.translated`) for the translate backend |
| 6 | ✅ built | persist-only backend PATCHes the query to Cosmos item state |

## Backend per control
- **fabric-graph** → `POST /api/items/gql-graph/[id]/query` → **503 honest-gate** (`LOOM_FABRIC_GRAPH_WORKSPACE` + Fabric Workspace Contributor) — preview, full UI renders.
- **cosmos-gremlin-translate** → `POST /api/items/cosmos-gremlin-graph/[id]/query` with `lang:'gql'` → real `gqlToGremlin()` translation (vitest-covered) → `executeGremlin`. On a translation miss returns 422 with a precise hint (write Gremlin directly). On runtime gap returns the Cosmos Gremlin 503 honest-gate.
- **persist-only** → PATCH `/api/cosmos-items/gql-graph/[id]` (honest no-dispatch mode).
