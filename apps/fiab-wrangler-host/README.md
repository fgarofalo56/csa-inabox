# loom-wrangler-host — CSA Loom Data Wrangler pandas host

Azure-native 1:1 for Microsoft Fabric's **[Data Wrangler](https://learn.microsoft.com/fabric/data-science/data-wrangler)**
— the notebook-based visual data-prep tool that applies a gallery of cleaning
operations to a DataFrame sample and generates pandas / PySpark code. There is
**no Microsoft Fabric dependency**: this is a plain FastAPI + pandas service
deployed as an internal-ingress Azure Container App
(`platform/fiab/bicep/modules/integration/wrangler.bicep`).

The notebook editor's **Data Wrangler** panel (`lib/components/notebook/data-wrangler-panel.tsx`)
is the sole caller, via the Console BFF `/api/notebook/wrangler`. The BFF reads
`LOOM_WRANGLER_ENDPOINT`; when unset it returns an honest 503 naming the env var
+ the bicep module (the full panel still renders).

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET  | `/healthz`, `/health` | Liveness/readiness probe. |
| GET  | `/operations` | The closed operation gallery the panel renders. |
| POST | `/preview` | Apply queued steps to the posted sample → preview grid + per-column summary + generated pandas/PySpark code. |
| POST | `/codegen` | Code-only (no sample) generation. |

`POST /preview` body:

```json
{
  "columns": ["Name", "Age", "City"],
  "rows": [{ "Name": " Alice ", "Age": "29", "City": "france" }],
  "steps": [
    { "op": "strip_whitespace", "column": "Name" },
    { "op": "cast_type", "column": "Age", "dtype": "int" },
    { "op": "one_hot_encode", "columns": ["City"] }
  ],
  "df_var": "df",
  "out_var": "df_clean"
}
```

Response: `{ ok, columns, rows, row_count, summary[], steps[], code: { pandas, pyspark } }`.
Each queued step is executed with **real pandas** on the sample; a per-step
error is reported in `steps[]` and never fails the whole request. The generated
code is the Fabric contract — the sample drives the live preview, the code runs
on the user's full DataFrame back in the notebook.

## Operation gallery (closed set — no arbitrary code)

`drop_columns`, `select_columns`, `rename_column`, `cast_type`, `filter_rows`,
`sort`, `drop_duplicates`, `drop_missing`, `fill_missing` (value/mean/median/mode/ffill/bfill),
`one_hot_encode`, `split_column`, `replace_text`, `change_case`, `strip_whitespace`,
`scale_minmax`, `group_by`.

## Security posture (honest)

- **No arbitrary code.** The gallery is a closed set; there is no `eval`/`exec`
  of a user-supplied expression. (Fabric's freeform "custom code" op is
  intentionally NOT reproduced — see `loom_no_freeform_config`.)
- **No Azure data plane.** The sample is in the request and the result in the
  response; the service reads no storage/SQL/ARM. Its assigned managed identity
  therefore needs only **AcrPull** (mirrors `loom-script-runner`).
- **Internal ingress only**, non-root runtime user, scale-to-zero between runs.

## Local run

```bash
cd apps/fiab-wrangler-host
pip install -r requirements.txt
uvicorn app.main:app --port 8080
curl -s localhost:8080/operations | jq '.operations | length'
```

## Deploy

Built by `.github/workflows/full-app-deploy-commercial.yml` (image
`loom-wrangler-host`) and deployed by `wrangler.bicep`, wired into the console
env as `LOOM_WRANGLER_ENDPOINT` in `admin-plane/main.bicep`.
