# PRP: Governance Autopilot — zero-touch Purview enrollment, scanning, classification and labeling, plus Copilot governance tools

| Field | Value |
|---|---|
| Status | DRAFT — design complete, execution-ready; W0 (measurement spike) may start immediately, everything else waits for the Decisions in section 11 or takes their recommended defaults |
| Created | 2026-10-16 |
| Decision source | Operator request 2026-10-16: Copilot must be able to act on the registered data-governance tools; scans must be set up for users; objects must be enrolled in Purview and the governance tools and be automatically classified, tagged and labeled; "it should just be part of the way Loom is integrated" |
| Tracking issue | To be filed by the executing session (title: "Governance Autopilot (PRP): zero-touch Purview enrollment + Copilot governance tools"); work-item issues are filed from section 5 |
| Related rules | `.claude/rules/auto-bind-by-default.md`, `no-vaporware.md`, `no-fabric-dependency.md`, `cloud-parity.md`, `deploy-integrity.md`, `ux-baseline.md`, `web3-ui.md`, `ui-parity.md`, `assertion-design.md`, `session-end.md`, `task-tracking.md` |
| Related programs | `finish-2026-10/PRP-02-estate-power.md` (pause contract, section 5.5), `per-workspace-spark-identity` and `apim-ai-gateway` (bicep collision, section 6.3), Workspace identity program I1-I9 |
| Boundaries | Commercial, GCC-High, IL5, DoD. GCC is supported-in-code only and has never been exercised (`cloud-parity.md`, "Supported-in-code is not ever-exercised"); this PRP does not change that and does not claim a GCC receipt |
| Implemented by this PR | Nothing. This PR adds the PRP and the index entry only |

## Contents

0. Summary · 1. Goals and non-goals · 2. What the operator hit (measured) · 3. Measured current state · 4. Microsoft Learn facts used · 5. Design · 6. Work items · 7. Verification · 8. Risks and unknowns · 9. Rollback · 10. Scan cost · 11. Decisions needed · 12. Done · 13. References

Evidence convention: every claim about the repo carries a `file:line` measured on `origin/main` at `b22896b69` on 2026-10-16 (paths under `apps/fiab-console/` unless stated). Anything not read in full is marked **UNVERIFIED**. Line numbers drift; re-verify before editing.

## 0. Summary

On 2026-10-16 the operator asked Copilot to take every asset in every workspace, make sure each is a registered Purview data source or artifact, and make sure scans exist. Copilot ran `loom_self_audit`, `workspace_list`, `item_list`, `loom_list_gates` and a docs search, then stopped: "no Purview Data Map registration/scan tool ... is available". The operator's reaction was that the platform should do this, not report that it cannot.

The measured picture is more specific than "Loom has no Purview integration". Loom already ships a large Purview client (scan, source, ruleset, classification, glossary and lineage writes in `lib/azure/purview-client.ts`) and a best-effort per-item auto-onboarder (`lib/azure/purview-autoonboard.ts`). What is missing is the layer that makes it a product:

1. **Copilot has zero Purview tools.** The tool registry contains no Purview, catalog or governance tool (section 3.5). Copilot cannot call what the BFF can.
2. **Auto-scan is off by default and only fires at item creation.** `LOOM_PURVIEW_AUTOSCAN` defaults off (`lib/azure/purview-autoonboard.ts:207-211`), is not set by bicep, and nothing re-runs enrollment afterwards. Items that predate the feature, items whose creation-time enrollment failed, and sources deleted out-of-band are never repaired.
3. **Scan permissions are not deployed.** Bicep grants the Purview managed identity no reader role on any backing source (grep of `platform/fiab/bicep` found none; only a Key Vault Secrets User on the opt-in Databricks scan vault, `modules/admin-plane/catalog.bicep:309-318`). A scan created by Loom would be created and then fail with 403 unless an operator hand-grants roles. That violates `auto-bind-by-default.md` item 5.
4. **Copilot cannot see the estate.** `workspace_list` returns only workspaces whose partition key equals the caller oid (`lib/azure/copilot-orchestrator.ts:967-973`, `app/api/items/_lib/item-crud.ts:853-861`), while `item_list` is access-aware (`item-crud.ts:812-850`), so item rows reference workspaces `workspace_list` never returned. The tool result is then cut at 16,000 characters mid-JSON with no flag (`copilot-orchestrator.ts:2681-2683`).
5. **No reconcile, no status, no coverage view.** There is no record of what Loom believes is registered or scanned, no drift detection, no admin surface, and no honest "scanned" definition (a Completed run plus a read-back asset count).

**This PRP builds the Governance Enrollment Service**: a single owner of source registration, scan creation, scan scheduling and execution, classification, tagging, label application and lineage emission for Loom-owned assets. It is event-driven (item create/update/delete, workspace and domain create), swept on a schedule by a service identity across all workspaces, self-healing, and exposed to Copilot as nine tools. It deploys the scan permissions as infrastructure, mirrors the Loom workspace and domain hierarchy into Purview collections, adopts rather than duplicates an existing Purview estate (brownfield), and degrades per cloud with Azure-native equivalents where Purview lacks a capability (notably sensitivity labeling in Azure Government).

**The acceptance test is the operator's own prompt** (section 7.1): "take all assets under every workspace and make sure they are registered data sources or registered artifacts in the Purview associated with Loom, and make sure the scans are set up and configured for them" must succeed end to end, with receipts.

## 1. Goals and non-goals

### Goals
- G1. Creating a Loom item with a scannable backing store results, with no user action, in a registered Purview source, a scan scoped to that item's path/database, a first full run, and a schedule. Names match the Loom item (`auto-bind-by-default.md` item 2).
- G2. A scheduled sweep by a service identity enrolls and repairs every workspace in the tenant, including items created before this feature (backfill) and items whose Purview objects were deleted or renamed (self-heal, item 3).
- G3. Classification, tags (workspace, domain, item type, medallion layer, owner) and sensitivity labels are applied automatically and propagated back to Loom item metadata so editors show them.
- G4. Copilot has real governance tools with correct authorization, confirmation and audit, and the operator prompt above succeeds.
- G5. Copilot sees the authoritative estate: paginated, never silently truncated, with a total count and a `truncated` flag it must honour.
- G6. The permissions scans need are deployed by bicep and bootstrap, not requested.
- G7. Brownfield: discover an existing Purview estate, offer reuse versus deploy-new, adopt existing sources and scans by backing resource id, never duplicate.
- G8. Per-cloud parity with explicit per-cloud status (section 5.12), and honest status everywhere: "scanned" means a Completed run and a read-back asset count.

### Non-goals
- Replacing Purview. Loom drives Purview (Data Map, scan plane, Atlas, Unified Catalog) and adds Loom-native equivalents only where a cloud lacks the Purview feature.
- Governance policy authoring beyond the label/classification mapping policy in section 5.7 (DLP policy authoring and data access policies are existing separate surfaces).
- Scanning the contents of arbitrary customer sources that are not Loom-owned backing stores (those stay on the existing register-existing flow, `app/api/governance/scans/register-existing/route.ts`).
- Fixing the unrelated lakehouse storage isolation issue. A private advisory about workspace isolation of lakehouse storage exists; this PRP references only its existence and requires (section 5.13) that enrollment never widens cross-workspace visibility.
- Real Microsoft Fabric / Power BI scanning. Fabric and Power BI sources are opt-in only (`no-fabric-dependency.md`); nothing here requires them.

## 2. What the operator hit (measured from the operator transcript)

Copilot (model gpt-5.6-terra) used these tools in order: `loom_self_audit` (99/100: 324 pass, 5 warn, 1 fail; the fail was Databricks account-admin 403; warns included AAS paused, paginated render URL unset, DR posture read 404, Graph identity-picker not wired), `workspace_list` (one owned workspace), `item_list` (about 8.7 s, response truncated), `loom_list_gates` (134 of 134 configured including `purview`, `svc-purview-uc`, `svc-mip`, `svc-dlp`, `svc-openlineage`), then Microsoft Learn docs search and fetch. It answered that it could not safely complete registration or scan creation because no Purview Data Map registration/scan tool exists, noted the one-workspace versus many-workspace-ids discrepancy and that the truncated inventory was not authoritative, and gave a sound coverage model: scan the scan-capable backing sources, treat authoring artifacts via lineage.

That coverage model is largely right and is adopted in section 5.4, corrected against Learn (for example Event Hubs is not a Data Map scan source, section 4).

The three gaps this PRP closes: (1) no Purview tools in Copilot, (2) no authoritative cross-workspace inventory, (3) nothing re-enrolls, re-scans, classifies or labels automatically so end users do governance plumbing by hand.

## 3. Measured current state

### 3.1 Purview client and routes (reuse, do not rewrite)

| Capability | Where | Notes |
|---|---|---|
| Client | `lib/azure/purview-client.ts` (2922 lines) | Scope constant `PURVIEW_SCOPE` at `:100` is `https://purview.azure.net/.default`, not cloud-aware |
| Endpoint resolution | `lib/azure/purview-endpoints.ts` | Order: `LOOM_PURVIEW_ENDPOINT`, then ARM `properties.endpoints.catalog` (15 min cache), then convention host; `purview.azure.us` in Gov (`:60-68`); file comment `:30-39` records that Learn documents no Gov-specific audience |
| Register source | `registerDataSource` `purview-client.ts:1617`; `registerDatabricksUnityCatalogSource` `:1721`; `deleteDataSource` `:1681` | PUT `/scan/datasources/{name}` |
| Scan create/run/read | `upsertScan` `:2407`; `defineDatabricksUnityCatalogScan` `:1803`; `triggerScanRun` `:1855`; `listScansForSource` `:1694`; `listScanRuns` `:2183`; `listDataSources` `:1589` | |
| Rulesets, rules, IR | `upsertScanRuleset` `:2347`; `upsertCustomClassificationRule` `:2265`; `upsertPurviewIntegrationRuntime` `:1953`; managed VNet and managed private endpoint `:2125`, `:2160` | |
| Classification, glossary, metadata | `addAssetClassification` `:1166`; `removeAssetClassification` `:1198`; `createAtlasGlossaryTerm` `:1293`; `applyGlossaryTerm` `:1322`; `setBusinessMetadata` `:1557`; `ensureClassificationDefs` `:1129` | Classification typedefs are tenant-namespaced (`purview-autoonboard.ts:324-341`) |
| Atlas entity and lineage | `registerAtlasEntity` `:877`; `createAtlasLineage` `:954`; `createAtlasColumnLineage` `:1005` | |
| Collections, domains | `/collections/{name}` `:2613-2669`; `createBusinessDomain` `:2609` | Collection creation lives in `domain-sync.ts` / `domain-registry.ts`, not in bootstrap |
| Unified Catalog | `lib/azure/purview-unified-client.ts` (`/datagovernance/catalog/dataProducts`, `:250`), host `api.purview-service.microsoft.com`, api-version `2026-03-20-preview`, Commercial only (`main.bicep:5945-5947`) | |
| Source mapping | `purview-source-map.ts`, `purview-source-mapping.ts`, `purview-bulk-register.ts` | Map ARM types and connectables to Purview kinds and resourceId |
| Routes | `app/api/admin/security/purview/{sources,scans,collections,glossary,discover,domains,dataquality}/route.ts`; `app/api/governance/scans/route.ts`, `.../scans/register-existing/route.ts`, `.../govern/trigger-scan/route.ts` | Route bodies not read in full: operations per route **UNVERIFIED** |

