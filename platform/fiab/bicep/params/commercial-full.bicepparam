// CSA Loom — Commercial full push-button deploy (everything enabled)
// Generated for the iterate-until-green session. Uses real Loom Admins
// group + flips every service flag on.

using '../main.bicep'

param environment = 'AzureCloud'
param location = 'eastus2'
param boundary = 'Commercial'
param deploymentMode = 'single-sub'
// audit-t157: tenant = first-run install (deploys the hub + DLZ). Add-landing-zone uses dlz-attach via the orchestrator, never this param file.
param topology = 'tenant'

// Compute
param containerPlatform = 'containerApps'
param functionsHostSku = 'FlexConsumption'
param apimSku = 'PremiumV2'

// Catalog
param catalogPrimary = 'unity-catalog-managed'

// AI orchestration
param agentOrchestrator = 'foundry-agent-service'
param foundryPortalEnabled = true

// Capacity sizing
param capacitySku = 'F8'

// Databricks feature flags
param databricksUnityCatalogEnabled = true
param databricksSqlWarehouseEnabled = true
// Databricks ACCOUNT id (GUID) — configures Unity Catalog by default (metastore +
// default catalog + Console-UAMI account_admin). Requires the Console UAMI to be a
// Databricks account admin (one-time) — docs/fiab/catalog/metastores.md.
// Sourced from LOOM_DATABRICKS_ACCOUNT_ID so a stock deploy with it set configures
// UC with no param-file edit. Unset = UC enabled later via the bootstrap workflow.
param databricksAccountId = readEnvironmentVariable('LOOM_DATABRICKS_ACCOUNT_ID', '')

// Security
param defenderForAIEnabled = true
// Unified Catalog + Enterprise Purview reuse:
//   The /catalog surface federates Purview + UC + OneLake and the
//   /admin/security Purview tab calls REAL endpoints.
//   Governance deploy-readiness (#229): Purview is now ON BY DEFAULT (opt-out).
//   A clean commercial-full deploy provisions + wires + PE-protects a NEW classic
//   Data Map account so /governance works on first login with no manual step.
//   Opt OUT with LOOM_PURVIEW_ENABLED=false. REUSE an existing account instead by
//   setting LOOM_PURVIEW_ACCOUNT to its short name (reuse takes precedence over
//   provisioning). LOOM_PURVIEW_LOCATION pins the account to a known-Purview
//   region when the hub region lacks capacity (empty = hub location).
param purviewEnabled = bool(readEnvironmentVariable('LOOM_PURVIEW_ENABLED', 'true'))
// Empty default = use the freshly provisioned account. Set LOOM_PURVIEW_ACCOUNT
// to a short account name to REUSE an existing Purview instead.
param loomPurviewAccount = readEnvironmentVariable('LOOM_PURVIEW_ACCOUNT', '')
param purviewLocation = readEnvironmentVariable('LOOM_PURVIEW_LOCATION', '')
// Information Protection + DLP — wired day-one. The post-deploy bootstrap
// grants the Console UAMI the Graph AppRoles (the appRoleAssignment to the MI
// IS the grant — no separate interactive admin-consent step is needed). Both
// default ON so LOOM_MIP_ENABLED + LOOM_DLP_ENABLED reach the Console out of
// the box; until the AppRoles land (deploy SP needs AppRoleAssignment.ReadWrite.All
// — see docs/fiab/v3-tenant-bootstrap.md) the tabs render the honest 503 gate,
// never an empty stub. Override with LOOM_MIP_ENABLED=false to suppress.
param loomMipEnabled = bool(readEnvironmentVariable('LOOM_MIP_ENABLED', 'true'))
// DLP defaults ON: the bootstrap grants the DLP AppRoles by default, so the
// DLP tab is wired out of the box. Override with LOOM_DLP_ENABLED=false to gate it.
param loomDlpEnabled = bool(readEnvironmentVariable('LOOM_DLP_ENABLED', 'true'))
// DLP policy CRUD via the SCC PowerShell sidecar — opt-in (Graph has no DLP
// write API). Off until the SCC app + cert are bootstrapped; reads/alerts/
// restrict-access work regardless.
param loomDlpAdminEnabled = bool(readEnvironmentVariable('LOOM_DLP_ADMIN_ENABLED', 'false'))
param loomIdentityPickerEnabled = bool(readEnvironmentVariable('LOOM_IDENTITY_PICKER_ENABLED', 'false'))
param loomDomainGroupProvisioningEnabled = bool(readEnvironmentVariable('LOOM_DOMAIN_GROUP_PROVISIONING', 'false'))
// Headless CI Bearer-token path on the deployment-pipeline routes (Azure DevOps /
// GitHub Actions task — Fabric fabric-devops-pipelines parity). Off by default;
// set LOOM_PIPELINE_CI_ENABLED=true to let the CSA Loom DevOps task drive deploys.
param loomPipelineCiEnabled = bool(readEnvironmentVariable('LOOM_PIPELINE_CI_ENABLED', 'false'))
param storageRequireCmk = false
param keyVaultHsmIsolated = false
param atlasOnAksEnabled = false

