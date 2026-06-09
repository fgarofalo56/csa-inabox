# cross-item-copilot-tools — parity audit (all built-in Copilot tools real)

Source surface: the full-screen `/copilot` cross-item Copilot. The orchestrator
(`apps/fiab-console/lib/azure/copilot-orchestrator.ts`,
`buildDefaultRegistry()`) registers the tool catalog; `POST
/api/copilot/orchestrate` streams `tool_call` / `tool_result` steps (T7) to the
transcript; `GET /api/copilot/status` reports the live tool count.

This doc is the per-tool receipt for the "every registered tool calls a real
backend (no `return []`, no canned data)" audit.

## Tool count

The audit found **38 built-in tools** (the task spec said "32"; the registry had
grown to 37 and the JSDoc header still read "25+"). This PR:

- corrects the JSDoc header to **38 built-in tools** (+ any runtime MCP-shim
  tools), and
- adds **1 new tool** (`fabric_poll_job`, #38) to close the async-gap on the
  Fabric 202 long-running operations.

`GET /api/copilot/status` already reports the live count from
`reg.list().length`, so it stays self-correcting.

## Audit result: ZERO stubs

`grep -rnE 'return \[\]|return \{\}|MOCK_|SAMPLE_'` over
`lib/azure/copilot-orchestrator.ts` + `app/api/copilot/` returns **zero**
undisclosed hits. Every `return []` in the backing clients is a 404/400
defensive guard inside a `try/catch` that has already made a real HTTP call —
not a stub. The backing clients (`adf-client`, `synapse-dev-client`,
`fabric-client`, `powerbi-client`, `kusto-client`) carry explicit "No mocks"
declarations.

## Per-tool receipt (38 tools)

| # | Tool | Service | Backing call | Wire |
|---|------|---------|--------------|------|
| 1 | synapse_serverless_query | Synapse | `synapse-sql-client.executeQuery` (mssql TDS, serverless FQDN) | REAL |
| 2 | synapse_dedicated_query | Synapse | `executeQuery` (dedicated pool) | REAL |
| 3 | synapse_pool_state | Synapse | `synapse-pool-arm.getPoolState` (ARM GET sqlPools) | REAL |
| 4 | synapse_pool_resume | Synapse | `synapse-pool-arm.resumePool` (ARM POST resume) | REAL |
| 5 | synapse_list_pipelines | Synapse | `synapse-dev-client.listPipelines` | REAL |
| 6 | synapse_run_pipeline | Synapse | `synapse-dev-client.runPipeline` | REAL |
| 7 | lakehouse_list | Lakehouse | `adls-client.listPaths` (DataLakeServiceClient) | REAL |
| 8 | lakehouse_read | Lakehouse | `adls-client.getMetadata` | REAL |
| 9 | lakehouse_write | Lakehouse | `adls-client.uploadFile` | REAL |
| 10 | databricks_run_warehouse_query | Databricks | `databricks-client.executeStatement` (+ poll) | REAL |
| 11 | databricks_run_notebook | Databricks | `databricks-client.runNotebook` | REAL |
| 12 | databricks_list_warehouses | Databricks | `databricks-client.listWarehouses` | REAL |
| 13 | databricks_list_jobs | Databricks | `databricks-client.listJobs` | REAL |
| 14 | apim_list_apis | APIM | `apim-client.listApis` (ARM) | REAL |
| 15 | apim_publish_api | APIM | `apim-client.upsertApi` (ARM PUT) | REAL |
| 16 | apim_list_products | APIM | `apim-client.listProducts` (ARM) | REAL |
| 17 | adx_query | ADX | `kusto-client.executeQuery` (`/v1/rest/query`) | REAL |
| 18 | adx_list_databases | ADX | `kusto-client.listDatabases` (`.show databases`) | REAL |
| 19 | adx_list_tables | ADX | `kusto-client.listTables` (`.show tables`) | REAL |
| 20 | adf_run_pipeline | ADF | `adf-client.runPipeline` (ARM createRun) | REAL |
| 21 | adf_list_pipelines | ADF | `adf-client.listPipelines` (ARM) | REAL |
| 22 | powerbi_list_workspaces | Power BI | `powerbi-client.listWorkspaces` | REAL + Gov gate |
| 23 | powerbi_list_reports | Power BI | `powerbi-client.listReports` | REAL + Gov gate |
| 24 | powerbi_refresh_dataset | Power BI | `powerbi-client.refreshDataset` | REAL + Gov gate |
| 25 | fabric_list_workspaces | Fabric | `fabric-client.listFabricWorkspaces` | REAL + Gov gate |
| 26 | fabric_create_notebook | Fabric | `fabric-client.createNotebook` | REAL + Gov gate |
| 27 | fabric_run_notebook | Fabric | `fabric-client.runNotebook` (202 → location) | REAL + Gov gate |
| 28 | **fabric_poll_job (NEW)** | Fabric | `fabric-client.getOperationState` (GET operation URL + /result) | REAL + Gov gate |
| 29 | foundry_list_connections | Foundry | `foundry-client.listConnections` (ARM paged) | REAL |
| 30 | activator_list | Activator | `activator-client.listActivators` | REAL + Gov gate |
| 31 | activator_trigger_rule | Activator | `activator-client.triggerRule` (preview REST) | REAL + Gov gate |
| 32 | workspace_create | Loom | `cosmos-client.workspacesContainer().items.create` | REAL |
| 33 | item_create | Loom | `item-crud.createOwnedItem` (Cosmos + AI Search + Purview) | REAL |
| 34 | item_configure | Loom | `item-crud.updateOwnedItem` (Cosmos replace) | REAL |
| 35 | item_list | Loom | `item-crud.listOwnedItems` / `listAllOwnedItems` | REAL |
| 36 | workspace_list | Loom | `item-crud.listOwnedWorkspaces` | REAL |
| 37 | loom_self_audit | Loom | `admin/self-audit.runSelfAudit` (live env + Cosmos + AOAI probes) | REAL |
| 38 | loom_heal | Loom | `admin/self-audit.applyFix` (Cosmos createIfNotExists; honest gate otherwise) | REAL |

## Changes in this PR

1. **`fabric_poll_job` (#28)** — new tool + `fabric-client.getOperationState()`.
   Fabric create/run-notebook tools return `{ _accepted, location }` for a 202
   long-running operation; the model previously saw only the receipt, never the
   terminal result. `getOperationState()` GETs the operation `Location` URL
   (real Fabric LRO REST), and when `status:'Succeeded'` also fetches `/result`
   so the transcript shows the real payload. The model is directed (tool
   description) to poll until `Succeeded`/`Failed`.

2. **Sovereign honest-gate** — `assertFabricFamilyAvailable(kind)` added to the
   pure `cloud-endpoints.ts` (alongside `graphDlpPolicyApiAvailable()`), called
   at the top of every Power BI / Fabric / Activator handler (#22–28, 30–31).
   Microsoft Fabric / Activator have **no** GCC-High / IL5 / DoD endpoint;
   Power BI has a sovereign host (`api.powerbigov.us`) that must be wired via
   `LOOM_POWERBI_BASE`. In a gated cloud the tool throws an honest error naming
   the Azure-native CSA Loom equivalent (Synapse + ADLS, ADX, Event Hubs, Azure
   Monitor) instead of silently calling a Commercial host that 401s — the
   `no-fabric-dependency` + `no-vaporware` correct behaviour. Commercial + GCC
   are unaffected.

3. **JSDoc count** — orchestrator header corrected from "25+" to "38 built-in
   tools".

## Verification

- `grep -rnE 'return \[\]|return \{\}|MOCK_|SAMPLE_'` over the orchestrator +
  `app/api/copilot/` → **zero** undisclosed hits.
- `grep -c "r.register({"` → **38**.
- `npx tsc --noEmit` → clean on every touched file.
- `vitest` → `copilot-fabric-family-gate.test.ts` 13/13 green; existing
  `cloud-endpoints.test.ts` 67/67 still green.