### 3.2 The per-item auto-onboarder and its limits

`createOwnedItem` (`app/api/items/_lib/item-crud.ts:865-954`) runs, after `items.items.create`: `autoBindOnCreate` (`:934`, `lib/azure/auto-bind.ts:779`, 8 s deadline, never throws, stamps `state.autoBind`), the AI Search mirror, `mirrorDataProduct`, `mirrorGovernanceDoc` (`:940`), `autoOnboardToPurview` (`:943`, `lib/azure/purview-autoonboard.ts:321`), then `emitLoomEvent('item.created')` (`:945`, `lib/events/webhook-emitter.ts:252`).

`autoOnboardToPurview` is a silent no-op without `LOOM_PURVIEW_ACCOUNT` (`:322`), registers an Atlas entity with tenant-namespaced classifications, writes the GUID back to item state, and then registers a data source and scan when a scannable backing resource can be resolved from the item (`:195-205`, scan name `${src.name}-scan` at `:265`, stamped as `state.purviewScanName` `:297`). The scan run is gated by `LOOM_PURVIEW_AUTOSCAN`, **default off for scan-cost control** (`:207-211`); the variable is not set in bicep. Limits:

- Fires on create only. No update, delete or sweep path. There is no outbox or change feed; the webhook emitter is the only event bus (provisioning research, `item-crud.ts`).
- `return null; // no scannable backing — skip silently` (`:203`): an item with no resolvable backing is skipped with no record and no status.
- Best-effort and never throws, so a failure leaves no durable error classification.
- Per-item registration, not per backing source. Learn states a source cannot be registered twice in one account (section 4), so many items on one storage account need source dedupe.
- No desired-state record, no drift detection, no reconcile.
- Delete hooks exist (`deleteOwnedItem` `item-crud.ts:1014`, `softDeleteOwnedItem` `:1135`, `restoreOwnedItem` `:1205`, `purgeRecycledItem` `:1261`) and `offboardFromPurview` exists (`purview-autoonboard.ts:443`); the reconcile semantics for a shared source are undefined today.

### 3.3 Item provisioning and backing stores

Provisioner interface `lib/install/provisioners/types.ts:217-229`; registry `PROVISIONERS` at `lib/install/provisioning-engine.ts:61-94`; `runProvisioning` is install-time only (`app/api/apps/[id]/install/route.ts:351` and three siblings); the generic create seam is `createOwnedItem` above. The item catalog has 142 top-level entries (`lib/catalog/fabric-item-types.ts:65`) and **no `backingStore` field**; backing stores appear only in prose.

| Item type(s) | Backing service (measured from provisioner research) |
|---|---|
| lakehouse | ADLS Gen2 container (OneLake only when opted in) |
| warehouse | Synapse dedicated SQL pool |
| kql-database, kql-queryset, eventhouse, workspace-monitor | ADX database |
| kql-dashboard | Loom-native over ADX |
| eventstream | Event Hubs |
| mirrored-database | ADF CDC to ADLS Bronze Delta |
| mirrored-databricks | Databricks Unity Catalog plus Synapse serverless SQL endpoint |
| notebook | Spark notebook (Synapse) |
| databricks-notebook, databricks-job | Databricks |
| data-pipeline, synapse-pipeline, adf-pipeline | Synapse (default), ADF or Fabric pipelines |
| semantic-model | Loom-native tabular over the warehouse |
| report | PBIR report bound to the semantic model |
| activator | Azure Monitor alert |
| ai-search-index | AI Search |
| data-product | Purview Unified Catalog data product and glossary terms |
| ml-model | MLflow / Unity Catalog |
| prompt-flow, evaluation | AI Foundry (AML data plane) |
| logic-app, stream-analytics-job | Logic Apps; Stream Analytics |
| synapse-serverless-sql-pool | External data source over the lake |
| materialized-lake-view | Synapse Spark batch |

Per-type keys in `state` where the backing resource id lives are **UNVERIFIED** beyond `state.autoBind` (`auto-bind.ts:81,128`) and lakehouse root keys (`item-crud.ts:909-913`, `auto-bind.ts:837`); W0 produces the authoritative table (a typed `resolveBackingSource(item)` contract) and the item-catalog gets a `backingStore` field (W2).

### 3.4 Data model and the visibility defect

- Cosmos containers: `workspaces` PK `/tenantId` (`lib/azure/cosmos-client.ts:816`), `items` PK `/workspaceId` (`:821`), `governance-domains` PK `/tenantId` (`:1032`), `loom-workspaces` admin catalog (`:1081`), `workspace-roles` ACL, `label-assignments` (`:1044`), `posture-aggregates*` (`:961`, `:965`).
- `tenantId` on a workspace holds the **owner Entra oid**, not the Entra tenant; `tid` is the Entra tenant and is absent on old docs (`lib/types/workspace.ts:59-82`). Access resolves owner, `LOOM_MULTIUSER_ACL`, tid boundary, ACL, admin-open (`lib/auth/workspace-access.ts:1-100`).
- `workspace_list` calls `listOwnedWorkspaces(ctx.userOid)` = `SELECT * FROM c WHERE c.tenantId=@t` (`item-crud.ts:853-861`): only workspaces whose partition key is the caller's own oid. It ignores ACL shares, admin-open and app-installed workspaces. The access-aware `listAccessibleWorkspaces(oid, opts)` already exists (`workspace-access.ts:570`) and is not used by the tool.
- `item_list` (`copilot-orchestrator.ts:943-964`) uses `listAllOwnedItems` (`item-crud.ts:812-850`, no limit, `fetchAll()` at `:836`, per-row `resolveWorkspaceAccessByOid`). The tool loop truncates the serialized result at 16,000 characters with `slice(0, 16_000) + '...[truncated]'` (`:2681-2683`, same constant in `help-copilot-orchestrator.ts:837`) — a mid-JSON cut with no structured flag. A bounded variant with `truncated: false|'limit'|'budget'` exists, `listOwnedItemsBounded` (`item-crud.ts:688-792`), unused by the tool.

Net: the "one workspace, many workspace ids, truncated" observation is three separate, now-located defects.

### 3.5 Copilot tool framework

- Registry `LoomToolRegistry` (`copilot-orchestrator.ts:409`); `ToolDef {name, description, service, parameters (obj() :464), handler(args, ctx), whenToUse?, readsContext?, serverName?}` (`:384-407`); `ToolContext = {userOid, session}` (`:378`). Other tool modules live in `lib/copilot/*-tools.ts` (for example `activator-tools.ts`, `kql-tools.ts`, `dax-tools.ts`).
- No Purview, catalog or governance tool is registered (grep for `purview` under `lib/copilot` matched only a memory test; `copilot-orchestrator.ts` mentions Purview only in context plumbing — tool inventory by name **UNVERIFIED**, W0 re-greps).
- Authorization: no scope field on `ToolDef`; each handler enforces its own check, for example `checkCapability(ctx.session,'admin.env-config','Admin')` in `loom_resolve_gate` (`:1088-1096`). Group-based admins do not resolve because tool context has no group claims.
- Write confirmation: no generic flag. Destructive tools use a `confirm:false` first-call pattern (`:687-706`); `item_create`, `item_configure`, `workspace_create` have none; proposed-change diffs use an approval sentinel with Keep/Undo (`:1435`, `:2675-2719`).
- Audit: every call and result persisted by `persistStep` (`:2651`, `:2707`), receipts in `loom-answer-receipts`; `loom_resolve_gate` writes `action:'gate.resolve'` through `applyEnvChanges` (`:1108-1115`); SIEM helper `emitAuditEvent` (`lib/admin/audit-stream.ts:212`, Log Analytics `LoomAudit_CL`).
- Honest-gate shape: handlers return `{ok:false,error,remediation}` (`:1047`, `:1093`); provisioners return `status:'remediation'` with a `gateId` (`types.ts:76-119`).
- `.claude/rules/tool-specifications.md` is path-scoped to `skills/`, `commands/`, `agents/` and does not apply to Loom Copilot tools.

### 3.6 Bicep, identities and roles

- Purview account: `Microsoft.Purview/accounts@2024-04-01-preview`, Standard SKU, system-assigned identity, `publicNetworkAccess: 'Disabled'` (`modules/admin-plane/catalog.bicep:138-164`); private endpoints `:185-246`; DNS zones `network.bicep:604-605` (tld `us` for GCC-High and IL5); `purviewEndpoint` output `.us` only for GCC-High and IL5, DoD not mentioned in that expression (`catalog.bicep:407-408`).
- Params: Commercial `purviewEnabled=true` with reuse via `loomPurviewAccount` (`commercial.bicepparam:140,146`); GCC `true` (`gcc.bicepparam:158`); GCC-High `false`, reuses tenant Purview, `catalogPrimary='purview'` (`gcc-high.bicepparam:155,128`); IL5 `false`, `catalogPrimary='atlas-aks'` (`il5.bicepparam:153,126`). A DoD param file was not found by grep (existence **UNVERIFIED**). Brownfield adopt inputs: `EXISTING_PURVIEW`, `EXISTING_PURVIEW_RG`, `EXISTING_PURVIEW_SUB`.
- ARM roles: `Purview Data Curator` to `adminEntraGroupId` only (`catalog.bicep:254-266`); Purview MSI gets Key Vault Secrets User on the Databricks scan vault only (`:309-318`); Console UAMI gets VM Contributor on the Purview SHIR VMSS (`purview-shir.bicep:184-190`). **No Purview-MSI reader role on storage, Synapse, ADX or Event Hubs.** `landing-zone/main.bicep:74` records "Purview-backed DLZ scan job wiring is deferred".
- Console UAMI Data Map roles are data-plane and granted post-deploy: `csa-loom-post-deploy-bootstrap.yml` (~`:714`) runs `scripts/csa-loom/grant-purview-datamap-role.sh` with `data-reader data-curator data-source-administrator collection-administrator`, briefly enabling public network access with a restoring trap. The scope of those grants (root collection versus per-collection) is **UNVERIFIED**. Bootstrap creates no collections, sources or scans.
- Env: `LOOM_PURVIEW_ACCOUNT` (`main.bicep:5918-5920`), `LOOM_PURVIEW_UC_ENDPOINT` and `_UC_API_VERSION` (`:5945-5947`, Commercial only), `LOOM_PURVIEW_UNIFIED_ACCOUNT` (`:5650`), SHIR names (`:4852,4860`). Not wired: `LOOM_PURVIEW_AUTOSCAN`, `LOOM_PURVIEW_ENDPOINT`, `LOOM_PURVIEW_GOVERNANCE_DOMAIN_ID`.
- Gates: `purview` (`lib/admin/env-checks/azure-services.ts:204`, registry `lib/gates/registry/azure-services.ts:167`) and `svc-purview-uc` (`env-checks/catalog-governance.ts:35`, registry `catalog-governance.ts:20`) check env presence only (reachability and roles live in `probePurview` `purview-client.ts:293`; **UNVERIFIED** whether the gates call it). The `svc-purview-uc` remediation text names the classic host while bicep uses `api.purview-service.microsoft.com` (`main.bicep:5921-5940`): a documented inconsistency to fix in W7.

### 3.7 Existing governance features