// OpenAI
param openaiLocation = 'eastus2'
param openaiEmbeddingsLocation = 'eastus2'
param openaiChatModel = 'gpt-4o'
param openaiEmbeddingsModel = 'text-embedding-3-large'

// Power BI
param powerBiSku = 'F64'

// Analytics report embed (F21 Usage "Open analytics" + F2 Govern "View more").
// Commercial → Power BI. Default the KIND so /admin/usage + Govern surface the
// embedded-report path out of the box; the BFF honestly gates (503 with the
// exact follow-up) until the workspace/report ids + Console-UAMI membership +
// the "Service principals can use Power BI APIs" tenant setting are supplied
// (post-deploy admin actions — docs/fiab/v3-tenant-bootstrap.md#usage-analytics-embed).
// The native Fluent usage/governance charts always work without these.
// Day-one default is EMPTY → main.bicep falls through to the Azure-native
// Managed Grafana embed (managedGrafanaEnabled + pbiEmbeddedEnabled=false),
// pointing the Govern (F2) + Usage (F21) embeds at the stable dashboards
// (loom-governance / loom-usage) the post-deploy bootstrap creates. This closes
// the two self-audit warnings out of the box WITHOUT a Power BI tenant. Set
// LOOM_REPORT_KIND/LOOM_USAGE_REPORT_KIND=powerbi (+ the workspace/report ids)
// to opt into the Power BI Embedded path instead.
param loomUsageReportKind     = readEnvironmentVariable('LOOM_USAGE_REPORT_KIND', '')
param loomUsagePbiWorkspaceId = readEnvironmentVariable('LOOM_USAGE_PBI_WORKSPACE_ID', '')
param loomUsagePbiReportId    = readEnvironmentVariable('LOOM_USAGE_PBI_REPORT_ID', '')
param loomReportKind          = readEnvironmentVariable('LOOM_REPORT_KIND', '')
param loomGovernPbiWorkspaceId = readEnvironmentVariable('LOOM_GOVERN_PBI_WORKSPACE_ID', '')
param loomGovernPbiReportId    = readEnvironmentVariable('LOOM_GOVERN_PBI_REPORT_ID', '')
// Opt-in dedicated Power BI Embedded (A1) capacity for the embed token path.
// Off by default — the reports can also live on the F64 capacity above.
param pbiEmbeddedEnabled       = bool(readEnvironmentVariable('LOOM_PBI_EMBEDDED_ENABLED', 'false'))

