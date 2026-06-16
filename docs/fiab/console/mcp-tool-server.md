# Loom MCP tool server

A [Model Context Protocol](https://modelcontextprotocol.io) server, hosted as an
Azure Function, that exposes a **vetted, read-only** subset of Loom operations as
MCP tools. Any MCP client — the Loom agent loop, Claude, VS Code, etc. — can
discover and call them.

It is **Azure-native and default-on**: provisioned by the admin-plane
orchestrator behind `loomBuiltinMcpEnabled` (default `true`, gated on
`deployAppsEnabled`), and every tool calls Azure REST (AI Search, ARM, ADF) with
the Function App's managed identity — no Fabric dependency, no mocks. The Python
code is published separately (zip / `func azure functionapp publish`), the same
precondition as the loom-* container images.

## Source

`azure-functions/mcp-server/`
- `function_app.py` — JSON-RPC 2.0 MCP server (`initialize` / `tools/list` / `tools/call`) over `POST /api/mcp`; `GET /api/health` liveness.
- `mcp_tools.py` — the vetted tool registry + real Azure REST handlers.
- `deploy/main.bicep` — deploy-from-scratch Function App + storage + App Insights + RBAC.
- `tests/` — JSON-RPC + auth unit tests (no Azure needed).
- `DEPLOYMENT.md` — full deploy + post-deploy grant steps.

## Tools

| Tool | Backend | Honest gate when unconfigured |
|------|---------|-------------------------------|
| `loom_search_catalog` | AI Search `loom-items` index | "Set `LOOM_AI_SEARCH_SERVICE` … or grant Search Index Data Reader" |
| `loom_list_resources` | ARM `…/resources` | "Set `LOOM_RESOURCE_GROUPS` / grant Reader on the RGs" |
| `loom_list_deployments` | ARM `…/deployments` | "Set `LOOM_RESOURCE_GROUPS` / grant Reader on the RGs" |

### Data-movement / pipeline tools

Backed by the same Azure Data Factory the console BFF uses
(`apps/fiab-console/lib/azure/adf-client.ts`) — real ARM REST against
`Microsoft.DataFactory/factories` via the Function App's managed identity. **No
Microsoft Fabric**: ADF is the Azure-native default backend for the
data-pipeline / copy-job / dataflow Loom items. Read/diagnose tools need
**Reader**; write/run tools need **Data Factory Contributor**. All gate honestly
on `LOOM_SUBSCRIPTION_ID` / `LOOM_DLZ_RG` / `LOOM_ADF_NAME` when unset.

| Tool | Surface | Backend (ADF REST) |
|------|---------|--------------------|
| `loom_list_pipelines` | consume | `GET /pipelines` |
| `loom_get_pipeline` | consume | `GET /pipelines/{n}` |
| `loom_list_dataflows` | consume | `GET /dataflows` |
| `loom_get_dataflow` | consume | `GET /dataflows/{n}` |
| `loom_upsert_pipeline` | author | `PUT /pipelines/{n}` |
| `loom_validate_pipeline` | author | `POST /validatePipeline` \| `/pipelines/{n}/validate` |
| `loom_author_dataflow` | author | `PUT /dataflows/{n}` (WranglingDataFlow / Power Query M) |
| `loom_run_pipeline` | run | `POST /pipelines/{n}/createRun` |
| `loom_run_dataflow` | run | ExecuteWranglingDataflow wrapper pipeline + `createRun` |
| `loom_run_copy_job` | run | datasets + (Inc/CDC) control linked service + Full/Incremental/CDC pipeline + `createRun` |
| `loom_list_pipeline_runs` | diagnose | `POST /queryPipelineRuns` |
| `loom_diagnose_run` | diagnose | `POST /pipelineruns/{id}/queryActivityruns` |

`loom_run_copy_job` is the Fabric **Copy job** parity surface (simplified data
movement). Full mode needs only ADF; **Incremental** (watermark) and **CDC**
(native SQL change tracking) modes additionally require the watermark / LSN
checkpoint control DB — when `LOOM_COPYJOB_CONTROL_SQL_SERVER` is unset those
modes return an honest gate naming the env var + the bicep module
(`platform/fiab/bicep/modules/admin-plane/copy-job-control.bicep`, which creates
`dbo.copy_watermark` + `dbo.usp_write_watermark`). `loom_author_dataflow` /
`loom_run_dataflow` are the Azure-native Dataflow Gen2 (Power Query) surface.

## Transport & auth

Stateless Streamable-HTTP (JSON-RPC over a single `POST /api/mcp`). Every request
must send the shared key in `x-api-key` (or `Authorization: Bearer`), matched
against `LOOM_MCP_API_KEY` (Key Vault `secretRef`). Missing key → **503** naming
the setting; it never serves tools anonymously.

## Console wiring + honest gate

The console reads `LOOM_BUILTIN_MCP_URL` (the deployed `/api/mcp` URL). The route
`GET /api/admin/mcp-servers/builtin` returns:
- **configured** `{ endpoint, healthEndpoint }` when the var is set — so the
  Connect-MCP panel can offer one-click registration;
- an **honest gate** naming `LOOM_BUILTIN_MCP_URL` + the bicep module when it
  isn't. A Loom deployment is fully functional without the MCP server.

The **External MCP Tools** panel (Admin → Tenant Settings → Copilot & Agents,
`lib/components/admin/mcp-servers-panel.tsx`) renders a **built-in tools card**
above the server table:
- configured + not yet registered → **Register built-in tools** one-click (saves
  it as a `key-vault`-auth server pointing at `loom-mcp-api-key`);
- configured + already registered → a **Registered** badge;
- not provisioned → the honest gate (env var + bicep module + DEPLOYMENT.md).

The panel already supports the rest of task-007 for any server (built-in or
external): register (URL + `key-vault` secretRef or header auth), **Test
Connection** (real `tools/list` round-trip showing the discovered tool names),
enable/disable, edit, delete. The agent loop discovers each enabled server's
tools at orchestrate time.

## Deploy

**Default-on (orchestrated):** `platform/fiab/bicep/modules/admin-plane/main.bicep`
provisions the Function via `builtin-mcp.bicep` (`loomBuiltinMcpEnabled = true`),
writes a deterministic shared key to the admin Key Vault as
`loom-mcp-api-key` (the name the console's built-in registration hardcodes), and
sets `LOOM_BUILTIN_MCP_URL` +
`LOOM_BUILTIN_MCP_API_KEY_SECRET` on the console. After the infra deploy, publish
the Python code (zip / `func azure functionapp publish`).

**Standalone:** see `azure-functions/mcp-server/DEPLOYMENT.md`.

### Estate-correct deploy (AAD-only storage + private Key Vault)

Validated live (sub `e093f4fd…` / centralus, 2026-06, Function `func-csa-loom-mcp`):

- **Identity-based runtime storage.** The Loom estate enforces AAD-only storage
  (Azure Policy sets `allowSharedKeyAccess=false`), so a key-based
  `AzureWebJobsStorage` connection string is rejected
  (`KeyBasedAuthenticationNotPermitted`). The Function uses
  `AzureWebJobsStorage__accountName` + `__blobServiceUri` / `__queueServiceUri`,
  and its MI holds **Storage Blob Data Owner** + **Storage Queue Data
  Contributor** on its own storage account. Both bicep modules wire this.
- **Literal API key (private vault).** The Loom Key Vault is private-link only; a
  Consumption Function App has no VNet integration and **cannot resolve a
  `@Microsoft.KeyVault(...)` reference** (it returns the literal reference string,
  so the server 401s while `apiKeyConfigured` still reads `true`). The key is set
  as a **literal** `LOOM_MCP_API_KEY` app setting (orchestrator: deterministic
  `guid()`; standalone: pass `apiKeyValue`). The same value lives in Key Vault so
  the console — which *can* reach the private vault over the CAE VNet — loads it
  for one-click registration.
- **Code publish on AAD-only storage.** With SCM basic auth disabled +
  identity-based storage, `config-zip` (and `func` 4.5.0 on Python 3.13) fail.
  Publish via **run-from-package**: build a self-contained zip (Linux wheels —
  `pip install --platform manylinux2014_x86_64 --only-binary=:all: --target
  .python_packages/lib/site-packages`), upload it to the Function storage, and set
  `WEBSITE_RUN_FROM_PACKAGE` to the blob URL (resolved by the Function MI).

Live receipts: `GET /api/health` → `200 {ok:true, apiKeyConfigured:true,
tools:[15]}`; `POST /api/mcp` `tools/list` → `200` JSON-RPC result listing 15
`loom_*` tools.

Post-deploy honest gates (unchanged): grant Reader on cross-RG Loom resource
groups, Search Index Data Reader on the AI Search service, and Data Factory
Contributor on the Loom Data Factory.