- MIP `svc-mip`: real Graph beta read client (`lib/azure/mip-graph-client.ts`), label CRUD via the PowerShell sidecar `azure-functions/scc-labels/` behind `LOOM_MIP_ADMIN_ENABLED` (`scc-labels-client.ts`); label state on `item.state.sensitivityLabel/sensitivityLabelId`, written by `app/api/items/[type]/[id]/sensitivity-label/route.ts` which also writes the Purview asset (best effort), audit log and `label-assignments`. Pages: `app/admin/sensitivity-labels`, `app/admin/batch-labeling`, `app/governance/sensitivity`. Propagation: `apps/fiab-label-propagation/`, `lib/governance/label-propagation.ts`.
- DLP `svc-dlp`: Graph client unavailable in GCC-High and IL5 by design (`gccHigh: 'unavailable'`, `il5: 'unavailable'`); Loom-native library `lib/governance/dlp-policy-library.ts` works everywhere.
- OpenLineage `svc-openlineage`: real ingest `POST app/api/lineage/openlineage/route.ts`; emitters for Synapse/ADF pipelines and Spark job definitions in `lib/lineage/synapse-emitters.ts` (`:152`, `:295`, `:415`); Atlas lineage from `lib/thread/thread-edges.ts:194-240`. No emission for notebooks, semantic models or reports was found (**UNVERIFIED**).
- Glossary: Purview Atlas only (`app/api/catalog/glossary/route.ts`), no Cosmos container. Classification taxonomy: `app/api/governance/classifications`, `lib/azure/purview-classification-sync.ts:157`. No dedicated tag store found (**UNVERIFIED**).
- Govern posture refresh Function `azure-functions/posture-refresh/function_app.py`, timer `0 */5 * * * *` (`:226`), `DefaultAzureCredential` with `LOOM_UAMI_CLIENT_ID` (`:71-77`); the pattern for a service-identity sweep.
- Pause state readable by code: `lib/estate/pause-orchestrator.ts:1406` `loadPauseSnapshot`, `lib/estate/pause-state.ts:186-267` `armPowerReading`/`isPausedState`, `lib/estate/pause-actuator.ts:104-135` `normalizePowerState` (Synapse sqlPools, Kusto, AAS). `lib/scheduler/run-adapters.ts:49,204` has `gateFor`/`triggerRun` per-JobKind adapters and honest skips.
- Cloud resolution: `lib/azure/cloud-boundary.ts:57` (`LOOM_CLOUD`, IL5 folds into GCC-High), `lib/azure/cloud-endpoints.ts`, Graph hosts in `cloud-endpoints-graph.ts` (GCC-High `graph.microsoft.us`, DoD `dod-graph.microsoft.us`).

## 4. Microsoft Learn facts used

Fetched 2026-10-16 (the Microsoft Learn MCP tools were not available in this session; facts come from learn.microsoft.com pages via web fetch/search and must be re-confirmed by W0 against the live pages).

| Fact | Source |
|---|---|
| A data source cannot be registered more than once in one Purview account; register a shared source once at a parent collection and create scans under each child collection so assets appear in each | https://learn.microsoft.com/en-us/purview/data-map-scanning-best-practices |
| Scan setup = name, scope, integration runtime, trigger, scan rule set, resource set. The initial scan is full; every later scan is incremental. Modifying a custom classification or scan rule set triggers a full scan, so choose rulesets before the first scan. Max scan duration 7 days. Scope scans to the relevant folders/schemas; all future assets under a checked parent are selected. Prefer MSI auth, then UAMI, then service principal. Azure Policies that block storage updates break scans (exclusion needed). Use meaningful scan names | same |
| ADLS Gen2: register needs Data Source Administrator + Data Reader on Purview and Reader on the account; scan with the Purview managed identity needs **Storage Blob Data Reader** (subscription, RG or resource scope); with a storage firewall only managed identity works and "Allow trusted Microsoft services" must be on; with private endpoints a self-hosted IR (service principal or key) is required; parquet on a SHIR needs a JRE | https://learn.microsoft.com/en-us/purview/register-scan-adls-gen2 |
| Scan REST (api-version 2023-09-01): `PUT {endpoint}/scan/datasources/{ds}/scans/{scan}` create/replace; `POST .../scans/{scan}:run?runId=<guid>&scanLevel=Full` returns 202 with `Operation-Location`; `GET .../runs/{runId}` status; `GET .../runs` history; `GET {endpoint}/scan/datasources` list; system rulesets at `/scan/systemScanRulesets/datasources/{type}`. Endpoint example `https://{account}.purview.azure.com` (the repo also writes runs with PUT `.../runs/{uuid}`, `purview-client.ts:1855`; W0 confirms which verb the account accepts) | https://learn.microsoft.com/en-us/rest/api/purview/scanningdataplane/scan-result/run-scan?view=rest-purview-scanningdataplane-2023-09-01 |
| Supported capability matrix: classification supported for ADLS Gen2, Blob, ADX, Azure SQL Database, Dedicated SQL pool, Synapse workspace, Databricks Hive Metastore and Unity Catalog (custom classification not for Unity Catalog), Cosmos DB; **Event Hubs is not listed as a scan source**; ADF/Synapse pipelines are lineage-only; sensitivity labels on Data Map assets supported for ADLS Gen2, Blob, ADX, Azure SQL DB, Synapse workspace, Cosmos DB (not Dedicated SQL pool, not Databricks); **Delta is not supported natively** — Parquet files of a Delta table are parsed as resource sets and partition columns are not in the schema | https://learn.microsoft.com/en-us/purview/data-map-data-sources |
| Sampling: structured files top 128 rows or 1 MB per column; documents first 20 MB; SQL top 128 rows. Scanner regions include USGov Virginia. Asset names containing `/`, `\` or `#` cannot be scanned | same |
| Scan rule sets: system and custom, per source type, name max 63 chars, no spaces; up to 10 ignore patterns (regex, prepopulated Spark transaction pattern); deselecting a file type does not prevent ingestion, only schema/classification | https://learn.microsoft.com/en-us/purview/data-map-scan-rule-set |
| Data Map sensitivity labeling is auto-labeling only, applied to asset metadata (not the files/columns), uses built-in classifiers only (no custom SITs/trainable classifiers/EDM), no simulation mode, preview, requires an M365 license in the tenant and, for non-M365 sources, M365 E5 plus pay-as-you-go | https://learn.microsoft.com/en-us/purview/data-map-sensitivity-labels |
| Azure Government (US Gov Virginia): Data Map partial; register and scan Azure sources supported; **Labeling (preview) unsupported; managed attributes unsupported; sources in preview unsupported; Synapse pipeline lineage unsupported; Power BI unsupported**; glossary, classifications, lineage supported. Page dated 2025-10 and labeled classic: re-confirm in W0. Nothing found for IL5/DoD specifically (**UNVERIFIED**: treat as Gov) | https://learn.microsoft.com/en-us/purview/legacy/classic-feature-availability |

Consequences that shape the design: (a) one source registration per backing account, scans fan out per scope; (b) rulesets are fixed before the first scan (avoid costly re-scans); (c) Event Hubs and pipelines are enrolled as Atlas entities plus lineage, not scans; (d) Delta lakehouses need an honest note that Purview sees Parquet resource sets, so Loom adds the Delta-table-level asset itself (Atlas entity from the Loom table catalog, section 5.4); (e) Gov has no Data Map labeling, so label application is Loom-native there.

## 5. Design

### 5.1 The Governance Enrollment Service (GES)

One module, `lib/governance/enrollment/`, is the **single owner** of: source registration, scan create/run/schedule, ruleset selection, classification and tag application, label application, Atlas entity and lineage emission, and drift repair for Loom-owned assets. Every other call site (the existing `autoOnboardToPurview`, `register-existing`, `trigger-scan`, Copilot tools, admin UI) delegates to it. It reuses `lib/azure/purview-client.ts` for transport; it does not add a second client.

Properties, each with its governing rule:
- **Idempotent**: `enroll(binding)` converges to the desired state and is safe to call any number of times (auto-bind item 3).
- **Self-healing**: a missing, renamed or out-of-band-deleted Purview source, scan or collection is re-created on the next reconcile; it never surfaces as a user message.
- **Deterministic names**: the Purview source/scan/collection carries the Loom workspace/item display name, sanitized only where Purview forces it (scan and ruleset names: letters, digits, underscore, hyphen; ruleset 63 chars no spaces), via one pure function `purviewName(kind, loomName, id)` with a short stable suffix only on collision. The sanitized-to-original mapping is stored on the binding (auto-bind item 2: "recorded in the item's state so the mapping is inspectable").
- **Honest**: a binding is `scanned` only when the latest run is `Completed` and a read-back asset count was recorded (section 5.5; `deploy-integrity.md` R7).
- **Fail-closed on unknowns**: when the account is unreachable the status is `unknown` with the reason, never `ok`.

### 5.2 Triggers

| Trigger | Mechanism | Notes |
|---|---|---|
| (i) Item create/update/delete | New `governance.enroll(item, op)` call placed next to `mirrorGovernanceDoc` / `autoOnboardToPurview` in `createOwnedItem` (`item-crud.ts:940-943`) and in the update/delete/soft-delete/restore/purge functions (`:1014`, `:1135`, `:1205`, `:1261`). It enqueues a work record and runs inline only up to a bounded budget (the 8 s deadline pattern of `autoBindOnCreate`); anything unfinished is picked up by the sweep. Never blocks or fails item creation | Replaces `autoOnboardToPurview` as the entry point; the existing function becomes the Atlas-entity step inside GES |
| (ii) Scheduled reconcile sweep across ALL workspaces | Timer (default every 6 h, Decision D3) invokes an internal route `POST /api/internal/governance/reconcile` using a service identity, authenticated like the estate caller (`lib/estate/estate-sp-auth.ts`, `verifyEstatePowerCaller`). The route enumerates every workspace and item with a **cross-partition service-identity query**, not `listOwnedWorkspaces`, so the sweep is not limited by any caller's visibility | This is the answer to the workspace_list visibility defect for enrollment: the sweep never depends on a caller scope. Host the timer in a Container App Job (same pattern as `lineage-extractor`, `secret-expiry-monitor`) or an Azure Function modeled on `posture-refresh`; recommended: Container App Job calling the BFF so the reconcile reuses the console's Purview client and cloud resolution rather than duplicating it |
| (iii) Workspace/domain create | Hook in workspace create and `domain-sync.ts` / `domain-registry.ts`: ensure the Purview collection hierarchy domain > workspace exists (section 5.3) | Collection names deterministic from domain/workspace names |
| (iv) Manual "Reconcile now" | Admin UI button and the `governance_reconcile` Copilot tool; scoped to all, one workspace, one item, or one source | Same code path as the sweep, `trigger: 'manual'` on the audit event |

Concurrency: a per-binding lease (Cosmos etag) prevents the sweep and an inline create enrolling the same source at once. A sweep is resumable: it stores a cursor and processes bounded batches.

### 5.3 Desired-state model: `governance-binding` and collection mirror

New Cosmos container `governance-bindings`, PK `/tenantKey` (tenant = Entra `tid`, see 5.13), one document per **backing source** (not per item), because Purview forbids duplicate registration and many items share one account.

