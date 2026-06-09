# semantic-model-calc-groups — parity with Power BI / AAS calculation groups + field parameters

Source UI:
- Power BI Desktop / Tabular Editor — Model view → **Calculation groups** (New calculation group → calculation items with DAX + dynamic format strings + precedence + ordinal).
- Power BI Desktop — **New parameter → Fields** (field parameters wizard) → builds a `NAMEOF()` calculated table.
- Learn:
  - https://learn.microsoft.com/analysis-services/tabular-models/calculation-groups
  - https://learn.microsoft.com/power-bi/create-reports/power-bi-field-parameters
  - https://learn.microsoft.com/rest/api/fabric/semanticmodel/items/update-semantic-model-definition

## Azure/Fabric feature inventory

Calculation groups (Tabular / Power BI):
1. Create a calculation **group** (a table) with a **precedence** integer (controls nesting order when multiple groups apply).
2. Add **calculation items**, each with a name, a **DAX expression** built on `SELECTEDMEASURE()` / `SELECTEDMEASURENAME()`.
3. Optional **dynamic format string** per item (`SELECTEDMEASUREFORMATSTRING()` or custom).
4. Optional **ordinal** to control the slicer display order (-1 = sort by name).
5. Model must set **discourageImplicitMeasures = true** for calc groups to evaluate.
6. Persist to a live model via the **XMLA endpoint** (Premium/PPU/Fabric/AAS) or push the full model definition (Fabric REST `updateDefinition`).
7. End result: a **slicer** on the group column switches how a visual's measure is aggregated.

Field parameters (Power BI):
1. Pick a set of **measures and/or columns**; give each a friendly **display name** and **sort order**.
2. Power BI generates a **calculated table** of the form `{ ("Label", NAMEOF('T'[Col]), 0), ... }`.
3. The table's label column drives a **slicer** that swaps which field a visual shows.

## Loom coverage

| Capability | Status | Where |
|---|---|---|
| Create calc group (name + precedence) | built ✅ | SemanticModelEditor → **Calc groups** tab |
| Add/remove calc items (name, ordinal) | built ✅ | Calc groups tab, per-group item list |
| Calc item DAX (`SELECTEDMEASURE()`) | built ✅ | Monaco DAX editor per item |
| Dynamic format string DAX | built ✅ | Monaco editor per item (optional) |
| `discourageImplicitMeasures=true` auto-applied | built ✅ | `buildTmsl()` + `mergeIntoTmsl()` when groups present |
| Field parameter wizard (measures/columns → NAMEOF table) | built ✅ | **Field parameters** tab, per-field rows + live generated DAX preview |
| Field display name + sort order | built ✅ | Field parameters tab |
| Persist (Loom-native, DEFAULT) → item content + TMSL at provision | built ✅ | `POST .../model` → Cosmos `state.content`; `buildTmsl()` emits the tables |
| Persist (AAS, opt-in) → live model over XMLA | built ✅ | `LOOM_SEMANTIC_BACKEND=aas` → `aas-client.executeTmsl()` |
| Persist (Fabric, opt-in) → updateDefinition | built ✅ | `LOOM_SEMANTIC_BACKEND=fabric` → getDefinition→merge→updateDefinition |
| Power BI XMLA write | honest-gate ⚠️ | `LOOM_SEMANTIC_BACKEND=powerbi` → MessageBar: needs Premium/PPU XMLA; config saved to item |
| GCC-High / IL5 / DoD AAS | honest-gate ⚠️ | `aasAvailabilityGate()` → MessageBar: AAS unavailable; loom-native still works |
| Load existing objects back into the editor | built ✅ | `GET .../model` reads Cosmos content or parses live Fabric model.bim TMSL |

Zero ❌. Zero stub banners.

## Backend per control

- **Calc groups / Field parameters tabs (read)** → `GET /api/items/semantic-model/{id}/model` → Cosmos `state.content` (loom-native) or Fabric `getDefinition` + TMSL parse (fabric).
- **Save calc groups / Save field parameters** → `POST /api/items/semantic-model/{id}/model`:
  - `loom-native` (default): `itemsContainer().replace()` writing `state.content.calculationGroups` / `.fieldParameters` (real Cosmos write).
  - `aas`: `aas-client.executeTmsl()` → SOAP/XMLA `Execute` against `https://{region}.asazure.windows.net/servers/{server}/` (real AAS data-plane).
  - `fabric`: `getFabricModelDefinition` → merge into `model.bim` → `updateFabricModelDefinition` (real Fabric REST).
  - `powerbi`: honest gate (XMLA write requires Premium).
- **TMSL emission at provision** → `lib/install/provisioners/semantic-model.ts buildTmsl()` emits `calculationGroup` tables (+ `discourageImplicitMeasures`) and `NAMEOF()` calculated tables.

## No-Fabric-dependency note

The DEFAULT backend (`loom-native`) requires **no Fabric/Power BI workspace**:
calc groups + field parameters are stored with the item and emitted in TMSL when
the model is provisioned to any tabular engine (AAS or Fabric). The editor's full
surface renders and saves with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset. AAS, Fabric,
and Power BI are strictly opt-in via `LOOM_SEMANTIC_BACKEND`.
