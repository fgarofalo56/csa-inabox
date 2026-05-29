# graph-model — parity with Fabric IQ Graph (node/edge schema + materialize)

Source UI: Microsoft Fabric IQ → Graph (preview) · https://learn.microsoft.com/fabric/graph/overview ·
https://learn.microsoft.com/fabric/iq/overview

## Azure/Fabric feature inventory
| # | Capability | Source UI |
|---|------------|-----------|
| 1 | Define node types (entities + properties) | Graph schema |
| 2 | Define edge types (relationships, from/to) | Graph schema |
| 3 | Add entity / add relationship dialogs | + buttons |
| 4 | Graph visualization of the schema | Graph canvas |
| 5 | Materialize to graph-native storage | build / publish |
| 6 | Target database binding | settings |
| 7 | Save | save |

## Loom coverage
| # | State | Notes |
|---|-------|-------|
| 1 | ✅ built | node types JSON editor + Add entity dialog (name + props) |
| 2 | ✅ built | edge types JSON editor + Add relationship dialog (name, from/to, props) |
| 3 | ✅ built | Fluent Dialogs with validation; eager-save for existing items |
| 4 | ✅ built | `GraphModelSchemaViz` → `ForceDirectedGraph` renders node types + edge connections |
| 5 | ✅ built | Materialize → real ADX `.create-merge table` per node/edge |
| 6 | ✅ built | target ADX database input (`loomdb-default`) |
| 7 | ✅ built | SaveBar + Ctrl+S → Cosmos item state |

## Backend per control
- Save / Add → PATCH `/api/items/graph-model/[id]` (Cosmos).
- Materialize → `POST /api/items/graph-model/[id]/materialize` → `kusto-client.executeMgmtCommand` issuing `.create-merge table Node_*/Edge_*`. Per-command result list surfaced; ADX not-configured errors surface verbatim (honest-gate).
- Schema viz: client-side from `state.nodes/edges`.
