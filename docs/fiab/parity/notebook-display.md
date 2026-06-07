# notebook-display — parity with Synapse Studio / Fabric notebook `display(df)`

Source UI:
- Synapse Studio Spark notebook cell output (interactive table + chart switcher)
  — https://learn.microsoft.com/azure/synapse-analytics/spark/apache-spark-data-visualization
- Fabric notebook `display()` rich preview (Table / Chart views, chart builder)
  — https://learn.microsoft.com/fabric/data-engineering/notebook-visualization

Azure-native by default (Synapse Spark Livy). No Microsoft Fabric / Power BI
dependency: works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

## How it works (data flow)

```
display(df)  ── pyspark kernel (IPython) ────────────────────────────────────
  ai-display.py (injected as Livy session statement 0 when LOOM_RICH_DISPLAY=1)
   → builtins.display() overridden
   → df.limit(LOOM_DISPLAY_SAMPLE_ROWS).toPandas() + per-column stats
   → display_pub.publish({'application/vnd.loom.display+json': payload})
        │
GET /runs/{runId} poll route ─────────────────────────────────────────────────
   → out.data['application/vnd.loom.display+json'] detected
   → enrichChartRecs() fills chart recommendations server-side (display-stats.ts)
   → FALLBACK: a raw Spark DataFrame (Spark SQL, or display() without the helper)
     arrives as application/json split-orient → buildLoomDisplay() profiles it
   → returned as output.richDisplay
        │
runCell() → patchCell(id, { output: { richDisplay } })
CodeCell → <RichDisplay payload> :
   • Table view  — sortable grid, column-select Inspect pane (real stats),
     row-select, summary footer, CSV copy, "N of M rows" badge, pagination
   • Charts view — up to 5 native-SVG charts (bar/scatter/line/heatmap-pivot),
     per-chart X/Y/legend/agg + rename/duplicate/delete/reorder
   • "Aggregate over all rows" → POST /run with display(df.groupBy(x).agg(…))
     → REAL Spark shuffle/agg job → poll → re-render chart with full-dataset data
```

The helper and its embedded preamble share one source of truth:
`lib/notebook/ai-display.py` → `scripts/embed-ai-display.mjs` →
`lib/notebook/ai-display-preamble.ts` (the BFF imports the constant; re-run the
script and commit when the `.py` changes).

## Synapse / Fabric feature inventory → Loom coverage

| Capability (Synapse/Fabric) | Loom coverage | Backend per control |
|---|---|---|
| Table view of a DataFrame sample | ✅ TanStack-style grid (paginated) | kernel `application/vnd.loom.display+json` rows; or server `application/json` profile |
| Per-column data type shown | ✅ column header sub-label | dtype from pandas / Spark schema |
| Sort by column | ✅ click header (asc/desc) | client-side over sampled rows |
| Column profile / stats (min/max/mean/stddev, nulls, distinct, top values) | ✅ Inspect pane on column select | computed in `ai-display.py` (pandas) and `display-stats.ts` |
| Row selection | ✅ per-row checkbox | client |
| Copy to clipboard (CSV) | ✅ "Copy all / selected as CSV" | `navigator.clipboard` |
| Total vs sampled row count | ✅ "5,000 of N rows" badge | Spark `df.count()` (real job) / pandas `len` |
| Chart view with recommended charts | ✅ up to 5 native-SVG charts | `recommendCharts()` heuristic (one place) |
| Chart types: bar / scatter / line / pivot | ✅ bar / scatter / line / heatmap(pivot) | `ChartSvg` (no charting dependency — IL5/CDN-safe) |
| Chart builder: X / Y / legend / aggregate | ✅ four Fluent `Select`s per chart | client re-aggregates the sample |
| Rename / duplicate / delete / reorder charts | ✅ inline rename + buttons | client chart state |
| Aggregate over the **full** dataset (not just sample) | ✅ "Aggregate over all rows" | POST `/run` → `display(df.groupBy(x).agg(...))` → real Spark job → `/runs` poll |
| display() of a pandas DataFrame (non-Spark) | ✅ `ai-display.py` pandas branch | pandas profile |
| Non-DataFrame display() (plots, HTML, widgets) | ✅ falls through to built-in display() | IPython built-in |

Zero ❌. The only non-functional state is the honest gate below.

## Honest gates (no vaporware)

- **`LOOM_RICH_DISPLAY=0` / unset** → the helper is not injected; `display(df)`
  renders the kernel's built-in text/HTML table (no error, no empty surface).
  Default in the admin-plane bicep is `true` (LOOM_RICH_DISPLAY=1).
- **`dfVarName` not captured** (e.g. `display(spark.range(10))` with no named
  variable) → the grid + sample-charts still render; only "Aggregate over all
  rows" is disabled, with a tooltip telling the user to assign the DataFrame to
  a named variable first. (Full-dataset agg needs a variable to reference in the
  follow-up Spark statement.)

## Bicep sync

- `platform/fiab/bicep/modules/admin-plane/main.bicep`
  - param `loomRichDisplay bool = true` → env `LOOM_RICH_DISPLAY`
  - param `loomDisplaySampleRows int = 5000` → env `LOOM_DISPLAY_SAMPLE_ROWS`
- `platform/fiab/bicep/modules/deploy-planner/ml-workspace.bicep`
  - opt-in `Microsoft.MachineLearningServices/workspaces/computes` ComputeInstance
    with an inline `setupScripts.scripts.startupScript` carrying the rich-display
    helper, gated on `richDisplayComputeInstanceName` + `richDisplayStartupScriptBase64`.

### Building the AML startup script base64

The Synapse Livy path needs nothing extra — the BFF injects `ai-display.py` at
session start. For AML Jupyter compute instances, pass the base64 of a shell
command that writes the helper into the IPython startup dir. Build it from the
canonical helper:

```bash
PY="$(cat apps/fiab-console/lib/notebook/ai-display.py | base64 -w0)"
CMD="mkdir -p /home/azureuser/.ipython/profile_default/startup && echo $PY | base64 -d > /home/azureuser/.ipython/profile_default/startup/99_loom_display.py"
printf '%s' "$CMD" | base64 -w0   # → richDisplayStartupScriptBase64
```

(AML `startupScript` runs at every machine start; `scriptSource:'inline'` with a
base64 `scriptData` is the supported mechanism —
https://learn.microsoft.com/azure/machine-learning/how-to-customize-compute-instance)

## Per-cloud notes

- Commercial / GCC: Synapse Livy `{ws}.dev.azuresynapse.net`; AML `*.api.azureml.ms`.
- GCC-High / IL5: `AZURE_SYNAPSE_DEV_HOST_SUFFIX=dev.azuresynapse.usgovcloudapi.net`
  (already handled in `synapse-dev-client.ts`); AML `*.api.ml.azure.us`. Charts
  are pure bundled `<svg>` (no CDN, no Vega/Plotly) → IL5-safe. The helper uses
  only stdlib + pandas/pyspark already present in the Synapse environment.

## Verification

- `display-stats.ts` unit tests: `lib/notebook/__tests__/display-stats.test.ts`
  (12 tests — stat computation, recommendation heuristic, agg-code generation).
- Live: run `display(spark.range(10_000_000))` on the Synapse Spark pool with
  `LOOM_RICH_DISPLAY=1` → grid shows `5,000 of 10,000,000 rows`, column `id`
  with min `0` / max `4999999` / mean+stddev, ≥1 recommended chart;
  "Aggregate over all rows" dispatches a Spark job (new runId in the toolbar).
