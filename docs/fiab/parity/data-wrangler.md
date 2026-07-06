# data-wrangler — parity with Microsoft Fabric **Data Wrangler**

Source UI (Fabric): the notebook **Data Wrangler** — a visual data-prep tool
launched from a notebook that applies a gallery of cleaning operations to a
DataFrame sample and generates pandas / PySpark code.

- https://learn.microsoft.com/fabric/data-science/data-wrangler (pandas)
- https://learn.microsoft.com/fabric/data-science/data-wrangler-spark (Spark → PySpark codegen)
- https://learn.microsoft.com/fabric/data-science/data-wrangler-ai (AI ops — roadmap)

**No Microsoft Fabric dependency.** The Loom Data Wrangler runs on an
Azure-native pandas host (`loom-wrangler-host`, a FastAPI + pandas Container App
deployed by `platform/fiab/bicep/modules/integration/wrangler.bicep`). The panel
lives in the notebook editor (`lib/components/notebook/data-wrangler-panel.tsx`),
reached from the ribbon **View → Data Wrangler** / **Insert → Data → Data
Wrangler** and the toolbar **Data Wrangler** button. All transforms execute on
the real host via `POST /api/notebook/wrangler`; when the host isn't deployed the
BFF honest-gates on `LOOM_WRANGLER_ENDPOINT` and the panel renders a warning
MessageBar (the full surface still renders) — per `no-vaporware.md`.

## Fabric feature inventory → Loom coverage

| # | Fabric Data Wrangler capability | Loom coverage | Backend per control |
|---|----------------------------------|---------------|---------------------|
| 1 | Launch from a notebook DataFrame | ✅ Ribbon (View/Insert) + toolbar button open the `DataWranglerPanel` OverlayDrawer | client |
| 2 | Convert DataFrame → pandas **sample** for preview | ✅ Panel takes a CSV sample (paste your own, or **Load sample data**); bounded to 5 000 rows (`MAX_ROWS`) | client parse → host |
| 3 | **Operations** panel — searchable, categorised gallery | ✅ Searchable Accordion gallery, 16 ops across Schema / Rows / Missing / Formulas / Text / Numeric / Aggregate (`WRANGLER_OPERATIONS`) | client metadata |
| 4 | Sort | ✅ `sort` (column, ascending) | host pandas `sort_values` → `orderBy` |
| 5 | Filter rows | ✅ `filter_rows` (eq/ne/gt/ge/lt/le/contains/startswith/notnull/isnull) | host boolean mask → `.filter` |
| 6 | Drop / keep columns | ✅ `drop_columns`, `select_columns` | `.drop` / `[cols]` → `.drop` / `.select` |
| 7 | Rename column | ✅ `rename_column` | `.rename` → `.withColumnRenamed` |
| 8 | Change column type | ✅ `cast_type` (int/float/str/bool/datetime) | `pd.to_numeric`/`to_datetime`/`astype` → `.cast` |
| 9 | Drop duplicate rows | ✅ `drop_duplicates` (optional subset) | `.drop_duplicates` → `.dropDuplicates` |
| 10 | Drop rows with missing values | ✅ `drop_missing` (subset, any/all) | `.dropna` → `.dropna` |
| 11 | Fill / impute missing values | ✅ `fill_missing` (value/mean/median/mode/ffill/bfill) | `.fillna` + stats → `.fillna`/agg (Window fallback noted for ffill/bfill) |
| 12 | One-hot encode | ✅ `one_hot_encode` | `pd.get_dummies` → MLlib `StringIndexer`+`OneHotEncoder` |
| 13 | Split column (by delimiter) | ✅ `split_column` | `str.split(expand)` → `F.split` |
| 14 | Find & replace text | ✅ `replace_text` | `str.replace` → `F.regexp_replace` |
| 15 | Change text case | ✅ `change_case` (lower/upper/title) | `str.lower/upper/title` → `F.lower/upper/initcap` |
| 16 | Trim whitespace | ✅ `strip_whitespace` | `str.strip` → `F.trim` |
| 17 | Numeric scale (min-max) | ✅ `scale_minmax` | min-max formula → agg + `withColumn` |
| 18 | Group by + aggregate | ✅ `group_by` (sum/mean/min/max/count/median) | `.groupby().agg` → `.groupBy().agg` |
| 19 | **Live preview grid** with each queued step applied | ✅ Real preview grid — every step executed on the host, debounced re-run on change | host `POST /preview` |
| 20 | Per-column **summary** (dtype, missing, unique) | ✅ Column header shows `dtype · N null · N uniq` | host `_summary` |
| 21 | **Cleaning-steps recipe** (ordered, removable) | ✅ Dismissible `TagGroup`; a failed step shows its error inline | client + host `steps[]` |
| 22 | **Export / add code to notebook** — pandas | ✅ **Insert pandas cell** → appends a code cell with the generated `clean_data()` | host `code.pandas` → notebook cell |
| 23 | **Export** — PySpark (Spark DataFrames) | ✅ **Insert PySpark cell** → appends a code cell with the PySpark `clean_data()` | host `code.pyspark` → notebook cell |
| 24 | Generated code doesn't overwrite the original DataFrame | ✅ pandas uses `df.copy()`; both emit a new `df_clean`, not in-place | host codegen |
| 25 | Custom sample size / method (first/last/random) | ⚠️ Sample is the pasted CSV / labelled starter (bounded). Custom-sample dialog is a follow-up; the core sample→preview→export loop is complete. | client |
| 26 | AI ops (Copilot / AI Functions in Data Wrangler) | ⚠️ Not in this surface — the notebook already has a Copilot pane + AI functions catalog (rel-T85). Data Wrangler AI ops are a roadmap item. | — |
| 27 | Freeform "custom code" operation | ➖ Deliberately **not** reproduced — `loom_no_freeform_config` forbids a freeform code surface; every op is a gallery choice. | n/a |