// =====================================================================
// Microsoft MCP servers + agent skills (curated github.com/microsoft/mcp +
// github.com/microsoft/skills) — EXTENDS the Power BI MCP plumbing above; it is
// NOT a parallel system. The remote built-ins reuse the same RemoteBuiltinMcp
// shape (lib/mcp/catalog.ts → REMOTE_BUILTIN_MCP_CATALOG), the same per-user
// auth paths (lib/azure/mcp-client.ts: 'entra-obo' / 'key-vault' / no-auth
// 'none'), and the same admin connect/status/?probe=1 BFF contract the Power BI
// route established. Each entry carries an honest Fluent gate (no-vaporware):
// until it is enabled AND configured its admin card names the EXACT env / KV
// secret / consent it needs, and ?probe=1 runs a REAL initialize→tools/list
// handshake — no stub.
//
// no-fabric-dependency: Microsoft Learn (no-auth, Microsoft-hosted, GA) is the
// SOLE default-ON remote MCP. Every other Microsoft server is strictly opt-in
// and OFF by default; Microsoft Fabric + Fabric RTI are explicit Fabric-family
// opt-ins (govSafe:false, never on a default path — api.fabric.microsoft.com is
// reached ONLY when that server is explicitly enabled). No api.fabric /
// api.powerbi host is ever touched on a default path.
//
// All toggles below are READ AT RUNTIME from these env vars (no .bicepparam
// edit needed) and fold into the admin-plane loomBackends.mcp sub-object — the
// same single-object trick the Azure-native backend selectors use to stay under
// the ARM 256-parameter limit, so no new top-level scalar param is added here.
//
//   Microsoft Learn (DEFAULT ON — Reference; no auth, zero config, live day-one)
//     LOOM_MS_LEARN_MCP_ENABLED   default 'true'  (set 'false' to disable; IL5
//                                 air-gap sets 'false' — learn.microsoft.com is
//                                 external egress, see il5.bicepparam)
//     LOOM_MS_LEARN_MCP_ENDPOINT  default https://learn.microsoft.com/api/mcp
//                                 (override e.g. to add ?maxTokenBudget=2000)
//
//   Entra On-Behalf-Of opt-ins (DEFAULT OFF) — each REUSES the existing Loom
//   confidential client (LOOM_MSAL_CLIENT_ID + the loom-msal-client-secret KV
//   secret) for the per-user OBO exchange; NO new secret literal is introduced.
//   Set _ENABLED='true' (+ _ENDPOINT where the endpoint is not yet GA):
//     LOOM_AZURE_ARM_MCP_ENABLED / _ENDPOINT     OBO https://management.azure.com/user_impersonation (self-host Azure MCP w/ OBO)
//     LOOM_FOUNDRY_MCP_ENABLED                   https://mcp.ai.azure.com — OBO https://ai.azure.com/.default (preview)
//     LOOM_MS_GRAPH_MCP_ENABLED                  https://mcp.svc.cloud.microsoft/enterprise — OBO https://graph.microsoft.com/.default (needs MCP.* delegated Graph perms + admin consent; read-only, preview)
//     LOOM_SENTINEL_MCP_ENABLED                  https://sentinel.microsoft.com/mcp/data-exploration — OBO https://sentinel.microsoft.com/.default (Security Reader+, preview)
//     LOOM_M365_MCP_ENABLED / _ENDPOINT          OBO https://graph.microsoft.com/.default — endpoint not yet GA, supply it (preview)
//     LOOM_TEAMS_MCP_ENABLED / _ENDPOINT         OBO https://graph.microsoft.com/.default — endpoint not yet GA, supply it (preview)
//     LOOM_ONEDRIVE_SHAREPOINT_MCP_ENABLED / _ENDPOINT   OBO https://graph.microsoft.com/.default — endpoint not yet GA, supply it (preview)
//     LOOM_ADMIN_CENTER_MCP_ENABLED / _ENDPOINT  OBO https://graph.microsoft.com/.default — endpoint not yet GA, supply it (preview)
//     LOOM_DATAVERSE_MCP_ENABLED / _ENDPOINT     per-org https://<org>.crm.dynamics.com/api/mcp — OBO <org>/.default; also enable the Dataverse MCP tenant setting in the Power Platform admin center (preview)
//
//   GitHub (DEFAULT OFF) — GitHub OAuth / PAT, NOT Entra (no OBO). Supply the
//   PAT via Key Vault secretRef ONLY — never a literal:
//     LOOM_GITHUB_MCP_ENABLED
//     LOOM_GITHUB_MCP_PAT_SECRET  = the Key Vault SECRET NAME holding the PAT
//                                   (sent as Authorization: Bearer <PAT>)
//     LOOM_GITHUB_MCP_ENDPOINT    default https://api.githubcopilot.com/mcp
//                                   (override for GitHub Enterprise)
//
//   Deployable Microsoft servers (Azure MCP, Microsoft SQL, Dataverse, Azure
//   DevOps, AKS, Markitdown, NuGet, Playwright) surface automatically in the
//   existing MCP catalog browser, hosted stdio→Container Apps; where no
//   first-party PUBLIC container image exists yet they carry an honest
//   IMAGE_REF gate (no-vaporware). Microsoft Fabric + Fabric RTI are present
//   ONLY as explicit Fabric-family opt-ins, never recommended/default.
//
//   The ~30 agent skills (lib/copilot/ms-skills.ts, attributed to
//   github.com/microsoft/skills) are Azure-native by default and bind to the
//   relevant MS MCP tool prefix only once that server is connected — they need
//   no bicep toggle. See docs/fiab/parity for the per-server inventory.
// =====================================================================

