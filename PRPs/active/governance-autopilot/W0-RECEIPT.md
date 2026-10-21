# W0 receipt: Governance Autopilot measurement spike

Date: 2026-10-16. Scope: measurement only, no product code, no Azure or Purview write. Commercial measured live from a workstation (read-only, explicit `--subscription`); GCC-High NOT run (Gov runs only through GitHub Actions) and handed off as a dispatchable workflow.

Legend: MEASURED = established by the command shown. BLOCKED = could not be established, reason and owner given. ASSUMED = a scenario knob with no measurement behind it.

## 1. Headline

- There is exactly ONE Purview account in the four Limitless subscriptions: `purview-csa-loom-eastus2` (DMLZ sub, rg `rg-csa-loom-admin-centralus`, location eastus2). MEASURED.
- What is registered or scanned in it is **BLOCKED**: the workstation cannot mint a token in the Limitless tenant (guest), and the House Garofalo token is answered `404 TenantNotFound`. Owner: an operator on a Limitless identity, or the Commercial run of the new workflow (see 7; it may itself be BLOCKED by the account's public-network-Disabled setting).
- 6 backing sources SHOULD be registered today (ADLS lakehouse account, Synapse workspace, ADX cluster, 2 Azure SQL servers, Databricks workspace); the diff against what is registered is therefore UNKNOWN, not "6 missing".
- No scan was billed in the last 30 days (actual cost $42.73, no Data Map or scan meter). Scan cost for the estate is $0.69 to $33.59 per day across the assumed range, about $4.20 per day at the middle assumption (section 5).

## 2. Code facts (file:line at `089666884`, paths under `apps/fiab-console/` unless stated)

### 2a. Backing-resource key per item type

There is no single key. Four layers write it: (1) install receipt `state.provisioning.{resourceId,secondaryIds}` (`app/api/apps/[id]/install/route.ts:371-382`; cleared on create by `stripCreateState`, `lib/azure/auto-bind.ts:864-868`, called at `app/api/items/_lib/item-crud.ts:913`); (2) flat keys from `AutoBindProvider.stateKeys()` in `lib/azure/auto-bind-providers.ts` (`state.autoBind` is provenance only, `auto-bind.ts:81,129`); (3) editor-written flat keys; (4) `purviewSourceName` stamped by `purview-autoonboard.ts:214-232`.

| Item type | Backing service | Key path in state | Written at | Fixture example |
|---|---|---|---|---|
| lakehouse (install) | ADLS Gen2 | `provisioning.secondaryIds.{container,rootPath,adlsRoot}` | `lib/install/provisioners/lakehouse.ts:909-915` | `app/api/admin/lakehouse-roots/keep/__tests__/keep-route.test.ts:92` `{container:'bronze',rootPath:'lakehouses/Sales'}` |
| lakehouse (new item) | ADLS Gen2 | `adlsContainer`, `lakehouseRoot` | `auto-bind-providers.ts:621-624` | `app/api/access-requests/__tests__/decision.test.ts:136` `{adlsContainer:'gold'}` |
| lakehouse (external) | ADLS Gen2 | `storageAccount` | read `lib/azure/lakehouse-abfss.ts` ~`:580`, `purview-autoonboard.ts:182` | `app/api/items/_lib/__tests__/lakehouse-create-state.test.ts:128` `'dlzacct'` |
| warehouse | Synapse dedicated pool | `provisioning.secondaryIds.database`, then `database`/`databaseName` | `warehouse.ts:570-571`; read `app/api/items/_lib/synapse-item-scope.ts` ~`:215-232` | `app/api/items/warehouse/[id]/__tests__/ghsa-synapse-shared-pool.test.ts:70` |
| kql-database, eventhouse | ADX | `provisioning.secondaryIds.database` or `.resourceId`, then `database` | `kql-db.ts:254-258`; read `app/api/items/_lib/adx-item-scope.ts:190-203` | `app/api/items/[type]/[id]/sensitivity-label/__tests__/label-grant-scope.test.ts:128` `database:'kql-own'` |
| kql-database (new item) | ADX | `kqlDatabase`, `kustoClusterUri` | `auto-bind-providers.ts:509-512` | none found |
| eventstream | Event Hubs, ASA | `ehId`, `transportHub`, `asaJobId`, `asaJobName` | `eventstream.ts:107-114,195-204` | `lib/azure/__tests__/eventstream-hub-scope.test.ts:31` `transportHub:'es-transport-abc'` |
| data-pipeline (ADF), adf-pipeline | ADF | `pipelineName`, `factory`, `factorySubscriptionId`, `factoryResourceGroup` | `auto-bind-providers.ts:286-291`; `adf-pipeline.ts:139` | `lib/azure/__tests__/auto-bind-seed.test.ts:374` `pipelineName:'P1'` |
| data-pipeline (Synapse), synapse-pipeline | Synapse | `pipelineName`, `workspace` | `auto-bind-providers.ts:372-375`; `synapse-pipeline.ts:142` | same file |
| mirrored-database | ADF CDC to ADLS | `secondaryIds.{pipeline,bronze,adlsRoot,discoveredTables}` | `mirrored-database.ts:568-586` | not sampled |
| mirrored-databricks | Databricks UC | `secondaryIds.catalogName`, `ucTablesJson` | `mirrored-databricks.ts:140-148` | `lib/install/provisioners/__tests__/databricks-mirror.test.ts:61` `catalogName:'main'` |
| materialized-lake-view | ADLS Delta | `secondaryIds.{fqn,container,deltaUrl}` | `materialized-lake-view.ts:75-90` | not sampled |
| synapse-serverless-sql-pool | Synapse serverless | `secondaryIds.{endpoint,database,dataSource,adlsRoot}` | `synapse-serverless-sql-pool.ts:389-399` | not sampled |
| ai-search-index | AI Search | `indexName`, optional `service` | read `lib/azure/search-binding.ts:93-94`; install `ai-search.ts:377-378` | `lib/azure/__tests__/search-binding.test.ts:54` `indexName:'hotels-sample'` |
| ml-model | AML / Databricks | `modelName`, `workspaceName`, `version` | read `lib/azure/model-binding.ts:96-98`; install writes only `notebookPath`,`runId` (`ml-model.ts:309`) | none found |
| notebook | Synapse or Databricks | `secondaryIds.{synapseWorkspace,synapseNotebook}` or `{databricksHost,databricksPath}` | `notebook.ts:366,426` | not sampled |
| databricks-job / -notebook / -sql-warehouse | Databricks | `secondaryIds.jobId` / `notebookPath` / `warehouseId` | `databricks-job.ts:329`, `databricks-notebook.ts:92`, `databricks-sql-warehouse/[id]/create/route.ts:82` | not sampled |
| kql-dashboard | ADX | `secondaryIds.{clusterUri,database}` | `kql-dashboard.ts:340,417,451` | not sampled |
| logic-app | Logic Apps | `logicAppName` | install `route.ts:404-405` | not sampled |
| stream-analytics-job | ASA | `secondaryIds.jobName`, `resourceId` (ARM id) | `stream-analytics-job.ts:132,264` | not sampled |
| data-product | Purview UC | `secondaryIds.{governanceDomainId,dataProductIds,glossaryTermIds}` | `data-product.ts:396-401` | not sampled |
| activator | Azure Monitor | `resourceId` = last rule name | `activator.ts:411-453` | not sampled |

**Gaps for W2** (no key, or no consistent key): `semantic-model`, `report` (Loom-native; model in `state.content`, `secondaryIds.backend='loom-native'`, `semantic-model.ts:592-598`, `report.ts:264-265`); `data-pipeline`/`notebook`/`prompt-flow`/`evaluation` (no scannable data); `eventstream`, `kql-database`, `ai-search-index`, `warehouse`, `ml-model` carry only NAMES, with the cluster, namespace or service coming from env, so a resolver needs `lib/azure/attached-target-resolver.ts` and not `state` alone; `mirrored-database` has no source-DB FQDN key; hand-created items have no `provisioning` at all.

**Existing resolvers to reuse**: `lib/azure/item-backing-scope.ts:48-93` (lakehouse, warehouse, kql), `adx-item-scope.ts:190`, `synapse-item-scope.ts`, `search-binding.ts`, `model-binding.ts`. **`loomItemToScanSource` (`purview-autoonboard.ts:161-206`) is value-driven**: it looks for an `abfss://` or `*.dfs.*` value, `storageAccount` (`:182`), `metastoreId` (`:188-192`) or a SQL FQDN (`:195-201`), so warehouse, kql-database, eventstream, ai-search and semantic-model resolve to null and are skipped silently (`:203`).

### 2b. Synapse grant mechanism

T-SQL `CREATE USER [name] FROM EXTERNAL PROVIDER` then `EXEC sp_addrolemember N'db_datareader', N'name'` (dedicated pools reject `ALTER ROLE ... ADD MEMBER`, comment `lib/azure/access-policy-client.ts:204-207`).

| Mechanism | Runs as | Cite |
|---|---|---|
| Runtime grant | Console UAMI via `synapseExecute`, dedicated pool only, hard-coded `dedicatedTarget()` | `lib/azure/access-policy-client.ts:132` (`enforceAccessGrant`), `:161`, `:208-212`, idempotent via `warehouseRoleHeld` `:408`, role map `:53` |
| Post-deploy bootstrap | CI, gated on `vars.LOOM_SYNAPSE_PUBLIC_TOGGLE=='true'`; grants `db_owner` | `.github/workflows/csa-loom-post-deploy-bootstrap.yml:1166-1190` serverless master login, `:1192-1220` dedicated, `:1222-1255` every serverless user DB |
| Manual script, referenced by no workflow | operator with sqlcmd | `scripts/csa-loom/grant-bi-rbac.sh:57-77` |
| In-VNet job | container job | `scripts/csa-loom/grant-synapse-rbac-invnet-job.sh:124-138` |
| Bicep deploymentScript (ADF MI datareader+datawriter) | deployment | `platform/fiab/bicep/modules/admin-plane/copy-job-control.bicep:127-129` |

Nothing grants the Purview account MSI anywhere (only `scripts/csa-loom/setup-purview-databricks-scan.sh:10` mentions a Purview MSI, for Databricks). To add it: use the Purview account NAME as the principal (an MSI's Entra display name) in the same two statements, in the bootstrap dedicated step and in the serverless step (login in master first, `:1186`, then user plus `db_datareader` per user database); the runtime path would need a serverless target because it is dedicated-only.

### 2c. Data Map calls in `lib/azure/purview-client.ts`

Three api-versions: Atlas and Discovery `2023-09-01` (`:103`), account/collections `2019-11-01-preview` (`:105`), scanning `2022-07-01-preview` (`:107`). 54 `purviewFetch` call sites. Scan plane (all `SCAN_API_VERSION`): GET `/scan/datasources` (`:1591`), PUT/DELETE `/scan/datasources/{n}` (`:1665`,`:1685`), GET `.../scans` (`:1697`), PUT `.../scans/{s}` (`:1836`,`:2434`), **PUT `.../scans/{s}/runs/{guid}?scanLevel=` (`:1864-1865`)**, GET `.../runs` (`:2186`), `/scan/integrationruntimes` (`:1965`,`:1989`,`:1999`,`:2094`), `/scan/managedvirtualnetworks` (`:2110-2175`), `/scan/classificationrules` (`:2287`,`:2307`,`:2327`), `/scan/scanrulesets` (`:2366`,`:2383`). Account plane: `/collections` GET (`:718`), PUT/DELETE (`:2614`,`:2636`,`:2670`). Atlas: `/datamap/api/atlas/v2/*` (entity, typedefs, glossary, businessmetadata).

**Run verb, code versus Learn.** Code: `PUT /scan/datasources/{src}/scans/{scan}/runs/{guid}?scanLevel=Full&api-version=2022-07-01-preview`; its comment (`:1845-1852`) records it as PROVEN live against the classic account on 2026-07-15 (runId must be a GUID; `scanLevel` mandatory; 202 `{scanResultId,status:'Accepted'}`). Learn "Scan Result - Run Scan" (2023-09-01), quoted: `POST {endpoint}/scan/datasources/{dataSourceName}/scans/{scanName}:run?runId={runId}&scanLevel={scanLevel}&api-version=2023-09-01`, response `202 Accepted` with `Operation-Location`. They differ in verb AND api-version. W0 could not test (read-only), so which verb a 2023-09-01 call accepts is **BLOCKED on a write**: owner W4, probe `:run` once on a throwaway scan in a non-production collection.

**Learn corrections that matter to the PRP** (same page): run status enum is `Accepted, InProgress, TransientFailure, Succeeded, Failed, Canceled`, there is no `Completed`; asset counts are at `discoveryExecutionDetails.statistics.assets.{discovered,classified,failed}`; data source and scan names must match `^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$`, 3 to 63 chars (no underscore). Learn "API authentication for Microsoft Purview data planes" (updated 2026-06-01): token resource `https://purview.azure.net`; per plane roles are Data Curator (catalog), Data Source Administrator (scanning), Collection Admin (account plane and metadata policy), which is exactly the four-role set `grant-purview-datamap-role.sh:98` grants.

### 2d. `purview` and `svc-purview-uc` gates

Env presence only. `purview`: `required: ['LOOM_PURVIEW_ACCOUNT']`, `lib/admin/env-checks/azure-services.ts:204-210`; `svc-purview-uc`: `required: ['LOOM_PURVIEW_UC_ENDPOINT']`, `lib/admin/env-checks/catalog-governance.ts:35-41`; registry entries `lib/gates/registry/azure-services.ts:167-176` and `catalog-governance.ts:20-27`. Neither calls `probePurview`. Its only callers are `lib/admin/self-audit.ts:182-194` and `app/api/governance/purview/status/route.ts:33`. The `svc-purview-uc` remediation text (`catalog-governance.ts:37`) says `https://<account>.purview.azure.com`, while bicep wires `api.purview-service.microsoft.com` (confirmed inconsistency; W8 fixes).

### 2e. Per-cloud endpoints and audience

| Item | Code | Learn |
|---|---|---|
| Scope | `PURVIEW_SCOPE='https://purview.azure.net/.default'`, `purview-client.ts:100`, cloud-invariant | resource `https://purview.azure.net`; no sovereign audience documented (data-gov-api-rest-data-plane) |
| Host suffix | `isGovCloud()` ? `purview.azure.us` : `purview.azure.com` (`purview-endpoints.ts:60-68`); `isGovCloud` is true for AzureUSGovernment AND AzureDOD (`cloud-boundary.ts:96-99`) | Gov classic host `purview.azure.us` (Learn networking table, cited in `purview-endpoints.ts`) |
| Bicep output | `.us` only for GCC-High and IL5 (`catalog.bicep:407-408`) | n/a |
| Resolution order | `LOOM_PURVIEW_ENDPOINT`, ARM `properties.endpoints.catalog`, convention host (`purview-endpoints.ts:19-40`); **an account on the new platform reports a `{tenantId}-api.purview-service.microsoft.com` catalog host and the code deliberately falls back to the classic convention host** (`:208-226`) | |

The measured account is exactly that case (section 3): ARM `endpoints.catalog` is `https://d1fc0498-...-api.purview-service.microsoft.com/catalog`, so Loom talks to `purview-csa-loom-eastus2.purview.azure.com`.

Whether a Gov tenant accepts `https://purview.azure.net` is **BLOCKED** for me (Gov via Actions only): the new workflow probes `purview.azure.net`, `purview.azure.us` and `purview.azure.com` for GCC-High and records the HTTP status of each.

### 2f. DoD

No DoD bicepparam. `params/` = commercial, commercial-full, dlz-attach, gcc, gcc-high, il5, tenant-dmlz. `platform/fiab/bicep/main.bicep:20` is `@allowed(['Commercial','GCC','GCC-High','IL5'])`, so bicep cannot target DoD. App code knows `DoD`/`AzureDOD` (`cloud-boundary.ts:38,68-89`). No deploy workflow for DoD exists (`.github/workflows/` has `deploy-fiab-gcch.yml` and `deploy-fiab-il5.yml` only). DoD is not deployable today.

### 2g. Copilot tool registration, confirmation, audit

`LoomToolRegistry` `copilot-orchestrator.ts:409` (`register` `:413`); `ToolDef` `:386-405` (no write/approval flag); `ToolContext` `:380` carries only `userOid` and `session.claims` (no group claims, confirming PRP R14). Singleton `getRegistry()` `:1846-1850`; `buildDefaultRegistry` `:493`. Registration: inline `r.register` `:497-1309`; modules via `lib/copilot/kql-tools.ts` (`:666`), `tabular-read-tool.ts` (`:1138`), `activator-tools.ts` (`:1181`), `sql-tools.ts` `registerWarehouseTools` (`:1292`), `dax-tools.ts` (`:1297`), `knowledge-tools.ts` (`:1302`); imports `:79-103`. A new `governance-tools.ts` follows the `registerXTools(r)` pattern at `:1292-1302`.
Confirmation: no generic mechanism; per-tool `confirm` boolean defaulting false (`adf_delete_pipeline` `:683-693`, `adf_remove_factory_object` `:694-707`); `PROPOSED_CHANGE_KEY` (`:1435-1442`, unpacked `:2675-2678`, emitted `:2709-2724`) is an editor-diff Keep/Undo, not a write approval. `loom_resolve_gate` (`:1070`) checks capability `admin.env-config` (`:1085-1093`) and writes `action:'gate.resolve'` through `applyEnvChanges` (`:1108-1115`).
Audit: `persistStep` (`:1859`; call and result at `:2640-2650`, `:2704`) saves the session; the orchestrator never calls `emitAuditEvent` (`lib/admin/audit-stream.ts:212`); only `lib/admin/env-apply.ts:242` does. Every new write tool must call `emitAuditEvent` itself.
Existing governance-adjacent: no registered tool name contains purview, glossary, lineage or governance; `catalog_search` (`lib/azure/iq-mcp-tools.ts:36`, route `app/api/iq/mcp/route.ts:37`) is not in the Copilot registry; `mesh-governance` agent kind `lib/copilot/agent-registry.ts:41,185,201,240`.

### 2h. Visibility and truncation lines (all PRP citations re-checked)

`workspace_list` handler `copilot-orchestrator.ts:967-973` calls `listOwnedWorkspaces(ctx.userOid)` (`item-crud.ts:852-862`, `WHERE c.tenantId = @t` at `:857`, owner only). `item_list` `copilot-orchestrator.ts:942-964` uses `listAllOwnedItems` (`item-crud.ts:812`) with no tool-level bound. 16,000-char cut: `copilot-orchestrator.ts:2681-2682` (`serialized.length > 16_000`, then slice) and `help-copilot-orchestrator.ts:837`. `listAccessibleWorkspaces` `lib/auth/workspace-access.ts:570` (returns owned only when `multiUserAclEnabled()` is false, `:586`). `listOwnedItemsBounded` is `item-crud.ts:688-796` (PRP said 688-792), with `limit`/`budgetMs` at `:691-692` and `truncated: false|'limit'|'budget'`.

### 2i. Other UNVERIFIED items

- Console UAMI Data Map grant scope: ROOT collection, via the metadata policy of the collection named after the account (`scripts/csa-loom/grant-purview-datamap-role.sh:3-22,199`); all four roles by default (`:98`). Not per-collection.
- Azure Policy exclusions: none exists for Purview. Read-only `az policy assignment list`: DMLZ 3 assignments, none storage/purview related; DLZ 15, one storage-related (`Deny Storage accounts without HTTPS - dev`), which does not block scanning. MEASURED, `az policy assignment list --subscription <id>` for DMLZ and DLZ; ALZ and Main not listed.
- Lineage emission for notebook, semantic-model, report: none. `lib/lineage/` holds `synapse-emitters.ts`, `synapse-lineage-harvest.ts`, `openlineage.ts`, `dataset-item-resolver.ts`, `dataset-naming.ts`, `lineage-audit.ts`, `spark-conf-keys.ts` only.
- Nav registration: `lib/nav/governance-sections.ts:50-61` and `lib/nav/admin-sections.ts:94` (entries are `{href,label,desc,adminOnly?}`); a new page registers there.
- Route operations under `app/api/admin/security/purview/*` and `app/api/governance/scans/*`: not read in full; remains UNVERIFIED (W5/W8 read them before editing).
- Glossary/tag store: not re-investigated; remains UNVERIFIED.

## 3. Live Commercial measurements

All commands are read-only. `S_DMLZ=e093f4fd-5047-4ee4-968d-a56942c665f3`. Scripts call `az` through `scripts/measure/measure.mjs` (no shell, so no MSYS path mangling, failed command throws).

| Fact | Value | State | Produced by |
|---|---|---|---|
| Purview accounts in the 4 Limitless subscriptions | 1: `purview-csa-loom-eastus2`, DMLZ, `rg-csa-loom-admin-centralus`, location eastus2; DLZ, ALZ, Main: 0 | MEASURED | `az resource list --subscription <id> --resource-type Microsoft.Purview/accounts` x4; also `node scripts/measure/governance-arm-inventory.mjs --subscriptions <4 ids> --out temp/inv.json` |
| SKU / capacity | Standard, capacity 1 | MEASURED | `az resource show --subscription $S_DMLZ --ids <account id>` (via `governance-run.mjs`) |
| Managed identity | SystemAssigned, principalId present | MEASURED | same |
| Public network access | Disabled | MEASURED | same |
| Private endpoints | 2 connections (account, portal), both Approved | MEASURED | same |
| ARM endpoints | catalog and scan on `d1fc0498-...-api.purview-service.microsoft.com`; guardian on `purview-csa-loom-eastus2.purview.azure.com` (new-platform account) | MEASURED | same |
| Tags | `CSA_Loom=true`, `loom-estate-id=loom:e093f4fd:rg-csa-loom-admin-centralus` | MEASURED | same |
| Data plane read (collections, sources, scans, runs) | `GET https://purview-csa-loom-eastus2.purview.azure.com/scan/datasources?api-version=2022-07-01-preview` with a House Garofalo token for audience `https://purview.azure.net` answered **HTTP 404 `{"error":{"code":"TenantNotFound","message":"Tenant not registered"}}`**. Minting a token with `--tenant d1fc0498-...` fails `AADSTS50020` (guest account does not exist in the Limitless tenant for the Azure CLI app) | **BLOCKED** | `node scripts/measure/governance-purview-dataplane.mjs --account purview-csa-loom-eastus2 --out temp/dp.json` (exit 2) |
| Resources scanned by inventory | 105 resources across the 4 subscriptions, 0 blocked reads, positive control = 51 storage accounts read | MEASURED | `governance-arm-inventory.mjs` |
| Storage accounts | 51 total, 18 Loom-owned; 193 containers read from Loom-owned ones | MEASURED | same (`az storage container-rm list`) |
| ADX | 1 cluster `adx-csa-loom-z52x3p`, 54 databases (read through the parent via ARM REST; `az resource list` on the child type returns 0 and would have been a false zero) | MEASURED | same |
| Synapse / pools | 3 workspaces (1 Loom: `syn-loom-default-centralus`), 1 pool `loompool` | MEASURED | same |
| Event Hubs | 5 namespaces (1 Loom: `evhns-loom-default-centralus`) | MEASURED | same |
| Azure SQL | 9 servers (3 Loom-owned, one of which is the Synapse-managed server) | MEASURED | same |
| Databricks | 4 workspaces (1 Loom: `adb-loom-default-centralus`) | MEASURED | same |
| AAS | 2, both Loom: `aasloomk6mvh5sm6z7do` (DMLZ), `loomdefault` (DLZ) | MEASURED | same |
| Actual Purview account cost 2026-09-16..2026-10-15 | $42.73 total, a single meter: `Microsoft Purview Data Security` / `In Transit Protection Request`. No Data Map capacity-unit meter, no scan vCore meter | MEASURED (first call 429, one retry after 45 s succeeded) | `az rest --method post --url /subscriptions/$S_DMLZ/providers/Microsoft.CostManagement/query?api-version=2023-11-01 --body @temp/cost.json` (ActualCost, filter ResourceId, group by MeterSubCategory and Meter) |
| Scan run history / typical scan duration | none readable | **BLOCKED** (same cause as the data plane) | |

Interpretation, stated carefully: no scan meter in 30 days of billing is evidence that no scan ran in that window; it does not prove the registered-source list is empty. The absence of a capacity-unit meter on a Standard capacity-1 account is unexplained (new-platform accounts may bill the Data Map under a different meter); do not use the published $0.411/CU-hour to predict this account's bill.

### Expected versus registered

Expected registrations (Loom-owned, scannable kind), from `expectedSources()` in `governance-lib.mjs` over the inventory: **6**.

| Kind | Resource | Scan scopes |
|---|---|---|
| AdlsGen2 | `saloomdefaulttr4nm4dcgsq` (containers bronze, silver, gold, landing, ...) | per workspace path |
| AzureSynapseWorkspace | `syn-loom-default-centralus` (pool `loompool`) | database |
| AzureDataExplorer | `adx-csa-loom-z52x3p` | 54 databases |
| AzureSqlDatabase | `sql-loom-plan-k6mvh5sm6z7do` (db `loom-plan`) | database |
| AzureSqlDatabase | `sql-loom-e2e-cus` (db `RetailDemo`) | database |
| DatabricksUnityCatalog | `adb-loom-default-centralus` | catalogs |

Not scannable by Data Map (Atlas entity only, PRP 5.4): Event Hubs `evhns-loom-default-centralus`, AAS `aasloomk6mvh5sm6z7do` and `loomdefault`. Excluded with reasons: 67 not Loom-owned (other estates in the same subscriptions), 4 Cosmos (Loom platform state), 2 Databricks/Purview-managed storage, 1 Synapse-managed SQL server, 5 Loom storage accounts with containers but none medallion, and **10 Loom-owned storage accounts for which ARM returned zero containers** (empty and unreadable look identical through `container-rm list`). Of those 10, `sadsloomdefaultraggblczl` (rg `rg-csa-loom-dlz-default-centralus`) deserves a data-plane look: if it holds lakehouse data the count is 7, not 6.

Diff against what is registered: **INCONCLUSIVE** (registered list not readable). `diffRegistered()` returns INCONCLUSIVE rather than "all 6 missing" when its input is null.

## 4. Gov (GCC-High): not run

Nothing was executed against a Gov boundary. The workflow `.github/workflows/governance-w0-measure.yml` runs the same read-only measurement; dispatch commands in section 7. Expected outputs it will establish: which of three audiences the Gov Purview data plane accepts, the registered sources and scans, and whether the runner can reach the account at all. If Gov Purview is private-endpoint-only and the runner is public, the job ends BLOCKED with the transport error (honest red), and the in-VNet route (the console minted-session route or the reconcile job) is the only reader.

## 5. Scan cost

Formula (`scanCostMonthly` in `governance-lib.mjs`):

`monthly = capacityUnits * cuRate * 730 + sum over sources (fullScans * fullHours + incrementalScans * incrementalHours) * vcoresPerScan * vcoreRate`

| Input | Value | Provenance |
|---|---|---|
| vCore-hour rate | $0.63 (Commercial eastus2); $0.7875 (usgovvirginia) | published, Azure Retail Prices API (`prices.azure.com`, `serviceName eq 'Azure Purview'`), read 2026-10-16. Not on Learn, not in the pricing page HTML (`$-`) |
| Capacity unit rate | $0.411/h (eastus2); $0.51375/h (usgovvirginia) | published, same |
| Capacity units | 1 | measured (ARM `sku.capacity`) |
| Sources to scan | 6 | measured (section 3) |
| Actual last-30-day bill | $42.73, no scan meter | measured |
| vCores per scan | 8, 16, 32 | ASSUMED: no Microsoft source |
| Scan duration | small 0.25 h full / 0.1 h incremental; medium 1 / 0.25; large 4 / 1 | ASSUMED: no run history readable |
| Cadence | 1 full per source per month (worst case), weekly incremental = 4.33/month | PRP D3 default |

Scan cost per estate (6 sources), USD per day (per month in brackets), from `node scripts/measure/governance-cost.mjs --inventory temp/inv.json --region eastus2`:

| vCores per scan | small | medium | large |
|---|---|---|---|
| 8 | 0.69 (20.65) | 2.10 (62.97) | 8.40 (251.90) |
| 16 | 1.38 (41.31) | 4.20 (125.95) | 16.79 (503.80) |
| 32 | 2.75 (82.62) | 8.40 (251.90) | 33.59 (1007.60) |

Reading: for a 6-source estate the plausible band is $1 to $17 per day; the extreme corner is $34 per day. The Data Map capacity-unit charge (about $300/month if billed as published) is separate and this account's bill shows none. With D1 (on by default with caps) the cap that matters is the daily FULL-scan count: a full re-scan of every source is the expensive event (rulesets changed, scope changed). Replace the assumed rows with measured ones after the first scan run (W4 receipt: `startTime`/`endTime` per run, vCores from the Purview monitoring blade).

## 6. UNVERIFIED items from PRP sections 3, 5, 8, 10 and 11

| Item | Resolution | State |
|---|---|---|
| Live Purview state and quotas | account facts section 3; registered/scans/runs and quotas | account MEASURED; data plane **BLOCKED**, owner: operator on a Limitless identity or the Commercial workflow run |
| Per-cloud audience | code and Learn agree on `https://purview.azure.net` (2e); Gov acceptance | Commercial token minting OK but untestable against the Limitless tenant (BLOCKED); Gov **BLOCKED**, owner: Gov Actions run |
| IL5 / DoD Purview availability | DoD not deployable (2f); IL5 `catalogPrimary='atlas-aks'` stays; no Learn page found for either | UNVERIFIED, owner: operator decision D7 plus Gov run |
| Per-type backing keys | 2a table | RESOLVED, with listed gaps |
| Synapse grant mechanism | 2b | RESOLVED |
| Scan cost rate | published rates found, vCores/duration still assumed | RESOLVED (rate), ASSUMED (rest) |
| Run verb | Learn POST `:run` 2023-09-01 versus code PUT `/runs/{guid}` 2022-07-01-preview | **BLOCKED** on a write; owner W4 |
| Gates probe reachability | no, env-only (2d) | RESOLVED |
| Azure Policy exclusion | none for Purview; 1 unrelated storage policy (2i) | RESOLVED for DMLZ/DLZ |
| Console UAMI Data Map grant scope | root collection, four roles (2i) | RESOLVED |
| DoD param file | none; bicep `@allowed` excludes DoD (2f) | RESOLVED |
| Notebook/semantic-model/report lineage emission | none (2i) | RESOLVED |
| Nav registration path | `lib/nav/governance-sections.ts`, `admin-sections.ts` (2i) | RESOLVED |
| Tool inventory | no governance tool (2g) | RESOLVED |
| Event Hubs scan | Event Hubs is not a Data Map scan source (Learn, PRP section 4); not re-fetched | carried forward |
| Gov labeling and managed attributes unsupported | PRP-cited classic feature-availability page dated 2025-10; not re-fetched in W0 | carried forward, re-confirm in W10 |
| Private-endpoint-only storage needs a SHIR or managed-VNet IR (R3) | not testable read-only | UNVERIFIED, owner W4 |
| Scan throttling and concurrency limits (R8) | not published in pages fetched; not measurable without scans | UNVERIFIED |
| `item_list` latency before the fix (PRP 6.4 W0 item g) | needs a minted session on the live console | **BLOCKED**, owner: operator with a minted-session cookie (W1 measures before and after) |
| Per-type item creation to confirm keys live (PRP 6.4 W0 item e) | creating items is a write | not done by design; keys come from code, fixtures and provisioners (2a) |

## 7. Still needs the operator or a Gov Actions run

1. Commercial data-plane read (registered sources, scans, runs, collections, quotas). Either run the new workflow, or run `node scripts/measure/governance-purview-dataplane.mjs --account purview-csa-loom-eastus2` from an identity in the Limitless tenant with Data Reader on the root collection. Caveat: the account is public-network Disabled, so a GitHub-hosted runner will most likely get 403 or a transport error and the artifact will say BLOCKED with that status; the reliable reader is inside the VNet (the console minted-session route `GET /api/governance/purview/status` already proves reachability, and `listDataSources`/`listScansForSource` through a minted session give the registered state).
2. GCC-High: dispatch (do not run locally):
   `gh workflow run governance-w0-measure.yml -f boundary=GCC-High` (approval on environment `gcc-high-deploy` is required; optional `-f subscriptions=<guid>,<guid>`), then `gh run download <run-id> -n governance-w0-gcch`.
   Commercial: `gh workflow run governance-w0-measure.yml -f boundary=Commercial`, then `gh run download <run-id> -n governance-w0-commercial`.
3. Run verb (`:run` versus PUT `/runs/{guid}`): one controlled write on a throwaway scan (W4).
4. `item_list` latency baseline from a minted session (W1).
5. Operator decisions D3, D5, D6, D7, D8, D9, D11 still on defaults.

## 8. Recommendations that change the PRP

Applied to `PRP.md` in this PR, each marked `[W0 correction]` or `[W0 resolved]` in place:

1. Run status `Completed` does not exist in Learn; replaced with `Succeeded` everywhere (10 sites), with the full enum and the asset-count field path recorded in section 4.
2. Data source and scan names cannot contain underscores (5.1).
3. Run verb note: POST `:run` 2023-09-01 versus the repo's PUT `/runs/{guid}` 2022-07-01-preview; the repo's is proven live, so do not "fix" it to POST without a probe.
4. Gates are env-only, not probes (3.6).
5. DoD: bicep cannot target it at all, not merely "no param file" (3.6).
6. Synapse grant mechanism resolved (5.6).
7. Backing-key resolution: there is no single key and `loomItemToScanSource` skips five item families silently (3.3).
8. Scan cost rate found and the account's actual bill recorded (10).
9. Tool inventory resolved; orchestrator never emits SIEM audit, new tools must (3.5).

Recommended but NOT applied (need your call or later evidence):

- Section 5.3/5.4: the 6-source estate says register-per-account, but 54 ADX databases make ADX the largest scan-scope fan-out; W2 should model scan scopes per database for ADX.
- Section 5.5: replace the single "scanned" definition with the Learn run enum plus the nested `discoveryExecutionDetails.status` (a run can be `Succeeded` overall with discovery `CompletedWithExceptions`); treat that as a warning state, not green.
- Section 5.6: Storage Blob Data Reader for the Purview MSI should be granted on `saloomdefaulttr4nm4dcgsq` (the only lakehouse account found), not by RG scope; 10 other Loom storage accounts returned no containers and need an owner decision on whether they are in scope.
- Section 4/5.12: the Gov labeling/feature-availability page is 2025-10 classic; re-confirm in W10.
- Add to W8: the `purview` gate should call `probePurview` (or a cached result) so it cannot read green while the account answers 404 or 403.
- Add to W1: `item_list` measurement needs a minted session; W0 could not take it.

## 9. Artifacts in this PR

- `scripts/measure/governance-lib.mjs`, `governance-arm-inventory.mjs`, `governance-purview-dataplane.mjs`, `governance-cost.mjs`, `governance-run.mjs`, `governance-w0.test.mjs` (18 tests, `node --test scripts/measure/governance-w0.test.mjs`).
- `.github/workflows/governance-w0-measure.yml` (workflow_dispatch only, `contents: read`, not dispatched).
- Mutation evidence (sandbox copy under `temp/`, tracked tree untouched): 5 mutations, all RED (killed): remove the `diffRegistered` INCONCLUSIVE guard; remove the `readList` `value[]` check; remove the inventory positive control; widen `isLoomOwned` to every `rg-` group; accept a non-2xx audience probe.
- Gates run: the six `scripts/ci/check-*` checks pass on the new workflow; `extract-security-graph.mjs` drifted by +4 nodes from the new scripts and was regenerated in this commit (additions only); Snyk Code scan of `scripts/measure` authenticated and returned 4 pre-existing Medium findings in `drain-status.mjs` and `red-tally.mjs` (CWE-78 through `measure.mjs`), none in the governance files.

## 10. Live receipt: Commercial measure run (added 2026-10-20)

Run `governance-w0-measure.yml` (boundary Commercial), GitHub Actions run **39522529002**, dispatched 2026-10-20 from main. The job exited 2 by design (the Purview data-plane datum is BLOCKED); the JSON artifact `governance-w0-commercial.json` was uploaded and read.

| Datum | State | Value |
|---|---|---|
| ARM inventory across the 4 Limitless subscriptions | MEASURED | positive control read 51 storage accounts; 0 blocked reads |
| Loom-owned resources | MEASURED | storage 18 of 51, Kusto 1, Event Hubs 1 of 5, Azure SQL servers 3 of 9, SQL databases 5 of 17, AAS 2, Synapse workspaces 1 of 3, SQL pool 1, Databricks 1 of 4, Purview accounts 1 |
| Expected Purview sources | MEASURED | 6: ADX `adx-csa-loom-z52x3p`, 2 Azure SQL databases (`sql-loom-plan-k6mvh5sm6z7do`, `sql-loom-e2e-cus`), ADLS Gen2 `saloomdefaulttr4nm4dcgsq`, Synapse `syn-loom-default-centralus`, Databricks `adb-loom-default-centralus` |
| Not scannable as a Data Map source | MEASURED | AAS `aasloomk6mvh5sm6z7do`, Event Hubs `evhns-loom-default-centralus`, SQL server `loomdefault` (Event Hubs = entity plus lineage only, per D9) |
| Purview data plane from a GitHub-hosted runner | **BLOCKED, now explained** | A token for audience `https://purview.azure.net` was minted, and the data plane answered HTTP **403** `AccountProtectedByPrivateEndpoint` ("Not authorized to access account") on `purview-csa-loom-eastus2.purview.azure.com`. |
| Registered sources, scans, last runs | BLOCKED | not readable from a public runner |
| Registered-vs-expected diff | INCONCLUSIVE | the registered list was not read |

### What this changes in the design (PRP sections 4, 5, 6 and decision D11)

1. **The Purview Data Map is reachable only from inside the network.** `publicNetworkAccess` is Disabled with 2 private endpoints, and a public runner gets 403. So Data Map calls (register source, create scan, run scan, read status) must come from a host in the VNet: the Console (its UAMI), or the in-VNet reconcile job (D11). They must NOT come from a GitHub-hosted Actions runner. W4 and W5 acceptance receipts for the Data Map must therefore be taken through the console or the in-VNet job, not through a hosted-runner workflow. Gov (GCC-High) is expected to behave the same way; confirm with the same workflow there.
2. **Copilot tools run inside the console**, which already sits on the private network. No new network path is needed for the Copilot side.
3. **The workflow is still useful** for the ARM-side facts (inventory, expected sources, cost inputs), which are all MEASURED above.
4. **Scans of private-endpoint sources** (the lakehouse account, Synapse, SQL, ADX, Databricks) still need a managed-VNet or self-hosted integration runtime. That remains W3/W4's job and is not measured here.
5. **Still BLOCKED** and owned by W4/W5 via the in-VNet host: the registered-source list, existing scans, and Purview quotas.
