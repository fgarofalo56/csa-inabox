# dax-query-view — parity with Power BI "DAX query view"

Source UI: https://learn.microsoft.com/power-bi/transform-model/dax-query-view

CSA Loom surface: the **DAX query** tab in the semantic-model editor
(`lib/editors/components/dax-query-view.tsx`), BFF
`/api/items/semantic-model/[id]/dax-query`. FGC-21.

## Power BI DAX query view feature inventory

| Capability | What it does |
|---|---|
| DAX query editor | A first-class Monaco DAX pane, independent of the measure editor |
| Run | Execute EVALUATE and show a results grid |
| "Show as a query" / quick queries | Right-click a table/column → generate a starter DAX query |
| Save as measure | Pin a scalar result into the model as a measure |
| Copilot / NL2DAX | Generate DAX from natural language |

## Loom coverage

| Row | Loom | Backend |
|---|---|---|
| DAX editor | ✅ Monaco `language="dax"` pane | — |
| Run | ✅ results grid, backend + SQL-translation shown | `POST {op:'run'}` → `evalDax` (Synapse SQL / AAS XMLA) |
| quick queries | ✅ table/column pickers → `daxQueryTemplate` (preview, row-count, distinct, group-by) | pure client generator |
| Save as measure | ✅ name + expression → Loom-native model store | `POST {op:'save-measure'}` → `upsertMeasure` + `writeModelState` |
| NL2DAX | ✅ "Ask the DAX Copilot" reuses the DAX persona (`/api/copilot/dax`) | AOAI, Synapse-backed, zero Power BI |

**No `api.powerbi.com` / `api.fabric.microsoft.com` on any path.** The DAX pane is
the sanctioned 1:1 query-surface (loom_no_freeform_config). Reachable from the
semantic-model editor tab.
