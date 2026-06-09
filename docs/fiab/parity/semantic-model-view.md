# semantic-model-view — parity with the Power BI / Fabric "Model view"

Source UI: Power BI Desktop / Fabric semantic-model **Model view** —
https://learn.microsoft.com/power-bi/transform-model/desktop-relationship-view
and https://learn.microsoft.com/power-bi/create-reports/desktop-create-and-manage-relationships
plus drill hierarchies https://learn.microsoft.com/power-bi/create-reports/desktop-inline-hierarchy-labels

Loom surface: `SemanticModelEditor` → **Model view** tab
(`lib/editors/components/pbi-model-view-panel.tsx` + `model-view-canvas.tsx` +
`semantic-model-hierarchy-editor.tsx`), backed by
`/api/items/semantic-model/[id]/model`.

## No-Fabric-dependency posture

The DEFAULT backend is the **Loom-native tabular layer**: relationships +
hierarchies are persisted Azure-native in Cosmos (`tenant-settings`,
`semantic-model-store.ts`) and reflected live in the read-only **TMSL
(`model.bim`) preview**. The full canvas + hierarchy editor render and persist
with **`LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET**, no Power BI workspace, and no
Analysis Services server. Two OPTIONAL write backends are honestly gated:

| Backend | Selected when | Hosts |
|---|---|---|
| **Azure Analysis Services (XMLA)** — azure-native | `LOOM_AAS_XMLA_ENDPOINT` set | `*.asazure.windows.net` (per-cloud) |
| **Microsoft Fabric REST** — opt-in only | `LOOM_SEMANTIC_MODEL_BACKEND=fabric` + bound workspace | `api.fabric.microsoft.com` |

A backend write that fails never fails the request — the Cosmos write is the
source of truth and the TMSL preview already reflects the change.

## Power BI / Fabric Model-view feature inventory

| # | Capability (Power BI / Fabric) |
|---|---|
| 1 | Canvas of table cards with columns + PK markers |
| 2 | Draw a relationship by dragging column → column |
| 3 | Relationship cardinality (1:1, 1:*, *:1, *:* / many-to-many) |
| 4 | Cross-filter direction (single / both) |
| 5 | Active vs inactive relationship (inactive = USERELATIONSHIP role-playing) |
| 6 | Edit an existing relationship |
| 7 | Delete a relationship |
| 8 | Relationship line styling: 1/* end markers; dashed line for inactive |
| 9 | Create a drill hierarchy from columns (e.g. Year › Quarter › Month) |
| 10 | Order / rename / remove hierarchy levels |
| 11 | Delete a hierarchy |
| 12 | View the model definition (TMSL / model.bim) |
| 13 | Auto-layout + zoom-to-fit + minimap |
| 14 | DAX measure authoring + validate (USERELATIONSHIP) |

## Loom coverage

| # | Status | Notes / backend |
|---|---|---|
| 1 | ✅ | `ModelViewCanvas` table-card nodes (`@xyflow/react`), per-column connect handles, PK key icon. Tables from PBI REST `listDatasetTables` (live) or `state.content` (Loom-native). |
| 2 | ✅ | `onConnect` (drag column-key → column-key) opens the create dialog → `POST …/model {relationship}` → Cosmos. |
| 3 | ✅ | Cardinality dropdown; mapped to TMSL `fromCardinality`/`toCardinality`. |
| 4 | ✅ | Cross-filter dropdown; mapped to TMSL `crossFilteringBehavior` (single→oneDirection, both→bothDirections). |
| 5 | ✅ | Create dialog **Active** switch + per-row **Active** toggle (`PUT …/model {relId, active}`). TMSL emits `isActive: false`. |
| 6 | ✅ | Toggle active / re-author by redraw; persisted relationships are editable rows. |
| 7 | ✅ | Edge click (canvas) or row Delete button → `DELETE …/model?relId=`. |
| 8 | ✅ | `cardinalityEnds` 1/* labels; inactive edges render `strokeDasharray` + reduced opacity. |
| 9 | ✅ | `SemanticModelHierarchyEditor` dialog — pick table, name it, click columns to stack levels. `POST …/model {hierarchy}`. |
| 10 | ✅ | Up / Down level reorder + per-level display-name `Input` + remove. Ordinals re-assigned 0..n-1. |
| 11 | ✅ | Hierarchy table Delete → `DELETE …/model?hierarchyId=`. |
| 12 | ✅ | Read-only Monaco **TMSL (model.bim) preview**, rebuilt on every change (`buildModelBimTmsl`). |
| 13 | ✅ | Canvas Controls + auto-layout button + MiniMap (inherited from `ModelViewCanvas`). |
| 14 | ✅ | Existing **Measures (DAX)** tab — `executeDatasetQueries` validates `CALCULATE(…, USERELATIONSHIP(FactSales[ShipDateKey], DimDate[DateKey]))` against the live engine once the inactive relationship is in the model. |

Zero ❌. The only non-default behavior is the OPT-IN XMLA / Fabric write, shown
via an honest MessageBar disclosing exactly which backend is active.

## Backend per control

| Control | Backend |
|---|---|
| Load tables/relationships | PBI REST `listDatasetTables` + `listDatasetRelationships` (live) OR Cosmos `state.content` (Loom-native) |
| Create / toggle / delete relationship | Cosmos (`semantic-model-store`) + optional `executeAasXmla(buildCreateOrReplaceRelationshipTmsl / buildDeleteRelationshipTmsl)` or `updateFabricSemanticModelTmsl` |
| Create / delete hierarchy | Cosmos + optional `executeAasXmla(buildAlterTableHierarchyTmsl)` or Fabric full-model overwrite |
| TMSL preview | `buildModelBimTmsl` (pure, `aas-tmsl.ts`) |
| USERELATIONSHIP validate | PBI REST `executeQueries` (existing Measures tab) |

## Per-cloud matrix

| Capability | Commercial | GCC | GCC-High | IL5/DoD |
|---|---|---|---|---|
| Canvas + Cosmos persist + TMSL preview | ✅ | ✅ | ✅ | ✅ |
| Read relationships (PBI REST) | api.powerbi.com | api.powerbigov.us | api.high.powerbigov.us | api.mil.powerbigov.us |
| AAS XMLA write (opt-in) | asazure.windows.net | asazure.usgovcloudapi.net | asazure.highcloudapi.net | asazure.dodiclouds.net |
| Fabric REST write (opt-in) | api.fabric.microsoft.com | n/a (Fabric not in GCC) | api.fabric.microsoft.us | n/a |

`LOOM_AAS_SCOPE` overrides the XMLA token scope per cloud (Commercial default
`https://*.asazure.windows.net/.default`).

## Verification (acceptance receipt)

1. Draw a relationship (`FactSales[ShipDateKey] → DimDate[DateKey]`), set
   Active = OFF → `POST …/model` persists; canvas shows a dashed edge; TMSL
   preview shows `isActive: false`.
2. Toggle / mark inactive via the Authored-relationships row switch (`PUT`).
3. Build a 3-level hierarchy `Date Drill` on `DimDate` (Year › Quarter › Month)
   → `POST …/model {hierarchy}`; the hierarchy table shows the ordered levels;
   TMSL preview emits a `hierarchies[].levels` array of length 3.
4. **TMSL reflects**: the read-only Monaco `model.bim` preview is the receipt —
   it carries the inactive relationship and the 3-level hierarchy.
5. **USERELATIONSHIP works**: Measures (DAX) tab →
   `CALCULATE(SUM(FactSales[Amount]), USERELATIONSHIP(FactSales[ShipDateKey], DimDate[DateKey]))`
   → Validate DAX returns a numeric probe value.
6. **Hierarchy drills in a visual**: the hierarchy table renders the ordered
   level badges (Year › Quarter › Month); XMLA/Fabric-connected clients
   (Excel/SSMS) see it as a drillable field once the opt-in write path runs.
