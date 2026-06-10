# tabular-semantic-link — parity with Microsoft Fabric Semantic Link (SemPy)

Source UI / API: Microsoft Fabric **Semantic Link** (`sempy.fabric`) — the
notebook-side library that reads a Power BI / Fabric semantic model: list
datasets, list tables, list measures, and evaluate DAX against a live model.
Learn: https://learn.microsoft.com/python/api/semantic-link-sempy/sempy.fabric

CSA Loom builds this **one-for-one on the Azure-native tabular layer** — a
notebook / DAX Copilot persona reads a **Loom semantic model** and pulls real
values with **zero Power BI / Fabric dependency on the default path**. Per
`no-fabric-dependency.md`, the Power BI / Fabric XMLA endpoints are reached
ONLY when an operator explicitly opts into the Azure Analysis Services backend.

## Backend per cloud

| Cloud      | Default (`loom-native`)                         | Opt-in (`analysis-services`)                          | Power BI / Fabric |
|------------|-------------------------------------------------|------------------------------------------------------|-------------------|
| Commercial | ✅ Cosmos model metadata + Synapse SQL DAX eval | ✅ `LOOM_AAS_SERVER` + UAMI Reader on the AAS server | opt-in only       |
| GCC        | ✅ same as Commercial                           | ✅ same (GCC runs on Commercial Azure)               | opt-in only       |
| GCC-High   | ✅ loom-native **forced**                       | ⛔ AAS not in Azure Government (gov gate fires)       | ⛔ blocked         |
| IL5 / DoD  | ✅ loom-native **forced**                       | ⛔ AAS not in Azure Government                        | ⛔ blocked         |

`isGovCloud()` forces `loom-native` so a Gov deployment never reaches an AAS or
Power BI host. The Power BI REST host never appears on any tabular code path.

## Semantic Link feature inventory → Loom coverage

| SemPy capability                          | Loom tool / surface                                  | Backend (default)                          | Status |
|-------------------------------------------|------------------------------------------------------|--------------------------------------------|--------|
| `list_datasets()`                         | `tabular_list_models`                                | Cosmos `items` (owned semantic-model)      | ✅ built |
| `list_tables(dataset)`                    | `tabular_list_tables`                                | model `state.content.tables`               | ✅ built |
| `list_columns(dataset, table)`            | columns returned inline by `tabular_list_tables`     | model `state.content.tables[].columns`     | ✅ built |
| `list_measures(dataset)`                  | `tabular_list_measures`                              | model `state.content.measures`             | ✅ built |
| `evaluate_dax(dataset, dax)`              | `tabular_eval_dax`                                   | DAX→T-SQL over Synapse serverless          | ✅ built (constrained DAX) |
| `evaluate_measure(...)`                   | `tabular_eval_dax` with `EVALUATE ROW(...)`          | DAX→T-SQL                                  | ✅ built |
| Full DAX (FILTER/RELATED/SUMMARIZECOLUMNS)| `tabular_eval_dax` on `analysis-services` backend    | AAS XMLA `Execute`                         | ⚠️ honest-gate (set `LOOM_SEMANTIC_BACKEND=analysis-services` + `LOOM_AAS_SERVER`) |
| Notebook / DAX persona system prompt      | `copilot-personas.ts` notebook + DAX registries      | n/a (prompt scoping)                       | ✅ built |
| Result rendering                          | `LoomDataTable` (T7) in `copilot-pane.tsx`           | n/a                                        | ✅ built |

## Backend per control (which data plane each calls)

| Control                | loom-native (default)                                   | analysis-services (opt-in)                |
|------------------------|---------------------------------------------------------|-------------------------------------------|
| `tabular_list_models`  | `listOwnedItems('semantic-model', tenant)` (Cosmos)     | (same — model list is always Cosmos)      |
| `tabular_list_tables`  | `extractContent(item)` from `state.content`             | XMLA `Discover(TMSCHEMA_TABLES)`          |
| `tabular_list_measures`| `extractContent(item)` from `state.content`             | XMLA `Discover(TMSCHEMA_MEASURES)`        |
| `tabular_eval_dax`     | `translateDaxToSql` → `executeQuery(serverlessTarget())`| XMLA `Execute("EVALUATE …")`              |

## loom-native DAX coverage (constrained, honest)

The loom-native translator (`translateDaxToSql`) supports the read-shape DAX a
notebook/DAX assistant emits to pull values:

- `EVALUATE <Table>` → `SELECT TOP 1000 * FROM [Table]`
- `EVALUATE TOPN(N, <Table>)` → `SELECT TOP N * FROM [Table]`
- `EVALUATE ROW("Label", CALCULATE(SUM|COUNT|AVERAGE|MIN|MAX(Table[Col])))` →
  `SELECT AGG([Col]) AS [Label] FROM [Table]`

Anything else returns a precise `TabularError` (no silent failure, no mock rows)
that names the AAS backend for full-DAX support — per `no-vaporware.md`.

## Bicep sync

`platform/fiab/bicep/modules/admin-plane/main.bicep`:
- params `loomSemanticBackend` (`loom-native` | `analysis-services`),
  `loomAasServer`, `loomAasDatabase`
- env vars `LOOM_SEMANTIC_BACKEND`, `LOOM_AAS_SERVER`, `LOOM_AAS_DATABASE` on the
  console Container App. Defaults keep the Azure-native path with **no** AAS /
  Power BI / Fabric requirement.

## Verification

- `lib/azure/__tests__/tabular-eval-client.test.ts` — 19 cases covering the DAX
  translator, metadata extraction, backend selection (incl. the gov gate), and
  the AAS endpoint helpers; asserts no `powerbi` string leaks into the AAS scope
  / XMLA URL.
- Notebook Copilot calls `tabular_list_models` → `tabular_list_tables` /
  `tabular_list_measures` against a real Loom semantic model (Cosmos) and
  `tabular_eval_dax` pulls real values over Synapse — all with
  `LOOM_DEFAULT_FABRIC_WORKSPACE` unset and the Power BI REST host never hit.