```
governance-binding {
  id, tenantKey, cloud,
  loomItemIds[]            // all items resolved to this source (many:1)
  workspaceIds[], domainId // collection placement
  backingResourceId        // ARM id; the dedupe key
  backingKind              // adls | synapse-sql | azure-sql | adx | databricks-uc | eventhubs | none
  scanScopes[]             // container/path/database/schema scopes, one scan per scope group
  purviewSourceName, purviewCollection, purviewSourceAdopted: bool   // adopted = pre-existing (brownfield)
  scans[]: { scanName, scopes, rulesetName, schedule, authMethod, ir, lastRun:{ id, status, startedAt, endedAt, discoveredAssets, classifiedAssets }, state }
  nameMap: { loomName -> purviewName }   // sanitization record
  desired: { register, scan, schedule, classify, label, lineage }  // from policy
  observed: { sourceExists, scanExists, permissionsOk, computePaused, lastReconciled }
  drift: none | missing-source | missing-scan | renamed | rbac | paused | scope | ruleset
  error: { class: transient|permission|network|quota|config|defect|paused, detail, remediation, since }
  version, etag
}
```

Each Loom item additionally gets a small `state.governance` projection (status chip data: registered, scanned, classified, labeled, lastScanAt, bindingId) so editors render without a join. The binding is the source of truth; the projection is derived and rewritten by GES.

**Collections mirror the Loom hierarchy**: Purview root collection > Loom domain (from `governance-domains`) > Loom workspace. Sources are registered at the **domain** collection (or the root for ungrouped workspaces); scans are created under the **workspace** collection, which per Learn makes the discovered assets appear under that workspace's collection while the source is registered once. Collection creation uses the existing `/collections/{name}` writer (`purview-client.ts:2613-2669`).

### 5.4 Coverage matrix (every item type with a backing store)

Treatments: **S** = register source + scan; **A** = Atlas entity + lineage (artifact, no scan); **E** = enrolled as Atlas entity plus tags only; **N** = not applicable (no governable store). Auth = how Purview scans. All scans scoped; one source registered per backing account/server/cluster/workspace.

| Loom item type(s) | Backing | Treatment | Purview source kind | Scan auth (default) | Scan scope | Ruleset | Receipt that proves it |
|---|---|---|---|---|---|---|---|
| lakehouse, mirrored-database (Bronze), materialized-lake-view output | ADLS Gen2 account | **S** | AdlsGen2 | Purview MSI + Storage Blob Data Reader (deployed, 5.6); SHIR + SPN only where private-endpoint-only (5.5) | Container plus `bronze/silver/gold` roots owned by the workspace; Delta tables appear as Parquet resource sets, so GES also writes a table-level Atlas entity per Loom-cataloged Delta table | System ADLS Gen2 ruleset cloned to `loom-<tenant8>-adls-default` with Spark ignore patterns | Source exists with Loom name; run `Completed`; discoveredAssets > 0 read back; assets under workspace collection |
| warehouse, synapse-serverless-sql-pool, mirrored-databricks SQL endpoint | Synapse dedicated pool / workspace | **S** | AzureSynapseWorkspace or AzureSqlDataWarehouse (dedicated pool) | Purview MSI as db user with `db_datareader` plus `VIEW DEFINITION` via the existing Synapse grant mechanism | Database/schema | System Synapse ruleset clone | As above; no labels (Learn: not supported for Dedicated SQL pool) |
| kql-database, eventhouse, kql-queryset, workspace-monitor | ADX database | **S** | AzureDataExplorer | Purview MSI as ADX `AllDatabasesViewer`/database viewer | Database | System ADX ruleset clone | As above |
| mirrored-databricks, databricks-notebook, databricks-job, ml-model (UC) | Databricks workspace / Unity Catalog | **S** (UC) / **A** (jobs, notebooks) | AzureDatabricksUnityCatalog (existing `registerDatabricksUnityCatalogSource` `purview-client.ts:1721`, `setup-purview-databricks-scan.sh`) | Per existing UC scan setup (Key Vault secret path, `catalog.bicep:309-318`) | Catalogs/schemas of the workspace | UC ruleset (custom classification unsupported per Learn) | Existing UC scan receipt pattern. Account-admin 403 seen in self-audit is a **permission** error class here: remediation names the role |
| eventstream | Event Hubs | **A** | none (Event Hubs is not a Data Map scan source) | n/a | n/a | n/a | Atlas entity for the hub, lineage edges from producers/consumers and the Stream Analytics job |
| data-pipeline, synapse-pipeline, adf-pipeline | Synapse/ADF pipelines | **A** | none | n/a | n/a | n/a | Pipeline-run lineage already emitted (`synapse-emitters.ts`); GES ensures the pipeline entity and edges to enrolled sources exist. Synapse pipeline lineage is unsupported in Azure Government by Learn; Gov uses the Loom OpenLineage path (5.12) |
| notebook, spark-job-definition, spark-environment | Synapse Spark | **A** | none | n/a | n/a | n/a | Lineage via OpenLineage Spark listener where `svc-openlineage` is configured; otherwise entity-only, status `entity` not `lineage` |
| semantic-model, report, kql-dashboard | Loom-native over warehouse/lakehouse/ADX | **A** | none | n/a | n/a | n/a | Entities plus lineage edges to the upstream enrolled source (new emission, W6; none found today) |
| data-product | Purview Unified Catalog | **E** | Unified Catalog (existing) | n/a | n/a | n/a | Existing provisioner `data-product.ts:255` |
| ai-search-index, prompt-flow, evaluation, logic-app, stream-analytics-job, activator | Azure services without a Data Map scan source | **E** | none | n/a | n/a | n/a | Atlas entity with owner/workspace/domain tags |
| Azure SQL Database connections (mounted or connected) | Azure SQL | **S** | AzureSqlDatabase | Purview MSI as contained db user | Database | System Azure SQL ruleset clone | As above; `autoOnboardToPurview` already recognizes `*.database.windows.net` / `usgovcloudapi.net` (`:195-200`) |
| Everything else in the 142-entry catalog with no backing store | none | **N** | none | n/a | n/a | n/a | Listed with reason `no-governable-store` in `governance_inventory`; never silently skipped |

The classification of all 142 catalog entries into S/A/E/N is produced as data in W2 (`backingStore` field on `FabricItemType`) and asserted by a test that every catalog slug has a treatment (a new slug without one fails CI).

**Dedupe**: key = `backingResourceId`. Register once; each workspace's scan scopes only its own container/path (this also keeps each workspace's assets in its own collection). Scans for one source are staggered by the cost guard (5.5).

### 5.5 Scans: create, run, schedule, fail

1. **Create** with the ruleset chosen up front (changing it later forces a costly full scan per Learn). Scope = the item's path/database, never the whole account unless the workspace owns it.
2. **Run** an initial full scan (`scanLevel=Full`, `runId` = GUID) immediately after create, subject to the cost guard and the pause contract below. Record `Operation-Location`/run id on the binding.
3. **Schedule** incremental scans. Default weekly off-peak (Decision D3), a trigger on the scan, not a Loom cron, so scans run even if Loom is down.
4. **Read back**: poll the run via a bounded wait or the next sweep (no tight loops); mark `scanned` only on `Completed` plus a discovered-asset count obtained from the search/Atlas API for the workspace collection. A `Completed` run with 0 assets for a non-empty source is `completed-empty` and surfaces as a warning with the likely cause (scope wrong, files unsupported, ignore pattern), never a green check.
5. **Retry** transient failures (HTTP 429/5xx, run `Failed` with a transient classification) with bounded exponential backoff (3 attempts, jittered, capped 15 min); exhaustion fails closed with the error recorded (`deploy-integrity.md` R6: a retry that cannot fail is forbidden, so each retry path has a test that exhausts it).
6. **Classify failures** and attach a concrete remediation:

| Class | Detection | Remediation text (must be true, R7) |
|---|---|---|
| permission | 401/403 on register/scan/run, or run failed with an auth error | Names the exact principal, role and scope, for example "Purview managed identity needs Storage Blob Data Reader on /subscriptions/.../storageAccounts/X"; if Loom can grant it, GES grants it (auto-bind) and only reports if the grant itself fails |
| network | DNS/timeout/private-endpoint indications; storage firewall without trusted-services | "Account X has private endpoints only: scan needs a self-hosted or managed-VNet IR" and GES provisions/binds the IR via the existing `upsertPurviewIntegrationRuntime` / managed VNet functions (`purview-client.ts:1953,2125,2160`), reusing the SHIR VMSS (`purview-shir.bicep`) |
| quota/throttle | 429, scan-concurrency messages | Backoff and queue; surfaces `queued` not `failed` |
| paused | The backing compute is paused per the estate snapshot (below) | `skipped: paused` with the reason; not an error |
| config | Missing ruleset/collection/source drift | Self-repair, then re-run |
| defect | Anything unclassified | Raw message kept in the binding, class `defect`, issue-filing hint; never reworded as a cause the code did not verify |

7. **Pause contract with PRP-02 (estate power)**: before registering-or-scanning a source whose compute can be paused (ADX, Synapse dedicated pool, AAS, Databricks warehouse), GES reads `loadPauseSnapshot(tenantId)` (`pause-orchestrator.ts:1406`) and a live `armPowerReading()` (`pause-state.ts:186`). Paused means: do not start a scan, record `error.class='paused'`, `drift='paused'`, show "Skipped: ADX cluster is paused (resume it to scan)" with the existing Resume action, and enqueue the scan for the first sweep after resume. GES never resumes compute on its own (a scan is not worth the compute cost without an operator choice) — Decision D6 option. The contract is a read dependency only; PRP-02 need not land first, GES simply reads the same module (`lib/estate/*`, exists on main).
8. **Cost and throttling guard**: global concurrent-scan cap (default 2), per-tenant daily full-scan cap, stagger by source, and a monthly budget estimate shown in the admin UI (section 10). Exceeding a cap queues rather than errors. Default-on scanning is a cost-material change and is Decision D1.

### 5.6 Permissions as deployed infrastructure

All grants are produced by bicep or the bootstrap workflow; none is a documented manual step (`auto-bind-by-default.md` item 5, `no-vaporware.md` Bicep sync).

| Principal | Target | Role | Where |
|---|---|---|---|
| Purview account MSI | Storage accounts holding lakehouse roots | Storage Blob Data Reader (scope: account, or container where the platform owns one container per workspace; RG scope is rejected because it widens beyond Loom storage) | New module `modules/admin-plane/purview-scan-grants.bicep`, invoked per storage account from the same place storage accounts are declared (landing-zone and admin-plane), replacing the deferred note at `landing-zone/main.bicep:74` |
| Purview MSI | Synapse workspace + dedicated pool(s) | Synapse SQL contained user `db_datareader` + `VIEW DEFINITION` (not an ARM role): added by the existing Synapse grant mechanism (**which mechanism: UNVERIFIED, W0**) | bootstrap workflow step |
| Purview MSI | ADX cluster | Cluster/database `Viewer` principal assignment (ARM `Microsoft.Kusto/clusters/databases/principalAssignments`) | bicep |
| Purview MSI | Azure SQL servers | Contained db user via Entra admin script step; server must allow Azure services or use IR | bootstrap |
| Purview MSI | Event Hubs namespace | Azure Event Hubs Data Receiver is not needed (no scan); Reader at namespace scope for entity discovery only if D9 selects it | bicep, conditional |
| Loom service identity (Console UAMI and the reconcile job identity) | Purview account | Data Source Administrator, Data Curator, Collection Admin at the **root** collection (needed to create collections) and Data Reader. Already granted by `grant-purview-datamap-role.sh`; GES adds a **self-check** (`permissionsOk`) and an in-product Fix-it | existing step kept; reconcile job identity added |
| Console UAMI | Each backing source | Reader (ARM) for discovery and for the source-readiness check that tells the operator precisely which role is missing | bicep |
| Reconcile job identity | Cosmos (read all workspaces/items, write bindings) | Cosmos built-in data roles, as `posture-refresh` has | bicep |

