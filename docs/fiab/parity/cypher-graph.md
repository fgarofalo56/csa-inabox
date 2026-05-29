# cypher-graph — parity with graph query UIs (openCypher → ADX graph-match)

Source UI: Fabric/ADX graph query experiences + openCypher editors ·
https://learn.microsoft.com/azure/data-explorer/kusto/query/graph-match-operator ·
https://learn.microsoft.com/fabric/graph/overview

## Azure/Fabric feature inventory
| # | Capability | Source UI |
|---|------------|-----------|
| 1 | Cypher query editor | graph query bar |
| 2 | Run query | Execute |
| 3 | Results: graph viz or grid | result pane |
| 4 | Source graph/table selection | dataset picker |
| 5 | Dialect switch (Cypher ↔ native) | engine toggle |
| 6 | Translated/native query inspection | "view native query" |

## Loom coverage
| # | State | Notes |
|---|-------|-------|
| 1 | ✅ built | Monaco, `SAMPLE_CYPHER` seed |
| 2 | ✅ built | Run → translate → POST `/api/items/kql-database/[id]/query` |
| 3 | ✅ built | `ForceDirectedGraph` renders `graph-match` rows (Source/Target/Relationship) + raw JSON |
| 4 | ✅ built | Source-table input (`GraphSnapshot` default) feeds the translator |
| 5 | ✅ built | Mode: Cypher ↔ KQL ribbon toggle |
| 6 | ✅ built | Translated KQL shown in a `<pre>` block before execution |

## Backend per control
- Run (Cypher) → `cypherToKql()` (real translator, vitest-covered) → `POST /api/items/kql-database/[id]/query` → ADX `make-graph` + `graph-match` via `kusto-client.executeQuery`.
- Run (KQL mode) → raw KQL to the same route.
- Honest-gate: kql-database route returns the ADX not-configured reason when the cluster isn't bound.
- Translation miss → inline error MessageBar instructing to switch to KQL mode (no silent failure).