// Network
param hubVnetCidr = '10.0.0.0/16'

// Identity — Loom Admins group (object id). Required: supply via env.
param adminEntraGroupId = readEnvironmentVariable('LOOM_ADMIN_ENTRA_GROUP_ID', '')

// Feature-Permissions bootstrap admin — members can open /admin/* before any
// grants exist. Defaults to the Loom Admins group above (so members bypass the
// gate with full Admin). Also set LOOM_TENANT_ADMIN_OID to a specific user OID
// for a reliable single-user bootstrap (group-claim emission can be disabled in
// the tenant, in which case the OID match is what unblocks /admin/permissions).
param loomTenantAdminGroupId = readEnvironmentVariable('LOOM_TENANT_ADMIN_GROUP_ID', adminEntraGroupId)
param loomTenantAdminOid = readEnvironmentVariable('LOOM_TENANT_ADMIN_OID', '')

// Loom version + image tags — preserves currently deployed images
param loomVersion = readEnvironmentVariable('LOOM_VERSION', 'v2.1')
param appImageTags = {
  console: readEnvironmentVariable('LOOM_CONSOLE_TAG', 'v2.1')
  mcp: readEnvironmentVariable('LOOM_MCP_TAG', 'v0.7')
  orchestrator: readEnvironmentVariable('LOOM_ORCHESTRATOR_TAG', 'v0.7')
  activator: readEnvironmentVariable('LOOM_ACTIVATOR_TAG', 'v0.7')
  mirroring: readEnvironmentVariable('LOOM_MIRRORING_TAG', 'v0.7')
  directLake: readEnvironmentVariable('LOOM_DIRECTLAKE_TAG', 'v0.7')
  // ── THESE KEYS MUST BE PRESENT (measured 2026-08-06, FINISHLINE L-GOV) ──────
  // A .bicepparam object assignment REPLACES the template default, it does not
  // merge — and main.bicep forwards this bag to admin-plane VERBATIM (no union).
  // admin-plane/main.bicep reads these five with a PLAIN `.` (no `.?`):
  //   mcpBridge  — inside the UNCONDITIONAL `apps` array literal
  //   maf / setupOrchestrator / scriptRunner / wrangler — module call sites
  // The compiled artifact proves it:
  //   /resources/adminPlane/.../resources/appDeployments
  //     condition: containerPlatform=='containerApps' && deployAppsEnabled  (BOTH true here)
  //     .../apps/value[2]/image:
  //       "[format('loom-mcp-bridge:{0}', parameters('appImageTags').mcpBridge)]"
  // so an ARM deploy with this file aborts on "property 'mcpBridge' doesn't
  // exist" before touching a resource. main.bicep's own default carries all five
  // with a comment recording this exact failure; this file dropped them.
  //
  // WHY IT WENT UNNOTICED: the live Commercial lane (deploy-fiab-commercial.yml)
  // uses params/commercial.bicepparam, which does NOT assign appImageTags and so
  // inherits the complete default. THIS file is the one no-vaporware.md names as
  // the canonical FROM-SCRATCH path ("-p params/commercial-full.bicepparam"), so
  // the greenfield acceptance run was the path that could not work.
  // Guarded by scripts/ci/check-appimagetags-coverage.mjs.
  mcpBridge: readEnvironmentVariable('LOOM_MCP_BRIDGE_TAG', 'v0.1')
  setupOrchestrator: readEnvironmentVariable('LOOM_SETUP_ORCHESTRATOR_TAG', 'v0.1')
  maf: readEnvironmentVariable('LOOM_MAF_TAG', 'v0.1')
  scriptRunner: readEnvironmentVariable('LOOM_SCRIPT_RUNNER_TAG', 'v0.1')
  wrangler: readEnvironmentVariable('LOOM_WRANGLER_TAG', 'v0.1')
  // loom-duckdb — the N2b/N3 DuckDB serving tier admin-plane/main.bicep now
  // deploys BY DEFAULT. Same value the module's `?? 'v0.1'` fallback already
  // produced (so this is a no-op against the live estate), stated explicitly so
  // the tag contract is visible on the same page as the other images:
  //   producer .github/workflows/full-app-deploy-commercial.yml
  //            `tag` input, default v0.1 -> build matrix stamps loom-duckdb:v0.1
  //   template <acr>/loom-duckdb:v0.1
  duckdb: readEnvironmentVariable('LOOM_DUCKDB_TAG', 'v0.1')
  // DEFAULT-ON data-plane tier (2026-07-28). Explicit rather than relying on the
  // template's `?? 'v0.1'` fallback, so the tag is operator-settable here the
  // same way it is in gcc-high / il5. v0.1 matches what
  // full-app-deploy-commercial.yml and build-fiab-images-acr-tasks.yml push by
  // default; both images must exist in ACR before an apps-enabled deploy.
  loomMigrate: readEnvironmentVariable('LOOM_MIGRATE_TAG', 'v0.1')
  risingwave: readEnvironmentVariable('LOOM_RISINGWAVE_TAG', 'v0.1')
  // loom-unity (#2681) — the Unity-Catalog-compatible OSS metastore.
  // admin-plane/main.bicep now deploys it DEFAULT-ON on every boundary (it was
  // an out-of-band standalone entrypoint before), so this image is a hard
  // prerequisite of the apps phase — a missing manifest fails the Container App
  // PUT with MANIFEST_UNKNOWN, not just the feature.
  unity: readEnvironmentVariable('LOOM_UNITY_TAG', 'v0.1')
  // loom-trino (N7e) — the DEFAULT-ON Federated SQL engine behind SQL Lab's
  // "Federated SQL (Trino)". Stated explicitly (same value the template's
  // `appImageTags.?trino ?? 'v0.1'` fallback already produced, so this is a
  // no-op against the live estate) so the tag is operator-settable HERE the
  // same way it is in gcc-high / il5 — per .claude/rules/cloud-parity.md the
  // per-cloud levers must match, not just the per-cloud behaviour.
  //   producer .github/workflows/full-app-deploy-commercial.yml -> loom-trino:v0.1
  trino: readEnvironmentVariable('LOOM_TRINO_TAG', 'v0.1')
}