Public network access on the Purview account is Disabled (`catalog.bicep:138-164`); the bootstrap grant step temporarily enables it (workflow ~`:714`). The reconcile job and BFF reach Purview over the existing private endpoints; W3 verifies the job's network path in every boundary. Azure Policy exclusions for the Purview account (Learn: policies that block storage updates break scans) are added to bicep where Loom owns the policy assignment (**UNVERIFIED** whether any exists).

Brownfield variants: where the customer owns the storage/Synapse/ADX, GES cannot deploy their RBAC; it validates readiness (section 5.11) and emits the exact `az role assignment create` / SQL / Kusto command in the gate Fix-it, executed in-product where the operator identity can (auto-bind: do it if the platform can).

### 5.7 Auto-classify, tag, label

**What Purview does natively**: system classification during scan (L3 sampling); sensitivity-label application to Data Map assets only when auto-labeling is configured in Purview Information Protection and the tenant has M365 E5 + pay-as-you-go (Learn), built-in classifiers only, preview, and **unsupported in Azure Government**.

**What Loom adds** (so the result is identical across clouds and does not require E5):
1. **Default classification ruleset per source type** (`loom-<tenant8>-<kind>-default`): system rules on, with a Loom-maintained list of region-specific rules off (Learn notes system rules include non-US patterns that cause false positives), 10 ignore patterns reserved for Spark transaction files, `_delta_log`, `_SUCCESS`, checkpoints, and temp prefixes. Custom Loom classification rules from the existing taxonomy are included through `upsertCustomClassificationRule`/`syncClassificationTaxonomyToPurview` (`purview-classification-sync.ts:157`).
2. **Tags from Loom metadata**, applied as Atlas business metadata and glossary terms (`setBusinessMetadata` `:1557`, `applyGlossaryTerm` `:1322`): workspace, domain, item type, medallion layer (derived from path root), owner, endorsement, environment. Tag keys are a fixed namespace `loom.*` registered once (`ensureClassificationDefs`-style typedef call).
3. **Classification results read back**: after a `Completed` scan GES queries classified assets per workspace collection (Atlas search/`searchDataMapAssets`) and writes `classifiedAssets`, the top classifications and per-asset classification into the binding and the item projection (`state.governance`), so editors and the existing `classification-flyout.tsx` / `label-flyout.tsx` show them.
4. **Label policy** (admin-editable, `label-policy` document per tenant, default shipped): a mapping `classification -> sensitivity label` with precedence and a safe default.
   - Default mapping targets the tenant's existing labels discovered through `mip-graph-client.ts` (matched by an ordered name heuristic, then confirmed once via the Fix-it) or, if the tenant has no labels or the cloud has no Graph label read, the Loom-native label set `Public / General / Confidential / Highly Confidential` stored in the existing label library.
   - Auto-apply is limited to labels the policy marks `autoApply: true` (default: up to Confidential); Highly Confidential is **suggested** in the admin UI and Copilot, applied on one-click approval (Decision D2).
   - Application path: Loom writes the label through the existing `app/api/items/[type]/[id]/sensitivity-label/route.ts` logic (item state, `label-assignments`, audit, Purview asset best effort), extracted into a shared function so GES and the route cannot diverge. Downstream label propagation reuses `lib/governance/label-propagation.ts` / `apps/fiab-label-propagation/`.
   - Purview-native auto-labeling is an **opt-in additive path** in Commercial (Decision D5) because of the E5/PAYG licensing and preview status; it is never required.
   - Never downgrade: a label applied by a human is not overwritten by policy (policy only raises or fills an empty label), and every automatic application is audited with the classification that caused it.
5. **Lineage**: GES guarantees the entity and edges for artifacts per the coverage matrix and adds missing emission for notebooks, semantic models and reports (W6) using `createAtlasLineage`/OpenLineage. In Azure Government, where Purview lacks Synapse pipeline lineage, the existing Loom OpenLineage ingest is the lineage source of truth and the Atlas edges are written by Loom directly.

**Gov equivalents**: classification and glossary are supported in Gov Data Map (Learn), so scans classify there; labeling and managed attributes are not, so labels and tags live in Loom (item state, `label-assignments`, Atlas business metadata only where the account accepts it — **UNVERIFIED** in Gov, W0 probes) and the admin UI states "Loom-native labeling (Purview Data Map labeling is not available in this cloud)".

### 5.8 Copilot tools

Nine tools in a new `lib/copilot/governance-tools.ts`, registered in `LoomToolRegistry` (`copilot-orchestrator.ts:409`). Because there is no scope field on `ToolDef` (3.5), authorization is enforced inside each handler by one shared helper `requireGovernanceCapability(ctx, level)` (added in this PRP) that resolves **group-based admins correctly** (fixing the gap noted at 3.5 by passing the resolved capability set into `ToolContext`; if that is invasive, W1 documents the limitation and falls back to the session-claim path used by `loom_resolve_gate`).

| Tool | Kind | Auth | Input (JSON schema summary) | Behaviour | Confirm | Audit event |
|---|---|---|---|---|---|---|
| `governance_inventory` | read | any signed-in user sees what they can access; tenant admin may pass `scope:'tenant'` | `{scope?:'mine'|'tenant', workspaceId?, itemType?, coverage?:'enrolled'|'unenrolled'|'any', cursor?, pageSize? (default 100, max 500)}` | Returns authoritative rows from bindings joined to items: workspace, item, backing resource, treatment (S/A/E/N), status. Always returns `{total, returned, nextCursor, truncated}`; never silently truncated; the tool description instructs the model that `truncated:true` or a non-null `nextCursor` means keep paging | n/a | `governance.inventory.read` |
| `governance_status` | read | as above | `{bindingId? | itemId? | workspaceId?}` | Source/scan/run/classification/label state plus drift and error class with remediation | n/a | `governance.status.read` |
| `governance_enroll` | write | workspace Contributor+ for own workspaces; tenant admin for tenant scope | `{itemIds[]? | workspaceId? | all?:true, dryRun?:bool (default true on first call)}` | Dry-run returns the plan (sources to register, scans to create, estimated scan cost and count against the daily cap). Execute performs `enroll` | **Two-step**: plan, then `confirm:true` echoing the plan hash. The existing `confirm:false` first-call pattern (`:687-706`) is reused | `governance.enroll` |
| `governance_reconcile` | write | tenant admin | `{scope:'all'|'workspace'|'binding', id?}` | Runs the same reconcile as the sweep, bounded batches; returns progress and cursor | confirm for `all` | `governance.reconcile` |
| `governance_scan_run` | write | workspace Contributor+ | `{bindingId, scanName?, level?:'Full'|'Incremental'}` | Starts a run subject to the cost guard and pause contract | confirm for `Full` on sources over a size threshold | `governance.scan.run` |
| `governance_scan_status` | read | as inventory | `{bindingId | scanName}` | Latest and recent runs, durations, discovered/classified counts, failure class | n/a | `governance.scan.status.read` |
| `governance_classify_summary` | read | as inventory | `{workspaceId? | bindingId?}` | Top classifications, counts, unlabeled sensitive assets. Returns counts and classification **names**, never sampled values (PII) | n/a | `governance.classify.read` |
| `governance_apply_label_policy` | write | tenant admin | `{mode:'preview'|'apply', scope}` | Preview lists proposed label changes with the classification reason; apply writes allowed ones only | `apply` requires confirm; Highly Confidential requires per-batch approval via the proposed-change Keep/Undo sentinel (`copilot-orchestrator.ts:1435,2675-2719`) | `governance.label.apply` |
| `governance_explain_gap` | read | as inventory | `{itemId | bindingId | workspaceId}` | Explains why something is not enrolled/scanned/classified in terms of drift and error class, with the Fix-it or the next tool to call | n/a | `governance.gap.explain` |

All results use the `{ok, data, error, remediation}` shape, are wrapped with `asSummary` where markdown, and respect the 16,000 character loop cap by being **paginated by design** so that cap is never hit mid-JSON. Abuse limits: write tools are rate-limited per user and per tenant (default 10 write calls per 10 minutes per user; `all` scope once per hour), refuse when the cost guard is exceeded, and refuse prompt-injected scope escalation by taking scope only from validated arguments and the caller's session, never from retrieved content. A write tool that hits an honest gate returns `{ok:false, error, remediation, gateId}` so `loom_resolve_gate` can resolve it.

Tool descriptions carry `whenToUse` text naming the operator phrasing ("register in Purview", "set up scans", "make sure every asset is governed") so intent routing selects them. The system prompt snippet for governance asks is registered with the tool set, not hard-coded in the orchestrator.

### 5.9 Fix the visibility defects (dependency of the tools)

Owned by W1, in `copilot-orchestrator.ts` and `item-crud.ts`:
1. `workspace_list` switches from `listOwnedWorkspaces` to `listAccessibleWorkspaces` (`workspace-access.ts:570`) so owned, ACL-shared, admin-open and app-installed workspaces all appear, with `{total, truncated}`. A test seeds one owned and one ACL-shared workspace and fails if either is missing.
2. `item_list` returns a paginated envelope `{items, total, returned, nextCursor, truncated}` using the bounded variant (`listOwnedItemsBounded`, `item-crud.ts:688-792`) with an explicit page size; the 16,000-char slice is replaced for structured results by a structured `truncated:true` marker plus a continuation hint, so a mid-JSON cut cannot occur for these tools.
3. `item_list` latency (about 8.7 s measured) is addressed by the same bounding plus a point-read path when `workspaceId` is given (per-row `resolveWorkspaceAccessByOid` becomes one access resolution per workspace — measured by W0 before and after).
4. `governance_inventory` is the authoritative cross-workspace manifest; `item_list` remains the general tool.

### 5.10 UI

Admin > Governance enrollment at `app/admin/governance-enrollment/page.tsx` (name hypothetical; nav registration under `lib/nav/` **UNVERIFIED**), `AdminShell`, API under `app/api/admin/governance-enrollment/`. Built to `ux-baseline.md`, `web3-ui.md`, `ui-parity.md`:
- Coverage table by workspace > source > item type with status chips (registered, scanned, classified, labeled), drift state, last scan time and duration, discovered/classified counts; filters; `TileGrid` summary cards (coverage %, drifted, failed, paused-skipped, unlabeled sensitive) with elevation and Fluent icons; guided `EmptyState` (no Purview configured -> Fix-it to connect or deploy).
- Row actions: Reconcile now, Run scan, View in Purview (deep link), Explain gap (calls the same logic as the Copilot tool).
- Policy editor: label mapping (classification to label, precedence, autoApply), scan schedule, concurrency and daily caps, ruleset selection; draft/publish rather than save-on-edit (a policy change can trigger full scans; the UI shows the cost estimate before publish).
- Resizable panes via `SplitPane` with persisted `sizingKey` (G3); badge rows `flexWrap` + `minWidth:0`; Copilot entry point and LearnPopovers; first-open on a fresh tenant is guided, not red (a not-yet-reconciled estate shows "Reconciling..." progress, not errors).
- Per-item **Governance** status chip and tab in item editors (registered/scanned/classified/labeled, last scan, Open in Purview, Fix-it on failure), mounted through the shared editor chrome rather than per-editor code.
- Gates registered in the central registry (G2): `governance-enrollment` (service enabled), `purview-scan-permissions` (permissionsOk per source, Fix-it grants or shows the exact command), `purview-collection-admin`, each with a Fix-it kind (`role-grant`/`provision`) in `lib/gates/registry/catalog-governance.ts` plus env-check specs, so Copilot can resolve them with `loom_resolve_gate`. The `svc-purview-uc` host text mismatch (3.6) is corrected in the same change.
- Parity doc `docs/fiab/parity/governance-enrollment.md` against Purview Data Map > Sources/Scans/Scan rule sets/Monitoring and Purview Unified Catalog asset views; every inventory row built or honest-gated, zero missing.

