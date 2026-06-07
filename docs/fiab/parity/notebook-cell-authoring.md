# notebook-cell-authoring — parity with Fabric / Synapse notebook cell editor

Source UI:
- Microsoft Fabric notebook editor (cell toolbar, cell-type switch, %% magics, drag reorder, split/merge, collapse) — https://learn.microsoft.com/fabric/data-engineering/how-to-use-notebook
- Synapse Spark notebook magics — https://learn.microsoft.com/azure/synapse-analytics/spark/apache-spark-development-using-notebooks
- AML Serverless Spark standalone jobs — https://learn.microsoft.com/azure/machine-learning/how-to-submit-spark-jobs

Scope of this surface: per-cell authoring UX + Spark cell routing inside the
Loom Notebook editor (`lib/editors/notebook-editor.tsx`,
`lib/components/notebook/code-cell.tsx`, `markdown-cell.tsx`).

## Fabric/Synapse feature inventory → Loom coverage

| Capability (real UI) | Loom coverage | Backend per control |
|---|---|---|
| Cell-type selector (Python / PySpark / Spark SQL / Scala / R / T-SQL) | ✅ `Select` in code-cell header (`LANG_OPTIONS`) + default-lang switch | local state → persisted in `definition.cells[].lang` |
| Code ⇄ Markdown cell type | ✅ Convert button per cell + Edit-ribbon "Convert → code/markdown" | `convertCell()` rewrites `cell.type` |
| `%%pyspark` / language-magic highlight | ✅ `%%pyspark → Spark` brand badge in header when a magic leads the cell | pure `detectCellMagic` |
| Run cell | ✅ Run button; magic cells route to Spark, others to selected compute | `/run` (Livy/Databricks) or `/execute-spark` |
| Stop / interrupt | ✅ Stop button replaces Run while running; cancels the poll loop | client interrupt registry (`cancelRef`) |
| Move cell up / down | ✅ Chevron buttons (existing) | `moveCell()` |
| Delete cell | ✅ Delete button | `deleteCell()` |
| Duplicate cell | ✅ Copy button | `duplicateCell()` |
| Drag-to-reorder | ✅ Drag handle (⠿) per cell, native HTML5 DnD; persists on Save | `reorderCells()` → `definition.cells` (the .ipynb) |
| Split cell | ✅ Edit ribbon → "Split cell" | `splitCell()` (midpoint) |
| Merge with below | ✅ Edit ribbon → "Merge with below" | `mergeCellDown()` |
| Collapse / expand cell | ✅ Chevron toggle hides editor + output; shows "N lines hidden" badge | `cell.collapsed` |
| Maximize / restore cell | ✅ (existing) | local state |
| Lock cell | ✅ (existing) | `cell.locked` |
| Rich output (text/plain, df table, html, image) | ✅ (existing normalizeLivyOutput path) | Livy / Databricks output |

## %%pyspark routing (the new backend)

`%%pyspark` (and `%%python`/`%%spark`/`%%sql`/`%%sparkr` aliases) route to a
dedicated Spark backend via `POST/GET /api/items/notebook/[id]/execute-spark`,
independent of the compute picker. Backend is chosen server-side
(`resolveSparkBackend()`):

| Cloud | `LOOM_AML_SPARK` | backend | path |
|---|---|---|---|
| Commercial / GCC | set | **AML Serverless Spark** | standalone Spark job (ARM) → blob `result.json` (`aml-spark-client.ts`) |
| Commercial / GCC | unset | **Synapse Spark (Livy)** | interactive session/statement on `LOOM_SYNAPSE_SPARK_POOL` |
| GCC-High / IL5 (Gov) | forced empty in bicep | **Synapse Spark (Livy)** | AML Serverless Spark is not offered in Azure Government |

The magic is stripped before submission (so Livy/AML runs the body). Python
cells without a magic continue to run on the selected compute (`/run`).

## No-Fabric-dependency

Default path (no AML, or Gov) is **Synapse Spark Livy** — Azure-native, needs no
Fabric/Power BI workspace. AML Serverless Spark is the opt-in Commercial
alternative, gated solely on `LOOM_AML_SPARK`. No `fabricWorkspaceId` read.

## Backends wired (no-vaporware)

- `aml-spark-client.ts` — real ARM: datastore lookup → blob upload → code-asset
  version → `jobType:'Spark'` submit → poll → read `result.json`. Honest
  `AmlSparkNotConfiguredError` 503 gate naming `LOOM_AML_SPARK`.
- `execute-spark/route.ts` — real Livy session/statement reuse via Cosmos
  `pendingRuns`; honest 503 when no Synapse pool is configured.
- bicep `admin-plane/main.bicep` — `LOOM_AML_SPARK` (Gov-gated empty) +
  `LOOM_SYNAPSE_SPARK_POOL` wired into the console env.

## Verification

- `app/api/items/notebook/__tests__/execute-spark-routes.test.ts` — 17 tests
  green: backend resolution (Gov→synapse, IL5→synapse, Commercial+AML→aml,
  default→synapse), pool fallback, magic stripping, AML runId, Synapse
  session-create + submit-on-idle, statement output (`text/plain = 5`), AML
  job poll + result read, honest 503 gates.
- `npx tsc --noEmit` clean across the project.
- Acceptance: a `%%pyspark` cell running `print(spark.range(5).count())` returns
  `5` from the Spark endpoint (Synapse Livy `text/plain` or AML `result.json`);
  Python cells run on the selected compute; drag reorder persists to
  `definition.cells` (the notebook's .ipynb) through Save.