Legend: ✅ built · ⚠️ honest follow-up (core loop complete) · ➖ intentionally excluded per die-hard rule.

## Backend

- **Compute:** `loom-wrangler-host` — FastAPI + pandas Container App
  (`apps/fiab-wrangler-host/`), internal ingress, scale-to-zero, least-privilege
  AcrPull-only identity. Runs **no arbitrary code** (closed operation gallery)
  and touches **no Azure data plane** (sample in the request, result in the
  response).
- **Endpoints:** `GET /healthz`, `GET /operations`, `POST /preview`
  (execute steps on the sample → preview + summary + pandas/PySpark code),
  `POST /codegen`.
- **BFF:** `POST /api/notebook/wrangler` — session-validated, `{ok,…}` envelope
  via `apiOk`/`apiError`, honest 503 on `LOOM_WRANGLER_ENDPOINT` unset.
- **Bicep:** `integration/wrangler.bicep`, wired in `admin-plane/main.bicep`
  (`wranglerActive` var + dedicated `uami-loom-wrangler` AcrPull grant + console
  env `LOOM_WRANGLER_ENDPOINT`); image built by
  `.github/workflows/full-app-deploy-commercial.yml` (`loom-wrangler-host`).

## Verification

- Host transform engine exercised end-to-end with real pandas (strip → dedupe →
  cast → median-fill → title-case → filter → one-hot): correct preview rows +
  per-column summary + generated pandas & PySpark `clean_data()` — see the PR
  body receipt.
- Guard cascade green: `check-bff-errors`, `check-route-guards`,
  `check-env-sync`, `check-no-freeform`, `check-bicep-sync`, `check-docs-hygiene`.
- Live E2E against the deployed host is pending the operator's next bicep deploy
  (the image + Container App land then); until then the panel renders with the
  honest `LOOM_WRANGLER_ENDPOINT` gate.