// MSAL — the app registration + client secret are now PROVISIONED by default
// (loomMsalAppReg.enabled=true → entra-app-registration.bicep / the post-deploy
// bootstrap, GH #1383). Pass LOOM_MSAL_CLIENT_ID only to BYO an existing app
// registration; empty lets the deploy provision a fresh one (no hardcoded
// shared app id — each deployment gets its own, with redirect URIs reconciled
// to its own console host).
param loomMsalClientId = readEnvironmentVariable('LOOM_MSAL_CLIENT_ID', '')
param loomMsalClientSecret = readEnvironmentVariable('LOOM_MSAL_CLIENT_SECRET', '')
// Stable session secret — pass via env to preserve sign-ins; empty → admin-plane
// derives a stable per-RG GUID (newGuid() is invalid in a .bicepparam, BCP065).
param loomSessionSecret = readEnvironmentVariable('LOOM_SESSION_SECRET', '')

// Multi-sub mode (empty for single-sub)
param dlzSubscriptionIds = []
param dlzDomainNames = []

// Feature flags — ALL ON for full push-button deploy
// AI Search currently OFF — eastus2 capacity exhausted (InsufficientResourcesAvailable).
// Re-enable in next iteration when capacity refreshes OR switch region.
param deployAppsEnabled = true
param aiFoundryEnabled = true
// Azure AI Content Safety — copilot persona moderation (Prompt Shields + harm
// analyze). Available in Commercial; wires LOOM_CONTENT_SAFETY_ENDPOINT.
param contentSafetyEnabled = true
// Agent Foundry — provisions the dedicated AIServices account (aifndry-loom-eastus2)
// with the loom-agents project + chat (gpt-4.1-mini) + text-embedding-ada-002
// deployments and wires LOOM_AOAI_* / LOOM_FOUNDRY_PROJECT_*. This is what makes
// AI Functions (POST /api/ai-functions), Copilot, and the data-agent test-chat
// return real completions on a clean deploy instead of the 501 not_configured gate.
param agentFoundryEnabled = true
param apimEnabled = true
param hubFirewallEnabled = true
// AI Search — day-one default ON (audit gap-closure). Clears the AI Search /
// reindex / data-product-search / help-copilot / synonym-maps surfaces so they
// resolve without a "set LOOM_AI_SEARCH_SERVICE" setup gate. Set false to opt out.
param aiSearchEnabled = true
param adxEnabled = true
// RTI (Real-Time Intelligence) backends — Event Hubs + Stream Analytics. ON by
// default (opt-out); set the env var to 'false' to skip the cost. Event Hubs
// backs the Eventstream sources + Data Explorer receive; Stream Analytics backs
// the stream-analytics-job editor + the Eventstream transform node. To REUSE an
// existing Event Hubs namespace / ASA job, set the EXISTING_* vars in the BYO block.
param loomEventHubEnabled = bool(readEnvironmentVariable('LOOM_EVENTHUB_ENABLED', 'true'))
param loomStreamAnalyticsEnabled = bool(readEnvironmentVariable('LOOM_STREAM_ANALYTICS_ENABLED', 'true'))
// Setup Orchestrator — on by default so the Setup Wizard's Deploy submits the
// real subscription-scoped ARM deployment and the Console UAMI is granted
// Contributor on the target sub(s). Set LOOM_SETUP_TEMPLATE_URI to the published
// main.json templateLink; empty = the orchestrator honestly fails Deploy with the
// publish remediation rather than faking success.
param setupOrchestratorEnabled = bool(readEnvironmentVariable('LOOM_SETUP_ORCHESTRATOR_ENABLED', 'true'))
param setupTemplateUri = readEnvironmentVariable('LOOM_SETUP_TEMPLATE_URI', '')
// Cosmos Gremlin (graph editor) + NoSQL vector accounts. Default on so the
// cosmos-gremlin-graph + vector-store editors work on a clean full deploy —
// the Gremlin capability is fixed at account-creation, so the default NoSQL
// account can't back the graph editor.
param cosmosGraphVectorEnabled = true
// Org-visuals (Embed codes F22 + Organizational visuals F23) — ON by default
// (opt-out). Wires the Console UAMI org-visuals container grant + Storage Blob
// Delegator + LOOM_ORG_VISUALS_URL. Set false to honest-gate those panes; the
// medallion lake is unaffected. Azure Blob only — no Fabric/Power BI dependency.
param loomOrgVisualsEnabled = true
param vpnGatewayEnabled = true
param appGatewayEnabled = true
// Azure ML workspace — backs the notebook "Azure ML" compute path (Compute
// Instances + datastores + Command-job cell runs). The deploy-planner
// ml-workspace.bicep module provisions an AML workspace + its KV/Storage/
// AppInsights deps and grants the Console UAMI AzureML Data Scientist, which
// surfaces LOOM_AML_WORKSPACE/RG/REGION to the console. No Fabric dependency.
param mlWorkspaceEnabled = true

