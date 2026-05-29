# ontology — parity with Fabric IQ Ontology / digital twin builder semantic canvas

Source UI: Fabric IQ → Ontology (preview) + digital twin builder semantic canvas ·
https://learn.microsoft.com/fabric/iq/ontology/overview ·
https://learn.microsoft.com/fabric/real-time-intelligence/digital-twin-builder/concept-semantic-canvas

## Azure/Fabric feature inventory
| # | Capability | Source UI |
|---|------------|-----------|
| 1 | Create entity types | semantic canvas |
| 2 | Create relationship types (incl. IS_A hierarchy) | semantic canvas |
| 3 | Class/entity hierarchy view | canvas tree |
| 4 | Graph visualization of the ontology | semantic canvas (node-link) |
| 5 | Property/description authoring | entity detail |
| 6 | Materialize / project to graph / Eventhouse | project to KQL |
| 7 | Save | save |

## Loom coverage
| # | State | Notes |
|---|-------|-------|
| 1 | ✅ built | Add entity dialog (name, parent, description) appends to the ontology DSL |
| 2 | ✅ built | Add relationship dialog sets the IS_A parent in place |
| 3 | ✅ built | parsed class `Tree` (right panel) |
| 4 | ✅ built | `OntologyHierarchyViz` → `ForceDirectedGraph` of class → parent IS_A edges |
| 5 | ✅ built | description carried through the DSL + dialog |
| 6 | ✅ built | Materialize → creates a graph-model item (node per class, IS_A edge) which then ADX-materializes |
| 7 | ✅ built | SaveBar + Ctrl+S → Cosmos item state |

## Backend per control
- Save / Add → PATCH `/api/items/ontology/[id]` (Cosmos), eager-save for existing items.
- Materialize → `POST /api/items/graph-model` creating a derived graph-model; that item's `/materialize` pushes real ADX tables.
- Parsing + viz: client-side `parseOntologyHierarchy` (vitest-covered).
- Lakehouse entity binding + Activator condition-action rules: documented as deferred in the editor MessageBar (honest disclosure, not a disabled button).