### 5.11 Brownfield (discover, offer, adopt)

Per `deploy-integrity.md` R5 and R4:
1. **Discover** with an extension of `scripts/csa-loom/discover-purview-adopt-plan.sh` and a console route: multi-subscription Resource Graph over the operator's subscriptions for Purview accounts, plus for the chosen account the existing collections, registered sources (`listDataSources` `purview-client.ts:1589`), scans (`listScansForSource` `:1694`) and rulesets. Also discovers the candidate backing sources Loom would bind (storage, Synapse, ADX, SQL, Databricks, Event Hubs).
2. **Offer** per service: "use existing Purview account X" or "deploy new", with what Loom would use it for and change (collections it creates, sources it registers, rulesets it adds).
3. **Validate** the chosen account: SKU/region, network reachability from the console and reconcile job, the Loom identity's data-plane roles, and, per source, the Purview MSI's role on the backing resource, reporting precisely what is wrong.
4. **Adopt, never re-register**: match existing sources/scans to Loom bindings by `backingResourceId`; mark `purviewSourceAdopted=true`; leave the customer's scans untouched; add Loom scans beside them only for Loom-owned scopes that no existing scan covers; never rename customer objects. Collection placement for adopted sources follows the customer's collection (Loom links, does not move).
5. **Supplied values** are a first-class input: `EXISTING_PURVIEW*` params already exist; add the same for explicit collection and per-source overrides to the gate Fix-it wizard.
6. **Never silently duplicate** a Purview account: bicep `purviewEnabled=false` plus `loomPurviewAccount` is the reuse path; a deploy that would create a second account while one is discoverable fails preflight with the offer.

### 5.12 Cloud parity

| Capability | Commercial | GCC-High | IL5 | DoD | GCC |
|---|---|---|---|---|---|
| Register/scan Azure sources (ADLS, Synapse, ADX, SQL, UC) | Supported | Supported by Learn (US Gov Virginia); sources in preview are not | **UNVERIFIED**: IL5 `catalogPrimary='atlas-aks'` (`il5.bicepparam:126`) means Purview may not be the catalog; GES must target whichever catalog backend is primary, see below | **UNVERIFIED**: no DoD param file found, Purview DoD availability not established | Supported in code only, never exercised; no receipt claimed |
| Data plane host | `purview.azure.com` | `purview.azure.us` (`purview-endpoints.ts:68`) | `purview.azure.us` | `purview.azure.us` assumed, **UNVERIFIED** | `purview.azure.com` |
| Token audience | `https://purview.azure.net/.default` (`purview-client.ts:100`) | Same constant used today; Learn documents no Gov audience (`purview-endpoints.ts:30-39`); W0 verifies from an Actions run, never local `az` | Same | Same | Same |
| System classification during scan | Yes | Yes (Learn) | Via Atlas path | Via Atlas path | Yes |
| Purview Data Map labeling | Optional, Decision D5 | Not available (Learn: unsupported) -> Loom-native | Loom-native | Loom-native | n/a |
| Managed attributes | Preview | Unsupported -> Atlas business metadata/Loom tags | Loom tags | Loom tags | n/a |
| Pipeline lineage | Purview + Loom | Synapse pipeline lineage unsupported (Learn) -> Loom OpenLineage writes Atlas edges | Same | Same | n/a |
| Unified Catalog data products | Yes (`LOOM_PURVIEW_UC_ENDPOINT`) | Not wired (`main.bicep:5945-5947` Commercial only) | No | No | n/a |
| Copilot tools, enrollment service, inventory, UI | Yes | Yes | Yes | Yes | Supported in code only |

**Where Purview is not the primary catalog (IL5 with `atlas-aks`)**: the GES backend is an interface, `CatalogBackend`, with a `PurviewBackend` and an `AtlasBackend` (Apache Atlas on AKS, which already exposes the Atlas v2 entity and glossary APIs the client uses at `/datamap/api/atlas/v2/*`). Where scanning is unavailable, **Loom performs the scan natively**: a lightweight scanner (Container App Job, W5) that lists the backing store, samples with the same limits as Purview (128 rows / 1 MB), runs a Loom-maintained subset of classification patterns derived from the existing classification taxonomy, and writes Atlas entities and classifications. This is the Azure-native/OSS equivalent required by `cloud-parity.md` item 3 ("not in Gov is the start of the design problem"). It is a stated, bounded subset (documented pattern list, not a claim of Purview parity). **Decision D7** asks whether to build the native scanner in this program or file it as the Gov follow-up with a dated owner; the recommended default is build it, because IL5 is `atlas-aks` today and would otherwise have no scanning.

Receipts per cloud (section 7.4) are produced by GitHub Actions runs only for Gov (`cloud-parity.md` item 4; workstation `az` is a Commercial tenant). GCC: no receipt, no claim.

### 5.13 Security

- **Least privilege**: Purview MSI gets read roles scoped to Loom-owned storage/DB only (5.6); the Loom identity gets Data Source Admin/Collection Admin at the root only because collection creation requires it; the reconcile job gets Cosmos access and Purview roles, nothing on customer data planes. No credential appears in code, logs, tool results or audit payloads; scan auth is MSI. Where a service principal or key is unavoidable (private endpoints, SHIR), the secret lives in Key Vault and the binding stores only the reference.
- **Tenant isolation**: bindings are keyed by Entra `tid` (not the owner-oid `tenantId` field, 3.4); the cross-partition sweep processes one tenant at a time; Copilot tools filter by the caller's accessible workspaces (same resolution as `item_list`) and admin tools by tenant. A scan for workspace A is scoped to A's paths and lands in A's collection, so assets of workspace B are never placed under A. Classification typedef names stay tenant-namespaced (`loomClassificationTypedefName`, `purview-autoonboard.ts:339`) because Atlas typedefs are account-global and permanent. Collection-level Purview RBAC is not mirrored from Loom ACLs in this PRP (Purview roles are broader than Loom workspace roles) — **disclosed limitation**; users with Purview portal access see per-collection data under Purview's own model. A private advisory about lakehouse workspace isolation exists; this PRP must not make it worse (scan scopes use the same root-owner facts, `lakehouse-abfss.ts:171-257`) and does not describe it further.
- **PII**: classification results record names and counts, never sample values; the `governance_classify_summary` tool and audit events exclude values; Purview's own sampled values stay inside Purview.
- **Audit**: every automatic and manual action emits `emitAuditEvent` (`audit-stream.ts:212`) with `trigger` (`create|update|delete|sweep|manual|copilot`), actor (user oid or the service identity), binding id, action, outcome and error class, to SIEM `LoomAudit_CL`.
- **Abuse limits** on Copilot write tools: section 5.8.
- **Data Map token audience per cloud**: confirmed from code only as the single constant above; correctness per cloud is a W0 measurement, not an assumption.

## 6. Work items

Conventions: Sonnet by default; Opus only where stated. Lanes: at most 4 concurrent. "Owns" lists the files the item may edit; a file owned by two items is **sequenced, never parallel**. Re-verify line numbers at head before editing. Each item ends with its own command/receipt and the usual local bar (touched tests pass; PR open; CI green); the full `make validate` runs in CI.

### 6.1 Items

| ID | Title | Owns (edits only these) | Depends on | Model | Review |
|---|---|---|---|---|---|
| W0 | Measurement spike: live Purview state, token audience per cloud, backing-source resolver table, scan cost, Synapse grant mechanism | New `scripts/measure/governance-*.mjs`; receipt file `PRPs/active/governance-autopilot/W0-RECEIPT.md`. No product code | none | Sonnet | no |
| W1 | Visibility fixes + `governance_inventory` read path | `lib/azure/copilot-orchestrator.ts` (workspace_list/item_list only), `app/api/items/_lib/item-crud.ts` (list functions only), new `lib/governance/inventory.ts`, tests | W0 (resolver table for rows) | Sonnet | no |
| W2 | Binding model, GES core, `backingStore` field, name rules, reconcile engine (no scans yet) | New `lib/governance/enrollment/**`, `lib/catalog/fabric-item-types.ts` + `lib/catalog/item-types/types.ts` (add `backingStore`), `lib/azure/cosmos-client.ts` (new `governance-bindings` container only), tests | W0 | **Opus** for the design pass of the reconcile state machine and idempotency (one session), Sonnet for the rest | **required** (core data model + idempotency) |
| W3 | Permissions as infrastructure | `platform/fiab/bicep/modules/admin-plane/purview-scan-grants.bicep` (new), `catalog.bicep`, `landing-zone/main.bicep`, `admin-plane/main.bicep` (env wiring), `params/*.bicepparam` (all boundaries), `scripts/csa-loom/grant-purview-datamap-role.sh`, `.github/workflows/csa-loom-post-deploy-bootstrap.yml` (Purview/Synapse/ADX/SQL grant steps only) | W2 contract (which principals/scopes), W0 | Sonnet | **required** (bicep, hard to reverse) |
| W4 | Scan orchestration: create/run/schedule/read-back, retries, failure classes, cost guard, pause contract | `lib/governance/enrollment/scans/**` (new), `lib/azure/purview-client.ts` (additive functions only: scan trigger schedule, run read-back; no signature changes), `lib/scheduler/run-adapters.ts` (new `governance-scan` JobKind) | W2, W3 for live receipts | Sonnet | no |
| W5 | Triggers + sweep: create/update/delete hooks, internal reconcile route, reconcile job, collection mirror, native Loom scanner for atlas-aks boundaries | `app/api/items/_lib/item-crud.ts` (hook lines only), `lib/azure/purview-autoonboard.ts` (delegate to GES), `app/api/internal/governance/reconcile/route.ts` (new), `lib/azure/domain-sync.ts`, `lib/azure/domain-registry.ts` (collection hooks), `platform/fiab/bicep/modules/**/governance-reconcile-job.bicep` (new, **bicep lane**), `apps/fiab-governance-scanner/**` (new, native scanner, D7) | W2, W4 | Sonnet (native scanner: Sonnet) | **required** for the internal route (auth surface) |
| W6 | Classification, tags, label policy, label application, missing lineage emission | `lib/governance/label-policy/**` (new), shared label-apply function extracted from `app/api/items/[type]/[id]/sensitivity-label/route.ts` (route edited to call it), `lib/azure/purview-classification-sync.ts` (additive), `lib/lineage/**` (notebook/semantic-model/report emitters) | W2, W4 | Sonnet | **required** (label application touches data classification) |
| W7 | Copilot governance tools | New `lib/copilot/governance-tools.ts`; `lib/azure/copilot-orchestrator.ts` (registration + loop truncation behaviour only — sequenced after W1 on this file) | W1, W2 (read tools earlier; write tools after W4/W5/W6) | Sonnet | **required** (authorization + write tools) |
| W8 | Admin UI, per-item chip/tab, gates, parity doc | `app/admin/governance-enrollment/**`, `app/api/admin/governance-enrollment/**`, shared editor-chrome chip component, `lib/gates/registry/catalog-governance.ts`, `lib/admin/env-checks/catalog-governance.ts` (+ `svc-purview-uc` text fix), `lib/nav/**`, `docs/fiab/parity/governance-enrollment.md` | W2 (API contract), W1 | Sonnet | no (browser G1 walk is the gate) |
| W9 | Brownfield discover/offer/adopt | `lib/governance/brownfield/**`, `scripts/csa-loom/discover-purview-adopt-plan.sh`, wizard Fix-it for supplied values, deploy preflight for duplicate-account | W2, W3 | Sonnet | **required** (touches deploy preflight) |
| W10 | Docs, receipts, E2E and Gov Actions lanes | `docs/fiab/governance-autopilot.md` (greenfield and brownfield walkthroughs, both clouds), `docs/fiab/purview-setup.md` (link), `.github/workflows/` governance receipt job (reuse existing lanes; no new Gov deploy lane), `tests/e2e/**` for the operator-prompt acceptance test | all | Sonnet | no |