// BI stack — Azure Analysis Services is the Azure-native default tabular engine
// behind the semantic-model / report surfaces. Day-one default ON (audit
// gap-closure) so the AAS / XMLA / DirectQuery surfaces resolve without a
// "set LOOM_AAS_SERVER" setup gate. main.bicep now passes aasEnabled through to
// admin-plane (the passthrough was previously missing). Azure-native — no Fabric /
// Power BI workspace dependency (XMLA / Direct Lake shim remain opt-in). Set false
// for GCC-High / DoD (AAS unavailable there → Synapse-Serverless / Loom-native fallback).
param aasEnabled = true

// Azure Managed Grafana — day-one default ON (audit gap-closure) so the
// Govern / Usage embedded-dashboard surfaces resolve without a
// "set LOOM_GRAFANA_ENDPOINT" setup gate.
param managedGrafanaEnabled = true

// Event Grid custom topic — day-one default ON (audit gap-closure) so the
// business-events topics surface resolves without a "set LOOM_EVENTGRID_SUB" gate.
param eventGridEnabled = true

// Report-subscription delivery (Logic App + function) — day-one default ON
// (audit gap-closure) so report subscriptions deliver without a setup gate.
param reportSubscriptionsEnabled = true

// Consumption Logic App (logic-app provisioner + approval / report-subscription
// delivery) — day-one default ON (audit gap-closure).
param logicAppsEnabled = true

