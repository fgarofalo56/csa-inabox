# paginated-report-renderer — deployment

Azure Function that renders a CSA Loom **RDL report definition** to **PDF /
Excel / Word**. This is the **Azure-native default** export path for the
`paginated-report` item type — no Microsoft Fabric / Power BI capacity is
involved (see `.claude/rules/no-fabric-dependency.md`).

## What it is

| Surface | Auth | Purpose |
|---|---|---|
| `POST /api/render` | Function key (`?code=…`) | Body `{ definition, format, parameterValues }` → rendered binary |
| `GET /api/health` | anonymous | liveness probe |

Renderers: ReportLab (PDF), openpyxl (XLSX), python-docx (DOCX). The report is
paginated from the `sampleRows` captured on each dataset at authoring time (the
editor's **Run preview** runs the real dataset query over TDS).

## Deploy

```bash
# 1) Infra (storage + Y1 plan + Function App, Python 3.12)
az deployment group create \
  -g <function-rg> \
  -f azure-functions/paginated-report-renderer/deploy/main.bicep
# (loomCosmosAccountName is optional — only for the future live-query path)

# 2) Publish the code
cd azure-functions/paginated-report-renderer
func azure functionapp publish <functionName-from-output>

# 3) Wire the Console
#    - read the host key:
az functionapp keys list -g <function-rg> -n <functionName> --query functionKeys.default -o tsv
#    - store it in the Console Key Vault as 'loom-paginated-render-key'
az keyvault secret set --vault-name <console-kv> -n loom-paginated-render-key --value <key>
#    - set the admin-plane params and roll the Console:
#        loomPaginatedRenderUrl   = <functionUrl output>
#      (LOOM_PAGINATED_RENDER_URL + LOOM_PAGINATED_RENDER_KEY are emitted by
#       admin-plane/main.bicep when loomPaginatedRenderUrl is non-empty)
```

When `LOOM_PAGINATED_RENDER_URL` is **unset**, the Console's paginated-report
designer still fully works for authoring; only the **Export** buttons are
honest-gated with the exact remediation (a Fluent MessageBar naming this env
var + bicep module).

## Per-cloud

Zero cloud-specific code. The backing-storage suffix is resolved by the bicep
`environment().suffixes.storage` expression (Commercial `core.windows.net`,
GCC-High/IL5 `core.usgovcloudapi.net`). Cosmos is not required for rendering.