### 6.2 Dependency graph and lanes

```
W0 ─┬─> W1 ──────────────────────────────> W7(read tools) ──> W7(write tools)
    ├─> W2 ─┬─> W4 ─┬─> W5 ─┬─> W6 ─────────────^
    │       │       │       └─> W9
    │       └─> W8 (against the W2 API contract; real data after W4)
    └─> W3 (bicep lane; contract from W2 stub)           W10 last
```

Lane plan (max 4 concurrent):
- **Lane 1**: W0, then W1, then W7 (shares `copilot-orchestrator.ts` with W1: sequential inside the lane).
- **Lane 2**: W2, then W4, then W5, then W6 (shares `item-crud.ts`, `purview-client.ts`, the binding model).
- **Lane 3 (bicep)**: W3 alone, then the bicep half of W5. Never concurrent with another PR touching `platform/fiab/bicep/**` (section 6.3).
- **Lane 4**: W8 once the W2 API contract is merged, then W9, then W10.

### 6.3 Collisions and sequencing rules (bicep and shared files)

- `platform/fiab/bicep/**` is a shared surface. `per-workspace-spark-identity` (W-waves touch identities and storage role assignments), `apim-ai-gateway` (13-point epic, multi-boundary) and the drain's bicep lane all edit it. **Only one bicep-touching PR from any program is in flight at a time.** W3 and the W5 bicep half are queued behind whichever is open, and each is a small PR (one module + wiring).
- W3 adds Storage Blob Data Reader for the Purview MSI on storage accounts, and `per-workspace-spark-identity` rewrites storage role assignments (ABAC, path-conditioned grants). To avoid a conflicting grant model: W3's role assignment is isolated in its own module with a documented condition-free scope (account level, read-only), and the spark-identity PRP's "narrow the shared grants last" wave must keep it. This is recorded in both PRPs. If spark-identity W-waves land first, W3 rebases onto the new storage module layout rather than duplicating it.
- `copilot-orchestrator.ts`, `item-crud.ts`, `purview-client.ts`, `cosmos-client.ts` and `fabric-item-types.ts` are multi-owner files: edits are additive and sequenced in the order of the table.
- Do not run drain cycles that pick bicep work in the same session as W3/W5-bicep (same rule `MASTER-INDEX.md` already states for the other two bicep PRPs).
- No work starts a deploy-affecting merge while a deploy path is failing (`deploy-integrity.md` R1); W3 in particular waits for a green Commercial deploy receipt after PRP-02's P0.

### 6.4 Per-item acceptance (exact receipts)

- **W0**: `W0-RECEIPT.md` with raw outputs for: (a) the live Purview account name, existing collections, sources and scans (`listDataSources`/`listScansForSource` through a minted-session route); (b) the Purview MSI and Console UAMI role assignments on each backing source type in Commercial (workstation `az` is Commercial only) and in GCC-High via a GitHub Actions run id; (c) the token audience that actually succeeds in GCC-High (an Actions run); (d) the run verb accepted (`:run` POST versus PUT `.../runs/{id}`); (e) a typed table of `resolveBackingSource(item)` keys per item type, produced by creating one item of each type; (f) scan cost from Cost Management for the Purview account over the last 30 days; (g) timing of `item_list` before the fix. Any value not measurable is written as "not measured: <why>".
- **W1**: a test with two workspaces (one owned, one ACL-shared) asserts `workspace_list` returns both; a test with 600 items asserts `item_list` returns `total=600`, `returned<=pageSize`, a `nextCursor`, and `truncated:true` when the page is cut; the 16,000-character slice never fires on these tools. Receipt: a minted-session cookie call showing the envelope.
- **W2**: unit tests for `purviewName` (sanitization table incl. spaces, 63-char ruleset limit, collision suffix), binding upsert idempotency (second `enroll` is a no-op with an unchanged etag), dedupe (two lakehouses on one account produce one source and two scan scopes), every catalog slug has a treatment.
- **W3**: `az bicep build` on every touched module and `lint-bicep`; What-If receipt (Actions) for Commercial and GCC-High showing the new role assignments; post-deploy: a script `scripts/measure/governance-permissions.mjs` that reads back each Purview-MSI assignment and exits non-zero on a missing one.
- **W4**: injected-failure tests for each failure class; a retry-exhaustion test that must end in `failed` (not retry forever); a paused-ADX fixture that must yield `skipped: paused` and no scan call; live receipt: one scan Created, Run started, `Completed`, asset count read back.
- **W5**: create an item, observe the binding without any further call; delete the Purview scan out-of-band, run Reconcile, observe it recreated with the same name; the sweep enumerates a workspace the invoking identity does not own.
- **W6**: label-policy tests (never downgrade a human label; Highly Confidential not auto-applied; policy edit changes the outcome); a Gov-simulated run where Data Map labeling is unavailable still labels via the Loom-native path.
- **W7**: tool-contract tests (schema, auth denial for a non-admin on tenant scope, confirm required on `all`, rate limit trips on the 11th call); the acceptance test in section 7.1.
- **W8**: Playwright walk plus screenshots (dark and light), narrow-width badge pass, fresh-tenant first-open pass (G1/G2/G3); `pnpm uat` deep-functional spec for the page.
- **W9**: brownfield E2E in 7.3.
- **W10**: docs build passes (`mkdocs` strict hook caveat noted in the PR if the known mkdocs-material warning trips); both walkthroughs reviewed against the wizard (`deploy-integrity.md` R8).

## 7. Verification

### 7.1 The acceptance test: the operator's own prompt

Prompt (verbatim): "take all assets under every workspace and make sure they are registered data sources or registered artifacts in the Purview associated with Loom, and make sure the scans are set up and configured for them."

Pass condition, all required, executed in a real browser session on the estate by a tenant admin with at least three workspaces (one owned, one ACL-shared, one app-installed) and mixed item types (lakehouse, warehouse, kql-database, eventstream, data-pipeline, notebook, report):
1. Copilot calls `governance_inventory` (not `item_list` alone) and pages until `truncated:false`; the final answer's total equals the count from a direct Cosmos cross-partition count for the tenant (the independent control).
2. Copilot shows the `governance_enroll` plan (sources to register, scans to create, estimated runs against the cap) and asks for confirmation.
3. After confirmation: every S item has a Purview source and scan named per `purviewName`; every A/E item has an Atlas entity; every binding shows `scanned` only with a `Completed` run and a non-zero asset count (or an explicit `completed-empty`/`skipped: paused` reason).
4. The assistant's final message reports counts by status and lists exceptions with their error class and remediation; it never claims "all scanned" while any binding is not `scanned`.
5. Second run of the same prompt is a no-op (idempotency): `governance_enroll` plan shows zero changes.
6. A non-admin user running the same prompt gets only their accessible workspaces and a clear statement that tenant scope needs an admin.

Value that would break each load-bearing assertion (assertion-design.md): (1) fails if `workspace_list` still returns only owned workspaces or the manifest is cut mid-page; (3) fails if the binding status is set from the PUT response instead of the run read-back (fixture: a scan whose run ends `Failed` must leave the binding not-scanned); (5) fails if enroll re-creates objects (fixture counts PUT calls and asserts zero on the second run); (6) fails if the sweep identity's visibility leaks into a user-scoped tool (fixture user with one ACL-shared workspace must not see a third workspace).

### 7.2 Unit and integration tests (assertion-design rules)

Every new test names the failing input in a comment or message. Required fixtures and the value that breaks them:

| Assertion | Input that makes it fail |
|---|---|
| `purviewName` keeps original in `nameMap` | a name with a space and 70 chars must produce a <=63-char hyphen/underscore name; fails if sanitization drops the map |
| Dedupe keyed by `backingResourceId` | two items with different casing of the same resource id must resolve to one binding (ARM ids are case-insensitive); fails if keyed on the raw string |
| Paused skip | a snapshot with `ADX=Stopped` must cause zero `upsertScan` and zero `triggerScanRun` calls; fails if the pause check runs after the first call |
| Retry exhaustion | a 503 on every call must end `failed` after exactly 3 attempts with class `transient-exhausted`; fails if the loop is unbounded or swallows the final error |
| Label never downgrades | existing human label Highly Confidential and a policy match for Confidential must leave Highly Confidential |
| Tenant isolation | two tenants with the same workspace display name must never share a collection or a binding |
| Tool pagination | 501 rows with `pageSize=500` must return `nextCursor` non-null and `truncated:true` |
| Rate limit | the 11th `governance_enroll` within the window must be refused with a retry-after |

Absence-only assertions (for example "no mock data returned") are paired with a positive one (the real client was called with the expected URL), per `assertion-design.md` item 4.

**Mutation evidence (required for W2, W4, W6, W7)**: in a **sandbox copy** of the worktree (not the tracked tree), apply at least these mutations and show RED then green: (a) remove the paused check; (b) mark `scanned` on PUT success; (c) key dedupe on the raw resource id; (d) remove the `confirm` requirement from `governance_enroll`; (e) let the label policy overwrite a human label. Report for each whether the arm was killed by the intended test (a green mutation is reported as blind test, weak mutation, or equivalent mutant, never rounded off). Use `git hash-object` before and after if anything is done in place; prefer the copy.

### 7.3 End-to-end receipts

- **Clean create (greenfield)**: create a lakehouse in a new workspace on a fresh estate. Receipt: item created; backing ADLS container created; **no further call**; within the bounded window the Purview source exists with the Loom name, the scan exists and its first run is `Completed`; assets and at least one classification appear under the workspace collection; a label from the policy is applied where a rule matches; the editor shows the Governance chip as registered, scanned, classified, labeled. With `LOOM_DEFAULT_FABRIC_WORKSPACE` **unset** (`no-fabric-dependency.md`).
- **Brownfield**: against an estate with a pre-existing Purview account that already has the storage source registered under a different name and one customer scan: the discover step lists it; the operator picks reuse; GES adopts the existing source (no second registration, no rename), leaves the customer scan untouched, and adds a Loom scan only for the uncovered workspace scope. Receipt shows `purviewSourceAdopted=true` and zero duplicate sources by `backingResourceId`.
- **Self-heal**: delete the scan and the source in Purview directly; after the next reconcile both exist again with the same names.
- **Paused**: pause ADX through the PRP-02 mechanism; reconcile reports `skipped: paused` with the Resume action; resume; the next sweep scans.
- **Browser G1 walk**: every control on the new admin page and the per-item tab exercised with real data, dark and light, narrow width, fresh-item first-open with no error banners.

### 7.4 Per-cloud receipts