// ---------- Bring-your-own existing services (reuse instead of provision-new) ----------
// Set the EXISTING_* env var (or edit here) to point Loom at an EXISTING resource
// in ANY resource group / subscription instead of provisioning a new one. When set,
// the matching module is skipped and the Console wires to the existing resource;
// run scripts/csa-loom/grant-navigator-rbac.sh post-deploy to grant the UAMI roles.
// Empty → provision new per the *Enabled flag above. See docs/fiab/bring-your-own-services.md.
// Discover reuse candidates across your subs: bash scripts/csa-loom/discover-services.sh
// Generate this block interactively (reuse vs new per service, cross-sub aware):
//   bash scripts/csa-loom/byo-wizard.sh --boundary commercial-full
// >>> BYO-WIZARD START (regenerated by scripts/csa-loom/byo-wizard.sh — edit env vars or re-run the wizard)
// ---------- ADOPT-OR-CREATE plan (replaces the per-service EXISTING_* params) ----------
// main.bicep no longer declares 36 `existing*` scalars; it declares ONE `adopt`
// object keyed by the service key in apps/fiab-console/lib/deploy/adoption-catalog.ts.
// That is what freed the ARM parameter budget (251 -> 216 of 256) so networking,
// storage, Log Analytics and ACR adoption become possible at all.
//
// TWO input paths, and the explicit plan always wins:
//
//   1. LOOM_ADOPT_JSON - the whole plan as one JSON document, emitted by
//      `planToArmParameters()` (apps/fiab-console/lib/deploy/plan-to-arm.ts).
//      This is the first-class path every deploy tier uses.
//   2. The legacy per-service EXISTING_* environment variables below, kept
//      working verbatim so byo-wizard.sh / scan-and-deploy.sh / a hand-exported
//      shell keep behaving exactly as before.
//
// `union(legacy, plan)` means a service present in BOTH resolves to the plan's
// decision. A service in NEITHER is absent from the object, and main.bicep's
// `adoptMode()` defaults an absent key to 'create' - so an empty environment
// still produces a complete greenfield deployment.
//
// NOTE: setting an EXISTING_* name now also SUPPRESSES the matching new resource
// (main.bicep's provision<Service> vars). Previously several services - Purview,
// Maps, Foundry, Synapse, Databricks, ADF - rebound the Console env to the
// existing resource while STILL deploying a duplicate beside it.
var legacyAdoptFromEnv = union(
  empty(readEnvironmentVariable('EXISTING_AI_SEARCH_SERVICE', '')) ? {} : { aisearch: { mode: 'adopt', target: { name: readEnvironmentVariable('EXISTING_AI_SEARCH_SERVICE', ''), rg: readEnvironmentVariable('EXISTING_AI_SEARCH_RG', ''), sub: readEnvironmentVariable('EXISTING_AI_SEARCH_SUB', '') } } },
  empty(readEnvironmentVariable('EXISTING_APIM', '')) ? {} : { apim: { mode: 'adopt', target: { name: readEnvironmentVariable('EXISTING_APIM', ''), rg: readEnvironmentVariable('EXISTING_APIM_RG', ''), sub: readEnvironmentVariable('EXISTING_APIM_SUB', '') } } },
  empty(readEnvironmentVariable('EXISTING_KUSTO_CLUSTER', '')) ? {} : { adx: { mode: 'adopt', target: { name: readEnvironmentVariable('EXISTING_KUSTO_CLUSTER', ''), rg: readEnvironmentVariable('EXISTING_KUSTO_RG', ''), sub: readEnvironmentVariable('EXISTING_KUSTO_SUB', '') } } },
  empty(readEnvironmentVariable('EXISTING_AOAI', '')) ? {} : { foundry: { mode: 'adopt', target: { name: readEnvironmentVariable('EXISTING_AOAI', ''), rg: readEnvironmentVariable('EXISTING_AOAI_RG', ''), sub: readEnvironmentVariable('EXISTING_AOAI_SUB', '') }, extra: { chatDeployment: readEnvironmentVariable('EXISTING_AOAI_CHAT_DEPLOYMENT', ''), embedDeployment: readEnvironmentVariable('EXISTING_AOAI_EMBED_DEPLOYMENT', ''), miniDeployment: readEnvironmentVariable('EXISTING_AOAI_MINI_DEPLOYMENT', ''), strongDeployment: readEnvironmentVariable('EXISTING_AOAI_STRONG_DEPLOYMENT', '') } } },
  empty(readEnvironmentVariable('EXISTING_PURVIEW', '')) ? {} : { purview: { mode: 'adopt', target: { name: readEnvironmentVariable('EXISTING_PURVIEW', ''), rg: readEnvironmentVariable('EXISTING_PURVIEW_RG', ''), sub: readEnvironmentVariable('EXISTING_PURVIEW_SUB', '') } } },
  empty(readEnvironmentVariable('EXISTING_SYNAPSE', '')) ? {} : { synapse: { mode: 'adopt', target: { name: readEnvironmentVariable('EXISTING_SYNAPSE', ''), rg: readEnvironmentVariable('EXISTING_SYNAPSE_RG', ''), sub: readEnvironmentVariable('EXISTING_SYNAPSE_SUB', '') } } },
  empty(readEnvironmentVariable('EXISTING_COSMOS_ACCOUNT', '')) ? {} : { cosmos: { mode: 'adopt', target: { name: readEnvironmentVariable('EXISTING_COSMOS_ACCOUNT', ''), rg: readEnvironmentVariable('EXISTING_COSMOS_ACCOUNT_RG', ''), sub: readEnvironmentVariable('EXISTING_COSMOS_ACCOUNT_SUB', '') } } },
  empty(readEnvironmentVariable('EXISTING_EVENTHUB_NAMESPACE', '')) ? {} : { eventhubs: { mode: 'adopt', target: { name: readEnvironmentVariable('EXISTING_EVENTHUB_NAMESPACE', ''), rg: readEnvironmentVariable('EXISTING_EVENTHUB_RG', ''), sub: readEnvironmentVariable('EXISTING_EVENTHUB_SUB', '') } } },
  empty(readEnvironmentVariable('EXISTING_ASA_JOB', '')) ? {} : { streamanalytics: { mode: 'adopt', target: { name: readEnvironmentVariable('EXISTING_ASA_JOB', ''), rg: readEnvironmentVariable('EXISTING_ASA_RG', ''), sub: readEnvironmentVariable('EXISTING_ASA_SUB', '') } } },
  empty(readEnvironmentVariable('EXISTING_DATABRICKS', '')) ? {} : { databricks: { mode: 'adopt', target: { name: readEnvironmentVariable('EXISTING_DATABRICKS', ''), rg: readEnvironmentVariable('EXISTING_DATABRICKS_RG', ''), sub: readEnvironmentVariable('EXISTING_DATABRICKS_SUB', '') }, extra: { hostname: readEnvironmentVariable('EXISTING_DATABRICKS_HOSTNAME', '') } } },
  empty(readEnvironmentVariable('EXISTING_ADF', '')) ? {} : { adf: { mode: 'adopt', target: { name: readEnvironmentVariable('EXISTING_ADF', ''), rg: readEnvironmentVariable('EXISTING_ADF_RG', ''), sub: readEnvironmentVariable('EXISTING_ADF_SUB', '') } } },
  empty(readEnvironmentVariable('EXISTING_AZURE_MAPS_ACCOUNT', '')) ? {} : { maps: { mode: 'adopt', target: { name: readEnvironmentVariable('EXISTING_AZURE_MAPS_ACCOUNT', ''), rg: readEnvironmentVariable('EXISTING_AZURE_MAPS_RG', ''), sub: readEnvironmentVariable('EXISTING_AZURE_MAPS_SUB', '') } } },
  empty(readEnvironmentVariable('EXISTING_AML_WORKSPACE', '')) ? {} : { aml: { mode: 'adopt', target: { name: readEnvironmentVariable('EXISTING_AML_WORKSPACE', ''), rg: readEnvironmentVariable('EXISTING_AML_RG', ''), sub: readEnvironmentVariable('EXISTING_AML_SUB', '') } } }
)
param adopt = union(legacyAdoptFromEnv, json(readEnvironmentVariable('LOOM_ADOPT_JSON', '{}')))
// No-Fabric mode is the default (Azure-native, per no-fabric-dependency.md).
param fabricEnabled              = (toLower(readEnvironmentVariable('FABRIC_ENABLED', 'false')) == 'true')
// <<< BYO-WIZARD END
param frontDoorEnabled = true

// Tags
param complianceTags = {
  Environment: 'Commercial'
  CSA_Loom: 'true'
  FedRAMP_Level: 'High'
  Data_Classification: 'Standard'
}

// =====================================================================
// Data-engineering backends — ON by default (opt-out). Set any to false to
// skip that provision; the console editor then honest-gates (LOOM_* env blanked)
// instead of 502-ing. See docs/fiab/prp/deploy-readiness-100pct.md.
// =====================================================================
param loomSynapseEnabled = true
param loomDatabricksEnabled = true
param loomDataFactoryEnabled = true
param loomSelfHostedIrEnabled = true
