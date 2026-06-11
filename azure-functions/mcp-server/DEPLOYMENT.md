# CSA Loom MCP tool server — deployment

An [MCP](https://modelcontextprotocol.io) server hosted as an Azure Function that
exposes a **vetted, read-only** subset of Loom operations as MCP tools, so any
MCP client (the Loom agent loop, Claude, VS Code, …) can call them.

It is **opt-in** — it has its own deploy module and is *not* deployed by the main
Loom orchestrator. A Loom deployment is fully functional without it.

## What it exposes

### Catalog / inventory (read-only)

| Tool | What it does | Backend |
|------|--------------|---------|
| `loom_search_catalog` | Keyword search the Loom catalog | AI Search `loom-items` index (REST) |
| `loom_list_resources` | List Azure resources in the Loom RGs | ARM `…/resources` |
| `loom_list_deployments` | Recent ARM/bicep deployments, newest first | ARM `…/deployments` |

### Data movement — pipelines / copy jobs / data flows

Author, consume, and diagnose the Loom data-movement surface. Backed by the same
Azure Data Factory the Loom console BFF uses (`Microsoft.DataFactory/factories`,
ARM REST) — the Azure-native default backend for the data-pipeline / copy-job /
dataflow Loom items. **No Microsoft Fabric dependency** (works with
`LOOM_DEFAULT_FABRIC_WORKSPACE` unset).

| Tool | Mode | What it does | Backend |
|------|------|--------------|---------|
| `loom_list_pipelines` | consume | List pipelines + activity counts | ADF `…/pipelines` |
| `loom_get_pipeline` | consume | Full pipeline definition | ADF `…/pipelines/{name}` |
| `loom_list_dataflows` | consume | List mapping/wrangling data flows | ADF `…/dataflows` |
| `loom_get_dataflow` | consume | Full data flow definition | ADF `…/dataflows/{name}` |
| `loom_upsert_pipeline` | **author** | Create/update a pipeline (activities JSON) | ADF `PUT …/pipelines/{name}` |
| `loom_validate_pipeline` | author | Syntactic/reference validation | ADF `…/validatePipeline` |
| `loom_author_dataflow` | **author** | Create/update a Power Query (Dataflow Gen2) data flow | ADF `PUT …/dataflows/{name}` |
| `loom_run_pipeline` | **run** | Trigger a run, return runId | ADF `…/pipelines/{name}/createRun` |
| `loom_run_dataflow` | **run** | Run a Dataflow Gen2 via an ExecuteWranglingDataflow wrapper pipeline | ADF `PUT …/pipelines` + `…/createRun` |
| `loom_run_copy_job` | **run** | Materialise + run a Full/Incremental/CDC copy job (Fabric Copy job parity) | ADF datasets + linked service + pipeline + `…/createRun` |
| `loom_list_pipeline_runs` | diagnose | Recent runs (status, duration, error) | ADF `…/queryPipelineRuns` |
| `loom_diagnose_run` | diagnose | Per-activity output for one run | ADF `…/queryActivityruns` |

The author/run tools require **Data Factory Contributor** on the factory; the
read/diagnose tools work with **Reader**. Configure with the `adfName` +
`dlzResourceGroup` deploy params; when unset, the data-movement tools
honest-gate (a precise error naming the missing app setting).

`loom_run_copy_job` **Incremental** (watermark) and **CDC** (native SQL change
tracking) modes additionally need the watermark / LSN checkpoint control DB. Set
`LOOM_COPYJOB_CONTROL_SQL_SERVER` (+ optional `LOOM_COPYJOB_CONTROL_SQL_DB`,
default `loom-control`) on the Function App and deploy
`platform/fiab/bicep/modules/admin-plane/copy-job-control.bicep` (it creates
`dbo.copy_watermark` + `dbo.usp_write_watermark`). When the control server is
unset, those two modes honest-gate; **Full** mode copy works without it.

All tools call real Azure REST with the Function App's managed
identity. When a backing service/permission is missing, the tool returns an
**honest error** naming the exact setting/role to fix — never a fake result.

## Transport

MCP **Streamable HTTP** in stateless JSON mode: a single `POST /api/mcp`
JSON-RPC 2.0 endpoint handling `initialize`, `tools/list`, `tools/call`.
`GET /api/health` is an unauthenticated liveness probe.

## Auth

Every `/api/mcp` request must send the shared key in `x-api-key` (or
`Authorization: Bearer <key>`), matched against the `LOOM_MCP_API_KEY` app
setting (a Key Vault `secretRef`). If the key isn't configured the server
returns **503** naming the missing setting — it never serves tools anonymously.

## Deploy

1. Create the API-key secret in the Loom Key Vault:

   ```bash
   az keyvault secret set --vault-name <kv> --name loom-mcp-api-key \
     --value "$(openssl rand -hex 32)"
   ```

2. Provision the Function App + supporting resources:

   ```bash
   az deployment group create -g <rg> \
     -f azure-functions/mcp-server/deploy/main.bicep \
     -p keyVaultName=<kv> apiKeySecretName=loom-mcp-api-key \
        loomSubscriptionId=<sub> \
        loomResourceGroups="['rg-csa-loom-admin-eastus2','rg-csa-loom-dlz-single-eastus2']" \
        aiSearchService=<search-service-name> \
        dlzResourceGroup=rg-csa-loom-dlz-single-eastus2 \
        adfName=adf-loom-default-eastus2
   ```

   (Omit `dlzResourceGroup` / `adfName` to ship without the data-movement tools —
   they then honest-gate until set.)

3. Publish the code:

   ```bash
   cd azure-functions/mcp-server
   func azure functionapp publish <functionAppName> --python
   ```

4. **Post-deploy grants (honest gates the bicep does not cover):**
   - `loom_list_resources` / `loom_list_deployments` across *other* RGs: grant the
     output `principalId` **Reader** on each RG in `loomResourceGroups`.
   - `loom_search_catalog`: grant the output `principalId` **Search Index Data
     Reader** on the AI Search service, or set `LOOM_AI_SEARCH_KEY`.
   - Data-movement tools: grant the output `principalId` **Data Factory
     Contributor** on the Loom Data Factory (`adfName`) for the author/run tools
     (`loom_upsert_pipeline` / `loom_run_pipeline`); **Reader** suffices for the
     read/diagnose tools (`loom_list_pipelines`, `loom_list_pipeline_runs`, …).

5. Register it in Loom: Admin → MCP servers → add `https://<host>/api/mcp` with
   the API key as a Key Vault `secretRef` (see the Connect-MCP-tools panel).

## Verify

```bash
curl https://<host>/api/health            # → {ok, tools, apiKeyConfigured}
curl -s https://<host>/api/mcp -H 'x-api-key: <key>' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq
```

## Local dev

```bash
cd azure-functions/mcp-server
cp local.settings.json.sample local.settings.json   # fill in values
pip install -r requirements.txt
func start
python -m pytest tests/                              # unit tests (no Azure needed)
```