| Cloud | Receipt required | Source |
|---|---|---|
| Commercial | 7.1 and 7.3 live on the estate; the roll is verified live from `/build-marker.txt` (merged is not done) | Browser walk + minted-session probes |
| GCC-High | Actions-run receipt: reconcile job executes, a scan is created and `Completed` on a Gov storage account, labeling path is Loom-native, audience works; dispatched through the existing Gov workflow identity | GitHub Actions run id recorded in the closing comment |
| IL5 | Actions-run receipt if the lane exists; **`deploy-fiab-il5.yml` is active with no recorded run** (`cloud-parity.md`), so IL5 stays "supported-in-code, never exercised" until it has one; do not list it as exercised | |
| DoD | Same treatment as IL5 unless a lane exists (existence **UNVERIFIED**) | |
| GCC | Supported-in-code only; no receipt, no claim | `cloud-parity.md` decision of 2026-09-03 |

Gov receipts never come from local `az` or a workstation token.

## 8. Risks and unknowns

| # | Risk / unknown | Likelihood x impact | Mitigation / how W0 resolves it |
|---|---|---|---|
| R1 | **Scan cost surprise** from default-on scanning across the whole estate (rate not verified in this PRP) | Med x High | Cost guard + caps + dry-run plan with estimate; D1 default-on is conditional on W0 cost measurement; first backfill staggered |
| R2 | **Purview MSI roles cannot be granted for brownfield or cross-subscription sources** by the Loom deploy identity | High x Med | Readiness validation names the exact missing role; in-product Fix-it executes when the operator identity allows; documented in brownfield walkthrough |
| R3 | **Private-endpoint-only storage** needs a self-hosted/managed-VNet IR; managed VNet IR availability and Gov behaviour unverified | Med x High | Reuse existing SHIR VMSS and managed-VNet functions; W0 tests one private account per cloud; failure class `network` with exact remediation |
| R4 | **Gov audience and IL5/DoD Purview availability are unverified** (code uses one commercial-style audience; Learn page is dated 2025-10 and classic) | Med x High | W0 Actions probe; `CatalogBackend` abstraction + native scanner so a gap becomes a Loom feature, not a hole (D7) |
| R5 | **Delta tables** are seen by Purview as Parquet resource sets without partition columns | High x Low | GES writes the Delta-table-level Atlas entity from the Loom table catalog; documented in the parity doc |
| R6 | **Tenant isolation**: shared Purview account, account-global classification typedefs, broader Purview roles than Loom ACLs | Med x High | Tenant-namespaced typedefs (exists), collection per workspace, no Purview-RBAC mirroring claim, review on W5/W6; do not widen the private lakehouse-isolation advisory |
| R7 | Reconcile storms: sweep plus inline create hooks plus Copilot calls racing | Med x Med | Per-binding lease via etag, batch cursor, caps |
| R8 | Purview throttling/429 and scan concurrency limits (numeric limits not verified here) | Med x Med | Backoff, queue, concurrency cap default 2; limits read in W0 |
| R9 | Bicep lane collisions with spark-identity, apim, drain | High x Med | Section 6.3 rules; W3 small and isolated |
| R10 | Copilot write tools abused by prompt injection or scope escalation | Low x High | Scope only from validated args + session, two-step confirm, rate limits, audit, tenant-admin-only for `all` |
| R11 | `item-crud.ts` hook adds latency or failures to item create | Med x Med | Inline budget 8 s pattern, never throws, enqueue-and-return |
| R12 | `purview-client.ts` is 2,922 lines; additive-only discipline needed | Med x Low | Additive functions; no signature changes |
| R13 | Label semantics: Purview Data Map labels are metadata-only, preview, and need E5; users may assume files are protected | Med x Med | UI wording states metadata-only; D5 default Loom-native |
| R14 | Group-based admins not resolved in Copilot tool context (3.5) | Med x Med | W7 passes resolved capabilities into `ToolContext` or documents the limit and uses the session path |

Facts not verified in this PRP (all assigned to W0): live Purview state and quotas; per-cloud audience; IL5/DoD Purview availability; per-type `state` backing keys; Synapse grant mechanism; scan cost rate; run verb; whether `purview`/`svc-purview-uc` gates probe reachability; whether any Azure Policy exclusion exists; scope of existing Console UAMI Data Map grants; whether a DoD param file exists; notebook/semantic-model/report lineage emission; nav registration path.

## 9. Rollback

- **Feature flags**: `LOOM_GOVERNANCE_AUTOPILOT` (master, default on after D1) and finer flags `LOOM_GOVERNANCE_SWEEP`, `LOOM_GOVERNANCE_AUTOSCAN`, `LOOM_GOVERNANCE_AUTOLABEL`, `LOOM_GOVERNANCE_COPILOT_WRITE_TOOLS`. Turning off a flag stops new actions; existing Purview objects are left in place (nothing is deleted on rollback).
- **Staged rollout**: W1 and read tools first; sweep in report-only mode (plan, no writes) for one cycle on Commercial and compare to expectations; then register-only; then scans; then labels last.
- **Bicep**: the new modules are additive role assignments and one job; revert = remove the module invocation. Role assignments are idempotent and safe to leave. No schema change to existing containers (new container `governance-bindings` only).
- **Data**: bindings are derived state and can be deleted and rebuilt by the sweep; item `state.governance` is a projection. Purview objects created by GES carry the tag `loom.managed=true`, so a cleanup script can list exactly what Loom created. Cleanup is never automatic and is a destructive action requiring operator approval.
- **Scan cost runaway**: the daily cap plus a kill switch (`LOOM_GOVERNANCE_AUTOSCAN=false`) stops new runs; running scans can be cancelled only from `In Progress` per Learn.

## 10. Scan cost estimate

Purview Data Map scanning is billed by scan compute; **the unit rate is not verified in this PRP** (Microsoft pricing page not fetched; UNVERIFIED). The estimate therefore is a formula plus a W0 measurement, not a number:

cost per month = sum over sources of (full scans x full-scan vCore-hours + incremental scans x incremental vCore-hours) x unit rate

Drivers Loom controls: number of sources (dedupe keeps this to one per backing account), scan scope (workspace-owned paths, ignore patterns for Spark/Delta log files), ruleset stability (changing a ruleset forces a full scan), schedule (weekly incremental default), caps (concurrency 2, daily full-scan cap). W0 reads the last 30 days of the Purview account cost and the existing scan history to derive a per-source vCore-hour baseline; the admin UI shows the projected monthly cost beside the schedule editor and the `governance_enroll` plan shows run counts against the cap. Default-on remains conditional on that number being within the operator's threshold (D1, D6).

## 11. Decisions needed (operator)

Each has a recommended default; execution proceeds on the default if not answered, except where marked **blocks**.

| # | Decision | Recommended default | Options |
|---|---|---|---|
| D1 | Turn automatic scanning on by default (flip `LOOM_PURVIEW_AUTOSCAN` semantics to on)? This is a cost-material change | **On**, with caps (concurrency 2, daily full-scan cap), after W0 cost number is within a threshold you set | (a) on by default with caps; (b) register + classify-from-metadata only, scans opt-in per workspace; (c) off, manual |
| D2 | Label automation level | Auto-apply policy labels up to Confidential, suggest Highly Confidential for one-click approval; never downgrade human labels | (a) as recommended; (b) auto-apply all; (c) suggest only |
| D3 | Cadences | Reconcile sweep every 6 h; scan schedule weekly incremental, off-peak; first scan full | sweep 1 h / 6 h / 24 h; scans daily / weekly / monthly |
| D4 | Priority position in the run order | **Third**, after estate power and the canvas PRP, ahead of per-workspace Spark identity. Waves W0-W2, W4, W6-W8 are not bicep and can start in parallel with others; the bicep waves are sequenced (6.3) | 2nd (ahead of canvas minimap); 3rd (recommended); after spark-identity |
| D5 | Purview-native auto-labeling in Commercial | Off; Loom-native labeling everywhere (no M365 E5/PAYG requirement, works in Gov) | (a) Loom-native only; (b) offer Purview-native as an opt-in additive path; (c) Purview-native primary where available |
| D6 | Behaviour when the source's compute is paused | Skip with visible reason; never auto-resume | (a) skip (recommended); (b) offer a one-click "Resume and scan"; (c) auto-resume within budget |
| D7 | Native Loom scanner for boundaries without Data Map scanning (IL5 `atlas-aks`, DoD) | Build it in this program (W5), bounded pattern subset, disclosed as such | (a) build now; (b) file as dated Gov follow-up with owner (cloud-parity requires a dated owner); (c) require Purview in those boundaries |
| D8 | Item delete behaviour | Keep Purview assets, mark `loom.retired=true`, deregister a shared source only when no item references it and after a 30-day retention | (a) as recommended; (b) delete assets immediately; (c) never deregister |
| D9 | Event Hubs (not a Data Map scan source) | Atlas entity + lineage only, no scan | add a Loom-side schema sampler later |
| D10 | Cross-workspace visibility for tenant admins in Copilot | Tenant admin may use `scope:'tenant'`; everyone else sees accessible workspaces only; all tenant-scope calls audited | (a) as recommended; (b) per-workspace consent |
| D11 | Reconcile host | Container App Job calling the BFF internal route | Azure Function; scheduler JobKind inside the BFF only |

### 11.1 Decisions recorded by the operator (2026-10-16)

Answered through the planning session; all four took the recommended default.

| # | Decision | Answer |
|---|---|---|
| D1 | Automatic scanning by default | **On by default, with caps** (concurrency and a daily full-scan cap). Real enablement waits on W0 measuring the Purview scan cost. |
| D2 | Label automation level | **Auto-apply up to Confidential; suggest above** for one-click approval; never downgrade a human label. |
| D4 | Priority position | **Third** in the run order, as written in MASTER-INDEX.md. |
| D10 | Copilot scope | **Tenant admins get tenant-wide scope** (`scope:'tenant'`); everyone else limited to workspaces they can access; every tenant-scope call audited. |

D3, D5, D6, D7, D8, D9 and D11 are NOT yet answered: execution proceeds on the recommended default in the table above unless the operator says otherwise before the wave that depends on it starts.

## 12. Done

This PRP is done when all of the following hold, on **deployed-and-verified** receipts and never on merge alone (`deploy-integrity.md` R2; report anything merged but not rolled as "merged, not deployed"):
1. The operator prompt in 7.1 passes live on the Commercial estate, with receipts attached to the tracking issue.
2. Clean-create, self-heal, paused-skip and brownfield E2Es in 7.3 pass live.
3. The GCC-High Actions receipt in 7.4 exists with a run id; IL5, DoD and GCC are explicitly stated as exercised or not.
4. W3 permissions are deployed by bicep/bootstrap in every supported boundary and the read-back script passes.
5. Admin page and per-item chip pass the G1 browser walk; parity doc shows zero missing rows.
6. Mutation evidence for W2, W4, W6, W7 is attached and the tracked tree is proven untouched.
7. Docs carry the greenfield and brownfield walkthroughs and agree with the wizard.
8. Any leftover becomes a filed issue, not conversation. Close the tracking issue only after items 1-7.

## 13. References

Repo (files cited above), memory references: the guards-that-do-not-watch index, the estate pause/resume mandate, instruments-that-lie notes. Microsoft Learn: see section 4. Rules: `.claude/rules/*.md` as listed in the header. Sibling PRPs: `PRPs/active/per-workspace-spark-identity/PRP.md`, `PRPs/active/apim-ai-gateway/PRP.md`, `PRPs/active/finish-2026-10/PRP-02-estate-power.md` (operator-local, untracked).
