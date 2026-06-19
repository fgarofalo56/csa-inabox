// CSA Loom — Admin Plane orchestrator
// Deployment scope: resource group (rg-csa-loom-admin-<region>)

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Cloud boundary (Commercial / GCC / GCC-High / IL5)')
@allowed(['Commercial', 'GCC', 'GCC-High', 'IL5'])
param boundary string

// Allow App Insights telemetry ingestion over the public endpoint. Keep true
// unless an Azure Monitor Private Link Scope is separately provisioned to carry
// ingestion privately — disabling it without an AMPLS silently drops all custom
// events (copilot.usage etc.) and breaks the /admin Copilot usage panel.
// Forwarded to monitoring.bicep. Declared as a `var` (not a `param`) to keep
// admin-plane/main.bicep under the hard ARM 256-parameter cap — it was
// default-only (never set in any *.bicepparam), so this is behavior-preserving.
// A boundary that provisions an AMPLS should set publicIngestionEnabled=false in
// monitoring.bicep directly.
var monitorPublicIngestionEnabled = true

@description('AZURE_CLOUD two-value discriminator. When non-empty, overrides the AZURE_CLOUD env var regardless of boundary. Commercial / GCC deployments pass AzureCloud; GCC-High / IL5 deployments pass AzureUSGovernment. When empty (default), AZURE_CLOUD is derived from boundary (GCC-High|IL5 → AzureUSGovernment; otherwise AzureCloud).')
@allowed(['', 'AzureCloud', 'AzureUSGovernment'])
param loomAzureCloud string = ''

@description('Container platform — containerApps or aks')
@allowed(['containerApps', 'aks'])
param containerPlatform string

@description('Optional registry/host prefix MCP catalog images are mirrored to (e.g. an ACR login server for air-gapped boundaries). Empty pulls from the upstream Docker MCP catalog / mcr.microsoft.com. Read by lib/azure/mcp-catalog.ts resolveCatalogImage().')
param loomMcpCatalogRegistry string = ''

// functionsHostSku (reserved for v3.x) was removed from this module: it was an
// unused pass-through and admin-plane/main.bicep had hit the 256-parameter
// Bicep/ARM limit (max-params Error). The parent main.bicep still declares it
// for forward-compat; the Functions host wiring will re-introduce it here when
// that work lands.

@description('APIM SKU')
param apimSku string

@description('Seed a self-contained sample API + product + active subscription in the Loom-provisioned APIM so the API Marketplace Try console + curl samples work out of the box. Ignored for BYO-APIM (existingApimName).')
param seedSampleApi bool = true

@description('Catalog primary')
param catalogPrimary string

@description('Agent orchestrator — part of the module param contract (set per boundary in the .bicepparam files: foundry-agent-service vs maf). Retained as a pass-through after the legacy in-array orchestrator stub was removed; the MAF tier is now driven by copilotMafEnabled and the Setup Orchestrator by its dedicated module, so this value is currently informational at this layer.')
#disable-next-line no-unused-params
param agentOrchestrator string

// capacitySku (reserved for v3.x) was removed from this module: it was an
// unused pass-through here (the live consumers are the landing-zone + capacity
// modules, which still receive it from the parent main.bicep). Removing it from
// admin-plane keeps the module under the 256-parameter Bicep/ARM limit.

@description('Foundry portal enabled')
param foundryPortalEnabled bool

@description('Defender for Cloud AI Threat Protection enabled')
param defenderForAIEnabled bool

@description('Purview Data Map enabled')
param purviewEnabled bool

@description('Atlas on AKS enabled (IL5 only)')
param atlasOnAksEnabled bool

@description('Wire LOOM_DATABRICKS_HOSTNAMES into the console for Unity Catalog federation')
param databricksUnityCatalogEnabled bool = false

@description('Optional Databricks SQL warehouse id used to read Unity Catalog system-table lineage (system.access.table_lineage). Empty = the unified-lineage service falls back to the REST lineage-tracking preview. Requires the Loom UAMI to have USE SCHEMA + SELECT on system.access in the metastore.')
param loomDatabricksLineageWarehouseId string = ''

@description('Notebook per-cell execution backend (F16). Azure-native default is Synapse Spark Livy. Set to "databricks" to opt into the Databricks Execution Context API, or "aml-ci" to execute against an Azure ML Compute-Instance Jupyter kernel (listNotebookAccessToken → Jupyter contents + kernel WebSocket; reuses LOOM_AML_*/LOOM_FOUNDRY_* + LOOM_SUBSCRIPTION_ID, no new vars). Must NOT be "databricks" at IL5.')
@allowed(['', 'synapse', 'databricks', 'aml-ci'])
param loomNotebookBackend string = ''

@description('DQ data-profiling monitor REST surface (governance/data-quality Monitors tab). Empty or "data-quality" uses the GA /api/data-quality/v1/monitors API (keyed by table UUID — default). "legacy" forces the deprecated quality_monitors surface for sovereign regions where the GA API is not yet enabled. No new resource/role.')
@allowed(['', 'data-quality', 'legacy'])
param loomDbxDqMonitorApi string = ''

@description('Power Apps canvas web-player base for the in-Loom Play/embed + Studio tabs. Empty = code default https://apps.powerapps.com (Commercial). Sovereign clouds override: GCC/GCC-High = https://apps.gov.powerapps.us; DoD/IL5 = https://apps.appsplatform.us.')
param powerAppsPlayerBase string = ''

@description('Power Platform BAP admin control-plane base (environments lifecycle). Empty = code default https://api.bap.microsoft.com (Commercial). Sovereign: GCC = https://gov.api.bap.microsoft.com; GCC-High = https://high.api.bap.microsoft.us; DoD = https://api.bap.appsplatform.us.')
param powerPlatformBapBase string = ''

@description('Power Apps control-plane base (apps/connections/connectors admin). Empty = code default https://api.powerapps.com (Commercial). Sovereign: GCC = https://gov.api.powerapps.us; GCC-High = https://high.api.powerapps.us; DoD = https://api.apps.appsplatform.us.')
param powerPlatformPowerAppsBase string = ''

@description('Power Automate (Flow) control-plane base (flows admin/run). Empty = code default https://api.flow.microsoft.com (Commercial). Sovereign: GCC = https://gov.api.flow.microsoft.us; GCC-High = https://high.api.flow.microsoft.us; DoD = https://api.flow.appsplatform.us.')
param powerPlatformFlowBase string = ''

@description('Cloud authorization tier (e.g. "IL5"). When IL5, the notebook editor blocks the Databricks opt-in (Databricks Gov is not IL5-authorized) and falls back to Synapse Livy.')
param loomCloudTier string = ''

@description('Enable rich display() visualization for notebook cells (F-DS). When true, the BFF injects the ai-display.py helper as Livy session statement 0 so display(df) renders the Loom interactive grid + chart recommendations. Azure-native (Synapse Spark) — no Fabric dependency. When false/unset, display(df) falls back to the kernel built-in table.')
param loomRichDisplay bool = true

@description('Maximum rows sampled for the display() rich visualization grid + client-side chart aggregation (full-dataset aggregation still fires a real Spark job). Default 5000.')
@minValue(100)
@maxValue(20000)
param loomDisplaySampleRows int = 5000

// openaiLocation / openaiEmbeddingsLocation / openaiChatModel /
// openaiEmbeddingsModel (all reserved for v3.x) were removed from this module:
// they were unused pass-throughs here (explicit deployment-name pinning lives
// in ai-foundry.bicep today, fed from the parent main.bicep). Dropping them
// keeps admin-plane/main.bicep under the 256-parameter Bicep/ARM limit
// (max-params Error) so every boundary can deploy.

@description('Key Vault Premium HSM isolated (IL5)')
param keyVaultHsmIsolated bool

@description('Grant the Console UAMI "Key Vault Crypto Service Encryption User" on the admin-plane Key Vault for Customer-Managed Keys (F14). Also drives LOOM_KEY_VAULT_ID / LOOM_UAMI_RESOURCE_ID env wiring. Off by default.')
param consolePrincipalNeedsCmkBind bool = false

@description('Admin Entra group object ID')
param adminEntraGroupId string

@description('Hub VNet CIDR')
param hubVnetCidr string

@description('Compliance tags')
param complianceTags object

@description('Skip role-assignment grants — set true when re-provisioning an environment that already has the grants, to avoid RoleAssignmentExists.')
param skipRoleGrants bool = false

@description('Soft-delete retention days for ADLS Gen2 recovery — surfaced to the Console as LOOM_RECYCLE_RETENTION_DAYS (OneLake Recycle bin restore window). Must match the storage account deleteRetentionPolicy. 1–365. Default 30.')
@minValue(1)
@maxValue(365)
param recycleRetentionDays int = 30

@description('Deploy the Loom apps (Console, MCP, Orchestrator, Copilot, Activator, Mirroring, Direct-Lake Shim). Requires the container images to exist in ACR first — set false on initial provision, then true after images are built + pushed (PRP-16).')
param deployAppsEnabled bool = false

@description('Deploy AI Foundry Hub. Requires explicit storage-account strategy; default off so initial provision succeeds before operator picks Hub strategy.')
param aiFoundryEnabled bool = false

@description('Deploy Azure AI Content Safety (Microsoft.CognitiveServices/accounts kind=ContentSafety, S0) in the admin-plane RG and wire LOOM_CONTENT_SAFETY_ENDPOINT so every copilot persona routes prompts + completions through Prompt Shields + harm moderation. Available in Commercial, GCC (Commercial Azure endpoints), and GCC-High (USGovArizona / USGovVirginia). Set false at DoD (US DoD Central/East) — those regions do not offer Content Safety; the Console then surfaces an honest "not configured" warning MessageBar instead of silently passing.')
param contentSafetyEnabled bool = false

@description('Deploy the dedicated AI Foundry Agent Service account (aifndry-loom-<location>) with the loom-agents project + chat/embedding model deployments. Backs LOOM_FOUNDRY_PROJECT_ENDPOINT / LOOM_AOAI_* for the Agent Service. ON BY DEFAULT (opt-out). Independent of aiFoundryEnabled.')
param agentFoundryEnabled bool = true

@description('Inline-completion (ghost text) AOAI deployment name for notebook/SQL code cells (LOOM_AOAI_COMPLETION_DEPLOYMENT). Empty = ghost text uses the chat deployment (LOOM_AOAI_DEPLOYMENT). Set to a dedicated gpt-4o-mini slot for lower latency without consuming chat quota. Leave empty in GCC-High / IL5 regions where the model is unavailable — the Console route falls back to the chat deployment.')
param loomAoaiCompletionDeployment string = ''

@description('Deploy the shared Data API builder preview runtime that the DAB editor\'s live REST/GraphQL testers point at via LOOM_DAB_PREVIEW_URL.')
param dabRuntimeEnabled bool = false

@description('Deploy the label-propagation timer Function (F15) — polls the Loom Cosmos lineage graph and writes sensitivity-label downstream propagation state. Defaults on; a no-op without a Cosmos account.')
param labelPropagationEnabled bool = true

@description('NCRONTAB schedule for the label-propagation timer (6-field). Default every 15 minutes.')
param labelPropagationCron string = '0 */15 * * * *'

@description('Deploy the report-subscriptions timer Function + delivery Logic App (scheduled Power BI report export → email). Default off — opt-in because it requires an Office 365 mailbox connection authorized post-deploy.')
param reportSubscriptionsEnabled bool = false

@description('NCRONTAB schedule (6-field) for the report-subscriptions timer tick. Default every 15 minutes so per-subscription schedules fire close to their intended time.')
param reportSubscriptionsCron string = '0 */15 * * * *'

@description('Delivery Logic App workflow name for report subscriptions. Deployed by integration/report-subscription-logicapp.bicep into the admin-plane RG; the Console + Function target it via LOOM_SUBSCRIPTION_LOGIC_APP_NAME. Empty (or reportSubscriptionsEnabled=false) → the subscriptions UI shows an honest delivery gate.')
param loomSubscriptionLogicAppName string = 'logic-loom-report-subs-${location}'

@description('SQL server FQDN the DAB preview runtime targets (e.g. <srv>.database.windows.net). Required when dabRuntimeEnabled.')
param dabSqlServerFqdn string = ''

@description('SQL database the DAB preview runtime targets. Required when dabRuntimeEnabled.')
param dabSqlDatabase string = ''

@description('Deploy APIM. Premium V2 takes 30+ min; default off so initial provision iterates quickly.')
param apimEnabled bool = false

@description('Deploy AI Search. Capacity in certain regions is intermittent; default off so first deploy succeeds even when AI Search SKUs are over-subscribed.')
param aiSearchEnabled bool = false

@description('Deploy shared ADX cluster in the admin plane. Each DLZ then attaches its own database to this single cluster.')
param adxEnabled bool = false

@description('ADX cluster SKU. Dev SKU is ~$140/mo.')
param adxSkuName string = 'Dev(No SLA)_Standard_E2a_v4'

@description('Deploy an Azure Analysis Services (AAS) Standard server — the Azure-native semantic-model backend (no Fabric/Power BI). Hosts Import-mode tabular databases for refresh-now / scheduled-refresh. Default off.')
param aasEnabled bool = false

@description('AAS SKU (Standard tier). S1 (~$160/mo) is the minimum that supports the data-plane refresh REST API with a service-principal admin. S0 is the cheapest Standard SKU. S8v2 / S9v2 are the v2 high-QPU SKUs (the legacy S8 / S9 are excluded — not available in many regions).')
@allowed(['S0', 'S1', 'S2', 'S4', 'S8v2', 'S9v2'])
param aasSkuName string = 'S1'

@description('Reuse an existing AAS server name instead of provisioning one (any RG). When set, the module is skipped and LOOM_AAS_SERVER_NAME points at it.')
param existingAasServerName string = ''

@description('Region of a reused existing AAS server (existingAasServerName). Empty defaults to the deployment location.')
param existingAasServerRegion string = ''

@description('Deploy the read-only Workspace-Monitoring ADX database + Azure Monitor diagnostic-export pipeline (Fabric workspace-monitoring parity). Requires adxEnabled (new cluster). Default off.')
param workspaceMonitorEnabled bool = false

@description('Monitoring database name (underscores only so the kql-dashboard data-source slug round-trips). Must match LOOM_WORKSPACE_MONITOR_DB.')
param workspaceMonitorDbName string = 'loomdb_workspace_monitor'

@description('Event Hub namespace ARM resource id for the LAW→EventHub→ADX live monitoring feed. Empty → DB + seeded tables work; live continuous ingestion is wired once set.')
param workspaceMonitorEventHubNamespaceId string = ''

@description('Enable ADX optimized auto-scale. Requires a Standard-tier adxSkuName (Basic/Dev SKUs reject it).')
param adxEnableOptimizedAutoscale bool = false

@description('ADX optimized auto-scale minimum instance count.')
@minValue(2)
@maxValue(1000)
param adxAutoscaleMinimum int = 2

@description('ADX optimized auto-scale maximum instance count.')
@minValue(2)
@maxValue(1000)
param adxAutoscaleMaximum int = 10

// ---------- User access patterns (Bastion is always-on; these add reach) ----------

@description('Deploy a P2S VPN Gateway in the hub VNet (AAD auth, OpenVPN). ~30 min provisioning, ~$30/mo. Lets admin laptops reach the internal Console without Bastion. Default off — set true when ready.')
param vpnGatewayEnabled bool = false

@description('Deploy Application Gateway v2 + WAF v2 in front of the Console (public IP, in-VNet backend). ~15 min provisioning, ~$250/mo. Default off.')
param appGatewayEnabled bool = false

@description('Front Door Premium with a Private Link tunnel to the ACA env (global edge, managed cert, WAF). ~5 min provisioning, ~$330/mo. PE approval required after first deploy. Default off.')
param frontDoorEnabled bool = false

// ---------- Container image tags + Loom Console env-var wiring ----------

@description('Container image tag per app (loom-console, loom-mcp, loom-mcp-bridge, loom-orchestrator, loom-activator, loom-mirroring, loom-direct-lake-shim, loom-copilot-maf). Default v0.1; override per release.')
param appImageTags object = {
  console: 'v0.1'
  mcp: 'v0.1'
  mcpBridge: 'v0.1'
  orchestrator: 'v0.1'
  activator: 'v0.1'
  mirroring: 'v0.1'
  directLake: 'v0.1'
  maf: 'v0.1'
  setupOrchestrator: 'v0.1'
}

@description('Deploy the browser-driven Setup Orchestrator Container App (loom-setup-orchestrator) so the Setup Wizard\'s Deploy submits the real subscription-scoped ARM deployment (templateLink to main.json). On by default — the activation gate `setupOrchestratorActive` additionally requires containerPlatform==containerApps + deployAppsEnabled, so it is a safe no-op on AKS boundaries (GCC-High / IL5), which deploy the orchestrator via the cluster GitOps path instead. The loom-setup-orchestrator image is built by the standard release matrix; if setupTemplateUri is unset the orchestrator honestly fails the Deploy with the publish remediation rather than faking success. Set false to skip the Container App + its cross-sub Contributor grants. The Setup Orchestrator UAMI (the Console UAMI) is granted Contributor per target subscription by main.bicep\'s setup-orchestrator-rbac module.')
param setupOrchestratorEnabled bool = true

@description('templateLink URI to the compiled main.json the Setup Orchestrator submits (publish via `az bicep build -f platform/fiab/bicep/main.bicep`). Empty = the orchestrator honestly fails the Deploy with the publish remediation rather than faking success.')
param setupTemplateUri string = ''

@description('Deploy the MAF (Gov AOAI-direct) orchestration-tier Container App (loom-copilot-maf). Only honored in GCC-High / IL5 with containerPlatform==containerApps + deployAppsEnabled. Requires the loom-copilot-maf image pushed to ACR first.')
param copilotMafEnabled bool = false

@description('Deploy the loom-dbt-runner Container App (dbt-core + dbt-synapse + dbt-fabric + ODBC Driver 18) that executes generated dbt projects against the Synapse dedicated SQL pool / Fabric Warehouse. Synapse/Fabric have no native dbt task, so this runtime is required ONLY for those dbt-job targets — the Databricks target runs natively as a Databricks Job dbt_task with no extra infra. Requires the loom-dbt-runner image pushed to ACR first. Container Apps only.')
param dbtRunnerEnabled bool = false

@description('Expose the unified Fabric IQ MCP tool surface (/api/iq/mcp) to EXTERNAL agents (Microsoft Agent 365, Azure AI Foundry, Copilot Studio) via Bearer-token auth. Console users always reach it via their MSAL session; this flag only gates the token path. When true the Console gets LOOM_IQ_MCP_ENABLED=true plus the shared LOOM_INTERNAL_TOKEN used as the default Bearer secret.')
param loomIqMcpEnabled bool = false

@description('Enable the headless CI Bearer-token path on the Loom deployment-pipeline routes (/api/deployment-pipelines/loom/**) so an Azure DevOps / GitHub Actions agent can drive deploys + management via the CSA Loom DevOps task/extension (Fabric "fabric-devops-pipelines" parity). Console users always reach these routes via their MSAL session; this flag only gates the token path, which fails closed when off. When true the Console gets LOOM_PIPELINE_CI_ENABLED=true plus the shared LOOM_INTERNAL_TOKEN as the default Bearer secret (set a dedicated LOOM_CI_TOKEN Key Vault secret to isolate CI from the broader internal-trust token).')
param loomPipelineCiEnabled bool = false

@description('Provision an Azure Files share + managedEnvironments/storages registration so the loom-mcp Container App can persist deployable MCP-server state across revisions. Container Apps only (Commercial / GCC); on AKS boundaries the MCP workload uses an Azure Files PersistentVolumeClaim instead. The Console "Mount persistence" admin control re-mounts the share imperatively.')
param mcpPersistenceEnabled bool = true

// ── Console runtime (probes, resources, telemetry) — deploy-readiness ─────────
// Codifies the live #1382 crash-loop fix so a FRESH deploy is healthy on first
// boot. Implemented as `var` rather than `param` because admin-plane/main.bicep
// is at the hard ARM 256-parameter cap (a real deploy blocker on origin/main);
// the probe/CPU/memory right-sizing is threaded via the app-deployments module
// DEFAULTS (probeTimeoutSeconds=5, consoleCpu=1.0, consoleMemory=2Gi — operator-
// overridable there for slow sovereign regions). Telemetry is ON by default; the
// crash itself is eliminated by hardening apps/fiab-console/lib/telemetry/
// app-insights.ts (live-metrics off + uncaughtException guard + env gate). A
// per-deploy opt-out param returns once the program-level param-object
// consolidation frees admin-plane budget.
//
// loomConsoleTelemetryEnabled (var, default true): drives the console app's
// telemetryEnabled field (withholds APPLICATIONINSIGHTS_CONNECTION_STRING when
// false) + the LOOM_CONSOLE_TELEMETRY_ENABLED env (instrumentation.ts reads it
// BEFORE importing @azure/monitor-opentelemetry — the historical SIGSEGV path).
// The Log Analytics workspace + App Insights account are ALWAYS provisioned
// (monitoring.bicep) and the Console UAMI keeps its Reader/Contributor grants,
// so /monitor KQL + the Copilot-usage panel (which read the workspace, not the
// SDK) keep working either way.
var loomConsoleTelemetryEnabled = true

// Shared internal trust token for the MAF → Console tool-dispatch callback.
// Deterministic on the admin RG so the value injected into BOTH the Console and
// the MAF app matches without a round-trip. Internal-network use only.
var loomInternalToken = guid(resourceGroup().id, 'loom-maf-internal-token-v1')

// Setup Orchestrator deploys on the Container Apps boundaries (Commercial / GCC)
// when explicitly enabled + app deploy on (it needs the image in ACR). On AKS
// boundaries it is deployed via the cluster GitOps path instead.
var setupOrchestratorActive = setupOrchestratorEnabled && containerPlatform == 'containerApps' && deployAppsEnabled

// MAF tier deploys only in Gov boundaries with Container Apps + app deploy on.
var copilotMafActive = copilotMafEnabled && (boundary == 'GCC-High' || boundary == 'IL5') && containerPlatform == 'containerApps' && deployAppsEnabled

// dbt-runner Container App is only meaningful on Container Apps + when apps deploy.
var dbtRunnerActive = dbtRunnerEnabled && containerPlatform == 'containerApps' && deployAppsEnabled

@description('Loom version label shown in the UI (/admin/updates) + /api/version. Wired to LOOM_VERSION / NEXT_PUBLIC_LOOM_VERSION. NOTE (#1468): /api/version now reads the authoritative version from the image\'s package.json (release-please-synced), so this env is a fallback override only. Default tracks the release-please manifest (.release-please-manifest.json); the top-level main.bicep passes its own loomVersion. Kept in sync so a clean default deploy never shows a stale label.')
param loomVersion string = '0.45.0'

@description('Loom Synapse workspace name (for env-var wiring on loom-console). Default uses the single-sub DLZ convention.')
param loomSynapseWorkspace string = 'syn-loom-default-${location}'

@description('Loom Synapse Dedicated SQL pool name.')
param loomSynapseDedicatedPool string = 'loompool'

@description('Direct Lake warm-cache TTL in seconds. Semantic-model "Direct Lake query" requests within this window are served from the Power BI in-memory VertiPaq cache; older queries fall back transparently to Synapse Serverless OPENROWSET over the Gold Delta files. 0 = always Serverless. Default 3600 (1 hour).')
param loomDlCacheTtlSeconds int = 3600
@description('Entra group object ID whose members may run the Ops Admin Copilot ARM/config actions (scale capacity, toggle the Synapse outbound-access policy, create workspaces). Empty = any signed-in admin (matches the rest of the admin pane). Recommended: a dedicated "Loom Ops Admins" group. Membership is checked via Microsoft Graph transitiveMembers using the Console UAMI Group.Read.All AppRole (already granted by identity-graph-rbac).')
param loomOpsAdminEntraGroup string = ''

@description('Power Platform environment GUID that the data-agent "Publish to Microsoft 365 Copilot" action targets (Copilot Studio agent + Teams/M365 Copilot channel via Dataverse). Empty = the editor surfaces an honest infra-gate and lists any environments the Dataverse app-user can see. Requires the LOOM_DATAVERSE_* app-user creds and Copilot Studio enabled in the environment. See docs/fiab/dataverse-app-user.md.')
param loomCopilotStudioEnvironmentId string = ''

@description('Enable the OneLake Security tab (F7) ADLS-ACL backend on the Console app (sets LOOM_ONELAKE_SECURITY_ACL=true). Requires the Console UAMI to hold Storage Blob Data Owner on the DLZ storage account — deploy synapse.bicep with loomOnelakeSecurityEnabled=true. Off by default.')
param loomOnelakeSecurityEnabled bool = false

@description('Enable the OPT-IN Fabric OneLake dataAccessRoles sync path on the Console app (sets LOOM_FABRIC_SECURITY_ENABLED=true). The Azure-native ADLS ACL path is the default and needs no Fabric workspace. Ignored at the GCC-High / IL5 boundary (Fabric is not authorized there). Off by default.')
param loomFabricSecurityEnabled bool = false

@description('Synapse dev-endpoint DNS suffix for sovereign clouds. Commercial = azuresynapse.net (default); GCC-High / DoD = azuresynapse.us. Empty resolves to azuresynapse.net in code.')
param loomSynapseDevSuffix string = ''

@description('Default Synapse Spark pool used for lakehouse schema DDL (CREATE/ALTER/DROP SCHEMA via Livy). Matches the synapse.bicep sparkPool default.')
param loomDefaultSparkPool string = 'loompool'

@description('Loom Synapse Spark (Big Data) pool name — backs the Lakehouse column-summary stats job + notebook/spark editors. Defaults to the loompool Spark pool the landing-zone Synapse module deploys.')
param loomSynapseSparkPool string = 'loompool'

@description('Max lakehouse Delta tables the Notebook Copilot persona reads into its schema-grounding context (delta-schema.ts buildDatastoreSchema cap). Keeps the AOAI prompt small; defaults to 30.')
param loomNotebookPersonaContextMaxTables int = 30

@description('AML workspace name for Serverless Spark %%pyspark cell execution (Commercial / GCC only). Empty disables AML Spark; the editor falls back to the Synapse Spark Livy path. Gov boundaries force this empty (AML Serverless Spark is not offered in Azure Government).')
param loomAmlSparkWorkspace string = ''

@description('Synapse Spark pool used for notebook %%pyspark cell execution (Livy). Defaults to loomSynapseSparkPool so notebook cells run on the same pool unless a dedicated interactive pool is wanted.')
param loomNotebookSparkPool string = loomSynapseSparkPool

@description('Synapse SQL TDS host suffix override. Empty (default) = derived from AZURE_CLOUD in synapse-sql-client.ts (Commercial/GCC sql.azuresynapse.net; GCC-High/IL5 sql.azuresynapse.usgovcloudapi.net). Set explicitly only to force a specific sovereign endpoint.')
param loomSynapseHostSuffix string = ''

@description('Synapse SQL endpoint suffix for the live Tables catalog row-count path. Commercial = azuresynapse.net (default); Azure Government (GCC / GCC-High / IL5) = azuresynapse.us. Leave empty for Commercial.')
param loomSynapseSqlSuffix string = ''

@description('Resource group of the AML workspace for MLflow experiment tracking (ml-experiment "Runs & metrics" tab, mlflow-client.ts). Empty → falls back to LOOM_FOUNDRY_RG. Set explicitly when pointing at a dedicated AML workspace; requires the Console UAMI AzureML Data Scientist on that workspace.')
param loomAmlRg string = ''

@description('Entra principal name the console identity is registered under in PostgreSQL (pgaadauth_create_principal). Defaults to the Console UAMI name (loom-console) — the name the post-deploy bootstrap registers as a PG principal for Weave + the relational-store editors. Override only if the UAMI is named differently.')
param loomPostgresAadUser string = 'loom-console'

@description('Loom Azure Data Factory name (for env-var wiring on loom-console — backs the ADF Pipeline/Dataset/Trigger editors).')
param loomAdfName string = 'adf-loom-default-${location}'

// NOTE: loomAasServer (AAS connection string used by both the semantic-model
// Power Query ingest refresh path AND the DAX tile / analysis-services
// backend path) is declared further below alongside loomSemanticBackend.

@description('Azure Analysis Services tabular model (database) name to refresh after the Power Query ingest lands Delta. Empty = AAS refresh gated.')
param loomAasModel string = ''

@description('Scaled self-hosted IR VMSS name (backs the SHIR metrics tile + scale controls). Defaults to the single-sub DLZ name; empty disables the SHIR surface (honest gate).')
param loomShirVmssName string = 'vmss-loom-shir-default'

// Data-engineering backend opt-out MIRRORS (default all ON). Carried on the
// existing `byoExisting` object param (keeps admin-plane under Bicep's 256-param
// ceiling — no new param) under the de* keys. When an operator disables a DLZ
// backend the console env var is blanked here too, so the editor shows its honest
// Fluent gate instead of 502-ing against a workspace/factory/VMSS that was never
// provisioned. main.bicep sets these from the same loom<Svc>Enabled booleans.
var deSynapseEnabled = byoExisting.?deSynapse ?? true
var deDatabricksEnabled = byoExisting.?deDatabricks ?? true
var deAdfEnabled = byoExisting.?deAdf ?? true
var deShirEnabled = byoExisting.?deShir ?? true

@description('Deploy the SHARED admin-zone Purview self-hosted IR VMSS (scale-to-zero). A Purview SHIR cannot be the DLZ ADF SHIR (Microsoft constraint — separate machine), so this is its own VMSS. Honest-gated: only deploys when purviewEnabled AND purviewIrAuthKey AND purviewShirAdminPassword are all set.')
param purviewShirEnabled bool = true

@description('Purview self-hosted IR node auth key (authKey1) from the Purview scanning data plane (Data Map → Source management → Integration runtimes, or the scanning REST API). Empty = honest gate (the Purview SHIR VMSS is not deployed; the auto-scale-up still no-ops cleanly). Store in Key Vault and pass at deploy.')
@secure()
param purviewIrAuthKey string = ''

@description('Local admin password for the Purview SHIR VMSS nodes (from Key Vault). Empty = honest gate (the Purview SHIR VMSS is not deployed).')
@secure()
param purviewShirAdminPassword string = ''

@description('Target node count the Purview scan-trigger automation scales the Purview SHIR VMSS TO (created at 0). 1-8.')
@minValue(1)
@maxValue(8)
param purviewShirMaxNodes int = 4

@description('Purview SHIR VMSS name — emitted to the Console as LOOM_PURVIEW_SHIR_VMSS_NAME so the BFF can scale it up before a SHIR-using scan. Must match purview-shir.bicep naming (vmss-loom-pvw-shir-<domain>).')
param loomPurviewShirVmssName string = 'vmss-loom-pvw-shir-default'

@description('Loom Azure Data Factory resource group. Empty defaults to LOOM_DLZ_RG.')
param loomAdfRg string = ''

@description('Opt-in ADF CDC mirroring — name of the pre-existing ADF linked service for the relational SOURCE (Azure SQL / SQL Server / PostgreSQL). Empty = mirrored databases use the built-in CSV snapshot engine (still Azure-native, no Fabric).')
param loomMirrorSourceLinkedService string = ''

@description('Opt-in ADF CDC mirroring — name of the pre-existing ADF AzureBlobFS linked service pointing at the DLZ ADLS account (the Delta sink). Empty = mirrored databases use the built-in CSV snapshot engine.')
param loomMirrorAdlsLinkedService string = ''

@description('Opt-in ADF Copy mirroring — name of the pre-existing ADF Snowflake linked service (credential in Key Vault). Empty = falls back to loomMirrorSourceLinkedService. Snowflake mirrors via an ADF Copy pipeline → ADLS Bronze Parquet, NO Fabric.')
param loomMirrorSnowflakeLinkedService string = ''

@description('Refresh cadence for the ADF Copy backend schedule trigger (Snowflake): 15min | 1h | 4h | daily | on-demand. Default 1h.')
@allowed([
  '15min'
  '1h'
  '4h'
  'daily'
  'on-demand'
])
param loomMirrorCopyCadence string = '1h'

@description('Semantic-model tabular backend. Default "loom-native" reads model metadata from Cosmos + evaluates DAX over Synapse SQL — NO Power BI / Fabric. Set to "analysis-services" / "aas" (with loomAasServer) to opt into an Azure Analysis Services XMLA backend (Commercial / GCC only — AAS is not in Azure Government). "fabric" / "powerbi" remain opt-in alternatives that require a bound Power BI / Fabric workspace.')
@allowed([
  'loom-native'
  'analysis-services'
  'aas'
  'fabric'
  'powerbi'
])
param loomSemanticBackend string = 'loom-native'

@description('Azure Analysis Services server URI for the OPT-IN tabular backend (only used when loomSemanticBackend = "analysis-services"). Accepted forms: asazure://<region>.asazure.windows.net/<server> OR an https XMLA URL. Leave empty (default) for loom-native — no AAS dependency. NOTE: Azure Analysis Services is NOT available in Azure Government (GCC-High / IL5 / DoD); leave empty there.')
param loomAasServer string = ''

@description('Azure Analysis Services model/database name (only used when loomAasServer is set). The Console UAMI must have at least Reader on the AAS server resource.')
param loomAasDatabase string = 'model'

@description('Approval Logic App workflow name (backs the Approval activity in the pipeline editor). Defaults to the deterministic DLZ convention deployed by modules/integration/approval-logicapp.bicep; empty -> the approval-logicapp route returns an honest 503 with deployment instructions.')
param loomApprovalLogicAppName string = 'logic-loom-approval-${location}'

@description('Approval Logic App resource group. Empty defaults to LOOM_DLZ_RG (where the DLZ approval Logic App is deployed).')
param loomApprovalLogicAppRg string = ''

@description('Optional shared secret guarding the Plan approval callback endpoint (/api/items/plan/<id>/approval-callback). When set, the approval Logic App callback URL must carry ?key=<secret>; the plan-approval route appends it automatically. Empty = open callback (acceptable for unclassified approval coordination; harden for CUI/IL5).')
@secure()
param loomApprovalCallbackSecret string = ''

@description('audit-T64: Azure SQL logical server (name or FQDN) that holds the Plan (preview) writeback table dbo.loom_plan_cells. Empty -> planning cells persist to Cosmos (always works) and the Plan editor shows an honest "set LOOM_PLAN_BACKING_SQL_*" gate. No Microsoft Fabric dependency (replaces Fabric\'s auto-provisioned Fabric SQL database).')
param loomPlanBackingSqlServer string = ''

@description('audit-T64: Azure SQL database name for the Plan (preview) writeback store. Pairs with loomPlanBackingSqlServer. Grant the Console UAMI db_ddladmin + db_datawriter on this database (plan-backing-sql.bicep). Empty -> Cosmos-only.')
param loomPlanBackingSqlDatabase string = ''

@description('F4: Key Vault URI for schedule-time pipeline parameter overrides. Empty defaults to the admin-plane vault (Console UAMI already has Secrets Officer there). Set to a separate vault URI to source parameters from elsewhere (grant the Console identity "Key Vault Secrets User" on it).')
param loomParamKeyVaultUri string = ''

@description('Key Vault URI for external-source SHORTCUT credentials (S3/GCS/SAS/Synapse-Link). Empty defaults to the admin-plane vault (Console UAMI already has Secrets Officer there). Set to a separate vault to isolate shortcut credentials — keep it the SAME vault the shortcut engine binding reads, or unset to default.')
param loomShortcutKeyVaultUri string = ''

@description('Key Vault URI holding the CA + client certificates (PEM) for eventstream MQTT/Kafka mutual-TLS (mTLS) connections. Empty defaults to the admin-plane vault. The Console UAMI is granted "Key Vault Certificate User" (read) on the admin-plane vault below; if you point this at a separate vault, grant that role there too.')
param loomEventstreamCertKeyVaultUri string = ''

@description('Git integration — Azure DevOps host override for on-premises Azure DevOps Server (GCC-High / IL5 / DoD, where ADO Services is unavailable). Empty uses dev.azure.com (commercial/GCC). Example on-prem: https://tfs.agency.gov')
param loomAdoHost string = ''

@description('Git integration — GitHub Enterprise Server REST API base override. Empty uses api.github.com (commercial/GCC/GCC-High). Example GHES: https://github.agency.gov/api/v3')
param loomGitHubHost string = ''

@description('Git integration — Key Vault secret-name prefix for per-workspace PATs. Default loom-git-pat. Change only if sharing the vault with another system that uses the same prefix.')
param loomGitPatKvPrefix string = 'loom-git-pat'

@description('F4: Azure App Configuration endpoint for schedule-time pipeline parameter overrides. Empty disables the App Config source. Set to an App Configuration endpoint and grant the Console identity "App Configuration Data Reader" to enable.')
param loomParamAppConfigEndpoint string = ''

// Public base URL of the Console (e.g. https://csa-loom.contoso.ai). Used as the
// callback target baked into the "Refresh materialized lake view" ADF pipeline so
// a scheduled ADF run can reach the MLV refresh endpoint behind Front Door. Empty
// = the refresh route derives the origin from the request (works for editor-driven
// refreshes). Declared as a `var` (not a `param`) to keep admin-plane/main.bicep
// under the hard ARM 256-parameter cap — it was default-only (never set in any
// *.bicepparam). A boundary needing ADF-scheduled MLV refreshes against a fixed
// vanity/Front Door URL can set this value here.
var loomConsoleBaseUrl = ''

@description('Loom HDInsight cluster linked-service name (backs the four ADF HDInsight pipeline activities — Hive/Spark/MapReduce/Streaming). Empty leaves the editor honest-gated until an Azure HDInsight linked service is registered in the factory.')
param loomHdinsightLinkedService string = ''

@description('Loom DLZ resource group (for ARM REST pause/resume from the Console BFF).')
param loomDlzRg string = 'rg-csa-loom-dlz-single-${location}'

@description('Resource group of the Azure SQL logical server(s) the per-database Share dialog manages. Empty defaults to LOOM_DLZ_RG. The Console UAMI receives constrained RBAC-Admin here (Reader/Contributor/SQL DB Contributor only) so it can assign roles at the database scope.')
param loomSqlServerRg string = ''

@description('Git provider for Azure SQL schema source control (Source control tab): "azdo", "github", or empty (honest gate). Repo + PAT are supplied via the LOOM_SQL_GIT_* settings below.')
@allowed([ '', 'azdo', 'github' ])
param loomSqlGitProvider string = ''

@description('Azure DevOps organization name (when loomSqlGitProvider=azdo).')
param loomSqlGitAdoOrg string = ''

@description('Azure DevOps project that holds the schema (DACPAC) repo (when loomSqlGitProvider=azdo).')
param loomSqlGitAdoProject string = ''

@description('Azure DevOps Git repository name for the schema project (when loomSqlGitProvider=azdo).')
param loomSqlGitAdoRepo string = ''

@description('Key Vault secret name holding the Azure DevOps PAT (when loomSqlGitProvider=azdo).')
param loomSqlGitAdoPatSecretName string = ''

@description('GitHub repository (org/repo) for the schema project (when loomSqlGitProvider=github).')
param loomSqlGitGithubRepo string = ''

@description('GitHub default branch for the schema project (when loomSqlGitProvider=github).')
param loomSqlGitGithubBranch string = 'main'

@description('Key Vault secret name holding the GitHub PAT (when loomSqlGitProvider=github).')
param loomSqlGitGithubPatSecretName string = ''

@description('Resource group containing the Azure SQL logical servers Loom manages. The Console UAMI is granted SQL DB Contributor here so the Compute & Storage scale tab can PATCH database SKUs (Microsoft.Sql/servers/databases/write). Empty = skip the grant; the tab then surfaces an honest MessageBar naming the role.')
param loomAzureSqlServerRg string = ''

@description('Opt-in (F5): also mirror workspace role assignments to a Microsoft Fabric workspace via /v1/workspaces/{id}/roleAssignments. Default false: Azure-native only (Cosmos + Azure RBAC). Forced off at IL5 (Fabric is not IL5-authorized).')
param loomWorkspaceRolesFabricEnabled bool = false

@description('Loom Stream Analytics resource group (backs the stream-analytics-job editor). Empty defaults to LOOM_DLZ_RG.')
param loomAsaRg string = ''

@description('Loom Stream Analytics subscription ID. Empty defaults to LOOM_SUBSCRIPTION_ID.')
param loomAsaSub string = ''

@description('Optional blob container SAS URL (write+read) where ASA writes Test Query sample output for the Eventstream transform builder. Empty surfaces an honest infra-gate on the "Run test" action; the compile/validate path needs no storage.')
@secure()
param loomAsaTestWriteUri string = ''

@description('Default ASA job name the Eventstream editor pre-fills for "Push destinations to ASA". Matches the starter job from modules/landing-zone/stream-analytics.bicep (asa-loom-<domain>-<region>). Editable in the UI.')
param loomAsaJobName string = 'asa-loom-default-${location}'

@description('Azure region for Stream Analytics jobs created on demand from the Eventstream canvas (POST /api/items/eventstream/{id}/provision). Defaults to the deployment region; falls back to LOOM_LOCATION then eastus in the client.')
param loomAsaLocation string = location

@description('audit-T29 — release-environment (Palantir Apollo / Shuttle parity): the Azure Deployment Environments DevCenter project (resourceId or name) used for catalog-driven environment provisioning. Empty surfaces an honest infra-gate in the release-environment editor (ARM deployment history + promotions still work). Deploy modules/admin-plane/devcenter.bicep to provision one. No Microsoft Fabric required.')
param loomDevCenterProject string = ''

@description('Loom Event Hubs namespace name (backs the Event Hubs namespace navigator in the Eventstream editor). Defaults to the single-sub DLZ convention evhns-loom-default-<region> emitted by modules/landing-zone/eventhubs.bicep; override for multi-domain deployments. Empty surfaces the navigator config gate.')
param loomEventHubNamespace string = 'evhns-loom-default-${location}'

@description('Loom Event Hubs resource group. Empty defaults to LOOM_DLZ_RG.')
param loomEventHubRg string = ''

@description('Loom Event Hubs subscription ID. Empty defaults to LOOM_SUBSCRIPTION_ID.')
param loomEventHubSub string = ''

@description('Optional storage account ARM resource ID to pre-fill the Event Hubs navigator Capture form (LOOM_EVENTHUB_CAPTURE_STORAGE_ID). Capture is configured per-hub at runtime; empty leaves the form blank. The Console UAMI needs Storage Blob Data Contributor on this account for Capture writes.')
param loomEventHubCaptureStorageId string = ''

@description('Optional blob container / ADLS filesystem name to pre-fill the Event Hubs navigator Capture form (LOOM_EVENTHUB_CAPTURE_CONTAINER). Only meaningful when loomEventHubCaptureStorageId is set.')
param loomEventHubCaptureContainer string = 'captures'

@description('Event Hubs Schema Registry schema group name for server-side Avro compatibility enforcement of event-schema-set registrations. When set, the console delegates schema registration to EH Schema Registry (data-plane PUT) and the service enforces compatibility on PUT. Leave empty to use the in-process Avro validator (the Azure-native default; no Fabric, no extra infra). Live default: loom-schemas, created by modules/landing-zone/eventhubs.bicep.')
param loomEhSchemaGroup string = ''

@description('RTI hub catalog — extra subscription IDs (comma-separated) to include in cross-subscription stream discovery via Azure Resource Graph, beyond the deployment subscription. The Console UAMI needs Reader at each subscription scope.')
param loomExtraSubscriptions string = ''

@description('Business Events — Event Grid custom-topic resource group for the /business-events publishing surface. Empty defaults to LOOM_DLZ_RG.')
param loomEventGridRg string = ''

@description('Business Events — Event Grid custom-topic subscription ID. Empty defaults to LOOM_SUBSCRIPTION_ID.')
param loomEventGridSub string = ''

@description('Business Events — default Event Grid custom-topic name governed events publish to. Created by modules/landing-zone/eventgrid-business.bicep. Live default: loom-business-events.')
param loomEventGridBusinessTopic string = 'loom-business-events'

@description('Business Events — default Event Hub entity the durable channel publishes governed events to (LOOM_EVENTHUB_BUSINESS_HUB). Empty uses loom-telemetry.')
param loomEventHubBusinessHub string = 'loom-telemetry'

@description('Enable the Event Hubs Data Explorer "View / Peek events" AMQP receive path (LOOM_EVENTHUB_RECEIVE_ENABLED). Default on (opt-out) — the @azure/event-hubs SDK is bundled in the Console image and loaded lazily only on the receive path; the Console UAMI Data Owner role covers receive. Set false to leave View events honestly dependency-gated.')
param loomEventHubReceiveEnabled bool = true

@description('Business Events — Cosmos container holding the governed event-type registry (LOOM_BUSINESS_EVENTS_CONTAINER). Created on first write by business-events-store.ts. Live default: business-event-types.')
param loomBusinessEventsContainer string = 'business-event-types'

@description('Optional ARM resource ID of a default IoT Hub for ADX data connections (KQL Database → Add data connection wizard). When set, the IoT Hub picker pre-selects this hub; when empty, the wizard discovers all IoT Hubs visible to the Loom identity via Resource Graph. The ADX cluster system-assigned managed identity must hold "IoT Hub Contributor" (role ID 4763167e-fb37-48bb-8710-0fcd9d82e439, grants Microsoft.Devices/IotHubs/IotHubKeys/read) at the target IoT Hub scope for device-to-cloud ingestion to succeed — because the hub is user-selected at runtime, that grant is a one-time operator action surfaced as an honest-gate MessageBar in the editor.')
param loomIotHubResourceId string = ''

@description('Loom Alert Rules resource group — where the day-one Azure Monitor alert rules + action group are created and where the Azure-native Activator writes scheduled-query alerts. Empty defaults to the admin resource group (resourceGroup().name) so LOOM_ALERT_RG is always wired day-one (no manual config). Override only to target a separate alerts RG.')
param loomAlertRg string = ''

@description('ARM management endpoint. Empty defaults to https://management.azure.com (Commercial). Set to https://management.usgovcloudapi.net for GCC-High / IL5.')
param loomArmEndpoint string = ''

@description('ARM token scope. Empty defaults to <ARM endpoint>/.default. Override only for sovereign clouds where the audience differs.')
param loomArmScope string = ''

@description('Loom Storage account name (for ADLS Gen2 lake URLs). When empty, env vars omitted and the Lakehouse editor surfaces a config message.')
param loomStorageAccount string = ''

@description('ADLS Gen2 storage account name for ADX continuous-export (Delta / OneLake-style availability). Backs LOOM_RTI_EXPORT_ADLS and grants the ADX cluster MI Storage Blob Data Contributor. Defaults to loomStorageAccount when empty.')
param loomRtiExportAdls string = ''

@description('Resource group of the ADX continuous-export ADLS account. Empty defaults to this deployment RG.')
param loomRtiExportAdlsRg string = ''

@description('Loom Cosmos account name. When empty, Cosmos env vars omitted.')
param loomCosmosAccount string = ''

@description('Loom Cosmos DB account resource group for the control-plane navigator (databases/containers/sprocs). Empty defaults to LOOM_DLZ_RG, where the single-sub DLZ Cosmos account lives.')
param loomCosmosAccountRg string = ''

@description('Deploy the Console\'s own `loom` Cosmos account IN THE HUB. Required in tenant/dlz-attach topologies where no local DLZ exists to host it (the DLZ landing-zone cosmos.bicep is skipped) — without it the Console points at a non-existent account and all item/config CRUD fails. main.bicep sets this true when NOT useSingleDlz and no BYO Cosmos is supplied. The account name is loomCosmosAccount (same value the Console env binds to), so no env change is needed.')
param deployConsoleCosmos bool = false

@description('Base URL of the posture-refresh Azure Function (deployed from azure-functions/posture-refresh/deploy/main.bicep). Backs the Govern tab data-owner view on-open refresh. Empty surfaces an honest MessageBar gate; the owner view still computes posture live from Cosmos.')
param loomPostureFunctionUrl string = ''

@description('Key Vault secret name holding the posture-refresh Function host key. The Console reads this via secretRef as LOOM_POSTURE_FUNCTION_KEY. Only emitted when loomPostureFunctionUrl is set.')
param loomPostureFunctionKeySecretName string = 'loom-posture-function-key'

@description('Base URL of the paginated-report-renderer Azure Function (deployed from azure-functions/paginated-report-renderer/deploy/main.bicep). Backs PDF/Excel/Word export for the paginated-report editor. Empty surfaces an honest export gate in the designer; authoring still works fully (no Microsoft Fabric / Power BI dependency).')
param loomPaginatedRenderUrl string = ''

@description('Key Vault secret name holding the paginated-report-renderer Function host key. The Console reads this via secretRef as LOOM_PAGINATED_RENDER_KEY. Only emitted when loomPaginatedRenderUrl is set.')
param loomPaginatedRenderKeySecretName string = 'loom-paginated-render-key'

@description('Loom Databricks workspace hostname (e.g. adb-1234567890123456.7.azuredatabricks.net) backing the Databricks navigator (jobs/clusters/notebooks/SQL warehouses + Unity Catalog). The real hostname embeds a non-deterministic workspace id, so it is NOT hard-coded — it is patched onto the Console post-deploy from the DLZ databricks workspaceUrl output (scripts/csa-loom/patch-navigator-env.sh). Empty surfaces the navigator config gate.')
param loomDatabricksHostname string = ''

@description('OPTIONAL Databricks ACCOUNT GUID (accounts.azuredatabricks.net). Enables the Catalog → Metastores one-click "attach workspace to a UC metastore" action (account-plane PUT /accounts/{id}/workspaces/{wsId}/metastore) + the account metastore picker. The Loom UAMI must be a Databricks account admin (or metastore admin) for assignment to succeed — see scripts/csa-loom/enable-unity-catalog.sh. Empty leaves the attach action gated honestly; registration + catalog listing still work without it.')
param loomDatabricksAccountId string = ''

@description('OPTIONAL Databricks account control-plane host override for sovereign clouds. Defaults to accounts.azuredatabricks.net (Commercial) when empty.')
param loomDatabricksAccountHost string = ''

@description('OPTIONAL Azure Analysis Services XMLA endpoint backing the semantic-model Model view XMLA write path (azure-native, no Fabric). Wire from the DLZ aas.bicep xmlaEndpoint output (enableAas=true). Empty by default — the Loom-native Cosmos backend works without it.')
param loomAasXmlaEndpoint string = ''

@description('Semantic-model write backend selector. Set to \'fabric\' to OPT INTO the Fabric REST write path (per no-fabric-dependency.md, strictly opt-in). Any other value keeps the azure-native default (Cosmos + optional AAS XMLA).')
param loomSemanticModelBackend string = ''

@description('Optional Databricks SQL Warehouse id used for lakehouse ALTER TABLE … CLUSTER BY (liquid clustering). When blank, the lakehouse settings route auto-selects the first RUNNING warehouse in the workspace. Empty by default so existing deployments are unaffected.')
param loomDatabricksSqlWarehouseId string = ''

@description('Enable the Direct-Lake-shim (Azure-native parity for Fabric Direct Lake). When true, the shim app gets its Cosmos/Service Bus/Event Grid env, the Console exposes the Direct Lake (shim) tab as active, and aas.bicep deploys the Service Bus queue + Event Grid system topic. Requires a Power BI Premium / PPU workspace + XMLA endpoint. Opt-in (default false) per no-fabric-dependency.md.')
param loomDirectLakeShimEnabled bool = false

@description('Service Bus namespace name hosting the Direct-Lake-shim queue. Empty defaults to sb-loom-dlshim-<location>.')
param loomDirectLakeShimSbNamespace string = ''

@description('Service Bus queue name for Delta _delta_log BlobCreated events (Direct-Lake-shim).')
param loomDirectLakeShimQueue string = 'loom-dl-shim-events'

@description('AAS / Power BI Premium service-principal object id — granted Storage Blob Data Reader on the DLZ ADLS account so the warm-cache model can read Delta Parquet. Empty skips that grant (the shim UAMI grant still applies).')
param loomAasMiPrincipalId string = ''

// ---------------------------------------------------------------------------
// Standalone Azure Machine Learning workspace — backs aml-client.ts
// (resolveAmlTarget). These coordinate the AML control-plane navigator
// (computes / datastores / jobs / models / schedules / environments). When
// loomAmlWorkspace is empty the client falls back to the AI Foundry hub env
// (LOOM_FOUNDRY_*) and the shared landing-zone subscription, so existing
// deployments need no new config. Cloud routing (Commercial vs
// management.usgovcloudapi.net) is handled by cloud-endpoints.ts at runtime.
// ---------------------------------------------------------------------------
@description('AML workspace name for the standalone AML client (LOOM_AML_WORKSPACE). Empty falls back to the AI Foundry hub name.')
param loomAmlWorkspace string = ''

@description('Resource group of the AML workspace (LOOM_AML_RESOURCE_GROUP). Empty falls back to LOOM_FOUNDRY_RG, then rg-csa-loom-admin-<region>.')
param loomAmlResourceGroup string = ''

@description('Subscription id of the AML workspace (LOOM_AML_SUBSCRIPTION). Empty falls back to the deployment subscription (LOOM_SUBSCRIPTION_ID).')
param loomAmlSubscription string = ''

@description('Primary region of the AML workspace (LOOM_AML_REGION). Empty falls back to LOOM_FOUNDRY_REGION, then eastus2.')
param loomAmlRegion string = ''

// ---------------------------------------------------------------------------
// SQL editor Copilot — Azure OpenAI endpoint (LOOM_AZURE_OPENAI_ENDPOINT).
// Backs the unified SQL editor's Fix / Explain / NL→T-SQL quick-actions and the
// Monaco inline ghost-text completion. The route resolves the data-plane host
// per cloud via getOpenAiSuffix() (openai.azure.com vs openai.azure.us), so this
// may be a bare account name OR a full inference URL. Empty derives from the
// Foundry Agent Service account (when agentFoundryEnabled=true); empty + Foundry
// off → the SQL Copilot pane shows an honest gate MessageBar naming this var and
// the Cognitive Services OpenAI User role, while the rest of the editor works.
// ---------------------------------------------------------------------------
@description('Azure OpenAI account endpoint or name for the SQL editor Copilot (LOOM_AZURE_OPENAI_ENDPOINT). Empty derives from the Foundry Agent Service account when agentFoundryEnabled=true.')
param loomAzureOpenAiEndpoint string = ''

@description('Azure OpenAI Chat Completions API version (LOOM_AOAI_API_VERSION) used by the Copilot / data-agent orchestrators. Default 2024-10-21; advance to 2025-01-01-preview or later for o-series reasoning models. Cloud-invariant — the data-plane HOST is derived per-boundary from environment() (openai.azure.us vs openai.azure.com).')
param loomAoaiApiVersion string = '2024-10-21'

@description('Azure OpenAI Evals (preview) API version (LOOM_AOAI_EVALS_API_VERSION) used by the AI Foundry Evaluations surface. Default "preview". Cloud-invariant — the data-plane HOST is derived per-boundary from environment().')
param loomAoaiEvalsApiVersion string = 'preview'

@description('Azure OpenAI fine-tuning + files (v1) API version (LOOM_AOAI_FT_API_VERSION) used by the AI Foundry Fine-tuning surface + dataset uploads. Default 2024-10-21. Cloud-invariant — only the data-plane host differs per boundary.')
param loomAoaiFtApiVersion string = '2024-10-21'

// =====================================================================
// Bring-your-own existing services (reuse instead of provision-new).
//
// When an existing<Service> name is set, the matching admin-plane module is
// NOT deployed and the Console wires its env to the existing resource (in any
// RG/sub). Empty → provision new per the *Enabled flag. Reuse-first deploys
// set these via readEnvironmentVariable('EXISTING_*', '') in the .bicepparam.
// Role grants for reused resources are applied post-deploy (reuse-first,
// cross-sub) by scripts/csa-loom/grant-navigator-rbac.sh; the live env-var
// values (esp. cross-region ADX URI) are reconciled by patch-navigator-env.sh.
// See docs/fiab/bring-your-own-services.md.
// =====================================================================
@description('Reuse an existing Azure AI Search service (name) instead of provisioning one. Empty → provision new when aiSearchEnabled.')
param existingAiSearchService string = ''
@description('Resource group of the existing AI Search service. Empty defaults to this admin RG.')
param existingAiSearchRg string = ''
@description('Reuse an existing API Management service (name) instead of provisioning one. Empty → provision new when apimEnabled.')
param existingApimName string = ''
@description('Resource group of the existing APIM service. Empty defaults to this admin RG.')
param existingApimRg string = ''
@description('Reuse an existing ADX/Kusto cluster (name) instead of provisioning one. Empty → provision new when adxEnabled.')
param existingAdxClusterName string = ''
@description('Resource group of the existing ADX cluster. Empty defaults to this admin RG.')
param existingAdxClusterRg string = ''
@description('Reuse an existing AI Foundry / AOAI (AIServices) account (name) instead of provisioning the Foundry hub. Empty → provision new when aiFoundryEnabled.')
param existingFoundryAccountName string = ''
@description('Resource group of the existing Foundry/AOAI account. Empty defaults to this admin RG.')
param existingFoundryRg string = ''

// ---- Bring-your-own existing services — cross-sub (…Sub) dimension for the
// four admin-plane reuse pairs PLUS the remaining reusable services (Purview,
// Synapse, Cosmos, Event Hubs, Databricks) per
// docs/fiab/design/full-deployment-and-byo.md §4.2. Consolidated into ONE object
// param (the module is near Bicep's 256-param limit). Each field is a pure
// string pass-through used to build the LOOM_<SVC>_SUB Console env var (clients
// fall back to LOOM_SUBSCRIPTION_ID when empty) and/or override the navigator
// binding (reuse > provisioned). NOT used as Bicep `existing` cross-sub
// references — post-deploy RBAC is granted by grant-navigator-rbac.sh against
// whatever sub resolves here. Emitted by scripts/csa-loom/byo-wizard.sh. Keys:
//   aiSearchSub, apimSub, adxClusterSub, foundrySub,
//   purviewAccount,            (purviewRg/purviewSub are ignored — account-host data-plane)
//   synapseWorkspace, synapseRg, synapseSub,
//   cosmosAccount, cosmosRg, cosmosSub,
//   adfFactory, adfRg, adfSub,
//   eventHubNamespace, eventHubRg, eventHubSub,
//   databricksWorkspace, databricksRg, databricksSub, databricksHostname
@description('Bring-your-own existing-service overrides (cross-sub …Sub + Purview/Synapse/Cosmos/EventHubs/Databricks). See the key list in admin-plane/main.bicep; emitted by byo-wizard.sh.')
param byoExisting object = {}

@description('Azure ML workspace name backing the notebook AML path (deploy-planner mlWorkspace module). Empty → the AML notebook toggle honest-gates (LOOM_AML_WORKSPACE unset).')
param amlWorkspaceName string = ''
@description('Resource group of the Azure ML workspace. Empty defaults to this admin RG.')
param amlWorkspaceRg string = ''

// Effective "reuse-or-new" identities used for Console env wiring below.
var byoAiSearchRg = !empty(existingAiSearchRg) ? existingAiSearchRg : resourceGroup().name
var byoApimRg     = !empty(existingApimRg) ? existingApimRg : resourceGroup().name
var byoAdxRg      = !empty(existingAdxClusterRg) ? existingAdxClusterRg : resourceGroup().name
var byoFoundryRg  = !empty(existingFoundryRg) ? existingFoundryRg : resourceGroup().name
// Cross-sub (…Sub) resolution — empty falls back to the deployment subscription.
var byoAiSearchSub = !empty(byoExisting.?aiSearchSub ?? '') ? byoExisting.aiSearchSub : subscription().subscriptionId
var byoApimSub     = !empty(byoExisting.?apimSub ?? '') ? byoExisting.apimSub : subscription().subscriptionId
var byoAdxSub      = !empty(byoExisting.?adxClusterSub ?? '') ? byoExisting.adxClusterSub : subscription().subscriptionId
var byoFoundrySub  = !empty(byoExisting.?foundrySub ?? '') ? byoExisting.foundrySub : subscription().subscriptionId
// Gap A — when the operator REUSES an existing AOAI / AIServices account
// (existingFoundryAccountName, from scan EXISTING_AOAI), derive the inference
// endpoint + the chat/embed deployment names so the Console env wires the full
// AOAI surface (not just LOOM_AOAI_ACCOUNT). The deployment names come from the
// scan via the byoExisting object (foundryChatDeployment / foundryEmbedDeployment
// keys, emitted by discover-services.sh / byo-wizard.sh) — no new top-level
// param (admin-plane is at the 256-param ceiling). Endpoint suffix is sovereign-
// correct (openai.azure.us in Gov, else openai.azure.com), matching the module
// output expression so the existing path is wired identically to the new path.
var byoFoundryEndpoint = !empty(existingFoundryAccountName) ? 'https://${existingFoundryAccountName}.${environment().suffixes.storage != 'core.windows.net' ? 'openai.azure.us' : 'openai.azure.com'}/' : ''
var byoFoundryChatDeployment = string(byoExisting.?foundryChatDeployment ?? '')
var byoFoundryEmbedDeployment = string(byoExisting.?foundryEmbedDeployment ?? '')
// Purview — existingPurviewAccount overrides loomPurviewAccount (reuse > param).
// The Purview catalog data-plane is reached by account host (`{account}.purview.azure.com`)
// + a UAMI data-plane role assigned in the Purview portal — it is subscription-
// agnostic, so a reused cross-sub Purview needs no LOOM_PURVIEW_SUB/RG env wire
// (the account name alone resolves it). Those vars were dropped to avoid a dead wire.
var existingPurviewAccount = byoExisting.?purviewAccount ?? ''
var effPurviewAccount = !empty(existingPurviewAccount) ? existingPurviewAccount : loomPurviewAccount
// Cross-region Purview location (#229). Threaded via byoExisting (not a new
// scalar param — admin-plane/main.bicep is at the 256-param linter cap). Empty =
// hub location. catalog.bicep provisions the account + name in this region.
var effPurviewLocation = byoExisting.?purviewLocation ?? ''
// Synapse navigator — reuse > provisioned DLZ workspace.
var existingSynapseWorkspace = byoExisting.?synapseWorkspace ?? ''
var effSynapseWorkspace = !empty(existingSynapseWorkspace) ? existingSynapseWorkspace : (deSynapseEnabled ? loomSynapseWorkspace : '')
var byoSynapseRg        = !empty(byoExisting.?synapseRg ?? '') ? byoExisting.synapseRg : loomDlzRg
var byoSynapseSub       = !empty(byoExisting.?synapseSub ?? '') ? byoExisting.synapseSub : subscription().subscriptionId
// Cosmos control-plane navigator — reuse > provisioned DLZ account.
var existingCosmosAccount = byoExisting.?cosmosAccount ?? ''
var effCosmosAccount = !empty(existingCosmosAccount) ? existingCosmosAccount : loomCosmosAccount
var effCosmosRg      = !empty(byoExisting.?cosmosRg ?? '') ? byoExisting.cosmosRg : (!empty(loomCosmosAccountRg) ? loomCosmosAccountRg : loomDlzRg)
var byoCosmosSub     = !empty(byoExisting.?cosmosSub ?? '') ? byoExisting.cosmosSub : subscription().subscriptionId
// Data Factory navigator — reuse > provisioned DLZ factory. Name/RG/Sub flow
// into LOOM_ADF_NAME/RG/SUB, which adf-client reads (sub/rg fall back to the
// deployment sub + DLZ RG when empty).
var existingAdfFactory = byoExisting.?adfFactory ?? ''
var effAdfName = !empty(existingAdfFactory) ? existingAdfFactory : (deAdfEnabled ? loomAdfName : '')
var effAdfRg   = !empty(byoExisting.?adfRg ?? '') ? byoExisting.adfRg : (!empty(loomAdfRg) ? loomAdfRg : loomDlzRg)
var byoAdfSub  = !empty(byoExisting.?adfSub ?? '') ? byoExisting.adfSub : subscription().subscriptionId
// Event Hubs navigator — reuse > provisioned DLZ namespace.
var existingEventHubNamespace = byoExisting.?eventHubNamespace ?? ''
var effEventHubNamespace = !empty(existingEventHubNamespace) ? existingEventHubNamespace : loomEventHubNamespace
var effEventHubRg        = !empty(byoExisting.?eventHubRg ?? '') ? byoExisting.eventHubRg : (!empty(loomEventHubRg) ? loomEventHubRg : loomDlzRg)
var byoEventHubSub       = !empty(byoExisting.?eventHubSub ?? '') ? byoExisting.eventHubSub : (!empty(loomEventHubSub) ? loomEventHubSub : subscription().subscriptionId)
// Business-events Event Grid topic location — created in the DLZ RG /
// deployment sub by modules/landing-zone/eventgrid-business.bicep. The
// console's business-events client must target THAT RG/sub to find the topic,
// so default the empty params to the DLZ RG / deployment sub (mirroring the
// Event Hub navigator fallbacks above) instead of leaving them blank. Without
// this, LOOM_EVENTGRID_RG/SUB ship empty on a clean deploy and the topic
// lookup fails even though the topic exists.
var effEventGridRg       = !empty(loomEventGridRg) ? loomEventGridRg : loomDlzRg
var effEventGridSub      = !empty(loomEventGridSub) ? loomEventGridSub : subscription().subscriptionId
// Databricks navigator — reuse hostname > provisioned/patched hostname.
var existingDatabricksHostname = byoExisting.?databricksHostname ?? ''
var effDatabricksHostname = !empty(existingDatabricksHostname) ? existingDatabricksHostname : (deDatabricksEnabled ? loomDatabricksHostname : '')
// Sovereign-cloud ADX (Kusto) hostname suffix — Commercial/GCC vs GCC-High/IL5.
// Used only for the BYO (existingAdxClusterName) path; the provisioned cluster
// uses adxCluster.outputs.clusterUri (ARM-generated, already cloud-correct).
var kustoSuffix = boundary == 'GCC-High' || boundary == 'IL5' ? 'kusto.usgovcloudapi.net' : 'kusto.windows.net'

// Direct-Lake-shim derived values (Service Bus + Cosmos endpoint). The shim
// queue lives in the DLZ RG alongside the ADLS Delta source. These are vars
// (not module outputs) so the shim/Console app env can reference them even
// when the aasShim module is skipped (loomDirectLakeShimEnabled=false).
var dlShimSbNamespaceName = !empty(loomDirectLakeShimSbNamespace) ? loomDirectLakeShimSbNamespace : 'sb-loom-dlshim-${location}'
var dlShimSbSuffix = environment().suffixes.storage == 'core.usgovcloudapi.net' ? 'servicebus.usgovcloudapi.net' : 'servicebus.windows.net'
var dlShimSbFqdn = '${dlShimSbNamespaceName}.${dlShimSbSuffix}'
var dlShimQueueId = '${subscription().id}/resourceGroups/${loomDlzRg}/providers/Microsoft.ServiceBus/namespaces/${dlShimSbNamespaceName}/queues/${loomDirectLakeShimQueue}'
var loomCosmosEndpointVal = !empty(loomCosmosAccount) ? 'https://${loomCosmosAccount}.documents.${environment().suffixes.storage == 'core.usgovcloudapi.net' ? 'azure.us' : 'azure.com'}:443/' : ''

// CSA Loom family sweep (Power Platform / ML / Geo / Graph): the DLZ
// orchestrator emits Cosmos Gremlin + NoSQL Vector endpoints when
// `cosmosGraphVectorEnabled = true`. Pass them through here so the
// Console BFF picks them up at runtime.
@description('Cosmos Gremlin endpoint (e.g. wss://<acct>.gremlin.cosmos.azure.com:443/). When empty, the cosmos-gremlin-graph editor surfaces its honest-gate MessageBar.')
param loomCosmosGremlinEndpoint string = ''
@description('Cosmos Gremlin database (default: loom-graph)')
param loomCosmosGremlinDatabase string = ''
@description('Cosmos Gremlin graph (default: default)')
param loomCosmosGremlinGraph string = ''
@description('Cosmos NoSQL vector endpoint for the vector-store editor. When empty, the editor only persists the spec without dispatch.')
param loomCosmosVectorEndpoint string = ''
@description('Cosmos NoSQL vector database (default: loom-vectors)')
param loomCosmosVectorDatabase string = ''
@description('Cosmos NoSQL vector container (default: docs-vec)')
param loomCosmosVectorContainer string = ''
// Weave (Semantic Ontology) graph store — the DLZ postgres-weave module emits a
// PG flexible-server FQDN (Apache AGE enabled) when weaveOntologyEnabled=true.
// Pass them through so the Console BFF (lib/azure/weave-ontology-store.ts) binds
// to the deployed server for object/link/action instance write-back.
@description('Weave ontology PostgreSQL + Apache AGE server FQDN (e.g. psql-loom-weave-default-xyz.postgres.database.azure.com). When empty, the Ontology editor Objects / Write-back actions surfaces show the honest-gate MessageBar naming LOOM_WEAVE_PG_FQDN + postgres-weave.bicep.')
param loomWeavePgFqdn string = ''
@description('Weave ontology PostgreSQL database holding the AGE graph (default: loom-weave).')
param loomWeavePgDatabase string = ''
@description('Weave AGE graph name created by the post-deploy bootstrap (default: loom_ontology).')
param loomWeaveGraph string = ''
@description('Azure Maps account name (e.g. maps-csa-loom-xyz). When empty, the geo-map / map editors fall back to OSM and surface the honest-gate MessageBar.')
param loomAzureMapsAccount string = ''
@description('Azure Maps primary key secret name in Key Vault (default: loom-azure-maps-primary-key). The Console reads this via secretRef.')
param loomAzureMapsKeySecretName string = 'loom-azure-maps-primary-key'

@description('Purview account name (short, NOT full URL) — e.g. "purview-csa-loom-eastus2". When empty, /admin/security Purview tab + /api/items/data-product/*/register-purview return HTTP 503 with a structured remediation hint.')
param loomPurviewAccount string = ''

@description('Enable Microsoft Information Protection (sensitivity labels / label policies + /admin/batch-labeling real MIP labels) calls via Microsoft Graph. DEFAULTS ON (opt-out): the post-deploy bootstrap grants the Console UAMI InformationProtectionPolicy.Read.All by default, so the surface uses real labels day-one once a Tenant Administrator issues admin consent (until then the tab renders the honest 503 NotConfigured MessageBar, never an empty stub). When false, /admin/security Information Protection + batch-labeling MIP labels are suppressed.')
param loomMipEnabled bool = true

@description('Enable sensitivity-label + label-policy CRUD (create/edit/delete) via the SCC PowerShell sidecar. Deploys azure-functions/scc-labels and wires LOOM_MIP_ADMIN_ENABLED / LOOM_SCC_LABELS_ENDPOINT / LOOM_SCC_LABELS_KEY into the Console. The sidecar needs the SCC app (Exchange.ManageAsApp + Compliance Administrator) + auth cert provisioned in post-deploy bootstrap. When false (default), label/policy READS still work but CRUD returns the honest 503 mip_admin_not_configured gate.')
param loomMipAdminEnabled bool = false

@description('Entra app (client) id for the SCC labels sidecar (Connect-IPPSSession -AppId). Set by bootstrap once the app + cert exist.')
param sccAppId string = ''

@description('Auth certificate thumbprint for the SCC labels sidecar (loaded via WEBSITE_LOAD_CERTIFICATES).')
param sccCertThumbprint string = ''

@description('Tenant onmicrosoft.com domain passed to Connect-IPPSSession -Organization (e.g. contoso.onmicrosoft.com).')
param sccOrganization string = ''

@description('Optional SCC PowerShell ConnectionUri override for sovereign clouds (Gov/GCC-High/DoD). Empty uses the Commercial default.')
param sccConnectionUri string = ''

@description('Enable Purview DLP (policies / rules / alerts / simulate) calls via Microsoft Graph. Defaults ON: the post-deploy bootstrap grants Console UAMI Policy.Read.All + SecurityAlert.Read.All by default, so LOOM_DLP_ENABLED is injected out of the box and the /admin/security DLP tab is wired (no "not wired in this deployment"). Alerts/violations work in every cloud once admin consent is issued; the preview-gated policy segment + simulate surface honest MessageBars where unavailable; the Restrict-access tab uses Azure-native ADLS/Synapse/ADX revokes with no Graph dependency.')
param loomDlpEnabled bool = true

@description('Enable DLP policy CRUD (create/edit/delete DLP compliance policies + rules) via the SCC PowerShell sidecar — Microsoft Graph has NO DLP write API, so authoring runs through Get/New/Set/Remove-DlpCompliancePolicy. Reuses the same scc-labels Function app + app identity (Exchange.ManageAsApp + Compliance Administrator) as label CRUD; setting this true also deploys that sidecar if loomMipAdminEnabled is false. Defaults off — DLP READS, alerts, violations + Azure-native Restrict-access keep working; only CRUD is gated until the SCC app + auth cert are provisioned in post-deploy bootstrap.')
param loomDlpAdminEnabled bool = false

// ---------------------------------------------------------------------------
// Govern → Admin view (F2) "View more" embedded report backend.
//   - Power BI Embedded (A1)  : Commercial / GCC "View more" backend.
//   - Azure Managed Grafana   : GCC-High / IL5 "View more" backend.
// Both default OFF so existing deployments are unchanged; the BFF
// /api/governance/govern/embed honestly gates when neither is wired.
// ---------------------------------------------------------------------------
@description('Deploy a Power BI Embedded (A1) capacity for the Govern Admin "View more" report (Commercial / GCC). Set LOOM_REPORT_KIND=powerbi + the report env vars after publishing a report.')
param pbiEmbeddedEnabled bool = false

@description('Deploy Azure Managed Grafana for the Govern Admin "View more" dashboard (GCC-High / IL5). Set LOOM_REPORT_KIND=grafana + the dashboard env vars after creating a dashboard.')
param managedGrafanaEnabled bool = false

@description('LOOM_REPORT_KIND for the Govern Admin "View more" report. "powerbi" (Commercial/GCC), "grafana" (GCC-High/IL5), or empty to leave the surface honestly gated.')
@allowed([ '', 'powerbi', 'grafana' ])
param loomReportKind string = ''

@description('Power BI workspace id holding the governance report (when loomReportKind=powerbi).')
param loomGovernPbiWorkspaceId string = ''

@description('Power BI report id to embed in the Govern Admin "View more" (when loomReportKind=powerbi).')
param loomGovernPbiReportId string = ''

@description('Managed Grafana dashboard UID to embed (when loomReportKind=grafana). Endpoint is auto-wired from the deployed Grafana when managedGrafanaEnabled.')
param loomGrafanaDashboardUid string = ''

@description('F21 Usage page (/admin/usage) "Open analytics" embedded report kind. "powerbi" (Commercial/GCC) or "grafana" (GCC-High/IL5). Empty = the native Fluent charts + Log Analytics telemetry only (no embed). Power BI is Fabric-family and strictly opt-in (no-fabric-dependency.md).')
@allowed([
  ''
  'powerbi'
  'grafana'
])
param loomUsageReportKind string = ''

@description('Power BI workspace id holding the usage report (when loomUsageReportKind=powerbi).')
param loomUsagePbiWorkspaceId string = ''

@description('Power BI report id to embed in the Usage "Open analytics" panel (when loomUsageReportKind=powerbi).')
param loomUsagePbiReportId string = ''

@description('Managed Grafana dashboard UID for the Usage "Open analytics" panel (when loomUsageReportKind=grafana). Endpoint is shared with loomGrafanaDashboardUid via the deployed Grafana when managedGrafanaEnabled.')
param loomGrafanaUsageDashboardUid string = ''

@description('ADLS Gen2 / Blob container URL for custom domain images (optional). When set, the /admin/domains Image tab shows a gallery of image blobs in this container alongside the always-available preset color swatches + icon tiles. Format: https://<account>.dfs.core.windows.net/<container>[/<prefix>]. Grant the Console UAMI Storage Blob Data Reader on the container. When empty, only preset swatches and icons are offered (honest gate — no Fabric/OneLake dependency).')
param loomDomainImageStorage string = ''

@description('OPT-IN ONLY: additively mirror item-level permission grants (F6 Share / Manage permissions) to the Fabric item /share endpoint, on TOP of the always-on Azure-native backing (Cosmos item-permissions + ADLS POSIX ACL + Storage data-plane RBAC). Requires the Console UAMI to be a member of each Fabric workspace + the "Service principals can use Fabric APIs" tenant setting. Ignored in GCC-High / IL5 (no Fabric API). When false (default), F6 is 100% Azure-native — no Fabric workspace required (per no-fabric-dependency.md).')
param loomFabricPermissionsEnabled bool = false

@description('Enable the Power BI Admin InformationProtection.setLabels API used by /admin/batch-labeling to propagate a MIP sensitivity label to linked Power BI artifacts. Requires (1) loomMipEnabled=true for the label GUIDs, and (2) the Console UAMI to be a Fabric Administrator (a one-time M365/Entra admin action — NOT an Azure ARM role, so it cannot be granted from bicep). When false, batch labeling still writes Cosmos + Purview; the Power BI checkbox is hidden.')
param loomPowerBiAdminLabels bool = false

@description('Enable the reusable Identity Picker (Entra user/group/service-principal search + transitive nested-group resolution) via Microsoft Graph. Requires the Console UAMI to have User.Read.All + Group.Read.All + Application.Read.All admin-consented (scripts/csa-loom/grant-identity-graph-approles.sh). When false, /api/governance/identities/search returns 503 with the exact remediation and the picker renders an honest-gate MessageBar. Enabling this ALSO unlocks per-toggle security-group scoping ("Apply to": Entire org / Specific groups / Except groups) on /admin/tenant-settings (F2) — the same Group.Read.All grant covers the group search + bulk getByIds display-name resolution; no extra param/env/role is needed. When false, F2 numeric params still save; the scope picker shows the same honest gate.')
param loomIdentityPickerEnabled bool = false

@description('Enable workspace ↔ Microsoft 365 group linking (workspace settings → "Teams and SharePoint" tab). When true, sets LOOM_WORKSPACE_M365_LINK=true on the Console and documents the additional Group.ReadWrite.All Graph AppRole the Console UAMI needs to CREATE a group for a workspace. Linking an EXISTING group needs only Group.Read.All (already covered by the identity picker grant). Default false so existing deployments do not get a surprise consent prompt.')
param loomWorkspaceM365LinkEnabled bool = false

@description('Enable per-domain Entra security-group provisioning for the D2 domain-admin / domain-contributor RBAC tiers. When true, sets LOOM_DOMAIN_GROUP_PROVISIONING=true on the Console and ORs the Group.ReadWrite.All Graph AppRole into the identity-graph-rbac documented set (the same AppRole workspace M365 linking uses). The Console then auto-creates loom-domain-<id>-admins + loom-domain-<id>-contributors security groups at domain-create time and binds them on /admin/permissions (Domain access). Default false — domains still work via the legacy admins[]/contributors model; when false POST /api/admin/domains?provisionGroups returns 503 with the exact remediation.')
param loomDomainGroupProvisioningEnabled bool = false

@description('Enable OneLake-shortcut sources to SharePoint document libraries and OneDrive folders via Microsoft Graph (lakehouse editor → New shortcut → SharePoint / OneDrive). When true, sets LOOM_SHAREPOINT_SHORTCUTS_ENABLED=true on the Console and documents the Graph Sites.Read.All + Files.Read.All AppRoles the Console UAMI needs (scripts/csa-loom/grant-shortcut-graph-approles.sh + admin consent). Azure-native parity with Fabric OneLake OneDrive/SharePoint shortcuts; NO Fabric dependency. When false, the SharePoint source renders but the browse/create return 503 with the exact remediation (no mock data).')
param loomSharepointShortcutsEnabled bool = false

@description('Resource-group name prefix for dedicated per-workspace backing resource groups created from the workspace create wizard (Advanced → "Provision a dedicated resource group"). The wizard appends a short workspace id. The Console UAMI needs Contributor at subscription scope to create them.')
param loomWorkspaceRgPrefix string = 'rg-loom-ws-'

@description('Azure AD tenant ID for MSAL on the Console.')
param loomMsalTenantId string = subscription().tenantId

@description('Azure AD app (client) ID of the Entra app registration backing MSAL. When empty, MSAL env vars omitted (Console runs unauth).')
param loomMsalClientId string = ''

@description('Azure AD app client secret stored in Key Vault as secret "loom-msal-client-secret". When empty, MSAL env vars omitted.')
@secure()
param loomMsalClientSecret string = ''

@description('Session cookie secret (HKDF input). When empty, a STABLE per-RG GUID is derived (guid(rg.id, ...)) so sign-ins survive redeploys; pass an explicit value (LOOM_SESSION_SECRET) for a tenant-managed secret. newGuid() cannot be used here because this param is also assignable from a .bicepparam, where newGuid() is invalid (BCP065).')
@secure()
param loomSessionSecret string = ''

@description('Entra app-registration (MSAL) provisioning config — passed as ONE object to stay under the 256-param ARM limit (this module is already near it). Fields: enabled (bool, default true — provision the app reg + client secret + stable SESSION_SECRET in Key Vault by default, opt-out; OFF runs the Console unauth / BYO via loomMsalClientId); scriptIdentityId (UAMI with Graph app-admin + KV Secrets Officer for the in-bicep deploymentScript — empty → the post-deploy bootstrap workflow provisions the app reg, the default push-button path); scriptIdentityClientId; scriptSubnetId (VNet-inject the script to reach the PE-locked KV); consoleHosts (comma-separated redirect-URI hosts, no scheme — localhost is always added; the bootstrap adds the runtime FQDN).')
param loomMsalAppReg object = {
  enabled: true
  scriptIdentityId: ''
  scriptIdentityClientId: ''
  scriptSubnetId: ''
  consoleHosts: ''
}

// =====================================================================
// Phase 2 — RBAC tenant-admin bootstrap + install-time provisioning targets
// =====================================================================

@description('Entra group oid(s) — comma-separated — whose members bypass the Loom Feature Permissions gate. Bootstrap admins need this set OR loomTenantAdminOid to manage /admin/permissions before any grants exist.')
param loomTenantAdminGroupId string = ''

@description('Entra user oid that bypasses the Loom Feature Permissions gate. Used in single-user bootstrap scenarios. Members of loomTenantAdminGroupId are recommended for production.')
param loomTenantAdminOid string = ''

// Bootstrap admin is never blank: when no explicit OID and no real admin group
// is supplied, fall back to the deploying principal (deployer().objectId) so the
// push-button deploy always has a working admin who can grant others access from
// the empty state (PRP deploy-readiness gap #4). A non-empty group id (even the
// placeholder) does not suppress this — the deployer-as-admin fallback is
// harmless and guarantees first-login admin access.
var hasRealAdminGroup = !empty(loomTenantAdminGroupId) && !startsWith(loomTenantAdminGroupId, '<')
var effectiveTenantAdminOid = !empty(loomTenantAdminOid) ? loomTenantAdminOid : (hasRealAdminGroup ? '' : deployer().objectId)

@description('Default Fabric/Power BI workspace id the Phase-2 install engine uses when a Loom workspace has no bound Fabric group yet. Optional — the wizard prompts when missing.')
param loomDefaultFabricWorkspace string = ''

@description('OPT-IN ONLY: route the cross-item Copilot through a real Fabric/Power BI Copilot capacity workspace. The empty default keeps the Copilot 100% Azure-native (Azure OpenAI) with NO Fabric/Power BI call — no Fabric workspace required (per no-fabric-dependency.md). Set to "fabric" AND provide loomDefaultFabricWorkspace to opt in: the orchestrator then validates the bound workspace via api.fabric.microsoft.com before each session (LLM inference still runs on Azure OpenAI; Fabric Copilot exposes no public invocation API). Ignored in GCC-High / IL5 — Fabric Copilot is not supported in sovereign clouds.')
@allowed(['', 'fabric'])
param loomCopilotBackend string = ''

// Phase-2 warehouse provisioner backend folded into loomBackends.warehouse
// (kept as a var to stay under the ARM 256-param ceiling — data-eng sweep).
var loomWarehouseBackend = loomBackends.?warehouse ?? 'synapse-dedicated'

@description('Opt-in only: Fabric workspace id that backs the warehouse when loomWarehouseBackend=fabric-warehouse. Required to surface GPU-accelerated query execution; leave empty for the Azure-native Synapse default (result-set caching acceleration).')
param loomWarehouseFabricWorkspace string = ''

// =====================================================================
// Azure-native backend selectors (no-fabric-dependency)
// =====================================================================

@description('Azure Data Lake Storage Gen2 bronze container name. Default: bronze.')
param loomBronzeContainer string = 'bronze'

// Pipeline orchestrator backend selector folded into loomBackends.pipeline
// (kept as a var to stay under the ARM 256-param ceiling — data-eng sweep).
var loomPipelineBackend = loomBackends.?pipeline ?? 'synapse'





@description('Data mirroring backend selector. Default: adf-cdc (Azure Data Factory Change Data Capture). Alternatives: synapse-link, fabric.')
@allowed(['adf-cdc', 'synapse-link', 'fabric'])
param loomMirrorBackend string = 'adf-cdc'

@description('Azure-native backend selectors for Fabric-flavored items, bundled into one object to stay under the ARM 256-parameter template limit. Each key defaults to the Azure-native path; set a value to "fabric"/"powerbi" to opt into the Fabric/Power BI alternative for that item (per no-fabric-dependency rule). The orgVisuals key is an opt-out toggle (default "enabled") for the Embed codes (F22) + Organizational visuals (F23) container grant + LOOM_ORG_VISUALS_URL env — set "disabled" to honest-gate those panes while keeping the medallion lake wired.')
param loomBackends object = {
  event: 'eventhubs'
  activator: 'azure-monitor'
  activatorTable: 'AppEvents_CL'
  dashboard: 'adx'
  lakehouse: 'adls'
  catalog: 'azure'
  bi: ''
  domains: 'cosmos'
  dataflow: 'adf'
  dataproducts: ''
  orgVisuals: 'enabled'
  // Folded out of standalone params (data-eng deploy-readiness sweep) to stay
  // under the ARM 256-parameter ceiling; consumed via same-named vars above so
  // every downstream LOOM_WAREHOUSE_BACKEND / LOOM_PIPELINE_BACKEND env is unchanged.
  warehouse: 'synapse-dedicated'
  pipeline: 'synapse'
}



// NOTE: loomSemanticBackend is declared once earlier in this file (the
// allow-list there is the union of all opt-in backends). loomAasServer /
// loomAasModel / loomAasDatabase are also declared once earlier (semantic-model
// Power Query ingest refresh + DAX tile path share the same env vars). Re-
// declaring any of them here would produce BCP028.

// NOTE: loomAasServer / loomAasModel are declared once earlier in this file
// (semantic-model Power Query ingest refresh path). They are REUSED below by
// the DAX tile / semantic execution path so a single set of env vars feeds
// both flows. Re-declaring them here would produce BCP028.

@description('Azure region of the AAS server (e.g. eastus2). Used by the DirectQuery source binder; falls back to the deployment location.')
param loomAasRegion string = location

@description('Azure Analysis Services SKU when loomSemanticBackend=analysis-services. Standard tier only — S0 is the cheapest Standard SKU and is broadly available. Developer (D1) and Basic (B1/B2) tiers are excluded because they are not offered in many regions (centralus exposes only S0, S1, S2, S4, S8v2, S9v2). AAS is Commercial/GCC only — never deployed at GCC-High / IL5 (the orchestrator guards on boundary).')
@allowed(['S0', 'S1', 'S2', 'S4', 'S8v2', 'S9v2'])
param loomAasSku string = 'S0'

@description('Pre-existing AAS server URL (asazure://<region>.asazure.windows.net/<name>) to wire as LOOM_AAS_SERVER_URL instead of deploying a new server. Leave empty to let analysis-services.bicep create one (requires loomSemanticBackend=analysis-services on a Commercial/GCC boundary). Power BI Premium XMLA users set LOOM_POWERBI_XMLA_ENDPOINT directly instead.')
param loomAasServerUrl string = ''

@description('HTTPS XMLA endpoint for semantic-model authoring that requires the XMLA write surface (e.g. Automatic aggregations, RLS/OLS role authoring). Azure-native default: an Azure Analysis Services server (https://<server>.asazure.windows.net/xmla, or .asazure.usgovcloudapi.net in Gov). A Power BI Premium / Fabric capacity XMLA endpoint (https://api.powerbi.com/xmla, https://api.powerbigov.us/xmla) is an opt-in alternative selected purely by URL. Empty = the Aggregations + Security surfaces render but show an honest MessageBar gate (no Fabric dependency).')
param loomPowerbiXmlaEndpoint string = ''

// NOTE: loomAasDatabase (TMSL Catalog) is declared once earlier in this file
// (defaulted to 'model'). The column-editor path reuses the same param.

@description('Resource group hosting the AAS server (used only for the ARM server picker). Empty falls back to the Console UAMI default scope.')
param loomAasResourceGroup string = ''

@description('Service-principal client id (appId) made an AAS server admin for data-plane XMLA (RLS/OLS role authoring via LOOM_AAS_CLIENT_ID/SECRET). Empty = the Console UAMI is the sole AAS admin (composite-model path). Store the SPN secret in Key Vault and wire LOOM_AAS_CLIENT_SECRET as a secretRef.')
param aasSpnClientId string = ''

@description('Azure Analysis Services SKU for the composite-model server. Standard tier only — S0 is the smallest/cheapest Standard SKU and is broadly available across regions. The Developer (D1) and Basic (B1/B2) tiers are NOT offered in many regions (e.g. centralus exposes only S0, S1, S2, S4, S8v2, S9v2), so they are no longer selectable here to avoid SkuNotAvailable on a day-one deploy. S8v2 / S9v2 are the v2 high-QPU SKUs.')
@allowed(['S0', 'S1', 'S2', 'S4', 'S8v2', 'S9v2'])
param aasSku string = 'S0'




@description('Purview Unified Catalog account name (or per-tenant -api host) backing the F22 data-product adapter. When set alongside loomBackends.dataproducts="unified-catalog" on the Commercial boundary, the Console routes data-product CRUD through the Unified Catalog REST API (https://api.purview-service.microsoft.com) instead of Cosmos. Leave empty on GCC / GCC-High / IL5 — the factory ignores it and uses Cosmos regardless. Independent of loomPurviewAccount (the classic Data Map account).')
param loomPurviewUnifiedAccount string = ''


// ---------------------------------------------------------------------
// Copy Job watermark control table (F14 — Fabric Copy job parity)
// ---------------------------------------------------------------------

@description('FQDN of the Azure SQL server holding the copy-job watermark control table (dbo.copy_watermark), e.g. sql-loom-ctrl.database.windows.net. Empty = incremental copy surfaces an honest-gate MessageBar; full copy still works.')
param loomCopyJobControlSqlServer string = ''

@description('Database name for the copy-job watermark control table.')
param loomCopyJobControlSqlDb string = 'loom-control'

@description('Deploy the copy-job control table + stored procedure (and grant the ADF factory + console UAMI) via a deployment script. Requires loomCopyJobControlSqlServer set and the console UAMI configured as an Entra admin on that SQL server.')
param copyJobControlEnabled bool = false



@description('Explicit Azure ML MLflow tracking URI for the ML Experiment editor. REQUIRED in IL5 / GCC-High (the commercial *.api.azureml.ms host is wrong there and no public alternate hostname is documented). Get it via `az ml workspace show --query mlflow_tracking_uri -o tsv`. Empty in Commercial / GCC, where the editor auto-constructs the URI from LOOM_AML_WORKSPACE/LOOM_FOUNDRY_NAME + region + subscription.')
param loomMlflowTrackingUri string = ''

// =====================================================================
// 1. Monitoring (LAW + AppInsights + Sentinel + AI rules) — FIRST
// because every other module wires diagnostic settings to it.
// =====================================================================

module monitoring 'monitoring.bicep' = {
  name: 'monitoring'
  params: {
    location: location
    defenderForAIEnabled: defenderForAIEnabled
    complianceTags: complianceTags
    skipRoleGrants: skipRoleGrants
    publicIngestionEnabled: monitorPublicIngestionEnabled
    // /monitor Logs (KQL) tab — Console UAMI gets Log Analytics Reader on the LAW.
    consolePrincipalId: identity.outputs.uamiConsolePrincipalId
  }
}

// Day-one DEFAULT Azure Monitor alert rules + action group (opt-out). Lands in
// THIS admin RG, which is the LOOM_ALERT_RG default (LOOM_ALERT_RG =
// resourceGroup().name when loomAlertRg is empty — see the apps[] env below), so
// the /monitor Alerts surface (lib/azure/monitor-client.listScheduledQueryRules,
// scoped to LOOM_ALERT_RG) finds these rules out of the box. Azure-native
// Activator parity — no Microsoft Fabric required (no-fabric-dependency.md).
// (If an operator overrides loomAlertRg to a SEPARATE RG, the default set still
// installs here in the admin RG; they manage alerts in their chosen RG and the
// always-on Monitoring Contributor grant + the Activator wizard cover that path.)
module defaultAlerts 'monitoring-default-alerts.bicep' = {
  name: 'monitoring-default-alerts'
  params: {
    location: location
    complianceTags: complianceTags
    lawId: monitoring.outputs.lawId
    consoleAppName: 'loom-console'
    // No admin email param day-one (keeps the admin-plane module under the
    // 256 ARM/Bicep parameter limit). The default rules notify subscription
    // Owners (the admin group) via the ARM-role receiver; an operator adds an
    // email/SMS/webhook receiver to the loom-default-alerts action group from
    // the /monitor Alerts editor. Opt-out via the module's skipDefaultAlerts.
    notifyOwners: true
  }
}

// =====================================================================
// 2. Network foundation
// =====================================================================

module network 'network.bicep' = {
  name: 'network'
  params: {
    location: location
    hubVnetCidr: hubVnetCidr
    boundary: boundary
    containerPlatform: containerPlatform
    workspaceId: monitoring.outputs.lawId
    complianceTags: complianceTags
    // F15 — grant the Console UAMI Network Contributor on this RG so the
    // Advanced-networking pane can write NSG rules + create private endpoints.
    consolePrincipalId: identity.outputs.uamiConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    firewallEnabled: firewallEnabled
    // Reconcile passes (skipRoleGrants=true) are exactly the redeploys where a
    // firewall-policy re-PUT trips FirewallPolicyUpdateFailed ("faulted referenced
    // firewalls"). Reuse that signal so the network module references the EXISTING
    // policy instead of re-PUTing it — no extra top-level param needed.
    firewallPolicyReconcile: skipRoleGrants
  }
}

// =====================================================================
// Azure Analysis Services — optional semantic-model XMLA backend.
// Deployed only when the operator opts into the AAS backend AND has not
// supplied a pre-existing server URL. Guarded on the boundary because AAS
// is Commercial / GCC only (not available in GCC-High / IL5). In Gov the
// Console falls back to LOOM_POWERBI_XMLA_ENDPOINT or an honest gate.
// =====================================================================
var deployAas = loomSemanticBackend == 'analysis-services' && empty(loomAasServerUrl) && !contains(['GCC-High', 'IL5'], boundary)

module analysisServices 'analysis-services.bicep' = if (deployAas) {
  name: 'analysis-services'
  params: {
    location: location
    consolePrincipalId: identity.outputs.uamiConsolePrincipalId
    aasAdminUpn: ''
    skuName: loomAasSku
    skipRoleGrants: skipRoleGrants
    tags: complianceTags
  }
}

// =====================================================================
// 3. Managed identities
// =====================================================================

module identity 'identity.bicep' = {
  name: 'identity'
  params: {
    location: location
    complianceTags: complianceTags
  }
}

// =====================================================================
// 4. Key Vault Premium (+ HSM if IL5)
// =====================================================================

module keyvault 'keyvault.bicep' = {
  name: 'keyvault'
  params: {
    location: location
    hsmIsolated: keyVaultHsmIsolated
    adminEntraGroupId: adminEntraGroupId
    consolePrincipalId: identity.outputs.uamiConsolePrincipalId
    // MCP app UAMI gets Key Vault Secrets User (read-only) so catalog-deployed
    // MCP servers can resolve their auth secret via Container Apps secretRef.
    mcpPrincipalId: identity.outputs.uamiMcpPrincipalId
    consolePrincipalNeedsCmkRole: consolePrincipalNeedsCmkBind
    skipRoleGrants: skipRoleGrants
    privateEndpointSubnetId: network.outputs.privateEndpointsSubnetId
    privateDnsZoneVaultId: network.outputs.privateDnsZoneIds.keyvault
    workspaceId: monitoring.outputs.lawId
    complianceTags: complianceTags
    // Built-in MCP shared API key — mirrored into KV so the Console (private-
    // endpoint reachable) can load it for one-click registration. Default-on.
    builtinMcpApiKeySecretName: loomBuiltinMcpActive ? loomBuiltinMcpApiKeySecretName : ''
    builtinMcpApiKey: loomBuiltinMcpActive ? loomBuiltinMcpApiKey : ''
  }
}

// =====================================================================
// 4b. Entra app registration (MSAL) — provisioned by default (opt-out).
// Day-one deploy-readiness (GH #1383): a fresh deploy gets a REAL app
// registration + client secret + stable SESSION_SECRET in Key Vault, with the
// redirect URIs reconciled to the console host — so interactive login works on
// first sign-in instead of returning a 500 (no credential) or AADSTS redirect
// mismatch. The app registration is a Graph object, so it runs as a
// deploymentScript when a Graph-app-admin script identity is supplied; the
// default push-button path provisions it via the post-deploy bootstrap workflow
// (scripts/csa-loom/bootstrap-msal-app-reg.sh — the SAME logic). The effective
// client id below feeds the Console env + secretRefs.
// =====================================================================
module entraAppReg 'entra-app-registration.bicep' = if (loomMsalAppRegEnabled && !empty(loomMsalAppRegScriptIdentityId)) {
  name: 'entra-app-registration'
  params: {
    location: location
    appDisplayName: 'CSA Loom Console (${resourceGroup().name})'
    // Pass the param hosts UNIONed with the live Front Door endpoint host so the
    // app registration registers https://<front-door>/auth/callback up front.
    // INCIDENT 2026-06-17: real users reach the console through Azure Front Door,
    // so the browser sends the FD host as redirect_uri. Registering only the ACA
    // ingress host caused AADSTS50011 redirect-URI mismatch → login dead. The
    // script merges (never overwrites) redirect URIs, so passing the FD host here
    // is additive and safe. (fdOn ⇒ frontDoor module deployed ⇒ host available.)
    consoleHosts: effectiveMsalConsoleHosts
    existingClientId: loomMsalClientId
    scriptIdentityId: loomMsalAppRegScriptIdentityId
    scriptSubnetId: loomMsalAppRegScriptSubnetId
    keyVaultName: keyvault.outputs.keyVaultName
    complianceTags: complianceTags
  }
}

// Entra app-registration config (read from the single object param — see
// loomMsalAppReg). Defaults keep the FLAG ON and the in-bicep script OFF (empty
// identity → the post-deploy bootstrap is the provisioner).
var loomMsalAppRegEnabled = bool(loomMsalAppReg.?enabled ?? true)
var loomMsalAppRegScriptIdentityId = string(loomMsalAppReg.?scriptIdentityId ?? '')
var loomMsalAppRegScriptSubnetId = string(loomMsalAppReg.?scriptSubnetId ?? '')
var loomMsalAppRegConsoleHosts = string(loomMsalAppReg.?consoleHosts ?? '')
// Union the configured console hosts with the live Front Door endpoint host so
// the in-bicep app-registration script registers the Front Door /auth/callback
// (the real user-facing host) — not just the ACA ingress FQDN. See INCIDENT
// 2026-06-17 note on the entraAppReg module call above.
var effectiveMsalConsoleHosts = fdOn ? (empty(loomMsalAppRegConsoleHosts) ? frontDoor.outputs.frontDoorEndpointHostName : '${loomMsalAppRegConsoleHosts},${frontDoor.outputs.frontDoorEndpointHostName}') : loomMsalAppRegConsoleHosts

// Effective MSAL client id: an explicit loomMsalClientId (BYO existing app)
// wins; otherwise the app-registration the entra-app-registration script
// provisioned. Empty here (default push-button) means the post-deploy bootstrap
// sets LOOM_MSAL_CLIENT_ID on the Console after the app registration is created.
var msalAppRegProvisioned = loomMsalAppRegEnabled && !empty(loomMsalAppRegScriptIdentityId)
var effectiveMsalClientId = !empty(loomMsalClientId) ? loomMsalClientId : (msalAppRegProvisioned ? entraAppReg!.outputs.appId : '')
// The client secret + SESSION_SECRET are KV-backed (read via keyVaultUrl
// secretRef) when the script provisioned them into Key Vault; otherwise inline
// (explicit param value / stable per-RG GUID) so day-one bicep-only deploys
// still mint sessions.
//
// INCIDENT (recurring, GH #1470): the loom-msal-client-secret Container App
// secret was baked as a LITERAL (keyVaultUrl null) on every estate where the
// MSAL secret was NOT provisioned by the in-bicep script
// (msalAppRegProvisioned=false → the post-deploy bootstrap writes it to KV
// instead). The bootstrap step ROTATES the Entra client secret + writes the new
// value to KV on every run, but a literal Container App secret keeps emitting
// the OLD value → AADSTS7000215 invalid_client → interactive login loops after
// each bootstrap run. The durable fix: make the secret a Key Vault REFERENCE
// (unversioned secret URI → Container Apps resolves the LATEST version on each
// new revision) whenever the deployment is wiring an MSAL client id AND the
// caller did not pin an explicit literal secret. Both provisioning paths (the
// in-bicep entra-app-registration script AND the post-deploy bootstrap) write
// the secret to KV under the same name (loom-msal-client-secret), so the KV
// reference is valid in either case; a rotation then propagates on the next
// revision roll. Only a BYO explicit literal secret (loomMsalClientSecret set)
// stays inline. The condition below KV-backs whenever no explicit literal was
// pinned AND the app-reg flow is the source of the secret (in-bicep script
// provisioned it, OR the flag is on so the bootstrap writes/rotates it in KV);
// when neither holds the prior inline behaviour is preserved.
var msalSecretKvBacked = empty(loomMsalClientSecret) && (msalAppRegProvisioned || loomMsalAppRegEnabled)
var sessionSecretKvBacked = msalAppRegProvisioned && empty(loomSessionSecret)

// Console's own `loom` Cosmos — HUB-scoped. Only deployed in tenant/dlz-attach
// topologies (deployConsoleCosmos), where no local DLZ exists to host the
// database the Console BFF reads/writes. Without this the Console renders but
// every item/config CRUD fails against a non-existent account (found on the
// centralus tenant clean-rebuild). Named loomCosmosAccount so the Console env
// (LOOM_COSMOS_ACCOUNT/ENDPOINT) binds to it with no change. Same posture as the
// DLZ cosmos.bicep: PE + disableLocalAuth + UAMI control/data-plane grants.
module consoleCosmos 'loom-console-cosmos.bicep' = if (deployConsoleCosmos && !empty(loomCosmosAccount)) {
  name: 'loom-console-cosmos'
  params: {
    location: location
    accountName: loomCosmosAccount
    privateEndpointSubnetId: network.outputs.privateEndpointsSubnetId
    privateDnsZoneCosmosId: network.outputs.privateDnsZoneIds.cosmos
    workspaceId: monitoring.outputs.lawId
    consolePrincipalId: identity.outputs.uamiConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
  }
}

// =====================================================================
// 5. Container registry
// =====================================================================

module registry 'registry.bicep' = {
  name: 'registry'
  params: {
    location: location
    privateEndpointSubnetId: network.outputs.privateEndpointsSubnetId
    privateDnsZoneAcrId: network.outputs.privateDnsZoneIds.acr
    workspaceId: monitoring.outputs.lawId
    complianceTags: complianceTags
  }
}

// =====================================================================
// 6. Container platform (Container Apps Env OR AKS)
// =====================================================================

module containerPlatformModule 'container-platform.bicep' = {
  name: 'container-platform'
  params: {
    location: location
    containerPlatform: containerPlatform
    containerSubnetId: network.outputs.containerPlatformSubnetId
    lawId: monitoring.outputs.lawId
    lawCustomerId: monitoring.outputs.lawCustomerId
    lawSharedKey: monitoring.outputs.lawSharedKey
    complianceTags: complianceTags
    // Scale & manage drawer → AKS node-pool scaling needs the Console UAMI to
    // hold "Azure Kubernetes Service Cluster Admin" on the cluster (AKS path).
    consolePrincipalId: identity.outputs.uamiConsolePrincipalId
    skipRoleGrants: skipRoleGrants
  }
}

// ---------------------------------------------------------------------------
// Built-in MCP tool server (azure-functions/mcp-server) — DEFAULT-ON
// ---------------------------------------------------------------------------
// The in-repo Python Azure Function exposing vetted, read-only Loom operations
// (catalog search + ARM inventory + ADF data-movement) as MCP tools. Provisioned
// by default so every Loom deployment ships a registrable built-in MCP endpoint.
// no-fabric-dependency: the tools call AI Search + ARM + ADF — all Azure-native.
//
// Default-on, expressed as a `var` (NOT a param) because admin-plane/main.bicep
// is at the hard ARM 256-parameter cap (see loomConsoleTelemetryEnabled above).
// Gated on deployAppsEnabled — the Python code is published separately (zip /
// `func azure functionapp publish`), the same precondition as the loom-* images.
var loomBuiltinMcpEnabled = true
var loomBuiltinMcpActive = loomBuiltinMcpEnabled && deployAppsEnabled
// KV secret name the Console loads the shared key from (via the MCP UAMI, which
// already holds Key Vault Secrets User). MUST be 'loom-mcp-api-key' — the
// built-in registration in mcp-servers-panel.tsx hardcodes that authValue.
// Deterministic key value — stable across redeploys (no churn), matching the
// loomInternalToken pattern.
var loomBuiltinMcpApiKeySecretName = 'loom-mcp-api-key'
var loomBuiltinMcpApiKey = guid(resourceGroup().id, 'loom-builtin-mcp-api-key-v1')
// AI Search service name for the catalog tool (BYO or freshly provisioned).
var effBuiltinMcpAiSearch = !empty(existingAiSearchService) ? existingAiSearchService : (aiSearchEnabled ? aiSearch!.outputs.searchName : '')

module builtinMcp 'builtin-mcp.bicep' = if (loomBuiltinMcpActive) {
  name: 'builtin-mcp'
  params: {
    location: location
    apiKey: loomBuiltinMcpApiKey
    loomSubscriptionId: subscription().subscriptionId
    loomResourceGroups: [ resourceGroup().name ]
    aiSearchService: effBuiltinMcpAiSearch
    adfName: effAdfName
    dlzResourceGroup: loomDlzRg
    armEndpoint: environment().resourceManager
    complianceTags: complianceTags
  }
}

// Function /api/mcp endpoint wired onto the Console as LOOM_BUILTIN_MCP_URL.
var builtinMcpUrl = loomBuiltinMcpActive ? builtinMcp!.outputs.mcpEndpoint : ''


// ---------------------------------------------------------------------------
// MCP persistence — Azure Files share + managedEnvironments/storages mount
// ---------------------------------------------------------------------------
//
// Container Apps does NOT support identity-based access to Azure file shares
// (Microsoft Learn — "Use storage mounts in Azure Container Apps"), so the
// storages registration uses the storage-account KEY (allowSharedKeyAccess must
// be true on THIS account; the app's own env secrets stay Key Vault-backed).
// Container Apps only — on AKS boundaries the MCP workload uses an Azure Files
// PVC (gitopsManifest path). Azure-native; no Microsoft Fabric dependency.
var mcpFilesActive = mcpPersistenceEnabled && containerPlatform == 'containerApps' && deployAppsEnabled
var mcpStorageAccountName = take('samcp${uniqueString(resourceGroup().id)}', 24)
var mcpShareName = 'mcp-data'
var mcpStorageRegistrationName = 'mcp-data'
var mcpMountPath = '/data'
// Managed-environment name — MUST match the deterministic name in
// container-platform.bicep (cae-csa-loom-${location}). Resolvable at the start
// of deployment (the storages child name cannot reference a module output).
var mcpCaeName = 'cae-csa-loom-${location}'

resource mcpStorage 'Microsoft.Storage/storageAccounts@2024-01-01' = if (mcpFilesActive) {
  name: mcpStorageAccountName
  location: location
  tags: complianceTags
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    allowBlobPublicAccess: false
    // REQUIRED by Container Apps Azure Files mounts (identity mounts unsupported).
    allowSharedKeyAccess: true
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    largeFileSharesState: 'Enabled'
    // The Container Apps SMB mount reaches the share over the Azure backbone;
    // AzureServices bypass keeps the account closed to the public internet for
    // ad-hoc access while permitting the managed-environment mount. Production
    // hardening (a private endpoint on the `file` sub-resource +
    // privatelink.file DNS zone) is the follow-up for fully-locked-down tenants.
    networkAcls: {
      defaultAction: 'Allow'
      bypass: 'AzureServices'
    }
  }

  resource fileServices 'fileServices@2024-01-01' = {
    name: 'default'
    resource share 'shares@2024-01-01' = {
      name: mcpShareName
      properties: { shareQuota: 100 }
    }
  }
}

// Register the share on the managed environment. The console's
// container-apps-arm-client re-PUTs this exact resource on the "Mount
// persistence" admin action (same accountKey-from-listKeys path).
resource mcpEnvStorage 'Microsoft.App/managedEnvironments/storages@2024-03-01' = if (mcpFilesActive) {
  name: '${mcpCaeName}/${mcpStorageRegistrationName}'
  dependsOn: [ containerPlatformModule ]
  properties: {
    azureFile: {
      accountName: mcpStorageAccountName
      accountKey: mcpFilesActive ? mcpStorage!.listKeys().keys[0].value : ''
      shareName: mcpShareName
      accessMode: 'ReadWrite'
    }
  }
}

// =====================================================================
// 7. AI Search
// =====================================================================

// Dedicated storage account for AI Search indexer/skillset debug-session state
// (container ms-az-cognitive-search-debugsession). Provisioned in the admin RG
// alongside the search service so the same-region system-MSI → storage
// connection is valid (per Learn, only a system-assigned MSI works for a
// same-region search→storage debug connection, via the trusted-service
// exception). Keyless: the search MSI is granted Storage Blob Data Contributor
// by ai-search.bicep, and the Console passes a `ResourceId=` connection string
// (no account key) — consistent with the search service's disableLocalAuth
// posture. Only deployed when a new AI Search service is provisioned.
var aiSearchDebugStorageName = take('sasrchdbg${uniqueString(resourceGroup().id)}', 24)

resource aiSearchDebugStorage 'Microsoft.Storage/storageAccounts@2024-01-01' = if (aiSearchEnabled && empty(existingAiSearchService)) {
  name: aiSearchDebugStorageName
  location: location
  tags: complianceTags
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    allowBlobPublicAccess: false
    // Keyless: the search MSI authenticates via Storage Blob Data Contributor;
    // no shared-key path is used for the debug-session connection.
    allowSharedKeyAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    // Trusted-service exception lets the AI Search system MSI reach the account
    // while keeping it closed to the public internet (same-region debug path).
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'AzureServices'
      ipRules: []
      virtualNetworkRules: []
    }
  }
}

module aiSearch 'ai-search.bicep' = if (aiSearchEnabled && empty(existingAiSearchService)) {
  name: 'ai-search'
  params: {
    location: location
    privateEndpointSubnetId: network.outputs.privateEndpointsSubnetId
    privateDnsZoneSearchId: network.outputs.privateDnsZoneIds.search
    workspaceId: monitoring.outputs.lawId
    adminEntraGroupId: adminEntraGroupId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
    // The governance-catalog index self-heals from the BFF (PE-locked service);
    // pass the Console UAMI so an operator can flip deployGovernanceIndex=true
    // when running on a VNet-injected script host.
    deployGovernanceIndex: false
    scriptIdentityId: identity.outputs.uamiConsoleId
    scriptIdentityClientId: identity.outputs.uamiConsoleClientId
    // Search Index Data Contributor → Console UAMI so the BFF can run the
    // vector-store data-plane ops (index PUT / docs index / docs search).
    consolePrincipalId: identity.outputs.uamiConsolePrincipalId
    // Grant the search system-MSI Storage Blob Data Contributor on the
    // debug-session storage account so indexer/skillset debug sessions can
    // persist their enrichment trace without an account key (keyless,
    // posture-correct). The Console passes the matching `ResourceId=`
    // connection string via LOOM_AI_SEARCH_DEBUG_STORAGE_CONN below.
    debugSessionStorageId: (aiSearchEnabled && empty(existingAiSearchService)) ? aiSearchDebugStorage.id : ''
  }
}

// =====================================================================
// 8. AI Foundry Hub (or Azure ML classic in boundaries without Foundry)
// =====================================================================

// Storage account for the AI Foundry Hub workspace (required dependency).
// Plain LRS Standard_v2, geo-redundancy off (matches DLZ policy), public
// network disabled, only the Foundry MI gets access via system role assignment.
resource foundryHubStorage 'Microsoft.Storage/storageAccounts@2024-01-01' = if (aiFoundryEnabled && empty(existingFoundryAccountName)) {
  name: take('safoundryhub${uniqueString(resourceGroup().id)}', 24)
  location: location
  tags: complianceTags
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    minimumTlsVersion: 'TLS1_2'
    publicNetworkAccess: 'Disabled'
    supportsHttpsTrafficOnly: true
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'AzureServices'
    }
  }
}

module aiFoundry 'ai-foundry.bicep' = if (aiFoundryEnabled && empty(existingFoundryAccountName)) {
  name: 'ai-foundry'
  params: {
    location: location
    boundary: boundary
    foundryPortalEnabled: foundryPortalEnabled
    hubStorageAccountId: foundryHubStorage!.id
    hubKeyVaultId: keyvault.outputs.keyVaultId
    hubContainerRegistryId: registry.outputs.acrId
    hubAppInsightsId: monitoring.outputs.appInsightsId
    workspaceId: monitoring.outputs.lawId
    privateEndpointSubnetId: network.outputs.privateEndpointsSubnetId
    privateDnsZoneAmlId: network.outputs.privateDnsZoneIds.azureml
    privateDnsZoneAmlApiId: network.outputs.privateDnsZoneIds.azuremlapi
    privateDnsZoneNotebooksId: network.outputs.privateDnsZoneIds.notebooks
    adminEntraGroupId: adminEntraGroupId
    consolePrincipalId: identity.outputs.uamiConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
  }
}

// =====================================================================
// =====================================================================
// 8a. Azure AI Content Safety — copilot moderation pipeline backend
// Standalone Content Safety account (Prompt Shields + harm analyze) that
// every copilot persona routes input + output through. The Console UAMI is
// granted Cognitive Services User so the BFF calls the data plane token-only.
// LOOM_CONTENT_SAFETY_ENDPOINT (wired below) gates the pipeline; when this
// module is off the Console honest-gates with a warning MessageBar.
// =====================================================================

module contentSafety '../deploy-planner/cognitive-account.bicep' = if (contentSafetyEnabled) {
  name: 'content-safety'
  params: {
    location: location
    kind: 'ContentSafety'
    nameFragment: 'contentsafety'
    skuName: 'S0'
    consolePrincipalId: identity.outputs.uamiConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
  }
}

// =====================================================================
// 8a-bis. Azure Analysis Services (opt-in composite-model host)
// Hosts a COMPOSITE tabular model mixing Import / DirectQuery / Dual
// storage modes. Off by default — the semantic-model item's default is the
// Loom-native tabular layer (no AAS required). See analysis-services.bicep.
// =====================================================================

module aas 'analysis-services.bicep' = if (aasEnabled) {
  name: 'aas'
  params: {
    location: location
    serverName: 'aasloom${uniqueString(resourceGroup().id)}'
    skuName: aasSku
    // All selectable aasSku values are Standard-tier (D1/B1/B2 removed — not
    // available in many regions, e.g. centralus). AAS rejects a server whose
    // sku.tier does not match the sku.name family, so this is always 'Standard'.
    skuTier: 'Standard'
    aasDatabase: 'LoomComposite'
    consolePrincipalId: identity.outputs.uamiConsolePrincipalId
    // RLS/OLS Security tab: when an operator supplies a dedicated SPN it becomes
    // the AAS data-plane admin (LOOM_AAS_CLIENT_ID authors roles over XMLA).
    // Otherwise the Console UAMI is the sole admin (composite-model path).
    aasAdminUpn: !empty(aasSpnClientId) ? 'app:${aasSpnClientId}@${tenant().tenantId}' : 'app:${identity.outputs.uamiConsoleClientId}@${tenant().tenantId}'
    // IMPORTANT: this `aas` (composite-model) module and the `aasServer`
    // (import-mode) module below BOTH resolve to the SAME physical AAS server —
    // both use server name `aasloom${uniqueString(resourceGroup().id)}`. If both
    // were allowed to grant the Console UAMI Reader, Azure would dedupe on
    // (principal,role,scope) and fail the second with RoleAssignmentExists
    // (pass-6 centralus deploy 2026-06-17). aas-server.bicep is the SINGLE owner
    // of the Reader grant on this shared server, so force-skip the grant here.
    // (The server-admin XMLA membership is data-plane, set independently below.)
    skipRoleGrants: true
    tags: complianceTags
  }
}
// Dedicated AIServices account + loom-agents project + chat/embedding
// model deployments. Backs LOOM_FOUNDRY_PROJECT_ENDPOINT + LOOM_AOAI_* for
// the Agent Service. Mirrors the live Commercial deployment one-for-one.
// =====================================================================

module agentFoundry '../ai/foundry-project.bicep' = if (agentFoundryEnabled) {
  name: 'agent-foundry'
  params: {
    location: location
    // Sovereign / private-only boundaries keep the account off the public net.
    publicNetworkAccess: boundary == 'Commercial'
    consolePrincipalId: identity.outputs.uamiConsolePrincipalId
    // MAF tier (GCC-High / IL5) UAMI gets Cognitive Services OpenAI User here so
    // the loom-copilot-maf Container App can call Gov AOAI direct. Empty in
    // non-Gov boundaries → grant skipped.
    mafPrincipalId: (copilotMafEnabled && (boundary == 'GCC-High' || boundary == 'IL5')) ? identity.outputs.uamiMafPrincipalId : ''
    skipRoleGrants: skipRoleGrants
    workspaceId: monitoring.outputs.lawId
    complianceTags: complianceTags
    // Private endpoint (Gap C) — only when the account is private-only
    // (non-Commercial). Bind the hub PE subnet + the privatelink.openai /
    // privatelink.cognitiveservices zones so AAD + key auth resolve inside the
    // VNet. Commercial keeps public access on and passes no subnet (day-one
    // works without VNet plumbing).
    privateEndpointSubnetId: boundary == 'Commercial' ? '' : network.outputs.privateEndpointsSubnetId
    privateDnsZoneOpenAiId: boundary == 'Commercial' ? '' : network.outputs.privateDnsZoneIds.openai
    privateDnsZoneCognitiveServicesId: boundary == 'Commercial' ? '' : network.outputs.privateDnsZoneIds.cognitiveservices
    // Optional dedicated ghost-text deployment. Empty => no extra deployment;
    // the Console route falls back to the chat deployment for inline completion.
    completionDeploymentName: loomAoaiCompletionDeployment
  }
}

// Shared Data API builder preview runtime (off by default — needs a SQL target).
module dabRuntime 'dab-runtime.bicep' = if (dabRuntimeEnabled && !empty(dabSqlServerFqdn)) {
  name: 'dab-runtime'
  params: {
    location: location
    managedEnvironmentId: containerPlatformModule.outputs.caeId
    uamiResourceId: identity.outputs.uamiConsoleId
    uamiClientId: identity.outputs.uamiConsoleClientId
    sqlServerFqdn: dabSqlServerFqdn
    sqlDatabase: dabSqlDatabase
  }
}

// =====================================================================
// 8b. Copy Job watermark control table (F14) — dbo.copy_watermark +
// dbo.usp_write_watermark in the control SQL DB, plus grants for the ADF
// factory MI + console UAMI. Opt-in; the console also self-heals the DDL.
// =====================================================================

module copyJobControl 'copy-job-control.bicep' = if (copyJobControlEnabled && !empty(loomCopyJobControlSqlServer)) {
  name: 'copy-job-control'
  params: {
    sqlServerFqdn: loomCopyJobControlSqlServer
    sqlDatabase: loomCopyJobControlSqlDb
    scriptIdentityId: identity.outputs.uamiConsoleId
    scriptIdentityClientId: identity.outputs.uamiConsoleClientId
    consoleUamiName: identity.outputs.uamiConsoleName
    adfFactoryName: loomAdfName
    azureCloud: boundary == 'GCC-High' || boundary == 'IL5' ? 'AzureUSGovernment' : 'AzureCloud'
    location: location
    complianceTags: complianceTags
  }
}


// =====================================================================
// 9. APIM (Premium V2 or classic Premium per boundary)
// =====================================================================

module apim 'apim.bicep' = if (apimEnabled && empty(existingApimName)) {
  name: 'apim'
  params: {
    location: location
    sku: apimSku
    publisherEmail: 'csa-loom-ops@example.com'   // override in .bicepparam
    apimSubnetId: network.outputs.apimSubnetId
    appInsightsId: monitoring.outputs.appInsightsId
    appInsightsInstrumentationKey: monitoring.outputs.appInsightsInstrumentationKey
    workspaceId: monitoring.outputs.lawId
    complianceTags: complianceTags
    // Console UAMI → "API Management Service Contributor" at the APIM scope so
    // the Admin → API Management panes work by default (no manual RBAC grant).
    consolePrincipalId: identity.outputs.uamiConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    seedSampleApi: seedSampleApi
  }
}
// =====================================================================
// 9b. Shared ADX cluster (admin-plane scope). DLZ databases attach here.
// =====================================================================

module adxCluster 'adx-cluster.bicep' = if (adxEnabled && empty(existingAdxClusterName)) {
  name: 'adx-cluster'
  params: {
    location: location
    skuName: adxSkuName
    enableOptimizedAutoscale: adxEnableOptimizedAutoscale
    autoscaleMinimum: adxAutoscaleMinimum
    autoscaleMaximum: adxAutoscaleMaximum
    workspaceId: monitoring.outputs.lawId
    complianceTags: complianceTags
    skipRoleGrants: skipRoleGrants
    // Console UAMI → Monitoring Contributor on the cluster (alert rules + diagnostics).
    consolePrincipalId: identity.outputs.uamiConsolePrincipalId
    // Continuous-export: grant cluster MI Storage Blob Data Contributor on the DLZ ADLS account.
    // Empty when loomStorageAccount is unset → grant is skipped → wizard shows honest gate.
    adlsAccountName: loomStorageAccount
    adlsAccountRg: loomDlzRg
    // EH data connections: grant cluster MI Azure Event Hubs Data Receiver on the DLZ EH namespace.
    // The namespace name follows the single-sub DLZ convention set in loomEventHubNamespace.
    ehNamespaceName: loomEventHubNamespace
    ehNamespaceRg: !empty(loomEventHubRg) ? loomEventHubRg : loomDlzRg
  }
}

// =====================================================================
// Azure Analysis Services (AAS) — Azure-native semantic-model backend.
// Hosts Import-mode tabular databases for the SemanticModelEditor's Storage
// Mode + Refresh surfaces (no Fabric / Power BI dependency). Skipped when
// reusing an existing server (existingAasServerName) or aasEnabled is false.
// =====================================================================
module aasServer 'aas-server.bicep' = if (aasEnabled && empty(existingAasServerName)) {
  name: 'aas-server'
  params: {
    location: location
    skuName: aasSkuName
    workspaceId: monitoring.outputs.lawId
    complianceTags: complianceTags
    skipRoleGrants: skipRoleGrants
    // Console UAMI: client id → AAS server-admin (app:{clientId}@{tenantId});
    // principal id → Reader (ARM list/get databases + schedule tag).
    consolePrincipalClientId: identity.outputs.uamiConsoleClientId
    consolePrincipalId: identity.outputs.uamiConsolePrincipalId
    tenantId: tenant().tenantId
  }
}

// Continuous-export (Delta → ADLS Gen2) RBAC: grant the new ADX cluster's
// system-assigned MI Storage Blob Data Contributor on the export account so
// OneLake-style availability works Azure-native (no Fabric workspace). Deployed
// at the storage account's RG (DLZ lake account is commonly in a different RG).
module adxExportRbac 'adx-export-rbac.bicep' = if (adxEnabled && empty(existingAdxClusterName) && !skipRoleGrants && !empty(!empty(loomRtiExportAdls) ? loomRtiExportAdls : loomStorageAccount)) {
  name: 'adx-export-rbac'
  scope: resourceGroup(!empty(loomRtiExportAdlsRg) ? loomRtiExportAdlsRg : resourceGroup().name)
  params: {
    exportAdlsAccountName: !empty(loomRtiExportAdls) ? loomRtiExportAdls : loomStorageAccount
    clusterPrincipalId: adxCluster!.outputs.clusterPrincipalId
  }
}

// F21 — Protected-label → RBAC enforcement. Grant the Console UAMI "Role Based
// Access Control Administrator" on the DLZ ADLS account so enforceLabelRbac()
// can create/revoke Storage Blob Data role assignments when a sensitivity label
// is applied/changed (lib/azure/label-protection.ts). Scoped to the DLZ RG (the
// lake account usually lives outside the admin RG). Skipped (honest gate in the
// editor) when loomStorageAccount is unset.
module labelRbacGrants 'label-rbac-grants.bicep' = if (!skipRoleGrants && !empty(loomStorageAccount)) {
  name: 'label-rbac-grants'
  scope: resourceGroup(loomDlzRg)
  params: {
    storageAccountName: loomStorageAccount
    consolePrincipalId: identity.outputs.uamiConsolePrincipalId
    skipRoleGrants: skipRoleGrants
  }
}

// F16 Azure Connections — grant the Console UAMI Storage Blob Data Contributor
// on the DLZ ADLS account + Log Analytics Contributor on the LAW so a
// workspace's "Azure connections" bindings are fully functional (dataflow
// staging + query-log export). Skipped (honest gate in the pane) when
// loomStorageAccount is unset; the LAW grant always applies (admin-RG LAW).
module azureConnectionsRbac 'azure-connections-rbac.bicep' = if (!skipRoleGrants) {
  name: 'console-azure-connections-rbac'
  scope: resourceGroup(loomDlzRg)
  params: {
    consolePrincipalId: identity.outputs.uamiConsolePrincipalId
    storageAccountName: loomStorageAccount
    // The LAW lives in the admin RG, not the DLZ RG — granted by the
    // admin-RG-scoped module below so the scope matches the resource.
    logAnalyticsWorkspaceName: ''
    skipRoleGrants: skipRoleGrants
  }
}

// Companion grant for the admin-RG Log Analytics workspace (the default
// query-log-export target). Scoped to the admin RG where the LAW is deployed.
module azureConnectionsLawRbac 'azure-connections-rbac.bicep' = if (!skipRoleGrants) {
  name: 'console-azure-connections-law-rbac'
  params: {
    consolePrincipalId: identity.outputs.uamiConsolePrincipalId
    storageAccountName: ''
    logAnalyticsWorkspaceName: monitoring.outputs.lawName
    skipRoleGrants: skipRoleGrants
  }
}

// F22 + F23 — Console UAMI data-plane grants on the org-visuals Blob container:
// Storage Blob Data Contributor (container scope: upload/read/delete bundles +
// embed manifests) + Storage Blob Delegator (account scope: getUserDelegationKey
// for the embed-code SAS). Scoped to the DLZ RG (the lake account usually lives
// outside the admin RG). Skipped (honest gate in the panes) when loomStorageAccount
// is unset. No Fabric/Power BI dependency.
module orgVisualsRbac '../landing-zone/org-visuals-rbac.bicep' = if (!skipRoleGrants && !empty(loomStorageAccount) && (loomBackends.?orgVisuals ?? 'enabled') != 'disabled') {
  name: 'org-visuals-rbac'
  scope: resourceGroup(loomDlzRg)
  params: {
    storageAccountName: loomStorageAccount
    consolePrincipalId: identity.outputs.uamiConsolePrincipalId
    skipRoleGrants: skipRoleGrants
  }
}

// Workspace-monitoring ADX database + Azure Monitor diagnostic-export pipeline.
// Read-only telemetry store (Fabric workspace-monitoring parity, no Fabric).
// Console UAMI gets Admin (provisioner seeds tables); admin group gets Viewer.
module workspaceMonitor 'workspace-monitor.bicep' = if (workspaceMonitorEnabled && adxEnabled && empty(existingAdxClusterName)) {
  name: 'workspace-monitor'
  params: {
    location: location
    adxClusterName: adxCluster!.outputs.clusterName
    monitorDbName: workspaceMonitorDbName
    lawName: monitoring.outputs.lawName
    consolePrincipalId: identity.outputs.uamiConsolePrincipalId
    adminEntraGroupId: adminEntraGroupId
    eventHubNamespaceId: workspaceMonitorEventHubNamespaceId
    skipRoleGrants: skipRoleGrants
  }
}

// =====================================================================
// 10. Catalog dispatcher (Purview / UC managed / Atlas-on-AKS)
// =====================================================================

module catalog 'catalog.bicep' = {
  name: 'catalog'
  params: {
    location: location
    boundary: boundary
    catalogPrimary: catalogPrimary
    purviewEnabled: purviewEnabled
    purviewLocation: effPurviewLocation
    atlasOnAksEnabled: atlasOnAksEnabled
    adminEntraGroupId: adminEntraGroupId
    consolePrincipalId: identity.outputs.uamiConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    privateEndpointSubnetId: network.outputs.privateEndpointsSubnetId
    // #229 — Purview private-endpoint DNS zones so the PE-locked account is
    // reachable from the hub VNet by default (account + portal hosts).
    privateDnsZonePurviewId: network.outputs.privateDnsZoneIds.purview
    privateDnsZonePurviewStudioId: network.outputs.privateDnsZoneIds.purviewStudio
    aksClusterId: containerPlatform == 'aks' ? containerPlatformModule.outputs.aksId : ''
    complianceTags: complianceTags
  }
}

// =====================================================================
// 10a. Shared admin-zone Purview Self-Hosted IR (SHIR) VMSS — scale-to-zero.
//
// A Purview SHIR MUST be a separate machine from the DLZ ADF SHIR (Microsoft
// constraint — see purview-shir.bicep header). This pre-deploys ONE shared
// Purview SHIR VMSS in the admin hub that scans many Purview data sources; the
// Console scales it 0→N before a SHIR-using scan and the idle-stop workflow
// scales it back to 0. Honest-gated: only deploys when Purview is enabled AND
// the operator supplied a Purview IR auth key + a node admin password (both
// @secure, empty by default). At IL5 (Atlas-on-AKS primary, no Purview) this
// stays off — purviewEnabled is false there.
// =====================================================================

module purviewShir 'purview-shir.bicep' = if (purviewShirEnabled && purviewEnabled && !empty(purviewIrAuthKey) && !empty(purviewShirAdminPassword)) {
  name: 'purview-shir'
  params: {
    location: location
    domainName: 'default'
    subnetId: '${network.outputs.hubVnetId}/subnets/snet-reserved'
    adminPassword: purviewShirAdminPassword
    purviewIrAuthKey: purviewIrAuthKey
    maxNodes: purviewShirMaxNodes
    consolePrincipalId: identity.outputs.uamiConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    workspaceId: monitoring.outputs.lawId
    complianceTags: complianceTags
  }
}

// =====================================================================
// 10b. Azure Maps account (geoanalytics backing)
//
// Backs the geo-map / geo-pipeline / map editors. Only deploys in
// Commercial / GCC — Azure Maps is not yet GA in GCC-High / IL5.
// When skipped, the editors render the documented honest-gate
// MessageBars (per no-vaporware.md).
// =====================================================================

@description('Provision an Azure Maps account to back the geo-map / geo-pipeline / map editors. Only honored in Commercial / GCC; skipped in GCC-High / IL5.')
param azureMapsEnabled bool = true
@description('Deploy the hub Azure Firewall (egress filtering). Default true; passthrough to network module.')
param firewallEnabled bool = true

module azureMaps 'azure-maps.bicep' = if (azureMapsEnabled && (boundary == 'Commercial' || boundary == 'GCC')) {
  name: 'azure-maps'
  params: {
    location: location
    boundary: boundary
    consolePrincipalId: identity.outputs.uamiConsolePrincipalId
    keyVaultId: keyvault.outputs.keyVaultId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
  }
}

// Effective Maps account name fed to every Console env binding below.
// When the module deploys (Commercial/GCC + enabled) we use its
// non-deterministic generated name; otherwise we fall back to the BYO /
// live-override input (`loomAzureMapsAccount`). A conditional-module output
// resolves to '' when its condition is false, so this expression is always
// safe. This closes the gap where the account deployed but
// `LOOM_AZURE_MAPS_ACCOUNT` + the `NEXT_PUBLIC_LOOM_AZURE_MAPS_KEY` secretRef
// were never bound (the param defaulted to '' and was never fed the output).
var effectiveMapsAccount = (azureMapsEnabled && (boundary == 'Commercial' || boundary == 'GCC'))
  ? azureMaps!.outputs.mapsAccountName
  : loomAzureMapsAccount

// =====================================================================
// 11. AI defense (Defender for AI workaround in Gov)
// =====================================================================

module aiDefense 'ai-defense.bicep' = {
  name: 'ai-defense'
  params: {
    location: location
    defenderForAIEnabled: defenderForAIEnabled
    lawId: monitoring.outputs.lawId
    lawName: monitoring.outputs.lawName
    // Key Vault reference syntax (operator stores `ops-teams-webhook`
    // secret in the Loom Key Vault). Vault name passed in directly to
    // avoid Bicep string-escape issues with the split expression.
    notificationWebhookKvRef: '@Microsoft.KeyVault(VaultName=${keyvault.outputs.keyVaultName};SecretName=ops-teams-webhook)'
    complianceTags: complianceTags
  }
}

// =====================================================================
// 12. App deployments (Console, MCP, Orchestrator, Copilot, Activator,
//                     Mirroring, Direct-Lake Shim, Presidio if Gov)
// =====================================================================

// MCP catalog Azure Files share + Container Apps env storage are provisioned by
// the inline `mcpStorage` storage account + `mcpEnvStorage` managedEnvironments/
// storages resources above (gated on mcpFilesActive). That inline path is the
// single source of truth — it carries the persistence toggle
// (mcpPersistenceEnabled), network ACLs, largeFileSharesState, and is the
// predecessor `appDeployments` already depends on (dependsOn: [mcpEnvStorage]).
// The Container Apps path mounts that share at /data; the AKS boundaries deploy
// MCP workloads via the GitOps manifest path. (A prior refactor briefly added a
// parallel `module mcpStorage 'mcp-storage.bicep'` here, which collided with the
// inline `resource mcpStorage` identifier and its non-existent `.outputs` —
// removed so main.bicep builds clean and every boundary can deploy.)

module appDeployments 'app-deployments.bicep' = if (containerPlatform == 'containerApps' && deployAppsEnabled) {
  name: 'app-deployments'
  // The loom-mcp app references the mcp-data managedEnvironments/storages
  // registration by name — make the storages resource a hard predecessor so
  // the mount exists before the container app is created.
  dependsOn: mcpFilesActive ? [ mcpEnvStorage ] : []
  params: {
    location: location
    containerPlatform: containerPlatform
    caeId: containerPlatformModule.outputs.caeId
    acrLoginServer: registry.outputs.acrLoginServer
    appInsightsConnectionString: monitoring.outputs.appInsightsConnectionString
    boundary: boundary
    keyVaultUri: keyvault.outputs.keyVaultUri
    complianceTags: complianceTags
    apps: [
      {
        name: 'loom-console'
        image: 'loom-console:${appImageTags.console}'
        uamiId: identity.outputs.uamiConsoleId
        uamiClientId: identity.outputs.uamiConsoleClientId
        ingressPort: 3000
        external: true
        healthPath: '/api/health'
        tier: 'console'
        minReplicas: 2
        maxReplicas: 6
        // Console-runtime telemetry opt-out (loomConsoleTelemetryEnabled, default
        // true). When false the App Insights connection string is withheld from
        // this app AND LOOM_CONSOLE_TELEMETRY_ENABLED below is '' — the OTel SDK
        // (the historical SIGSEGV path) never loads. The workspace/account still
        // exist for the read-only /monitor + Copilot-usage panes.
        telemetryEnabled: loomConsoleTelemetryEnabled
        env: concat(
          [
            { name: 'LOOM_VERSION', value: loomVersion }
            { name: 'NEXT_PUBLIC_LOOM_VERSION', value: loomVersion }
            { name: 'LOOM_SUBSCRIPTION_ID', value: subscription().subscriptionId }
            { name: 'LOOM_ADMIN_RG', value: resourceGroup().name }
            // Setup Orchestrator URL — the Setup Wizard's Deploy POSTs the captured
            // config here to run the real multi-sub az deployment sub create. Empty
            // until the orchestrator Container App is deployed (setupOrchestratorActive);
            // then the deploy BFF falls back to GitHub dispatch / copy-paste az.
            { name: 'LOOM_SETUP_ORCHESTRATOR_URL', value: setupOrchestratorActive ? setupOrchestrator!.outputs.url : '' }
            // MCP catalog deploy (admin → Copilot & Agents → External MCP Tools →
            // Browse library). The deploy/status/teardown BFF routes
            // (app/api/admin/mcp-servers/deploy + .../deployed/{status,teardown})
            // PUT/GET/DELETE Microsoft.App/containerApps via ARM, binding each
            // server to the MCP UAMI, writing per-field secrets to Key Vault, and
            // (optionally) mounting the Loom MCP Azure Files share. The canonical
            // env vars for the configSchema/per-field-KV path are LOOM_ACA_ENV_ID /
            // LOOM_ACA_ENV_DOMAIN / LOOM_MCP_CATALOG_UAMI_ID (set below). These are
            // wired only on the Container Apps boundary; on AKS the deploy route
            // honest-gates (LOOM_CONTAINER_PLATFORM=aks).
            { name: 'LOOM_CONTAINER_PLATFORM', value: containerPlatform }
            { name: 'LOOM_ACR_LOGIN_SERVER', value: registry.outputs.acrLoginServer }
            { name: 'LOOM_MCP_UAMI_ID', value: identity.outputs.uamiMcpId }
            { name: 'LOOM_MCP_UAMI_CLIENT_ID', value: identity.outputs.uamiMcpClientId }
            // Azure Files env-storage name (LOOM_MCP_STORAGE_NAME) and share name
            // (LOOM_MCP_FILES_SHARE) for catalog MCP servers that mount /data are
            // wired from the inline mcpFilesActive infra further down this same
            // env[] block (single source of truth) — not duplicated here.
            // Optional ACR mirror prefix for catalog MCP images in air-gapped
            // boundaries (empty → upstream Docker MCP catalog / mcr.microsoft.com).
            { name: 'LOOM_MCP_CATALOG_REGISTRY', value: loomMcpCatalogRegistry }
            // F15 Advanced networking — the workspace networking pane writes NSG
            // security rules (IP firewall + trusted instances) + private
            // endpoints (inbound protection + outbound rules) over ARM on the hub
            // VNet's RG. LOOM_NETWORKING_RG aliases LOOM_ADMIN_RG (the hub VNet
            // lives in the admin RG). The UAMI is granted Network Contributor on
            // this RG by network.bicep. Azure-native — no Microsoft Fabric.
            { name: 'LOOM_NETWORKING_RG', value: resourceGroup().name }
            { name: 'LOOM_HUB_VNET_NAME', value: network.outputs.hubVnetName }
            { name: 'LOOM_PE_SUBNET_ID', value: network.outputs.privateEndpointsSubnetId }
            { name: 'LOOM_NSG_NAME', value: network.outputs.nsgPrivateEndpointsName }
            // Deployment region — used as the `location` for on-demand ARM PUTs
            // that require it (e.g. the Gov warehouse-create path that provisions
            // a Synapse Dedicated SQL pool via createDedicatedSqlPool). Read by
            // synapse-dev-client / the warehouse create BFF route.
            { name: 'LOOM_LOCATION', value: location }
            { name: 'LOOM_AI_SEARCH_RG', value: byoAiSearchRg }
            { name: 'LOOM_ACA_RG', value: resourceGroup().name }
            // Managed-environment name + MCP Azure Files persistence wiring. The
            // console's container-apps-arm-client re-mounts the share via the
            // "Mount persistence" admin action (listKeys → upsertEnvStorage →
            // deployMcpContainerApp). Empty when mcpPersistenceEnabled is false
            // → the route shows an honest config gate (no Fabric dependency).
            { name: 'LOOM_ACA_ENVIRONMENT', value: containerPlatform == 'containerApps' ? containerPlatformModule.outputs.caeName : '' }
            { name: 'LOOM_MCP_FILES_ACCOUNT', value: mcpFilesActive ? mcpStorageAccountName : '' }
            { name: 'LOOM_MCP_FILES_SHARE', value: mcpFilesActive ? mcpShareName : '' }
            { name: 'LOOM_MCP_FILES_RG', value: resourceGroup().name }
            { name: 'LOOM_MCP_STORAGE_NAME', value: mcpStorageRegistrationName }
            { name: 'LOOM_MCP_DATA_DIR', value: mcpMountPath }
            { name: 'LOOM_DLZ_RG', value: loomDlzRg }
            // AAS resource group for the datamart-migration server (aas.bicep
            // deploys it into the DLZ RG). The migrate route falls back to
            // LOOM_DLZ_RG / LOOM_ADMIN_RG when unset.
            { name: 'LOOM_AAS_RG', value: loomDlzRg }
            // Default ADLS Gen2 account for the Azure-native lakehouse + shortcut
            // example targets ({{ADLS_ACCOUNT}} token). Without this the lakehouse
            // shortcut examples resolve to a non-existent host (ENOTFOUND).
            { name: 'LOOM_ADLS_ACCOUNT', value: loomStorageAccount }
            // ADLS Gen2 account for ADX continuous-export (Delta / OneLake-style
            // availability). When unset, the eventhouse Export dialog shows an
            // honest gate. Defaults to the lake account (same MI grant).
            { name: 'LOOM_RTI_EXPORT_ADLS', value: !empty(loomRtiExportAdls) ? loomRtiExportAdls : loomStorageAccount }
            // /monitor observability surface — Log Analytics workspace GUID
            // (customerId) for the Logs (KQL) tab. The UAMI needs
            // "Log Analytics Reader" on this workspace + "Monitoring Reader"
            // on the sub for metrics/activity/health/alerts.
            { name: 'LOOM_LOG_ANALYTICS_WORKSPACE_ID', value: monitoring.outputs.lawCustomerId }
            // Console-runtime OTel gate (deploy-readiness). instrumentation.ts
            // reads this BEFORE importing @azure/monitor-opentelemetry — when
            // empty the SDK is never loaded (no SIGSEGV), when 'true' it inits
            // with live-metrics disabled. Mirrors loomConsoleTelemetryEnabled;
            // also withholds APPLICATIONINSIGHTS_CONNECTION_STRING when false.
            { name: 'LOOM_CONSOLE_TELEMETRY_ENABLED', value: loomConsoleTelemetryEnabled ? 'true' : '' }
            { name: 'LOOM_LOG_ANALYTICS_RESOURCE_ID', value: monitoring.outputs.lawId }
            // audit-T29 — release-environment (Apollo/Shuttle parity). Optional
            // Azure Deployment Environments project; empty = honest infra-gate in
            // the editor (ARM history + promotions still function). No Fabric.
            { name: 'LOOM_DEVCENTER_PROJECT', value: loomDevCenterProject }
            // ADF Output-pane Log Analytics fallback — runs older than ADF's
            // 45-day native monitoring window are queried from the typed
            // ADFPipelineRun / ADFActivityRun tables in this workspace. Separate
            // env var (same workspace GUID) so operators can repoint the ADF
            // history fallback at a dedicated operational workspace without
            // touching the /monitor Logs (KQL) tab.
            { name: 'LOOM_ADF_LOG_ANALYTICS_WORKSPACE', value: monitoring.outputs.lawCustomerId }
            // Cloud-aware Log Analytics QUERY endpoint. Commercial/GCC use the
            // public host; GCC-High / IL5 (Azure Government) use api.loganalytics.us.
            // Read by adf-client.ts (ADF fallback) + monitor-client.ts (Logs tab).
            { name: 'LOOM_LOG_ANALYTICS_ENDPOINT', value: boundary == 'GCC-High' || boundary == 'IL5' ? 'https://api.loganalytics.us' : 'https://api.loganalytics.azure.com' }
            // Cloud-aware ARM management endpoint. Commercial/GCC use the public
            // host; GCC-High / IL5 (Azure Government) use management.usgovcloudapi.net.
            // Read by monitor-client.ts (inventory/health/metrics/activity/alerts +
            // Activator run-history Microsoft.AlertsManagement/alerts). Mirrors the
            // sovereign-cloud selection already used by adf-client.ts.
            { name: 'LOOM_ARM_ENDPOINT', value: boundary == 'GCC-High' || boundary == 'IL5' ? 'https://management.usgovcloudapi.net' : 'https://management.azure.com' }
            { name: 'LOOM_SYNAPSE_WORKSPACE', value: effSynapseWorkspace }
            { name: 'LOOM_SYNAPSE_RG', value: byoSynapseRg }
            { name: 'LOOM_SYNAPSE_SUB', value: byoSynapseSub }
            { name: 'LOOM_SYNAPSE_DEDICATED_POOL', value: loomSynapseDedicatedPool }
            // Direct Lake warm-cache TTL (seconds). Semantic-model queries within
            // this window are served from the Power BI in-memory VertiPaq cache;
            // older queries fall back transparently to Synapse Serverless
            // OPENROWSET over the Gold Delta files. 0 = always Serverless.
            { name: 'LOOM_DL_CACHE_TTL_SECONDS', value: string(loomDlCacheTtlSeconds) }
            // Ops Admin Copilot RBAC gate (Admin → Capacity & compute → Ops Copilot).
            // Members of this Entra group may execute NL-driven scale / OAP-toggle /
            // workspace-create actions. Empty = any signed-in admin.
            { name: 'LOOM_OPS_ADMIN_ENTRA_GROUP', value: loomOpsAdminEntraGroup }
            // Lakehouse schemas (F9) — Spark pool for CREATE/ALTER/DROP SCHEMA
            // DDL via Livy, and the sovereign-cloud dev-endpoint DNS suffix.
            { name: 'LOOM_DEFAULT_SPARK_POOL', value: loomDefaultSparkPool }
            { name: 'LOOM_SYNAPSE_DEV_SUFFIX', value: loomSynapseDevSuffix }
            { name: 'LOOM_SYNAPSE_HOST_SUFFIX', value: loomSynapseHostSuffix }
            { name: 'LOOM_SPARK_POOL', value: loomSynapseSparkPool }
            // Notebook Copilot persona (copilot-personas.ts) schema-grounding cap —
            // max lakehouse Delta tables read into buildDatastoreSchema() context.
            { name: 'LOOM_NOTEBOOK_PERSONA_CONTEXT_MAX_TABLES', value: string(loomNotebookPersonaContextMaxTables) }
            // %%pyspark cell routing (execute-spark). Commercial / GCC: AML
            // Serverless Spark when loomAmlSparkWorkspace is set. Gov (GCC-High /
            // IL5): forced empty so the route always uses Synapse Livy — AML
            // Serverless Spark is not available in Azure Government.
            { name: 'LOOM_AML_SPARK', value: boundary == 'GCC-High' || boundary == 'IL5' ? '' : loomAmlSparkWorkspace }
            // Synapse Spark pool dedicated to notebook %%pyspark cells (Livy).
            { name: 'LOOM_SYNAPSE_SPARK_POOL', value: loomNotebookSparkPool }
            // Rich display() — interactive grid + chart recommendations for
            // display(df). Injects ai-display.py as Livy session statement 0.
            { name: 'LOOM_RICH_DISPLAY', value: loomRichDisplay ? '1' : '0' }
            { name: 'LOOM_DISPLAY_SAMPLE_ROWS', value: string(loomDisplaySampleRows) }
            // TDS AAD token audience cloud portability (read by synapse-sql-client sqlScope()).
            // Commercial / GCC use database.windows.net; GCC-High / IL5 use the US-Gov audience.
            { name: 'LOOM_SYNAPSE_SQL_TOKEN_SCOPE', value: boundary == 'GCC-High' || boundary == 'IL5' ? 'database.usgovcloudapi.net' : 'database.windows.net' }
            // Synapse SQL endpoint suffix — Commercial defaults to azuresynapse.net
            // in synapse-sql-client.ts; gov clouds set azuresynapse.us here.
            { name: 'LOOM_SYNAPSE_SQL_SUFFIX', value: loomSynapseSqlSuffix }
            { name: 'LOOM_POSTGRES_AAD_USER', value: loomPostgresAadUser }
            // PostgreSQL Entra-auth cloud portability (read by postgres-flex-client.ts).
            // Commercial / GCC use the Commercial OSS RDBMS scope + .azure.com host;
            // GCC-High / IL5 (Azure US Government) use the US-Gov scope + .usgovcloudapi.net.
            { name: 'LOOM_POSTGRES_AAD_SCOPE', value: boundary == 'GCC-High' || boundary == 'IL5' ? 'https://ossrdbms-aad.database.usgovcloudapi.net/.default' : 'https://ossrdbms-aad.database.azure.com/.default' }
            { name: 'LOOM_POSTGRES_HOST_SUFFIX', value: boundary == 'GCC-High' || boundary == 'IL5' ? 'postgres.database.usgovcloudapi.net' : 'postgres.database.azure.com' }
            // Weave (Semantic Ontology) graph store — object/link/action instance
            // write-back over Apache AGE (lib/azure/weave-ontology-store.ts). When
            // LOOM_WEAVE_PG_FQDN is empty the Ontology editor's Objects / Write-back
            // actions surfaces show the honest-gate MessageBar (no Fabric required).
            { name: 'LOOM_WEAVE_PG_FQDN', value: loomWeavePgFqdn }
            { name: 'LOOM_WEAVE_PG_DATABASE', value: loomWeavePgDatabase }
            { name: 'LOOM_WEAVE_GRAPH', value: loomWeaveGraph }
            { name: 'LOOM_KEY_VAULT_URI', value: keyvault.outputs.keyVaultUri }
            // F14 Customer-Managed Keys — the ARM resource id of the admin-plane
            // Key Vault (scopes the KV Crypto role check) and the Console UAMI
            // resource id used as the storage account's CMK encryption identity.
            { name: 'LOOM_KEY_VAULT_ID', value: keyvault.outputs.keyVaultId }
            { name: 'LOOM_UAMI_RESOURCE_ID', value: identity.outputs.uamiConsoleId }
            // MCP browse-catalog + deploy wizard (External MCP Tools). The deploy
            // route provisions a catalog MCP server as an INTERNAL Container App in
            // this CAE, wires per-field Key Vault secrets, and registers it for
            // Copilot. caeId/caeDefaultDomain are '' on the AKS sovereign boundary
            // (GCC-High / IL5) — the route then surfaces an honest gate. The MCP
            // UAMI (uami-loom-mcp) resolves the deployed app's KV secrets at runtime
            // (granted "Key Vault Secrets User" by keyvault.bicep mcpPrincipalId);
            // the Console UAMI gets "Managed Identity Operator" (mcp-catalog-rbac)
            // so it can assign that identity to the new app.
            { name: 'LOOM_ACA_ENV_ID', value: containerPlatformModule.outputs.caeId }
            { name: 'LOOM_ACA_ENV_DOMAIN', value: containerPlatformModule.outputs.caeDefaultDomain }
            { name: 'LOOM_MCP_CATALOG_UAMI_ID', value: identity.outputs.uamiMcpId }
            // Built-in MCP tool server (azure-functions/mcp-server) /api/mcp
            // endpoint. The admin → External MCP Tools "Built-in server" card +
            // GET /api/admin/mcp-servers/builtin read this for one-click
            // registration. builtinMcpUrl is the deployed Function endpoint when
            // loomBuiltinMcpActive (default-on once the Function code is
            // published) and '' otherwise → the card honest-gates naming this
            // var + the builtin-mcp.bicep module. (PR #1413 computed/output this
            // value but never bound it to the console env — fixed here so a clean
            // deploy self-registers the built-in server.)
            { name: 'LOOM_BUILTIN_MCP_URL', value: builtinMcpUrl }
            // F4: schedule-time pipeline parameter overrides. KV defaults to the
            // admin-plane vault (Console UAMI already has Secrets Officer there);
            // point at a separate vault by overriding loomParamKeyVaultUri and
            // granting the Console identity "Key Vault Secrets User" on it.
            { name: 'LOOM_PARAM_KEYVAULT', value: !empty(loomParamKeyVaultUri) ? loomParamKeyVaultUri : keyvault.outputs.keyVaultUri }
            // External-source shortcut credentials (S3/GCS/SAS/Synapse-Link). KV
            // defaults to the admin-plane vault (Console UAMI has Secrets Officer);
            // override loomShortcutKeyVaultUri to isolate them in a dedicated vault
            // (keep it the same vault the shortcut engine binding reads).
            { name: 'LOOM_SHORTCUT_KEYVAULT', value: !empty(loomShortcutKeyVaultUri) ? loomShortcutKeyVaultUri : keyvault.outputs.keyVaultUri }
            // Eventstream MQTT/Kafka mTLS certs (CA + client cert PEM objects).
            // Defaults to the admin-plane vault; the Console UAMI is granted
            // "Key Vault Certificate User" on it (see keyvault.bicep). Override to
            // isolate streaming certs in a dedicated vault (grant the role there).
            { name: 'LOOM_EVENTSTREAM_CERT_VAULT', value: !empty(loomEventstreamCertKeyVaultUri) ? loomEventstreamCertKeyVaultUri : keyvault.outputs.keyVaultUri }
            // Git integration (commit / pull / sync). PATs are stored in the
            // admin-plane vault above (Console UAMI has Secrets Officer) under
            // `<LOOM_GIT_PAT_KV_PREFIX>-<workspaceId>`. ADO/GitHub host overrides
            // are only needed for on-prem ADO Server / GitHub Enterprise Server
            // (GCC-High/IL5/DoD); commercial+GCC leave them empty.
            { name: 'LOOM_ADO_HOST', value: loomAdoHost }
            { name: 'LOOM_GITHUB_HOST', value: loomGitHubHost }
            { name: 'LOOM_GIT_PAT_KV_PREFIX', value: loomGitPatKvPrefix }
            // App Configuration source for parameter overrides. Empty disables
            // the App Config path; set to an App Configuration endpoint and grant
            // the Console identity "App Configuration Data Reader" to enable.
            { name: 'LOOM_PARAM_APPCONFIG', value: loomParamAppConfigEndpoint }
            { name: 'LOOM_ADF_NAME', value: effAdfName }
            { name: 'LOOM_ADF_RG', value: effAdfRg }
            { name: 'LOOM_ADF_SUB', value: byoAdfSub }
            // Public Console base URL baked into the materialized-lake-view
            // "Refresh materialized lake view" ADF pipeline's callback activity.
            // Empty = the refresh route derives the origin from the request.
            { name: 'LOOM_CONSOLE_BASE_URL', value: loomConsoleBaseUrl }
            // Opt-in Azure Analysis Services semantic layer — backs the
            // semantic-model "Get data" (Power Query M) ingest refresh phase.
            // Empty values honestly gate the AAS phase (Delta still lands; query
            // via Synapse Serverless). Unavailable in Government clouds.
            { name: 'LOOM_AAS_SERVER', value: loomAasServer }
            { name: 'LOOM_AAS_MODEL', value: loomAasModel }
            // Opt-in ADF CDC mirroring (no-Fabric Delta sink). When BOTH are set
            // and LOOM_ADF_NAME is present, a mirrored-database Start provisions a
            // real ADF ChangeDataCapture resource → ADLS Bronze Delta. Unset = the
            // built-in CSV snapshot engine runs (still Azure-native, no Fabric).
            { name: 'LOOM_MIRROR_SOURCE_LINKED_SERVICE', value: loomMirrorSourceLinkedService }
            { name: 'LOOM_MIRROR_ADLS_LINKED_SERVICE', value: loomMirrorAdlsLinkedService }
            { name: 'LOOM_MIRROR_SNOWFLAKE_LINKED_SERVICE', value: loomMirrorSnowflakeLinkedService }
            { name: 'LOOM_MIRROR_COPY_CADENCE', value: loomMirrorCopyCadence }
            // Semantic-model tabular backend (Semantic Link read — the tabular_*
            // Copilot tools). Default "loom-native" = Cosmos model metadata +
            // Synapse SQL DAX eval, NO Power BI / Fabric. "analysis-services"
            // opts into an Azure Analysis Services XMLA backend (loomAasServer
            // required; Commercial/GCC only — AAS is not in Azure Government).
            { name: 'LOOM_SEMANTIC_BACKEND', value: loomSemanticBackend }
            { name: 'LOOM_AAS_SERVER', value: loomAasServer }
            { name: 'LOOM_AAS_DATABASE', value: loomAasDatabase }
            // Approval activity (F25) - Consumption Logic App + O365 approval
            // email backing the pipeline editor's Approval activity. Empty name
            // -> the approval-logicapp route returns an honest 503 naming the
            // bicep module + env var (no Fabric / Power Automate dependency).
            { name: 'LOOM_APPROVAL_LOGIC_APP_NAME', value: loomApprovalLogicAppName }
            { name: 'LOOM_APPROVAL_LOGIC_APP_RG', value: !empty(loomApprovalLogicAppRg) ? loomApprovalLogicAppRg : loomDlzRg }
            // audit-T13: optional shared secret guarding the Plan approval
            // callback (/api/items/plan/<id>/approval-callback). Empty = open.
            { name: 'LOOM_APPROVAL_CALLBACK_SECRET', value: loomApprovalCallbackSecret }
            // audit-T64: Plan (preview) EPM/CPM writeback store. Azure SQL DB
            // receiving planning-sheet cell writeback (dbo.loom_plan_cells).
            // Empty -> planning cells persist to Cosmos (always works) and the
            // Plan editor surfaces an honest "set LOOM_PLAN_BACKING_SQL_*" gate.
            // Azure-native parity of Fabric's auto-provisioned Fabric SQL DB —
            // no Microsoft Fabric dependency.
            { name: 'LOOM_PLAN_BACKING_SQL_SERVER', value: loomPlanBackingSqlServer }
            { name: 'LOOM_PLAN_BACKING_SQL_DATABASE', value: loomPlanBackingSqlDatabase }
            // Report subscriptions (scheduled report export + email). The
            // Function name is non-empty only when reportSubscriptionsEnabled —
            // the subscriptions BFF surfaces an honest delivery gate to the
            // editor until BOTH the timer Function and the delivery Logic App
            // are deployed. No Fabric / Power Automate dependency.
            { name: 'LOOM_REPORT_SUBSCRIPTIONS_FUNCTION', value: reportSubscriptionsEnabled ? reportSubscriptions.outputs.siteName : '' }
            { name: 'LOOM_SUBSCRIPTION_LOGIC_APP_NAME', value: reportSubscriptionsEnabled ? loomSubscriptionLogicAppName : '' }
            // Copy Job (F14) — watermark control table address. When the server
            // is unset, incremental copy surfaces an honest-gate MessageBar and
            // full copy still works; see data/copy-job-control.bicep.
            { name: 'LOOM_COPYJOB_CONTROL_SQL_SERVER', value: loomCopyJobControlSqlServer }
            { name: 'LOOM_COPYJOB_CONTROL_SQL_DB', value: loomCopyJobControlSqlDb }
            // HDInsight pipeline activities (Hive/Spark/MapReduce/Streaming) —
            // names the AzureHDInsight linked service in the factory. Exposed
            // both server-side and as NEXT_PUBLIC_* so activity-catalog.ts can
            // pre-fill the cluster reference for new activities. Empty leaves
            // the four activities honest-gated (MessageBar names this var).
            { name: 'LOOM_HDINSIGHT_LINKED_SERVICE', value: loomHdinsightLinkedService }
            { name: 'NEXT_PUBLIC_LOOM_HDINSIGHT_LINKED_SERVICE', value: loomHdinsightLinkedService }
            { name: 'LOOM_SHIR_VMSS_NAME', value: deShirEnabled ? loomShirVmssName : '' }
            // Shared admin-zone Purview SHIR VMSS — the BFF scales this 0→N
            // before a Purview scan that uses the self-hosted IR, and the
            // idle-stop workflow scales it back to 0. It lives in the admin RG
            // (LOOM_ADMIN_RG), NOT the DLZ — a Purview SHIR can't share a
            // machine with the ADF SHIR. Empty disables the surface (honest gate).
            { name: 'LOOM_PURVIEW_SHIR_VMSS_NAME', value: (purviewShirEnabled && purviewEnabled && !empty(purviewIrAuthKey) && !empty(purviewShirAdminPassword)) ? loomPurviewShirVmssName : '' }
            // Capacity & compute → Scale & manage drawer → AKS node-pool scaling.
            // Only populated on the AKS container platform (GCC-High / IL5); on
            // Commercial / GCC these are empty and the drawer's AKS section
            // honest-gates (503). LOOM_AKS_RG defaults to this admin RG (where the
            // AKS cluster lives) — aks-arm-client.ts reads both + LOOM_SUBSCRIPTION_ID.
            { name: 'LOOM_AKS_CLUSTER_NAME', value: containerPlatform == 'aks' ? containerPlatformModule.outputs.aksName : '' }
            { name: 'LOOM_AKS_RG', value: containerPlatform == 'aks' ? resourceGroup().name : '' }
            // Runtime configuration (/admin/env-config) Save on the AKS path uses
            // aks-arm-client.ts:updateAksDeploymentEnv (Run Command → kubectl set
            // env on the loom-console Deployment). Namespace the Console workload
            // lives in (app-deployments.bicep manifest omits one → 'default').
            { name: 'LOOM_AKS_NAMESPACE', value: containerPlatform == 'aks' ? 'default' : '' }
            // Azure-native Activator (lib/azure/activator-monitor.ts) creates
            // Microsoft.Insights/scheduledQueryRules + action groups here. Defaults
            // to THIS admin RG — the same RG where monitoring.bicep grants the
            // Console UAMI "Monitoring Contributor" (749f88ad…). Override to land
            // alerts elsewhere AND grant the role on that RG.
            { name: 'LOOM_ALERT_RG', value: !empty(loomAlertRg) ? loomAlertRg : resourceGroup().name }
            // Region stamped into the scheduledQueryRule + actionGroup ARM bodies.
            // Defaults to the deployment location so Gov (usgov*) deployments do
            // NOT fall back to the Commercial 'eastus' default in monitor-client.ts.
            { name: 'LOOM_ALERT_LOCATION', value: location }
            // ARM endpoint / scope overrides for sovereign clouds (GCC-High / IL5).
            // Empty on Commercial → monitor-client.ts falls back to
            // https://management.azure.com. Set both for Azure Government.
            { name: 'LOOM_ARM_ENDPOINT', value: loomArmEndpoint }
            { name: 'LOOM_ARM_SCOPE', value: loomArmScope }
            // Stream Analytics — defaults to LOOM_DLZ_RG / LOOM_SUBSCRIPTION_ID
            // when blank (see lib/azure/stream-analytics-client.ts). Override
            // when ASA lives in a different RG / sub than the DLZ.
            { name: 'LOOM_ASA_RG', value: loomAsaRg }
            { name: 'LOOM_ASA_SUB', value: loomAsaSub }
            { name: 'LOOM_ASA_TEST_WRITE_URI', value: loomAsaTestWriteUri }
            { name: 'NEXT_PUBLIC_LOOM_ASA_JOB_NAME', value: loomAsaJobName }
            // Region for ASA jobs the Eventstream canvas provisions on demand.
            { name: 'LOOM_ASA_LOCATION', value: loomAsaLocation }
            // Event Hubs namespace navigator (Eventstream editor left pane) —
            // defaults RG/sub to LOOM_DLZ_RG / LOOM_SUBSCRIPTION_ID when unset.
            { name: 'LOOM_EVENTHUB_NAMESPACE', value: effEventHubNamespace }
            { name: 'LOOM_EH_SCHEMA_GROUP', value: loomEhSchemaGroup }
            { name: 'LOOM_EVENTHUB_RG', value: effEventHubRg }
            { name: 'LOOM_EVENTHUB_SUB', value: byoEventHubSub }
            // Event Hubs Data Explorer "View / Peek events" (AMQP receive). The
            // @azure/event-hubs SDK is bundled in the Console image (package.json)
            // and loaded lazily only on the receive path; default-on (opt-out) so
            // portal-parity View works day-one. The Console UAMI's "Azure Event
            // Hubs Data Owner" (already granted on the namespace) covers receive.
            { name: 'LOOM_EVENTHUB_RECEIVE_ENABLED', value: loomEventHubReceiveEnabled ? '1' : '0' }
            // Business Events publishing surface (/business-events) — Event Grid
            // custom-topic channel + durable Event Hub channel + governed
            // event-type registry (Cosmos). The Event Grid sub/RG default to the
            // deployment sub / DLZ RG when empty (eventgridTopicsConfigGate).
            { name: 'LOOM_EVENTGRID_RG', value: effEventGridRg }
            { name: 'LOOM_EVENTGRID_SUB', value: effEventGridSub }
            { name: 'LOOM_EVENTGRID_BUSINESS_TOPIC', value: loomEventGridBusinessTopic }
            { name: 'LOOM_EVENTHUB_BUSINESS_HUB', value: loomEventHubBusinessHub }
            { name: 'LOOM_BUSINESS_EVENTS_CONTAINER', value: loomBusinessEventsContainer }
            // Capture form pre-fill (Event Hubs navigator "Configure capture"
            // panel). Optional — empty leaves the form blank. Capture is
            // configured per-hub at runtime; these only seed the destination.
            // The Console UAMI needs Storage Blob Data Contributor on the
            // target storage account for Capture writes (documented in
            // modules/landing-zone/eventhubs.bicep).
            { name: 'LOOM_EVENTHUB_CAPTURE_STORAGE_ID', value: loomEventHubCaptureStorageId }
            { name: 'LOOM_EVENTHUB_CAPTURE_CONTAINER', value: loomEventHubCaptureContainer }
            // RTI hub catalog (/rti-hub -> GET /api/rti-hub) - additional
            // subscription ids (comma-separated) to include in the Azure
            // Resource Graph stream discovery alongside LOOM_SUBSCRIPTION_ID.
            // Empty = discover the deployment subscription only. The Console
            // UAMI needs Reader at each subscription's scope (granted at sub
            // scope in platform/fiab/bicep/main.bicep).
            { name: 'LOOM_EXTRA_SUBSCRIPTIONS', value: loomExtraSubscriptions }
            { name: 'LOOM_IOT_HUB_RESOURCE_ID', value: loomIotHubResourceId }
            // Full ARM resource id of the Event Hubs namespace — consumed by the
            // eventhouse ingest route (ADX → Event Hub data connection, Get-Data
            // wizard) AND the workspace-monitoring provisioner (LAW→EH→ADX live
            // feed). An explicit workspaceMonitorEventHubNamespaceId override wins;
            // otherwise derived from the navigator namespace/RG/sub (DLZ fallback).
            { name: 'LOOM_EVENTHUB_NAMESPACE_RESOURCE_ID', value: !empty(workspaceMonitorEventHubNamespaceId) ? workspaceMonitorEventHubNamespaceId : (empty(effEventHubNamespace) ? '' : '/subscriptions/${byoEventHubSub}/resourceGroups/${effEventHubRg}/providers/Microsoft.EventHub/namespaces/${effEventHubNamespace}') }
            // Cloud-aware ARM base. Commercial → management.azure.com (default);
            // GCC-High / IL5 → management.usgovcloudapi.net. Read by eventhubs-
            // client, the eventhouse ingest/preview routes, adf/azure-sql clients.
            { name: 'LOOM_ARM_ENDPOINT', value: boundary == 'GCC-High' || boundary == 'IL5' ? 'https://management.usgovcloudapi.net' : 'https://management.azure.com' }
            // ----------------------------------------------------------------
            // Service-navigator control-plane wiring (parity program #209).
            // Each editor's left-pane navigator (ADF Studio-style) reads these
            // to target the real Azure resource. When the backing resource is
            // not deployed (its *Enabled flag is false) the value is '' and the
            // navigator renders its honest config-gate MessageBar — never a fake.
            // ----------------------------------------------------------------
            // Databricks navigator (jobs/clusters/notebooks/SQL warehouses). The
            // singular hostname is what databricks-client.ts reads; the real
            // value embeds a non-deterministic workspace id so it is patched
            // post-deploy from the DLZ workspaceUrl (see loomDatabricksHostname).
            { name: 'LOOM_DATABRICKS_HOSTNAME', value: effDatabricksHostname }
            // The same hostname also backs the workspace Spark / compute
            // configuration surface (Settings → Spark compute; F13) — instance
            // pools, runtime, environment libraries, and job defaults. No extra
            // env var is required; the only one-time admin action is granting the
            // Console UAMI the Databricks "Allow pool creation" entitlement
            // (see docs/fiab/v3-tenant-bootstrap.md#spark-compute-pool-entitlement).
            // Optional warehouse pin for lakehouse liquid-clustering DDL
            // (ALTER TABLE … CLUSTER BY). Blank → route auto-selects the first
            // RUNNING SQL Warehouse.
            { name: 'LOOM_DATABRICKS_SQL_WAREHOUSE_ID', value: loomDatabricksSqlWarehouseId }
            // dbt visual builder (audit-t144) Synapse/Fabric execution runtime.
            // The dbt-job item's Databricks target runs natively as a Databricks
            // Job dbt_task (no extra infra). The Synapse / opt-in Fabric targets
            // have no native dbt task, so they POST to the loom-dbt-runner
            // Container App. Empty → the editor surfaces an honest gate naming
            // this var; the Databricks target still works.
            { name: 'LOOM_DBT_RUNNER_URL', value: dbtRunnerActive ? dbtRunner!.outputs.dbtRunnerInternalEndpoint : '' }
            // Governance → Data quality (run/results/monitors) and Master data
            // management (match/merge → golden records) REUSE the Databricks /
            // Synapse / Kusto bindings above (LOOM_DATABRICKS_SQL_WAREHOUSE_ID,
            // LOOM_SYNAPSE_WORKSPACE, LOOM_KUSTO_CLUSTER_URI) — no new env var or
            // top-level resource is required (constraint-based DQ + self-built
            // MDM avoid partner SaaS, honoring no-fabric-dependency). The Console
            // UAMI already holds Storage Blob Data Contributor + the Databricks
            // access-connector grant (see databricks-storage-rbac, tasks #87/#92).
            // One-time admin action for MDM golden-record table creation +
            // Databricks Lakehouse Monitoring: grant the Console UAMI Unity
            // Catalog USE_CATALOG/USE_SCHEMA + CREATE TABLE/MODIFY (and SELECT)
            // on the target schema — documented in docs/fiab/v3-tenant-bootstrap.md.
            // DQ data-profiling monitor REST surface. Empty/'data-quality' → the
            // GA `/api/data-quality/v1/monitors` API (keyed by table UUID — the
            // default). 'legacy' forces the DEPRECATED `quality_monitors`
            // (`/api/2.1/unity-catalog/tables/{name}/monitor`) surface for any
            // sovereign region where the GA API is not yet enabled. No new
            // resource/role — the same Console UAMI UC grant above applies.
            { name: 'LOOM_DBX_DQ_MONITOR_API', value: loomDbxDqMonitorApi }
            // Notebook per-cell execution backend (F16). Empty/'synapse' → Azure-
            // native Synapse Spark Livy (default). 'databricks' opts into the
            // Databricks Execution Context API. LOOM_CLOUD_TIER=IL5 makes the BFF
            // block the Databricks opt-in regardless (falls back to Livy).
            { name: 'LOOM_NOTEBOOK_BACKEND', value: loomNotebookBackend }
            { name: 'LOOM_CLOUD_TIER', value: loomCloudTier }
            // ADX / Kusto navigator + KQL editors. bicep formerly set only the
            // bare LOOM_KUSTO_CLUSTER (read nowhere); the client reads the URI,
            // name, RG, location, and default database.
            // Each prefers a reused existing<Service> (any RG/sub) over the
            // provisioned module output, and is '' when neither → honest gate.
            { name: 'LOOM_KUSTO_CLUSTER_URI',  value: !empty(existingAdxClusterName) ? 'https://${existingAdxClusterName}.${location}.${kustoSuffix}' : (adxEnabled ? adxCluster!.outputs.clusterUri : '') }
            // Data Management (ingestion) endpoint — REQUIRED for `.purge table
            // records` (GDPR erasure); the engine endpoint rejects purge. Prefer
            // the ARM clusterDataIngestionUri; for a reused cluster derive the
            // ingest-* host. kusto-client falls back to prepending `ingest-` to
            // the cluster URI when this is unset.
            { name: 'LOOM_KUSTO_DM_URI',       value: !empty(existingAdxClusterName) ? 'https://ingest-${existingAdxClusterName}.${location}.${kustoSuffix}' : (adxEnabled ? adxCluster!.outputs.clusterDataIngestionUri : '') }
            { name: 'LOOM_KUSTO_CLUSTER_NAME', value: !empty(existingAdxClusterName) ? existingAdxClusterName : (adxEnabled ? adxCluster!.outputs.clusterName : '') }
            { name: 'LOOM_KUSTO_RG',           value: !empty(existingAdxClusterName) ? byoAdxRg : (adxEnabled ? resourceGroup().name : '') }
            { name: 'LOOM_KUSTO_SUB',          value: !empty(existingAdxClusterName) ? byoAdxSub : ((adxEnabled) ? subscription().subscriptionId : '') }
            { name: 'LOOM_KUSTO_LOCATION',     value: (!empty(existingAdxClusterName) || adxEnabled) ? location : '' }
            // Per-DLZ ADX database is named loomdb-<domain>; the single-sub DLZ
            // uses domain "default" → loomdb-default. For a reused cluster the real
            // default DB is reconciled post-deploy by patch-navigator-env.sh.
            { name: 'LOOM_KUSTO_DEFAULT_DB',   value: (!empty(existingAdxClusterName) || adxEnabled) ? 'loomdb-default' : '' }
            // ----------------------------------------------------------------
            // Azure Analysis Services (AAS) — Azure-native semantic-model
            // backend (lib/azure/aas-client.ts). When set, the SemanticModel
            // editor renders the AAS Storage-mode + Refresh surface and the
            // refresh routes dispatch to AAS by default (NEXT_PUBLIC_LOOM_BI_
            // BACKEND=aas). Prefer a reused server; else the provisioned module.
            // Empty when neither → editor shows the honest config-gate.
            // ----------------------------------------------------------------
            { name: 'LOOM_AAS_SERVER_NAME', value: !empty(existingAasServerName) ? existingAasServerName : (aasEnabled ? aasServer!.outputs.serverName : '') }
            { name: 'LOOM_AAS_REGION', value: !empty(existingAasServerName) ? (!empty(existingAasServerRegion) ? existingAasServerRegion : location) : (aasEnabled ? aasServer!.outputs.serverRegion : '') }
            // Default BI backend for the SemanticModelEditor + refresh routes.
            // 'aas' when an AAS server is present (Azure-native default, per
            // no-fabric-dependency.md); 'powerbi' is the opt-in Fabric-family
            // path. Read client-side as NEXT_PUBLIC_*; server routes also honor
            // LOOM_BI_BACKEND (mirrored below).
            { name: 'NEXT_PUBLIC_LOOM_BI_BACKEND', value: (!empty(existingAasServerName) || aasEnabled) ? 'aas' : 'powerbi' }
            { name: 'LOOM_BI_BACKEND', value: (!empty(existingAasServerName) || aasEnabled) ? 'aas' : 'powerbi' }
            // Workspace-monitoring read-only ADX DB (Azure Monitor diag-export
            // parity for Fabric workspace monitoring). Set only when deployed so
            // the provisioner + dashboard target the real DB; '' → honest gate.
            { name: 'LOOM_WORKSPACE_MONITOR_DB', value: (workspaceMonitorEnabled && adxEnabled && empty(existingAdxClusterName)) ? workspaceMonitorDbName : '' }
            // (LOOM_EVENTHUB_NAMESPACE_RESOURCE_ID for the live LAW→EH→ADX feed is
            // set once above — shared with the eventhouse ingest route; the
            // workspaceMonitorEventHubNamespaceId param overrides it when provided.)
            // RTI — continuous-export destination. Points at the same DLZ ADLS
            // account as LOOM_ADLS_ACCOUNT. Empty → the export-to-ADLS wizard
            // shows a Fluent MessageBar naming LOOM_RTI_EXPORT_ADLS (no-vaporware.md).
            { name: 'LOOM_RTI_EXPORT_ADLS',    value: loomStorageAccount }
            // RTI — queued / one-click ingestion endpoint (Get Data wizard). For a
            // provisioned cluster this is the ARM dataIngestionUri; for a reused
            // cluster the ingest-<name> host is reconciled post-deploy alongside
            // LOOM_KUSTO_CLUSTER_URI by patch-navigator-env.sh. Empty when ADX off.
            { name: 'LOOM_KUSTO_DATA_INGESTION_URI', value: !empty(existingAdxClusterName) ? 'https://ingest-${existingAdxClusterName}.${location}.${kustoSuffix}' : (adxEnabled ? adxCluster!.outputs.clusterDataIngestionUri : '') }
            // Sovereign-cloud ARM endpoint for Azure Monitor metrics calls (e.g.
            // the Eventhouse Capacity/throttle panel). Empty = public cloud
            // (https://management.azure.com). Operators in GCC-High / IL5 set
            // 'https://management.usgovcloudapi.net'. Read by monitor-client.ts.
            { name: 'LOOM_ARM_ENDPOINT',       value: '' }
            // AI Search navigator + the loom-items grounding index + help copilot.
            // RG/sub fall back to LOOM_AI_SEARCH_RG / LOOM_SUBSCRIPTION_ID.
            { name: 'LOOM_AI_SEARCH_SERVICE',  value: !empty(existingAiSearchService) ? existingAiSearchService : (aiSearchEnabled ? aiSearch!.outputs.searchName : '') }
            { name: 'LOOM_AI_SEARCH_SUB',      value: !empty(existingAiSearchService) ? byoAiSearchSub : (aiSearchEnabled ? subscription().subscriptionId : '') }
            // Keyless storage connection string for AI Search indexer debug-session
            // state (ms-az-cognitive-search-debugsession container). Uses the
            // `ResourceId=` form so the search system-MSI authenticates via the
            // Storage Blob Data Contributor grant (ai-search.bicep
            // debugSessionStorageId) — no account key, matching the search
            // service's disableLocalAuth posture. Empty when reusing a BYO search
            // service (existingAiSearchService): the operator then supplies a
            // per-session connection string in the UI, or sets this env var.
            // Read by the /api/ai-search/debug-sessions BFF route.
            { name: 'LOOM_AI_SEARCH_DEBUG_STORAGE_CONN', value: (aiSearchEnabled && empty(existingAiSearchService)) ? 'ResourceId=${aiSearchDebugStorage.id};' : '' }
            // OneLake catalog Explore-tab backend (azure=AI Search/Cosmos default; fabric=opt-in OneLake REST).
            { name: 'LOOM_CATALOG_BACKEND', value: loomBackends.catalog }
            // APIM navigator (apis/products/named-values/backends/subscriptions) + marketplace.
            { name: 'LOOM_APIM_NAME',          value: !empty(existingApimName) ? existingApimName : (apimEnabled ? apim!.outputs.apimName : '') }
            { name: 'LOOM_APIM_RG',            value: !empty(existingApimName) ? byoApimRg : (apimEnabled ? resourceGroup().name : '') }
            { name: 'LOOM_APIM_SUB',           value: !empty(existingApimName) ? byoApimSub : (apimEnabled ? subscription().subscriptionId : '') }
            // Cosmos DB control-plane navigator (databases/containers/sprocs). This
            // is the USER-navigated account (distinct from Loom's own store at
            // LOOM_COSMOS_ENDPOINT) and lives in the DLZ RG. Requires the Console
            // UAMI to hold "DocumentDB Account Contributor" (granted in cosmos.bicep).
            { name: 'LOOM_COSMOS_ACCOUNT',     value: effCosmosAccount }
            { name: 'LOOM_COSMOS_ACCOUNT_RG',  value: effCosmosRg }
            { name: 'LOOM_COSMOS_ACCOUNT_SUB', value: byoCosmosSub }
            // Item-level Share (per-Azure-SQL-database Access control / IAM).
            // The RG of the SQL server(s); the Console UAMI holds constrained
            // RBAC-Admin here (sql-database-share-rbac.bicep) so the Share dialog
            // can PUT/DELETE Reader/Contributor/SQL DB Contributor role
            // assignments at the database scope.
            { name: 'LOOM_SQL_RG',             value: !empty(loomSqlServerRg) ? loomSqlServerRg : loomDlzRg }
            // Azure SQL schema source control (Source control tab). Empty
            // provider → honest gate; otherwise the named repo + KV PAT secret
            // drive the SqlPackage DACPAC diff pipeline.
            { name: 'LOOM_SQL_GIT_PROVIDER',          value: loomSqlGitProvider }
            { name: 'LOOM_SQL_GIT_ADO_ORG',           value: loomSqlGitAdoOrg }
            { name: 'LOOM_SQL_GIT_ADO_PROJECT',       value: loomSqlGitAdoProject }
            { name: 'LOOM_SQL_GIT_ADO_REPO',          value: loomSqlGitAdoRepo }
            { name: 'LOOM_SQL_GIT_ADO_PAT_SECRET',    value: loomSqlGitAdoPatSecretName }
            { name: 'LOOM_SQL_GIT_GITHUB_REPO',       value: loomSqlGitGithubRepo }
            { name: 'LOOM_SQL_GIT_GITHUB_BRANCH',     value: loomSqlGitGithubBranch }
            { name: 'LOOM_SQL_GIT_GITHUB_PAT_SECRET', value: loomSqlGitGithubPatSecretName }
            { name: 'AZURE_CLOUD', value: !empty(loomAzureCloud) ? loomAzureCloud : (boundary == 'GCC-High' || boundary == 'IL5' ? 'AzureUSGovernment' : 'AzureCloud') }
            // Canonical 4-way sovereign discriminator for cloud-endpoints.ts.
            // IL5 collapses to GCC-High (same AzureUSGovernment endpoints); the
            // other boundaries pass through verbatim (Commercial | GCC | GCC-High).
            { name: 'LOOM_CLOUD', value: boundary == 'IL5' ? 'GCC-High' : boundary }
            { name: 'AZURE_TENANT_ID', value: loomMsalTenantId }
            // LOOM_MSAL_TENANT_ID is an alias of AZURE_TENANT_ID (self-audit anyOf:
            // AZURE_TENANT_ID | LOOM_MSAL_TENANT_ID). Set it on day one so the
            // env-config surface shows it satisfied rather than a false gap.
            { name: 'LOOM_MSAL_TENANT_ID', value: loomMsalTenantId }
            { name: 'LOOM_COSMOS_ENDPOINT', value: !empty(loomCosmosAccount) ? 'https://${loomCosmosAccount}.documents.${environment().suffixes.storage == 'core.usgovcloudapi.net' ? 'azure.us' : 'azure.com'}:443/' : '' }
            { name: 'LOOM_COSMOS_DATABASE', value: 'loom' }
            // Direct-Lake-shim (Azure-native parity for Fabric Direct Lake).
            // When enabled, the semantic-model "Direct Lake (shim)" tab is active
            // and the BFF can wire the Event Grid → Service Bus subscription at
            // runtime via LOOM_DIRECT_LAKE_SHIM_QUEUE_ID. Empty when opt-out →
            // the tab shows the honest setup MessageBar.
            { name: 'LOOM_DIRECT_LAKE_SHIM_ENABLED', value: loomDirectLakeShimEnabled ? 'true' : '' }
            { name: 'LOOM_DIRECT_LAKE_SHIM_QUEUE_ID', value: loomDirectLakeShimEnabled ? dlShimQueueId : '' }
            // Govern tab data-owner view (F3) — on-open posture refresh Function.
            // Empty → honest gate; the owner view still computes posture live.
            { name: 'LOOM_POSTURE_FUNCTION_URL', value: loomPostureFunctionUrl }
            // Paginated-report (RDL) export renderer Function — PDF/Excel/Word.
            // Empty → honest export gate in the designer; authoring still works.
            { name: 'LOOM_PAGINATED_RENDER_URL', value: loomPaginatedRenderUrl }
            // CSA Loom family sweep (Power Platform / ML / Geo / Graph) —
            // see scripts/csa-loom/powerplatform-tenant-bootstrap.sh for
            // the one-time tenant config required to use them.
            { name: 'LOOM_COSMOS_GREMLIN_ENDPOINT',  value: loomCosmosGremlinEndpoint }
            { name: 'LOOM_COSMOS_GREMLIN_DATABASE',  value: loomCosmosGremlinDatabase }
            { name: 'LOOM_COSMOS_GREMLIN_GRAPH',     value: loomCosmosGremlinGraph }
            { name: 'NEXT_PUBLIC_LOOM_COSMOS_GREMLIN_ENDPOINT', value: loomCosmosGremlinEndpoint }
            { name: 'LOOM_COSMOS_VECTOR_ENDPOINT',   value: loomCosmosVectorEndpoint }
            { name: 'LOOM_COSMOS_VECTOR_DATABASE',   value: loomCosmosVectorDatabase }
            { name: 'LOOM_COSMOS_VECTOR_CONTAINER',  value: loomCosmosVectorContainer }
            { name: 'LOOM_AZURE_MAPS_ACCOUNT',       value: effectiveMapsAccount }
            // Account name is not a secret (the key is, and stays in KV /
            // secretRef). Mirroring it as NEXT_PUBLIC lets the geo-map / map
            // editors prefill + display the deployed account, so the geo
            // surfaces verifiably "use the deployed account".
            { name: 'NEXT_PUBLIC_LOOM_AZURE_MAPS_ACCOUNT', value: effectiveMapsAccount }
            { name: 'LOOM_KUSTO_CLUSTER',            value: !empty(existingAdxClusterName) ? existingAdxClusterName : (adxEnabled ? adxCluster!.outputs.clusterName : '') }
            { name: 'NEXT_PUBLIC_LOOM_KUSTO_CLUSTER', value: !empty(existingAdxClusterName) ? existingAdxClusterName : (adxEnabled ? adxCluster!.outputs.clusterName : '') }
            // Phase 2 — RBAC tenant-admin bootstrap + install-time provisioning targets
            { name: 'LOOM_TENANT_ADMIN_GROUP_ID', value: loomTenantAdminGroupId }
            // Bootstrap tenant admin (PRP deploy-readiness gap #4: all /admin
            // pages 403 when no admin principal is wired). When neither an
            // explicit OID nor a real admin group is supplied, DEFAULT to the
            // principal running the deployment (deployer().objectId) so the
            // push-button path is NEVER blank — whoever deploys can sign in and
            // configure access out of the empty state. An explicit
            // loomTenantAdminOid always wins.
            { name: 'LOOM_TENANT_ADMIN_OID', value: effectiveTenantAdminOid }
            { name: 'LOOM_DEFAULT_FABRIC_WORKSPACE', value: loomDefaultFabricWorkspace }
            { name: 'LOOM_WAREHOUSE_BACKEND', value: loomWarehouseBackend }
            { name: 'LOOM_WAREHOUSE_FABRIC_WORKSPACE', value: loomWarehouseFabricWorkspace }
            // ----------------------------------------------------------------
            // Azure-native backend selectors (no-fabric-dependency)
            // ----------------------------------------------------------------
            { name: 'LOOM_BRONZE_CONTAINER', value: loomBronzeContainer }
            { name: 'LOOM_PIPELINE_BACKEND', value: loomPipelineBackend }
            { name: 'LOOM_EVENT_BACKEND', value: loomBackends.event }
            { name: 'LOOM_ACTIVATOR_BACKEND', value: loomBackends.activator }
            { name: 'LOOM_ACTIVATOR_DEFAULT_TABLE', value: loomBackends.activatorTable }
            { name: 'LOOM_DASHBOARD_BACKEND', value: loomBackends.dashboard }
            { name: 'LOOM_MIRROR_BACKEND', value: loomMirrorBackend }
            { name: 'LOOM_LAKEHOUSE_BACKEND', value: loomBackends.lakehouse }
            { name: 'LOOM_SEMANTIC_BACKEND', value: loomSemanticBackend }
            // Azure Analysis Services DAX backend (dashboard Q&A / pinned-DAX
            // tiles + DirectQuery source binder for semantic-model) — Azure-native,
            // active when LOOM_SEMANTIC_BACKEND=analysis-services. Empty server
            // honest-gates the DirectQuery source tab and the dashboard tile-query
            // route; no Fabric / Power BI dependency on the default path.
            { name: 'LOOM_AAS_SERVER', value: loomAasServer }
            { name: 'LOOM_AAS_REGION', value: empty(loomAasServer) ? '' : loomAasRegion }
            { name: 'LOOM_AAS_MODEL', value: empty(loomAasServer) ? '' : loomAasModel }
            // Analysis Services XMLA endpoint (semantic-model column metadata, PR #984).
            { name: 'LOOM_AAS_SERVER_URL', value: !empty(loomAasServerUrl) ? loomAasServerUrl : (deployAas ? analysisServices.outputs.aasServerUrl : '') }
            // AAS XMLA measure persistence (loomSemanticBackend=analysis-services
            // reads these). Empty string = unconfigured → aas-client surfaces an
            // honest infra-gate and DAX validation still works on every backend.
            { name: 'LOOM_AAS_DATABASE', value: loomAasDatabase }
            { name: 'LOOM_DATAFLOW_BACKEND', value: loomBackends.dataflow }
            // Report editor BI backend. Empty (default) → Loom-native renderer
            // that queries the bound AAS model with DAX (no Power BI / Fabric).
            // 'powerbi' opts into the Power BI embed. NEXT_PUBLIC_ mirror lets
            // the client editor branch without a round-trip. (no-fabric-dependency.md)
            { name: 'LOOM_BI_BACKEND', value: loomBackends.bi }
            { name: 'NEXT_PUBLIC_LOOM_BI_BACKEND', value: loomBackends.bi }
            { name: 'LOOM_AAS_SERVER', value: loomAasServer }
            { name: 'LOOM_AAS_DATABASE', value: loomAasDatabase }
            // Data-products store backend (Wave 4 — Data Marketplace / F22).
            // Empty | 'cosmos' → the Azure-native Cosmos DataProductStore (no
            // Microsoft Fabric / Purview-unified-catalog dependency). Set to
            // 'unified-catalog' to opt into the Purview Unified Catalog REST
            // adapter (Commercial only — GCC / GCC-High / IL5 fall through to
            // Cosmos silently; CSA_LOOM_BOUNDARY is injected for every app by
            // app-deployments.bicep so the factory's Gov fall-through needs no
            // extra var here). When opted in WITHOUT loomPurviewUnifiedAccount
            // the factory renders an honest gate instead of fabricated data.
            { name: 'LOOM_DATAPRODUCTS_BACKEND', value: loomBackends.dataproducts }
            // F4 Governance Domains — Cosmos CRUD + Purview mirror (default) or
            // opt-in Fabric Admin. LOOM_DOMAIN_IMAGES_URL points at the F4 domain
            // gallery blob endpoint emitted by catalog.bicep ('' when Purview/
            // catalog storage is not deployed — the editor shows an honest gate).
            { name: 'LOOM_DOMAINS_BACKEND', value: loomBackends.domains }
            { name: 'LOOM_DOMAIN_IMAGES_URL', value: catalog.outputs.domainImagesEndpoint }
          ],
          // F22 — Purview Unified Catalog account for the data-product adapter.
          // Only emitted when set; absence makes the factory serve the honest
          // gate (501/503 + remediation) on Commercial when
          // LOOM_DATAPRODUCTS_BACKEND=unified-catalog, rather than fabricated data.
          !empty(loomPurviewUnifiedAccount) ? [
            { name: 'LOOM_PURVIEW_UNIFIED_ACCOUNT', value: loomPurviewUnifiedAccount }
          ] : [],
          // Azure Analysis Services XMLA endpoint backing the semantic-model
          // incremental-refresh / hybrid-table surface (opt-in:
          // loomSemanticBackend=analysis-services). Only emitted when set;
          // absence makes the /refresh-policy route serve an honest 503 gate
          // naming LOOM_AAS_XMLA_ENDPOINT rather than fabricated partitions.
          // AAS is Azure-native, NOT Microsoft Fabric — the default
          // loom-native semantic backend works with this unset. GCC-High/IL5
          // must point the endpoint at asazure.usgovcloudapi.net AND grant
          // the Console UAMI the AAS Server Administrator role on the model.
          !empty(loomAasXmlaEndpoint) ? [
            { name: 'LOOM_AAS_XMLA_ENDPOINT', value: loomAasXmlaEndpoint }
          ] : [],
          // Azure Analysis Services — opt-in semantic backend for writing
          // calculation groups + field parameters to a LIVE model over XMLA.
          // LOOM_AAS_SERVER / LOOM_AAS_DATABASE are emitted unconditionally
          // above (shared with the Loom-native report renderer); only the
          // resource group (ARM server picker) is conditional here. Absence
          // keeps the AAS path honest-gated while the loom-native default
          // (Cosmos + TMSL) still works.
          !empty(loomAasResourceGroup) ? [
            { name: 'LOOM_AAS_RG', value: loomAasResourceGroup }
          ] : [],
          // Azure Maps subscription key — exposed to SPA as NEXT_PUBLIC_
          // so the MapEditor can use the static-map URL. AAD-auth path
          // doesn't need this. Only set when the maps account is wired.
          !empty(effectiveMapsAccount) ? [
            { name: 'NEXT_PUBLIC_LOOM_AZURE_MAPS_KEY', secretRef: 'loom-azure-maps-key' }
          ] : [],
          // Posture-refresh Function host key — only when the Function URL is wired.
          // Surfaced to the Govern owner-view refresh BFF, never to the browser.
          !empty(loomPostureFunctionUrl) ? [
            { name: 'LOOM_POSTURE_FUNCTION_KEY', secretRef: 'loom-posture-function-key' }
          ] : [],
          // Paginated-report-renderer Function host key — only when wired.
          // Surfaced to the export BFF (?code=…), never to the browser.
          !empty(loomPaginatedRenderUrl) ? [
            { name: 'LOOM_PAGINATED_RENDER_KEY', secretRef: 'loom-paginated-render-key' }
          ] : [],
          // Analysis Services — RLS/OLS Security tab backend (Azure-native).
          // LOOM_AAS_SERVER is the asazure://… data-plane name emitted by the
          // AAS module. LOOM_AAS_CLIENT_ID is the SPN appId (not secret). The
          // SPN secret is wired separately as the KV secretRef 'loom-aas-client-secret'
          // → LOOM_AAS_CLIENT_SECRET (operator step, see v3-tenant-bootstrap.md).
          aasEnabled ? [
            { name: 'LOOM_AAS_SERVER', value: aas.outputs.serverFullName }
            { name: 'LOOM_AAS_TENANT_ID', value: tenant().tenantId }
            { name: 'LOOM_AAS_CLIENT_ID', value: aasSpnClientId }
          ] : [],
          // Opt-in Power BI Premium / Fabric capacity XMLA endpoint (alternative
          // Security-tab backend). Only emitted when set; absence falls through
          // to AAS / the honest config-gate.
          !empty(loomPowerbiXmlaEndpoint) ? [
            { name: 'LOOM_POWERBI_XMLA_ENDPOINT', value: loomPowerbiXmlaEndpoint }
          ] : [],
          !empty(loomStorageAccount) ? [
            { name: 'LOOM_BRONZE_URL',  value: 'https://${loomStorageAccount}.dfs.${environment().suffixes.storage}/bronze' }
            { name: 'LOOM_SILVER_URL',  value: 'https://${loomStorageAccount}.dfs.${environment().suffixes.storage}/silver' }
            { name: 'LOOM_GOLD_URL',    value: 'https://${loomStorageAccount}.dfs.${environment().suffixes.storage}/gold' }
            { name: 'LOOM_LANDING_URL', value: 'https://${loomStorageAccount}.dfs.${environment().suffixes.storage}/landing' }
            // LOOM_CSV_IMPORTS_URL backs the Data product "Import from CSV" flyout
            // (F2/F18): the BFF stages the raw uploaded CSV to the csv-imports
            // container before bulk-creating draft data products + writing the
            // dataproduct-jobs status doc. Only emitted when an ADLS account is
            // configured; otherwise the flyout's honest gate fires and the import
            // still runs inline (Cosmos-only, no Blob staging). The csv-imports
            // container is created in landing-zone/storage.bicep; the Console UAMI
            // already holds Storage Blob Data Contributor on the account.
            { name: 'LOOM_CSV_IMPORTS_URL', value: 'https://${loomStorageAccount}.dfs.${environment().suffixes.storage}/csv-imports' }
            // LOOM_ORG_VISUALS_URL backs Embed codes (F22) + Organizational
            // visuals (F23): the Console BFF stores custom-visual bundles +
            // embed-manifest blobs in the org-visuals Blob container and mints
            // read-only user-delegation SAS embed URLs over it. Uses the .blob
            // endpoint (block-blob + SAS), unlike the .dfs lake URLs above. The
            // container is created in landing-zone/storage.bicep; the Console
            // UAMI is granted Storage Blob Data Contributor (container) + Storage
            // Blob Delegator (account) by org-visuals-rbac.bicep. Emitted in the
            // separately-gated array below (loomOrgVisualsEnabled opt-out) so a
            // deploy can disable Embed codes / Org visuals while keeping the
            // medallion lake URLs. No Fabric/Power BI dependency.
            // LOOM_RECYCLE_RETENTION_DAYS — OneLake Recycle bin restore window.
            // Mirrors the storage account's blob soft-delete deleteRetentionPolicy
            // (landing-zone/storage.bicep recycleRetentionDays) so the recycle-bin
            // UI shows the correct days-remaining countdown and computes purgeAfter.
            { name: 'LOOM_RECYCLE_RETENTION_DAYS', value: string(recycleRetentionDays) }
            // LOOM_SAMPLE_ADLS gates the data-pipeline "Practice with sample data"
            // card: when set, the BFF uploads a sample CSV to landing/samples and
            // runs an ADF copy pipeline into bronze/samples. Defaults to the DLZ
            // storage account (same as LOOM_ADLS_ACCOUNT). Only emitted when an
            // ADLS account is configured, so the card's honest gate fires
            // otherwise. Requires the ADF factory MSI to hold Storage Blob Data
            // Contributor (granted in landing-zone/adf.bicep).
            { name: 'LOOM_SAMPLE_ADLS', value: loomStorageAccount }
          ] : [],
          // LOOM_ORG_VISUALS_URL backs Embed codes (F22) + Organizational
          // visuals (F23). Gated independently of the medallion lake URLs by
          // loomOrgVisualsEnabled (opt-out, default true): a deploy can disable
          // the embed-code SAS surface while keeping the lakehouse wired. Uses
          // the .blob endpoint (block-blob + SAS) over the org-visuals container
          // created in landing-zone/storage.bicep; the Console UAMI is granted
          // Storage Blob Data Contributor (container) + Storage Blob Delegator
          // (account) by org-visuals-rbac.bicep. Unset → the panes honest-gate.
          (!empty(loomStorageAccount) && (loomBackends.?orgVisuals ?? 'enabled') != 'disabled') ? [
            { name: 'LOOM_ORG_VISUALS_URL', value: 'https://${loomStorageAccount}.blob.${environment().suffixes.storage}/org-visuals' }
          ] : [],
          // ----------------------------------------------------------------
          // Unified Catalog federation + admin-security env wiring.
          //
          // The /catalog surface federates Purview + Unity Catalog + Fabric
          // OneLake. The /admin/security panel surfaces Purview + MIP + DLP.
          // Each backend is gated independently — when an env var is
          // missing, the corresponding UI surface renders a Fluent
          // MessageBar naming the missing env var and the Graph AppRole /
          // Purview portal role that must be granted.
          //
          // LOOM_PURVIEW_ACCOUNT precedence:
          //   1. Explicit `loomPurviewAccount` param (used by both
          //      /catalog federation and /admin/security Purview tab)
          //   2. catalog.outputs.purviewAccountName (purview-csa-loom-<purviewLocation
          //      ?? location>) when `purviewEnabled = true` and no explicit
          //      account name was supplied. Using the catalog output (not a
          //      re-derived '${location}' literal) keeps the env in lock-step
          //      with the REAL account name when purviewLocation is cross-region.
          // ----------------------------------------------------------------
          !empty(effPurviewAccount) ? [
            { name: 'LOOM_PURVIEW_ACCOUNT', value: effPurviewAccount }
          ] : (purviewEnabled ? [
            { name: 'LOOM_PURVIEW_ACCOUNT', value: catalog.outputs.purviewAccountName }
          ] : []),
          // Purview Unified Catalog data-plane endpoint + API version — used by
          // the data-product creation wizard (/api/data-products,
          // /api/governance-domains) to register data products + list business
          // domains. STRICTLY OPT-IN + Commercial-only.
          //
          // CRITICAL host fix: the Unified Catalog REST surface
          // (/datagovernance/catalog/dataProducts) is served from the well-known
          // GLOBAL host https://api.purview-service.microsoft.com — NOT
          // {account}.purview.azure.com. That latter host is the CLASSIC Data Map
          // endpoint (Atlas v2 / scan / collections); hitting /datagovernance on
          // it 404s/HTTP-000s. Previously this var was hardcoded to the classic
          // host, which (being the explicit-wins endpoint in resolveUnifiedEndpoint())
          // overrode LOOM_PURVIEW_UNIFIED_ACCOUNT and broke the opt-in
          // unified-catalog backend. Token scope stays https://purview.azure.net.
          //
          // Off-Commercial (GCC / GCC-High / IL5) we DO NOT wire this at all —
          // the data-product factory ignores Unified Catalog there and uses Cosmos
          // (resolveDataProductBackend() forces 'cosmos' when boundary != Commercial),
          // so the wizard saves the draft to Loom's Cosmos store and shows an honest
          // "not registered in Purview" hint (no gate; 100% functional Azure-native
          // per no-fabric-dependency.md). For a per-tenant UC host, set
          // loomPurviewUnifiedAccount to the {tenantId}-api.purview-service.microsoft.com
          // value, which wins over this global default.
          (purviewEnabled && boundary == 'Commercial') ? [
            { name: 'LOOM_PURVIEW_UC_ENDPOINT', value: 'https://api.purview-service.microsoft.com' }
            { name: 'LOOM_PURVIEW_UC_API_VERSION', value: '2026-03-20-preview' }
          ] : [],
          // Apache Atlas-on-AKS lineage endpoint (DoD / IL5 boundary). Read by
          // /api/items/[type]/[id]/lineage when detectLoomCloud() === 'DoD'.
          // STRICTLY the Azure-native lineage backend for sovereign clouds — no
          // Fabric/OneLake dependency. Empty when atlasOnAksEnabled = false, in
          // which case the lineage drawer shows an honest "set LOOM_ATLAS_ENDPOINT"
          // MessageBar gate (never an empty graph).
          atlasOnAksEnabled ? [
            { name: 'LOOM_ATLAS_ENDPOINT', value: catalog.outputs.atlasEndpoint }
          ] : [],
          loomMipEnabled ? [
            { name: 'LOOM_MIP_ENABLED', value: 'true' }
          ] : [],
          // SCC labels sidecar wiring — enables label/policy CRUD (create/edit/
          // delete) + policy reads. Endpoint + host key come from the deployed
          // scc-labels Function (only present when loomMipAdminEnabled). When
          // unset the Console renders the honest mip_admin_not_configured gate.
          loomMipAdminEnabled ? [
            { name: 'LOOM_MIP_ADMIN_ENABLED', value: 'true' }
            { name: 'LOOM_SCC_LABELS_ENDPOINT', value: sccLabels.outputs.endpoint }
            { name: 'LOOM_SCC_LABELS_KEY', value: sccLabels.outputs.functionKey }
          ] : [],
          // Sovereign Graph base for MIP — GCC-High / IL5 use graph.microsoft.us.
          // mip-graph-client reads LOOM_MIP_GRAPH_BASE (defaults to graph.microsoft.com).
          boundary == 'GCC-High' || boundary == 'IL5' ? [
            { name: 'LOOM_MIP_GRAPH_BASE', value: 'https://graph.microsoft.us' }
          ] : [],
          // Custom domain-image gallery storage (honest-gated). The
          // /admin/domains Image tab lists image blobs here; preset swatches +
          // icons work regardless. Precedence: an explicit operator param wins;
          // otherwise fall back to the catalog module's auto-provisioned ADLS
          // (DFS) container URL so the custom-image gallery is wired with NO
          // manual step whenever Purview/catalog storage is deployed. Stays
          // unset (honest "not configured" gate) only when neither is present.
          // No Fabric/OneLake dependency.
          !empty(loomDomainImageStorage) ? [
            { name: 'LOOM_DOMAIN_IMAGE_STORAGE', value: loomDomainImageStorage }
          ] : (!empty(catalog.outputs.domainImagesDfsContainerUrl) ? [
            { name: 'LOOM_DOMAIN_IMAGE_STORAGE', value: catalog.outputs.domainImagesDfsContainerUrl }
          ] : []),
          loomDlpEnabled ? [
            { name: 'LOOM_DLP_ENABLED', value: 'true' }
          ] : [],
          // DLP policy CRUD via the SCC PowerShell sidecar (Graph has no DLP
          // write API). Reuses the same scc-labels Function app endpoint+key as
          // label CRUD; when loomMipAdminEnabled already wired them, only the
          // LOOM_DLP_ADMIN_ENABLED flag is added to avoid duplicate env keys.
          // When unset the Console renders the honest dlp_admin_not_configured
          // gate while DLP reads / alerts / Restrict-access keep working.
          loomDlpAdminEnabled ? concat(
            [ { name: 'LOOM_DLP_ADMIN_ENABLED', value: 'true' } ],
            loomMipAdminEnabled ? [] : [
              { name: 'LOOM_SCC_LABELS_ENDPOINT', value: sccLabels.outputs.endpoint }
              { name: 'LOOM_SCC_LABELS_KEY', value: sccLabels.outputs.functionKey }
            ]
          ) : [],
          // Govern → Admin view (F2) "View more" embedded report env. The
          // embed BFF gates honestly when LOOM_REPORT_KIND is empty; when set,
          // the matching report/dashboard env vars must also be present.
          !empty(loomReportKind) ? [
            { name: 'LOOM_REPORT_KIND', value: loomReportKind }
          ] : [],
          (loomReportKind == 'powerbi' && !empty(loomGovernPbiWorkspaceId) && !empty(loomGovernPbiReportId)) ? [
            { name: 'LOOM_GOVERN_PBI_WORKSPACE_ID', value: loomGovernPbiWorkspaceId }
            { name: 'LOOM_GOVERN_PBI_REPORT_ID', value: loomGovernPbiReportId }
          ] : [],
          (loomReportKind == 'grafana' && managedGrafanaEnabled) ? [
            { name: 'LOOM_GRAFANA_ENDPOINT', value: grafana.properties.endpoint }
            { name: 'LOOM_GRAFANA_DASHBOARD_UID', value: loomGrafanaDashboardUid }
          ] : (loomReportKind == 'grafana' && !empty(loomGrafanaDashboardUid) ? [
            { name: 'LOOM_GRAFANA_DASHBOARD_UID', value: loomGrafanaDashboardUid }
          ] : []),
          // F21 Usage page (/admin/usage) "Open analytics" embed — per-cloud,
          // strictly opt-in (the native Fluent charts + Log Analytics telemetry
          // are the always-on default). Power BI is Fabric-family → opt-in only
          // (no-fabric-dependency.md). Gov renders Managed Grafana, never an
          // EmptyState upsell.
          !empty(loomUsageReportKind) ? [
            { name: 'LOOM_USAGE_REPORT_KIND', value: loomUsageReportKind }
          ] : [],
          (loomUsageReportKind == 'powerbi' && !empty(loomUsagePbiWorkspaceId) && !empty(loomUsagePbiReportId)) ? [
            { name: 'LOOM_USAGE_PBI_WORKSPACE_ID', value: loomUsagePbiWorkspaceId }
            { name: 'LOOM_USAGE_PBI_REPORT_ID', value: loomUsagePbiReportId }
          ] : [],
          (loomUsageReportKind == 'grafana' && !empty(loomGrafanaUsageDashboardUid)) ? [
            { name: 'LOOM_GRAFANA_USAGE_DASHBOARD_UID', value: loomGrafanaUsageDashboardUid }
          ] : [],
          // Ensure LOOM_GRAFANA_ENDPOINT is wired for the Usage grafana embed
          // even when the Govern report doesn't also use grafana (avoid a
          // duplicate env name when both do).
          (loomUsageReportKind == 'grafana' && managedGrafanaEnabled && loomReportKind != 'grafana') ? [
            { name: 'LOOM_GRAFANA_ENDPOINT', value: grafana.properties.endpoint }
          ] : [],
          // F6 item-level permissions: the Fabric /share mirror is strictly
          // opt-in and additive — the Azure-native backing (Cosmos
          // item-permissions + ADLS POSIX ACL + Storage data-plane RBAC) is
          // always on and needs NO Fabric workspace. Only set this flag when an
          // operator wants grants ALSO pushed to a bound Fabric item.
          (loomFabricPermissionsEnabled && boundary != 'GCC-High' && boundary != 'IL5') ? [
            { name: 'LOOM_FABRIC_PERMISSIONS_ENABLED', value: 'true' }
          ] : [],
          // Fabric / Power BI Copilot opt-in. The cross-item Copilot is
          // Azure-native (Azure OpenAI) by DEFAULT — these env vars are ONLY
          // injected when an operator explicitly sets loomCopilotBackend='fabric'
          // AND binds a workspace AND the boundary is Commercial/GCC. Never set
          // in GCC-High / IL5 (Fabric Copilot is unavailable in sovereign
          // clouds). With them unset the orchestrator makes ZERO
          // api.fabric.microsoft.com calls (per no-fabric-dependency.md).
          (loomCopilotBackend == 'fabric' && !empty(loomDefaultFabricWorkspace) && boundary != 'GCC-High' && boundary != 'IL5') ? [
            { name: 'LOOM_COPILOT_BACKEND', value: 'fabric' }
            { name: 'LOOM_COPILOT_FABRIC_WORKSPACE', value: loomDefaultFabricWorkspace }
          ] : [],
          loomPowerBiAdminLabels ? [
            { name: 'LOOM_POWERBI_ADMIN_LABELS', value: 'true' }
          ] : [],
          // XMLA endpoint for semantic-model authoring that needs the XMLA write
          // surface (Automatic aggregations). Azure-native default = Azure
          // Analysis Services; Premium/Fabric XMLA is opt-in by URL. Empty →
          // the Aggregations tab renders but honest-gates (no Fabric dependency).
          !empty(loomPowerbiXmlaEndpoint) ? [
            { name: 'LOOM_POWERBI_XMLA_ENDPOINT', value: loomPowerbiXmlaEndpoint }
          ] : [],
          // Identity Picker (Entra user/group/SPN search + transitive nested
          // groups) — gated on the Console UAMI's Graph User.Read.All +
          // Group.Read.All + Application.Read.All grants. When false the BFF
          // returns 503 with the exact remediation (no mock principals).
          loomIdentityPickerEnabled ? [
            { name: 'LOOM_IDENTITY_PICKER_ENABLED', value: 'true' }
          ] : [],
          // Workspace ↔ Microsoft 365 group linking (workspace settings → "Teams
          // and SharePoint" tab). When enabled the Console can CREATE an M365
          // group for a workspace (needs the Group.ReadWrite.All Graph grant
          // documented by identity-graph-rbac.bicep). Linking an existing group
          // needs only Group.Read.All. When false the tab gates honestly.
          loomWorkspaceM365LinkEnabled ? [
            { name: 'LOOM_WORKSPACE_M365_LINK', value: 'true' }
          ] : [],
          // Per-domain Entra security-group provisioning for the D2 domain-admin /
          // domain-contributor RBAC tiers. When enabled the Console can CREATE the
          // loom-domain-<id>-admins / -contributors security groups at domain-create
          // time (needs the Group.ReadWrite.All Graph grant documented by
          // identity-graph-rbac.bicep — same AppRole as M365 linking). When false the
          // provisionGroups path gates honestly (503) and the legacy admins[]/
          // contributors model still applies.
          loomDomainGroupProvisioningEnabled ? [
            { name: 'LOOM_DOMAIN_GROUP_PROVISIONING', value: 'true' }
          ] : [],
          // OneLake shortcuts → SharePoint document libraries / OneDrive folders
          // via Microsoft Graph (lakehouse editor → New shortcut → SharePoint /
          // OneDrive). Needs the Console UAMI's Sites.Read.All + Files.Read.All
          // Graph AppRoles (documented by identity-graph-rbac.bicep). When false
          // the SharePoint source renders but the browse/create return 503 with
          // the exact remediation (no mock data) — per no-vaporware.md.
          loomSharepointShortcutsEnabled ? [
            { name: 'LOOM_SHAREPOINT_SHORTCUTS_ENABLED', value: 'true' }
          ] : [],
          // Dedicated per-workspace backing resource-group name prefix used by
          // the workspace create wizard (Advanced → provision a dedicated RG).
          // The Console UAMI needs Contributor at subscription scope to create
          // them; otherwise the wizard records an honest backingRgProvision error.
          [
            { name: 'LOOM_WORKSPACE_RG_PREFIX', value: loomWorkspaceRgPrefix }
          ],
          // Sovereign Microsoft Graph endpoint. Commercial/GCC use the global
          // host; GCC-High uses graph.microsoft.us; IL5/DoD uses
          // dod-graph.microsoft.us. The identity-picker client derives BOTH the
          // base AND the token scope from this value so gov tenants mint a
          // sovereign-scoped token. Existing Graph callers (admin/users,
          // lakehouse/permissions) already read LOOM_GRAPH_BASE, so setting it
          // here also fixes their gov-cloud endpoint in one shot.
          [
            { name: 'LOOM_GRAPH_BASE', value: boundary == 'GCC-High' ? 'https://graph.microsoft.us' : (boundary == 'IL5' ? 'https://dod-graph.microsoft.us' : 'https://graph.microsoft.com') }
          ],
          catalogPrimary == 'unity-catalog-managed' || databricksUnityCatalogEnabled ? [
            // Unity Catalog federation hostname list. Uses the REAL workspace
            // hostname (same source as the singular LOOM_DATABRICKS_HOSTNAME) —
            // NOT a synthesized adb-csa-loom-* name, which never resolves
            // (Databricks workspace URLs embed a non-deterministic id). Empty
            // until patched post-deploy from the DLZ workspaceUrl, so UC gates
            // honestly rather than calling a phantom host (per no-vaporware.md).
            { name: 'LOOM_DATABRICKS_HOSTNAMES', value: effDatabricksHostname }
          ] : [],
          // Unified-lineage system-table warehouse (optional). When set, the
          // /api/.../lineage routes read system.access.table_lineage for the
          // entity-aware (notebook/job/pipeline) lineage depth; empty falls
          // back to the REST lineage-tracking preview. See unified-lineage.ts.
          !empty(loomDatabricksLineageWarehouseId) ? [
            { name: 'LOOM_DATABRICKS_LINEAGE_WAREHOUSE_ID', value: loomDatabricksLineageWarehouseId }
          ] : [],
          // Databricks ACCOUNT API — enables Catalog → Metastores one-click UC
          // metastore attach (account-plane assignment) + the account metastore
          // picker. Empty leaves the attach action gated honestly; registration
          // (persisted to Cosmos) + catalog listing still work without it.
          !empty(loomDatabricksAccountId) ? [
            { name: 'LOOM_DATABRICKS_ACCOUNT_ID', value: loomDatabricksAccountId }
          ] : [],
          !empty(loomDatabricksAccountHost) ? [
            { name: 'LOOM_DATABRICKS_ACCOUNT_HOST', value: loomDatabricksAccountHost }
          ] : [],
          // Fabric API base is always set — the runtime gates on UAMI authz.
          [
            { name: 'LOOM_CLOUD_BOUNDARY', value: boundary }
            { name: 'LOOM_FABRIC_BASE', value: boundary == 'GCC-High' || boundary == 'IL5' ? 'https://api.fabric.microsoft.us/v1' : 'https://api.fabric.microsoft.com/v1' }
            // Power BI REST base — Azure-Government-backed Power BI host in
            // GCC-High / IL5 (api.powerbigov.us), Commercial host elsewhere.
            // This is a Power BI REST host (NOT a Fabric API host), so it is
            // permitted on the default path per no-fabric-dependency.md. Used by
            // the report Visual Designer's executeQueries calls + measure
            // validation. GCC runs on the Commercial api.powerbi.com host.
            { name: 'LOOM_POWERBI_BASE', value: boundary == 'GCC-High' || boundary == 'IL5' ? 'https://api.powerbigov.us/v1.0/myorg' : 'https://api.powerbi.com/v1.0/myorg' }
            // Power BI REST AAD scope (GenerateToken / ExportTo / refresh). This
            // is the analysis.* powerbi/api audience and splits 4 ways across the
            // sovereign boundaries — hard-coding the Commercial scope silently
            // 401s against api.powerbigov.us in Gov/DoD. getPbiScope() derives it
            // from LOOM_CLOUD when this is unset; we pin it explicitly per
            // boundary so the paginated-report embed token mints correctly.
            { name: 'LOOM_POWERBI_SCOPE', value: boundary == 'IL5' ? 'https://mil.analysis.usgovcloudapi.net/powerbi/api/.default' : (boundary == 'GCC-High' ? 'https://high.analysis.usgovcloudapi.net/powerbi/api/.default' : (boundary == 'GCC' ? 'https://analysis.usgovcloudapi.net/powerbi/api/.default' : 'https://analysis.windows.net/powerbi/api/.default')) }
            // Semantic-model Model view — OPTIONAL Azure Analysis Services XMLA
            // write endpoint (azure-native, no Fabric). Empty by default: the
            // Loom-native Cosmos backend works without it. Set to the DLZ
            // aas.bicep `xmlaEndpoint` output to enable XMLA writes.
            { name: 'LOOM_AAS_XMLA_ENDPOINT', value: loomAasXmlaEndpoint }
            // Semantic-model backend selector. 'fabric' opts INTO the Fabric REST
            // write path (per no-fabric-dependency.md, strictly opt-in); any other
            // value keeps the azure-native default.
            { name: 'LOOM_SEMANTIC_MODEL_BACKEND', value: loomSemanticModelBackend }
            { name: 'LOOM_FABRIC_ADMIN_BASE', value: boundary == 'GCC-High' || boundary == 'IL5' ? 'https://api.fabric.microsoft.us/v1.0/myorg/admin' : 'https://api.fabric.microsoft.com/v1.0/myorg/admin' }
            // F5/F9 Manage Access — Fabric role mirroring is OPT-IN and only
            // ever allowed in Commercial. GCC-High / IL5 / DoD are sovereign gov
            // boundaries where Fabric is not authorized for production workloads,
            // and even GCC should stay Azure-native by default. Unset → Azure-native only.
            { name: 'LOOM_WORKSPACE_ROLES_FABRIC', value: (loomWorkspaceRolesFabricEnabled && boundary == 'Commercial') ? '1' : '' }
            // SESSION_SECRET is ALWAYS set (not gated on MSAL) so the Console can
            // mint/verify session cookies even on the default push-button deploy
            // before LOOM_MSAL_CLIENT_ID is wired (PRP deploy-readiness gap #3 —
            // "signed-out after Entra login" was caused by SESSION_SECRET being
            // gated behind a non-empty loomMsalClientId). The session-secret ACA
            // secret is likewise always present (see secrets concat below).
            { name: 'SESSION_SECRET', secretRef: 'session-secret' }
          ],
          !empty(effectiveMsalClientId) ? [
            { name: 'LOOM_MSAL_CLIENT_ID', value: effectiveMsalClientId }
            { name: 'LOOM_MSAL_CLIENT_SECRET', secretRef: 'loom-msal-client-secret' }
            // NOTE: do NOT map this secret to AZURE_CLIENT_SECRET — the Console
            // authenticates to Azure with its MANAGED IDENTITY (AZURE_CLIENT_ID /
            // LOOM_UAMI_CLIENT_ID below). Setting AZURE_CLIENT_SECRET makes
            // @azure/identity's EnvironmentCredential attempt a client-secret
            // login with the UAMI client id → AADSTS7000232 (MSI can't use a
            // secret), which breaks Cost/Monitor/Defender calls. MSAL + Dataverse
            // read LOOM_MSAL_CLIENT_SECRET / LOOM_DATAVERSE_CLIENT_SECRET instead.
            // (SESSION_SECRET is now set unconditionally in the base env above.)
            { name: 'LOOM_UAMI_CLIENT_ID', value: identity.outputs.uamiConsoleClientId }
            // Console UAMI principal (object) id — used by the F16 Azure
            // Connections role check (azure-connections-client) to verify the
            // UAMI holds Storage Blob Data Contributor / Log Analytics
            // Contributor before recording a connection as 'connected'. Falls
            // back to decoding the MI token's oid claim when unset.
            { name: 'LOOM_UAMI_PRINCIPAL_ID', value: identity.outputs.uamiConsolePrincipalId }
            // Microsoft Graph user enrichment — flipped ON by default so
            // /admin/users surfaces displayName + department from Entra.
            // The Console UAMI also needs the Graph Directory.Read.All
            // app-role grant, which the
            // scripts/csa-loom/grant-uami-graph-roles.sh post-deploy
            // bootstrap step performs (idempotent).
            { name: 'LOOM_GRAPH_USERS_ENABLED', value: 'true' }
            // OneLake Security (F7) — Azure-native folder/table ACL roles for
            // lakehouse / mirrored items. The ADLS-ACL backend is enabled when
            // the Console UAMI holds Storage Blob Data Owner (granted by
            // synapse.bicep loomOnelakeSecurityEnabled). Fabric sync is opt-in.
            { name: 'LOOM_ONELAKE_SECURITY_ACL', value: string(loomOnelakeSecurityEnabled) }
            { name: 'LOOM_FABRIC_SECURITY_ENABLED', value: string(loomFabricSecurityEnabled) }
            // Semantic-model backend + opt-in Azure Analysis Services composite
            // host. The semantic-model item defaults to the Loom-native tabular
            // layer (no AAS needed); these only populate when aasEnabled. The
            // per-table storage-mode picker builds composite TMSL regardless.
            { name: 'LOOM_SEMANTIC_BACKEND', value: loomSemanticBackend }
            { name: 'LOOM_AAS_ENDPOINT', value: aasEnabled ? aas!.outputs.serverFullName : '' }
            { name: 'LOOM_AAS_DATABASE', value: aasEnabled ? aas!.outputs.database : '' }
            // Dataverse auth — UAMIs can't be Dataverse Application Users
            // (Microsoft platform restriction), so re-use the MSAL Web App
            // SP credentials. The SP must be registered as a Dataverse
            // Application User with System Administrator role on every
            // env Loom should read. See docs/fiab/dataverse-app-user.md.
            { name: 'LOOM_DATAVERSE_CLIENT_ID', value: effectiveMsalClientId }
            { name: 'LOOM_DATAVERSE_CLIENT_SECRET', secretRef: 'loom-msal-client-secret' }
            { name: 'LOOM_DATAVERSE_TENANT_ID', value: tenant().tenantId }
            // Power Platform environment for the data-agent "Publish to Microsoft
            // 365 Copilot" action (Copilot Studio agent + Teams/M365 Copilot
            // channel via Dataverse). Empty = editor lists discoverable envs +
            // honest-gates. See docs/fiab/dataverse-app-user.md.
            { name: 'LOOM_COPILOT_STUDIO_ENVIRONMENT_ID', value: loomCopilotStudioEnvironmentId }
            // Power Apps canvas web-player base for the in-Loom "Play / embed"
            // tab + Studio tab (powerplatform-client.powerAppPlayerEmbedUri).
            // Commercial = apps.powerapps.com (the code default). Sovereign
            // clouds override: GCC/GCC-H = apps.gov.powerapps.us,
            // DoD = apps.appsplatform.us. Empty = code falls back to commercial.
            { name: 'LOOM_POWERAPPS_PLAYER_BASE', value: powerAppsPlayerBase }
            // Power Platform control-plane host overrides for sovereign clouds
            // (powerplatform-client BAP_BASE / POWERAPPS_BASE / FLOW_BASE).
            // Empty = code defaults to the Commercial hosts. For GCC/GCC-High/DoD
            // set these so environment lifecycle, apps, flows, and connections
            // target the *.gov / *.us control planes. Dataverse-scoped authoring
            // (tables, flow definitions) is per-env (<org>.crm.dynamics.com) and
            // auto-sovereign — no override needed.
            { name: 'LOOM_BAP_BASE', value: powerPlatformBapBase }
            { name: 'LOOM_POWERAPPS_BASE', value: powerPlatformPowerAppsBase }
            { name: 'LOOM_FLOW_BASE', value: powerPlatformFlowBase }
            // AI Foundry model-hosting account — used by the hub editor's
            // Models / Quota / Keys / Networking / RBAC tabs and the
            // data-agent test chat. Empty when AI Foundry isn't deployed.
            { name: 'LOOM_FOUNDRY_RG', value: byoFoundryRg }
            { name: 'LOOM_FOUNDRY_SUB', value: byoFoundrySub }
            { name: 'LOOM_FOUNDRY_NAME', value: (aiFoundryEnabled && empty(existingFoundryAccountName)) ? aiFoundry!.outputs.hubName : '' }
            // Azure AI Content Safety endpoint — copilot persona moderation
            // pipeline (Prompt Shields + harm analyze). Empty when the Content
            // Safety account isn't deployed (e.g. DoD), in which case the
            // Console honest-gates with a warning MessageBar (no silent pass).
            { name: 'LOOM_CONTENT_SAFETY_ENDPOINT', value: contentSafetyEnabled ? contentSafety!.outputs.endpoint : '' }
            // Azure ML workspace for notebook Library & Environment management
            // (aml-environments-client.ts) AND MLflow experiment tracking
            // (ml-experiment "Runs & metrics" tab, mlflow-client.ts). The Foundry
            // hub IS an AML workspace (kind=Hub), so we point at it by default;
            // loomAmlWorkspace / loomAmlRg override to a dedicated AML workspace.
            // Falls back to LOOM_FOUNDRY_NAME/_RG in code when empty. No Fabric dep.
            { name: 'LOOM_AML_WORKSPACE', value: !empty(amlWorkspaceName) ? amlWorkspaceName : (!empty(loomAmlWorkspace) ? loomAmlWorkspace : ((aiFoundryEnabled && empty(existingFoundryAccountName)) ? aiFoundry!.outputs.hubName : '')) }
            { name: 'LOOM_AML_RG', value: !empty(amlWorkspaceRg) ? amlWorkspaceRg : (!empty(loomAmlRg) ? loomAmlRg : byoFoundryRg) }
            { name: 'LOOM_AOAI_ACCOUNT', value: !empty(existingFoundryAccountName) ? existingFoundryAccountName : (aiFoundryEnabled ? aiFoundry!.outputs.aiServicesAccountName : '') }
            // The model-hosting account lives in this admin-plane RG. foundry-cs-client.ts
            // reads LOOM_AOAI_RG (falls back to LOOM_FOUNDRY_RG, but pin it explicitly).
            { name: 'LOOM_AOAI_RG', value: byoFoundryRg }
            { name: 'LOOM_AOAI_SUB', value: byoFoundrySub }
            // Foundry region — foundry-client.ts reads this for region-scoped
            // quota/model calls; falls back to a hard-coded 'eastus2' otherwise.
            { name: 'LOOM_FOUNDRY_REGION', value: location }
            // ML Experiment editor — Azure ML MLflow tracking. LOOM_AML_WORKSPACE
            // / LOOM_AML_RG are already set above (shared with aml-environments-
            // client AND the notebook "Azure ML" compute path in aml-client.ts →
            // list/start Compute Instances, list datastores, submit Command jobs);
            // mlflow-client.ts also reads LOOM_AML_REGION +
            // LOOM_SUBSCRIPTION_ID to construct the Commercial / GCC / sovereign
            // tracking URI automatically (amlDataPlaneHost picks the right host).
            // IL5 / GCC-High may instead pin an explicit tracking URI below.
            //
            // Standalone Azure ML workspace coordinates also back aml-client.ts
            // (resolveAmlTarget): the AML control-plane navigator (computes /
            // datastores / jobs / models / schedules / environments) and the
            // notebook AML toggle. Empty values fall back to LOOM_FOUNDRY_* /
            // LOOM_SUBSCRIPTION_ID in the resolver, so an AI Foundry hub doubles
            // as the AML workspace without extra config. The deploy-planner
            // mlWorkspace module provisions a dedicated workspace + grants the
            // Console UAMI AzureML Data Scientist. No Fabric dependency. Cloud
            // routing is handled at runtime.
            { name: 'LOOM_AML_REGION', value: empty(loomAmlRegion) ? location : loomAmlRegion }
            { name: 'LOOM_AML_RESOURCE_GROUP', value: loomAmlResourceGroup }
            { name: 'LOOM_AML_SUBSCRIPTION', value: loomAmlSubscription }
            // IL5 / GCC-High may set an explicit tracking URI when auto-
            // construction can't express the boundary-specific / private-link
            // shape. Empty in Commercial / GCC, where auto-construction applies.
            // When set, mlflow-client.ts uses it verbatim (highest priority).
            { name: 'LOOM_MLFLOW_TRACKING_URI', value: loomMlflowTrackingUri }
            // Foundry Agent Service (data-plane) — backs the data-agent Publish flow +
            // the Foundry agent editor. The dedicated Agent Service account
            // (foundry-project.bicep, aifndry-loom-<location>) takes precedence;
            // otherwise fall back to the shared Hub's project (ai-foundry.bicep).
            // Empty when neither is deployed.
            { name: 'LOOM_FOUNDRY_PROJECT_ENDPOINT', value: agentFoundryEnabled ? agentFoundry!.outputs.projectEndpoint : ((aiFoundryEnabled && empty(existingFoundryAccountName)) ? aiFoundry!.outputs.projectEndpoint : '') }
            // Foundry ACCOUNT-level endpoint (alias of the project endpoint for
            // self-audit's anyOf: LOOM_AOAI_ENDPOINT | LOOM_FOUNDRY_PROJECT_ENDPOINT
            // | LOOM_FOUNDRY_ENDPOINT). Sourced from the dedicated Agent Service
            // account (aoaiEndpoint) when present, else the shared Foundry hub's
            // AI Services account endpoint. Empty when neither is deployed.
            { name: 'LOOM_FOUNDRY_ENDPOINT',         value: agentFoundryEnabled ? agentFoundry!.outputs.aoaiEndpoint : ((aiFoundryEnabled && empty(existingFoundryAccountName)) ? aiFoundry!.outputs.aiServicesEndpoint : (!empty(existingFoundryAccountName) ? byoFoundryEndpoint : '')) }
            { name: 'LOOM_FOUNDRY_PROJECT_ID',       value: agentFoundryEnabled ? agentFoundry!.outputs.projectId : ((aiFoundryEnabled && empty(existingFoundryAccountName)) ? aiFoundry!.outputs.projectId : '') }
            { name: 'LOOM_FOUNDRY_PROJECT_NAME',     value: agentFoundryEnabled ? agentFoundry!.outputs.projectNameOut : '' }
            // AOAI inference endpoint + model deployment names for the Agent
            // Service account. Consumed by the AOAI clients (chat + embeddings).
            // AOAI inference endpoint + model deployment names. Sourced from the
            // dedicated Agent Service account when present, else from the shared
            // Foundry hub (so the AI Functions Gov/AOAI path works on a hub-only
            // deploy — the deployment is then discovered from the hub connections
            // by resolveAoaiTarget()).
            { name: 'LOOM_AOAI_ENDPOINT',          value: agentFoundryEnabled ? agentFoundry!.outputs.aoaiEndpoint : (!empty(existingFoundryAccountName) ? byoFoundryEndpoint : ((aiFoundryEnabled && empty(existingFoundryAccountName)) ? aiFoundry!.outputs.aoaiInferenceEndpoint : '')) }
            // Deployment-name resolution order: dedicated Agent Service account
            // (agentFoundry, default on) → an explicit BYO deployment → the shared
            // Foundry hub's default model (ai-foundry.bicep now deploys gpt-4o-mini
            // on its AIServices account by default). The hub fallback is what makes
            // LOOM_AOAI_ENDPOINT (already wired to aiFoundry's inference endpoint
            // below) actually resolve a model on a hub-only / partial deploy — the
            // exact gap that left the live estate's aoai-csa-loom account with NO
            // deployment and the self-audit warning "No AOAI model deployment resolved".
            { name: 'LOOM_AOAI_CHAT_DEPLOYMENT',   value: agentFoundryEnabled ? agentFoundry!.outputs.chatDeployment : (!empty(byoFoundryChatDeployment) ? byoFoundryChatDeployment : ((aiFoundryEnabled && empty(existingFoundryAccountName)) ? aiFoundry!.outputs.defaultChatDeploymentName : '')) }
            // The copilot/data-agent orchestrators read LOOM_AOAI_DEPLOYMENT (not
            // the _CHAT_ variant) to resolve the model — keep both in sync so the
            // Copilot/data-agent chat works out of the box (the "no AOAI model"
            // gap was exactly this name mismatch on the live deploy).
            { name: 'LOOM_AOAI_DEPLOYMENT',        value: agentFoundryEnabled ? agentFoundry!.outputs.chatDeployment : (!empty(byoFoundryChatDeployment) ? byoFoundryChatDeployment : ((aiFoundryEnabled && empty(existingFoundryAccountName)) ? aiFoundry!.outputs.defaultChatDeploymentName : '')) }
            // AOAI Chat Completions API version. resolveAoaiTarget() reads
            // process.env.LOOM_AOAI_API_VERSION (default 2024-10-21). Exposing it
            // here lets operators advance the version (e.g. for o-series reasoning
            // models) without a code change. Cloud-invariant — only the data-plane
            // host differs per boundary, derived above from environment().
            { name: 'LOOM_AOAI_API_VERSION',       value: loomAoaiApiVersion }
            // AOAI Evals (preview) + fine-tuning/files (v1) API versions. The
            // foundry-cs-client reads LOOM_AOAI_EVALS_API_VERSION (default
            // 'preview') for the evals data-plane and LOOM_AOAI_FT_API_VERSION
            // (default 2024-10-21) for fine_tuning/jobs + /files. Cloud-invariant —
            // only the host differs per boundary.
            { name: 'LOOM_AOAI_EVALS_API_VERSION', value: loomAoaiEvalsApiVersion }
            { name: 'LOOM_AOAI_FT_API_VERSION',    value: loomAoaiFtApiVersion }
            // AOAI token audience by cloud (public: cognitiveservices.azure.com,
            // Gov: cognitiveservices.azure.us). Derived from the ARM environment()
            // built-in so no new parameter is needed. Read by the NL2KQL + Notebook
            // assist routes (process.env.LOOM_AOAI_AUDIENCE) to mint the bearer.
            { name: 'LOOM_AOAI_AUDIENCE',          value: environment().suffixes.storage != 'core.windows.net' ? 'https://cognitiveservices.azure.us' : 'https://cognitiveservices.azure.com' }
            { name: 'LOOM_AOAI_EMBED_DEPLOYMENT',  value: agentFoundryEnabled ? agentFoundry!.outputs.embedDeployment : byoFoundryEmbedDeployment }
            // Inline code completion (ghost text) deployment. Explicit
            // loomAoaiCompletionDeployment wins; otherwise the Foundry module's
            // output (empty unless a dedicated slot was deployed). When empty the
            // /api/copilot/complete route falls back to LOOM_AOAI_DEPLOYMENT.
            { name: 'LOOM_AOAI_COMPLETION_DEPLOYMENT', value: !empty(loomAoaiCompletionDeployment) ? loomAoaiCompletionDeployment : (agentFoundryEnabled ? agentFoundry!.outputs.completionDeployment : '') }
            // SQL editor Copilot (Fix / Explain / NL→T-SQL + inline ghost text).
            // Explicit loomAzureOpenAiEndpoint wins; otherwise reuse the Foundry
            // Agent Service AOAI endpoint. When both are empty the copilot route
            // returns an honest 503 gate naming this var + the Cognitive Services
            // OpenAI User role. LOOM_AOAI_DEPLOYMENT (above) supplies the model.
            { name: 'LOOM_AZURE_OPENAI_ENDPOINT',  value: !empty(loomAzureOpenAiEndpoint) ? loomAzureOpenAiEndpoint : (agentFoundryEnabled ? agentFoundry!.outputs.aoaiEndpoint : byoFoundryEndpoint) }
            { name: 'LOOM_DAB_PREVIEW_URL',        value: (dabRuntimeEnabled && !empty(dabSqlServerFqdn)) ? dabRuntime!.outputs.dabPreviewUrl : '' }
          ] : [
            { name: 'LOOM_UAMI_CLIENT_ID', value: identity.outputs.uamiConsoleClientId }
            { name: 'LOOM_GRAPH_USERS_ENABLED', value: 'true' }
            // OneLake Security (F7) — Azure-native folder/table ACL roles for
            // lakehouse / mirrored items. The ADLS-ACL backend is enabled when
            // the Console UAMI holds Storage Blob Data Owner (granted by
            // synapse.bicep loomOnelakeSecurityEnabled). Fabric sync is opt-in.
            { name: 'LOOM_ONELAKE_SECURITY_ACL', value: string(loomOnelakeSecurityEnabled) }
            { name: 'LOOM_FABRIC_SECURITY_ENABLED', value: string(loomFabricSecurityEnabled) }
            { name: 'LOOM_SEMANTIC_BACKEND', value: loomSemanticBackend }
            { name: 'LOOM_AAS_ENDPOINT', value: aasEnabled ? aas!.outputs.serverFullName : '' }
            { name: 'LOOM_AAS_DATABASE', value: aasEnabled ? aas!.outputs.database : '' }
            // Fabric IQ unified MCP tool surface (/api/iq/mcp). Off → the
            // token (external-agent) path is rejected; Console-session callers
            // always work. On → Agent 365 / Foundry can ground on ontology +
            // semantic + live-signals via the shared internal Bearer token.
            { name: 'LOOM_IQ_MCP_ENABLED', value: string(loomIqMcpEnabled) }
            // Headless CI Bearer-token path on the deployment-pipeline routes
            // (/api/deployment-pipelines/loom/**). Off → only Console-session
            // callers; the Azure DevOps / GitHub Actions task is rejected. On →
            // the CSA Loom DevOps task can drive deploys + management using the
            // shared internal Bearer token (or a dedicated LOOM_CI_TOKEN secret).
            { name: 'LOOM_PIPELINE_CI_ENABLED', value: string(loomPipelineCiEnabled) }
          ],
          // MAF orchestration tier (GCC-High / IL5). When the loom-copilot-maf
          // Container App deploys, set LOOM_MAF_ENDPOINT so copilot-orchestrator
          // auto-routes Gov turns to it, plus the shared internal token used to
          // authenticate the MAF → Console tool-dispatch callback.
          copilotMafActive ? [
            { name: 'LOOM_MAF_ENDPOINT', value: copilotMaf!.outputs.mafInternalEndpoint }
          ] : [],
          // Shared internal trust token — wired when ANY token-authenticated path
          // is active: the MAF tier, the IQ MCP external-agent path, OR the
          // deployment-pipeline CI path. Used as the default Bearer secret for
          // all three (LOOM_IQ_MCP_TOKEN / LOOM_CI_TOKEN override per-path).
          (copilotMafActive || loomIqMcpEnabled || loomPipelineCiEnabled) ? [
            { name: 'LOOM_INTERNAL_TOKEN', secretRef: 'loom-internal-token' }
          ] : [],
          // MCP stdio→HTTP/SSE bridge (apps/fiab-mcp-bridge). Deployed alongside
          // the other Loom apps; the External-MCP panel reads this to offer the
          // bridged npx/uvx servers for one-click registration. Empty when the
          // apps tier is off → the panel shows the honest gate.
          deployAppsEnabled ? [
            { name: 'LOOM_MCP_BRIDGE_URL', value: 'http://loom-mcp-bridge' }
          ] : []
        )
        secrets: concat(
          [
            // SESSION_SECRET is ALWAYS present (the env references it
            // unconditionally — PRP deploy-readiness gap #3). KV-backed when the
            // entra-app-registration script wrote a stable secret to Key Vault;
            // otherwise the inline stable per-RG GUID (or explicit param value)
            // so sign-ins survive redeploys even on a bicep-only day-one deploy.
            sessionSecretKvBacked
              ? { name: 'session-secret', keyVaultUrl: '${keyvault.outputs.keyVaultUri}secrets/session-secret', identity: identity.outputs.uamiConsoleId }
              : { name: 'session-secret', value: empty(loomSessionSecret) ? guid(resourceGroup().id, 'loom-session-secret-v1') : loomSessionSecret }
          ],
          !empty(effectiveMsalClientId) ? [
            // MSAL client secret — KV-backed when the entra-app-registration
            // script provisioned + stored it (the PRP "secret in Key Vault"
            // intent); otherwise the explicit param value (BYO existing app).
            msalSecretKvBacked
              ? { name: 'loom-msal-client-secret', keyVaultUrl: '${keyvault.outputs.keyVaultUri}secrets/loom-msal-client-secret', identity: identity.outputs.uamiConsoleId }
              : { name: 'loom-msal-client-secret', value: loomMsalClientSecret }
          ] : [],
          !empty(effectiveMapsAccount) ? [
            // Read from KV at deploy time. The azure-maps module wrote the
            // primary key here as 'loom-azure-maps-primary-key' on the
            // Loom Key Vault.
            { name: 'loom-azure-maps-key', keyVaultUrl: '${keyvault.outputs.keyVaultUri}secrets/${loomAzureMapsKeySecretName}', identity: identity.outputs.uamiConsoleId }
          ] : [],
          // Posture-refresh Function host key — stored in KV post-deploy as
          // 'loom-posture-function-key' (see azure-functions/posture-refresh/DEPLOYMENT.md).
          !empty(loomPostureFunctionUrl) ? [
            { name: 'loom-posture-function-key', keyVaultUrl: '${keyvault.outputs.keyVaultUri}secrets/${loomPostureFunctionKeySecretName}', identity: identity.outputs.uamiConsoleId }
          ] : [],
          // Paginated-report-renderer Function host key — stored in KV post-deploy
          // as 'loom-paginated-render-key' (see
          // azure-functions/paginated-report-renderer/DEPLOYMENT.md).
          !empty(loomPaginatedRenderUrl) ? [
            { name: 'loom-paginated-render-key', keyVaultUrl: '${keyvault.outputs.keyVaultUri}secrets/${loomPaginatedRenderKeySecretName}', identity: identity.outputs.uamiConsoleId }
          ] : [],
          // Shared internal trust token for the MAF → Console tool-dispatch
          // callback (GCC-High / IL5), the default Bearer secret for the IQ
          // MCP external-agent path, AND the default Bearer secret for the
          // deployment-pipeline CI path. Same deterministic value all consumers
          // get. Set a dedicated LOOM_CI_TOKEN secret to isolate CI if desired.
          (copilotMafActive || loomIqMcpEnabled || loomPipelineCiEnabled) ? [
            { name: 'loom-internal-token', value: loomInternalToken }
          ] : []
        )
      }
      {
        name: 'loom-mcp'
        image: 'loom-mcp:${appImageTags.mcp}'
        uamiId: identity.outputs.uamiMcpId
        uamiClientId: identity.outputs.uamiMcpClientId
        ingressPort: 8080
        external: false
        healthPath: '/.well-known/health'
        tier: 'mcp'
        minReplicas: 1
        maxReplicas: 3
        // Azure Files persistence (Container Apps only). The share is registered
        // on the CAE as mcpEnvStorage above; here we attach it as a volume +
        // mount so deployable MCP-server state survives revisions. Empty arrays
        // when mcpPersistenceEnabled is false → no mount (Azure-native default
        // still works without persistence). app-deployments.bicep passes these
        // through to template.volumes / container.volumeMounts.
        volumes: mcpFilesActive ? [
          { name: 'mcp-data-vol', storageType: 'AzureFile', storageName: mcpStorageRegistrationName }
        ] : []
        volumeMounts: mcpFilesActive ? [
          { volumeName: 'mcp-data-vol', mountPath: mcpMountPath }
        ] : []
        env: mcpFilesActive ? [
          { name: 'LOOM_MCP_DATA_DIR', value: mcpMountPath }
        ] : []
      }
      {
        // stdio→HTTP/SSE bridge (apps/fiab-mcp-bridge). Runs npx/uvx stdio MCP
        // servers as HTTP endpoints the External-MCP panel registers one-click.
        // AZURE_CLOUD drives the per-boundary catalog filter; AZURE_AUTHORITY_HOST
        // points Gov children at the .us login authority. Internal ingress only.
        name: 'loom-mcp-bridge'
        image: 'loom-mcp-bridge:${appImageTags.mcpBridge}'
        uamiId: identity.outputs.uamiMcpBridgeId
        uamiClientId: identity.outputs.uamiMcpBridgeClientId
        ingressPort: 8080
        external: false
        healthPath: '/.well-known/health'
        tier: 'mcp'
        minReplicas: 1
        maxReplicas: 3
        env: [
          { name: 'AZURE_CLOUD', value: (boundary == 'GCC-High' || boundary == 'IL5') ? 'AzureUSGovernment' : 'AzureCloud' }
          { name: 'AZURE_AUTHORITY_HOST', value: (boundary == 'GCC-High' || boundary == 'IL5') ? 'https://login.microsoftonline.us/' : 'https://login.microsoftonline.com/' }
          { name: 'LOOM_MCP_BRIDGE_CONFIG', value: '/app/config/loom-mcp-bridge.json' }
          { name: 'LOOM_MCP_BRIDGE_PORT', value: '8080' }
        ]
      }
      // NOTE: loom-setup-orchestrator is NOT in this generic appDeployments
      // array. It is deployed by the dedicated `setupOrchestrator` module below
      // (setup-orchestrator.bicep), gated on `setupOrchestratorActive`, running
      // AS the Console UAMI with the real Setup env (LOOM_ARM_ENDPOINT /
      // LOOM_SETUP_TEMPLATE_URI / internal token) and port 8080. A duplicate
      // entry here (a legacy agent-orchestrator stub) would collide on the
      // container-app name once the orchestrator deploys by default — removed.
      {
        name: 'loom-activator'
        image: 'loom-activator:${appImageTags.activator}'
        uamiId: identity.outputs.uamiActivatorId
        uamiClientId: identity.outputs.uamiActivatorClientId
        ingressPort: 8080
        external: false
        healthPath: '/health'
        tier: 'activator'
        minReplicas: 1
        maxReplicas: 3
      }
      {
        name: 'loom-mirroring'
        image: 'loom-mirroring:${appImageTags.mirroring}'
        uamiId: identity.outputs.uamiMirroringId
        uamiClientId: identity.outputs.uamiMirroringClientId
        ingressPort: 8083
        external: false
        healthPath: '/connectors'
        tier: 'mirroring'
        minReplicas: 1
        maxReplicas: 2
      }
      {
        name: 'loom-direct-lake-shim'
        image: 'loom-direct-lake-shim:${appImageTags.directLake}'
        uamiId: identity.outputs.uamiDirectLakeId
        uamiClientId: identity.outputs.uamiDirectLakeClientId
        ingressPort: 8080
        external: false
        healthPath: '/health'
        tier: 'direct-lake-shim'
        minReplicas: 1
        maxReplicas: 2
        env: [
          // Cosmos config store the shim reads its per-model refresh policy from
          // (direct-lake-config.refresh-policies). Same account as the Console
          // (the shim UAMI holds Cosmos DB Built-in Data Contributor).
          { name: 'COSMOS_ENDPOINT', value: loomCosmosEndpointVal }
          { name: 'COSMOS_DATABASE', value: 'direct-lake-config' }
          { name: 'COSMOS_CONTAINER', value: 'refresh-policies' }
          { name: 'AZURE_CLIENT_ID', value: identity.outputs.uamiDirectLakeClientId }
          // Service Bus queue the Event Grid system topic delivers _delta_log
          // BlobCreated events to. Empty when the shim is disabled → the
          // BackgroundService idles (honest, see DeltaLogEventHandler).
          { name: 'SERVICEBUS_NAMESPACE', value: loomDirectLakeShimEnabled ? dlShimSbFqdn : '' }
          { name: 'EVENTGRID_QUEUE', value: loomDirectLakeShimEnabled ? loomDirectLakeShimQueue : '' }
          { name: 'LOOM_DIRECT_LAKE_SHIM_ENABLED', value: loomDirectLakeShimEnabled ? 'true' : '' }
        ]
      }
    ]
  }
}

// Presidio sidecars — Gov only (where Content Safety isn't available)
module presidio 'presidio-sidecar.bicep' = if (containerPlatform == 'containerApps' && deployAppsEnabled && (boundary == 'GCC-High' || boundary == 'IL5')) {
  name: 'presidio'
  params: {
    location: location
    caeId: containerPlatformModule.outputs.caeId
    acrLoginServer: registry.outputs.acrLoginServer
    uamiId: identity.outputs.uamiCopilotId   // Reuses Copilot UAMI for ACR pull
    uamiClientId: identity.outputs.uamiCopilotClientId
    appInsightsConnectionString: monitoring.outputs.appInsightsConnectionString
    boundary: boundary
    complianceTags: complianceTags
  }
}

// =====================================================================
// MAF orchestration tier (GCC-High / IL5 only).
// Gov AOAI-direct copilot orchestration with NO AI Foundry Hub dependency.
// Auto-selected by copilot-orchestrator.ts when LOOM_MAF_ENDPOINT is set
// (only when this module deploys) + isGovCloud(). Tool dispatch + OBO are
// delegated back to the Console's token-gated internal endpoints.
// =====================================================================
module copilotMaf '../copilot/maf.bicep' = if (copilotMafActive) {
  name: 'copilot-maf'
  params: {
    location: location
    caeId: containerPlatformModule.outputs.caeId
    acrLoginServer: registry.outputs.acrLoginServer
    imageTag: appImageTags.maf
    uamiId: identity.outputs.uamiMafId
    uamiClientId: identity.outputs.uamiMafClientId
    // Gov AOAI endpoint — prefer the dedicated Agent Service account, then the
    // shared hub. Empty → the MAF app shows an honest runtime gate.
    aoaiEndpoint: agentFoundryEnabled
      ? agentFoundry!.outputs.aoaiEndpoint
      : ((aiFoundryEnabled && empty(existingFoundryAccountName)) ? aiFoundry!.outputs.aoaiInferenceEndpoint : '')
    aoaiDeployment: agentFoundryEnabled ? agentFoundry!.outputs.chatDeployment : ''
    aoaiApiVersion: '2024-10-21'
    consoleInternalEndpoint: 'http://loom-console'
    internalToken: loomInternalToken
    boundary: boundary == 'IL5' ? 'IL5' : 'GCC-High'
    appInsightsConnectionString: monitoring.outputs.appInsightsConnectionString
    complianceTags: complianceTags
  }
}

// =====================================================================
// dbt visual builder (audit-t144) — Synapse / Fabric dbt execution runtime.
// dbt-core + dbt-synapse + dbt-fabric + ODBC Driver 18 in a Container App.
// The Console (dbt-runner.ts) POSTs generated dbt projects here for the
// Synapse / opt-in Fabric targets (Databricks runs natively as a dbt_task and
// does NOT use this). Reuses the Console UAMI — it already holds Synapse SQL
// access; the runner authenticates with authentication=CLI. Scales to zero
// between batch runs. When absent the editor surfaces an honest gate.
// =====================================================================
module dbtRunner '../integration/dbt-runner.bicep' = if (dbtRunnerActive) {
  name: 'dbt-runner'
  params: {
    location: location
    caeId: containerPlatformModule.outputs.caeId
    acrLoginServer: registry.outputs.acrLoginServer
    imageTag: appImageTags.console
    uamiId: identity.outputs.uamiConsoleId
    uamiClientId: identity.outputs.uamiConsoleClientId
    appInsightsConnectionString: monitoring.outputs.appInsightsConnectionString
    complianceTags: complianceTags
  }
}

// Setup Orchestrator Container App (loom-setup-orchestrator) — submits the real
// subscription-scoped ARM deployment of main.json (templateLink) for the Setup
// Wizard's Deploy step. Runs AS the Console UAMI (identity.outputs.uamiConsole*),
// which main.bicep grants Contributor per target subscription via
// setup-orchestrator-rbac. Internal ingress; the Console reaches it at
// LOOM_SETUP_ORCHESTRATOR_URL with the shared internal token. Azure-native
// (Container Apps + ARM) — no Fabric dependency.
module setupOrchestrator 'setup-orchestrator.bicep' = if (setupOrchestratorActive) {
  name: 'setup-orchestrator'
  params: {
    location: location
    environmentId: containerPlatformModule.outputs.caeId
    uamiId: identity.outputs.uamiConsoleId
    uamiClientId: identity.outputs.uamiConsoleClientId
    acrLoginServer: registry.outputs.acrLoginServer
    image: '${registry.outputs.acrLoginServer}/loom-setup-orchestrator:${appImageTags.setupOrchestrator}'
    targetPort: 8080
    internalToken: loomInternalToken
    armEndpoint: boundary == 'GCC-High' || boundary == 'IL5' ? 'https://management.usgovcloudapi.net' : 'https://management.azure.com'
    setupTemplateUri: setupTemplateUri
    consoleInternalUrl: 'http://loom-console'
    appInsightsConnectionString: monitoring.outputs.appInsightsConnectionString
    complianceTags: complianceTags
  }
}

// label-propagation timer Function (F15) — sensitivity-label downstream
// propagation over the Loom Cosmos lineage graph. No-op without a Cosmos
// account (loomCosmosEndpoint empty). The Function identity is granted Cosmos
// DB Built-in Data Contributor in post-deploy bootstrap (grant-navigator-rbac.sh).
module labelPropagation 'label-propagation-function.bicep' = if (labelPropagationEnabled) {
  name: 'label-propagation-function'
  params: {
    location: location
    loomCosmosEndpoint: !empty(loomCosmosAccount) ? 'https://${loomCosmosAccount}.documents.${environment().suffixes.storage == 'core.usgovcloudapi.net' ? 'azure.us' : 'azure.com'}:443/' : ''
    loomCosmosDatabase: 'loom'
    labelPropagationCron: labelPropagationCron
    appInsightsConnectionString: monitoring.outputs.appInsightsConnectionString
    complianceTags: complianceTags
  }
}

// Report-subscriptions delivery Logic App (Consumption + O365 Send email V2
// with attachment) — Azure-native parity with Fabric/Power BI report
// subscription email delivery. Deployed alongside the timer Function in the
// admin-plane RG. Opt-in (reportSubscriptionsEnabled) because it requires an
// O365 mailbox connection authorized post-deploy. No Fabric / Power Automate.
module reportSubscriptionLogicApp '../integration/report-subscription-logicapp.bicep' = if (reportSubscriptionsEnabled) {
  name: 'report-subscription-logicapp'
  params: {
    location: location
    workflowName: loomSubscriptionLogicAppName
    // The Console UAMI is granted Logic App Contributor here so the BFF can
    // surface delivery status. The timer Function's MI is granted the same role
    // in post-deploy bootstrap (its principalId is an output of the Function
    // module below, not resolvable before this module deploys).
    consolePrincipalId: identity.outputs.uamiConsolePrincipalId
    complianceTags: complianceTags
  }
}

// Report-subscriptions timer Function — scheduled Power BI export → ADLS
// archive → email delivery via the Logic App above. No-op without a Cosmos
// account. The Function identity is granted Cosmos DB Built-in Data Contributor
// + Storage Blob Data Contributor + Logic App Contributor in post-deploy
// bootstrap (grant-navigator-rbac.sh) using the principalId output below.
module reportSubscriptions 'report-subscriptions-function.bicep' = if (reportSubscriptionsEnabled) {
  name: 'report-subscriptions-function'
  params: {
    location: location
    loomCosmosEndpoint: !empty(loomCosmosAccount) ? 'https://${loomCosmosAccount}.documents.${environment().suffixes.storage == 'core.usgovcloudapi.net' ? 'azure.us' : 'azure.com'}:443/' : ''
    loomCosmosDatabase: 'loom'
    reportSubscriptionsCron: reportSubscriptionsCron
    adlsAccount: loomStorageAccount
    loomSubscriptionId: subscription().subscriptionId
    subscriptionLogicAppName: loomSubscriptionLogicAppName
    subscriptionLogicAppRg: resourceGroup().name
    loomDlzRg: loomDlzRg
    appInsightsConnectionString: monitoring.outputs.appInsightsConnectionString
    complianceTags: complianceTags
  }
}

// SCC sensitivity-label + DLP CRUD sidecar (PowerShell). Performs New-/Set-/
// Remove-Label and *-LabelPolicy AND Get/New/Set/Remove-DlpCompliancePolicy
// via Security & Compliance PowerShell — the only API that can create/edit/
// delete labels, label policies, and DLP policies (Graph has no write surface).
// Opt-in: requires the SCC app + auth cert provisioned in post-deploy bootstrap.
// Deploys when EITHER label CRUD (loomMipAdminEnabled) OR DLP CRUD
// (loomDlpAdminEnabled) is requested. When both are false the Console renders
// the honest CRUD gates.
module sccLabels 'scc-labels-function.bicep' = if (loomMipAdminEnabled || loomDlpAdminEnabled) {
  name: 'scc-labels-function'
  params: {
    location: location
    sccAppId: sccAppId
    sccCertThumbprint: sccCertThumbprint
    sccOrganization: sccOrganization
    sccConnectionUri: sccConnectionUri
    appInsightsConnectionString: monitoring.outputs.appInsightsConnectionString
    complianceTags: complianceTags
  }
}

// =====================================================================
// User access patterns (Bastion is always-on via network.bicep).
// Each module is flag-gated so operators can pick the right path
// without rewriting Bicep. See docs/fiab/access-patterns.md.
// =====================================================================
module vpnGateway 'vpn-gateway.bicep' = if (vpnGatewayEnabled) {
  name: 'vpn-gateway'
  params: {
    location: location
    gatewaySubnetId: network.outputs.gatewaySubnetId
    complianceTags: complianceTags
  }
}

module appGateway 'app-gateway.bicep' = if (appGatewayEnabled && containerPlatform == 'containerApps' && deployAppsEnabled) {
  name: 'app-gateway'
  params: {
    location: location
    appGatewaySubnetId: network.outputs.appGatewaySubnetId
    consoleFqdn: 'loom-console.${containerPlatformModule.outputs.caeDefaultDomain}'
    consoleBackendIp: containerPlatformModule.outputs.caeStaticIp
    workspaceId: monitoring.outputs.lawId
    complianceTags: complianceTags
  }
}

module frontDoor 'front-door.bicep' = if (frontDoorEnabled && containerPlatform == 'containerApps' && deployAppsEnabled) {
  name: 'front-door'
  params: {
    location: location
    caeId: containerPlatformModule.outputs.caeId
    caeDefaultDomain: containerPlatformModule.outputs.caeDefaultDomain
    consoleFqdn: 'loom-console.${containerPlatformModule.outputs.caeDefaultDomain}'
    vanityDomain: loomVanityDomain
    // Auto-approve the FD -> ACA env Private Link connection so a clean deploy is
    // end-to-end functional (no manual portal "Approve"; otherwise FD 504s until
    // approved). The Console UAMI holds Network Contributor on this admin-plane RG
    // (network.bicep F15), which can approve the PE connection on the CAE.
    scriptIdentityId: identity.outputs.uamiConsoleId
    complianceTags: complianceTags
  }
}

@description('Optional vanity hostname for the console (e.g. csa-loom.contoso.ai). Empty = generated Front Door host only. The deploy emits the CNAME + _dnsauth TXT to add at your DNS provider.')
param loomVanityDomain string = ''

// =====================================================================
// Outputs
// =====================================================================

// =====================================================================
// Scale-by-SKU console (/admin/scaling) — the Console UAMI scales compute
// SKUs that all live in THIS admin RG: ADX/Kusto cluster, Synapse dedicated
// SQL pool (DWU), APIM, Container Apps, Fabric/foundry compute, AI Search.
// Those are ARM control-plane PATCH calls, so the UAMI needs write here.
// Without this grant the UAMI has only narrow per-resource + Reader roles in
// this RG and EVERY scale operation returns 403. Delegated to a sub-module so
// the principalId (a module output) is start-time-known inside it (BCP177).
// =====================================================================
module scalingRbac 'scaling-rbac.bicep' = {
  name: 'console-scaling-rbac'
  params: {
    consolePrincipalId: identity.outputs.uamiConsolePrincipalId
    skipRoleGrants: skipRoleGrants
  }
}

// MCP browse-catalog + deploy wizard — Console UAMI gets "Managed Identity
// Operator" so it can assign uami-loom-mcp to catalog-deployed MCP Container
// Apps (Contributor alone can't attach a user-assigned identity).
module mcpCatalogRbac 'mcp-catalog-rbac.bicep' = {
  name: 'console-mcp-catalog-rbac'
  params: {
    consolePrincipalId: identity.outputs.uamiConsolePrincipalId
    skipRoleGrants: skipRoleGrants
  }
}

// =====================================================================
// =====================================================================
// Govern → Admin view (F2) — "View more" embedded report backends.
//
//   - Power BI Embedded (A1, Gen2): Commercial / GCC. The Console UAMI is set
//     as a capacity administrator so it can mint embed tokens.
//   - Azure Managed Grafana: GCC-High / IL5. The Console UAMI is granted
//     "Grafana Viewer" so the BFF can embed the dashboard.
//
// Both gate off new bool params (default false) → no change to existing
// deployments. Per .claude/rules/no-fabric-dependency.md these are OPT-IN
// alternatives; the Govern surface works (with an honest gate) without either.
// =====================================================================
resource pbiEmbeddedCapacity 'Microsoft.PowerBIDedicated/capacities@2021-01-01' = if (pbiEmbeddedEnabled) {
  name: take('pbicsaloom${uniqueString(resourceGroup().id)}', 24)
  location: location
  tags: complianceTags
  sku: {
    name: 'A1'
    tier: 'PBIE_Azure'
  }
  properties: {
    administration: {
      members: [
        identity.outputs.uamiConsolePrincipalId
      ]
    }
    mode: 'Gen2'
  }
}

// =====================================================================
// F5 Manage Access — constrained Role Based Access Control Administrator on
// the DLZ RG so the Console can mirror workspace membership to real Azure RBAC
// role assignments (Contributor + Reader only, enforced via ABAC condition).
// Scoped to the DLZ RG (where the workspace backing resources live), so the
// module is invoked at that RG scope.
// =====================================================================
module workspaceRbac 'workspace-rbac.bicep' = if (!empty(loomDlzRg) && !skipRoleGrants) {
  name: 'console-workspace-rbac'
  scope: resourceGroup(loomDlzRg)
  params: {
    consolePrincipalId: identity.outputs.uamiConsolePrincipalId
    skipRoleGrants: skipRoleGrants
  }
}

// =====================================================================
// Direct-Lake-shim — Azure-native parity for Fabric Direct Lake. Deploys the
// Service Bus queue + Event Grid system topic on the DLZ ADLS account and
// grants the shim UAMI (+ optional AAS MI) Storage Blob Data Reader, so the
// shim can keep a warm AAS / Power BI Premium XMLA cache fresh from Delta
// `_delta_log` change events. Opt-in (loomDirectLakeShimEnabled) + requires the
// DLZ storage account; otherwise skipped (the semantic-model editor stays fully
// functional, showing the honest setup MessageBar in the Direct Lake tab).
// =====================================================================
module aasShim 'aas.bicep' = if (loomDirectLakeShimEnabled && !empty(loomDlzRg) && !empty(loomStorageAccount)) {
  name: 'aas-direct-lake-shim'
  scope: resourceGroup(loomDlzRg)
  params: {
    location: location
    storageAccountName: loomStorageAccount
    serviceBusNamespaceName: dlShimSbNamespaceName
    serviceBusQueueName: loomDirectLakeShimQueue
    shimMiPrincipalId: identity.outputs.uamiDirectLakePrincipalId
    aasMiPrincipalId: loomAasMiPrincipalId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
  }
}

// Item-level Share — constrained RBAC-Admin on the SQL server's RG so the
// per-database Share dialog can assign Reader/Contributor/SQL DB Contributor
// at the Microsoft.Sql/servers/databases scope (ABAC-limited to those roles).
//
// COLLISION GUARD: this grant and workspaceRbac (above) both assign the SAME
// role — Role Based Access Control Administrator — to the SAME principal (the
// Console UAMI). Azure dedupes role assignments by (principal, role, scope),
// NOT by name, so two RBAC-Admin assignments to the UAMI at the same RG fail the
// second one with `RoleAssignmentExists` (the centralus round-2 symptom, since
// loomSqlServerRg defaults to empty → this resolves to loomDlzRg, the very RG
// workspaceRbac targets). To stay idempotent on a fresh deploy we deploy THIS
// grant only when its RG is DISTINCT from the workspaceRbac RG; when they
// coincide, workspaceRbac's ABAC condition already includes SQL DB Contributor,
// so the single grant serves both the Manage Access and per-DB Share features.
var sqlShareRg = !empty(loomSqlServerRg) ? loomSqlServerRg : loomDlzRg
var workspaceRbacDeployed = !empty(loomDlzRg) && !skipRoleGrants
var sqlShareRgDistinct = !workspaceRbacDeployed || (toLower(sqlShareRg) != toLower(loomDlzRg))
module sqlDatabaseShareRbac 'sql-database-share-rbac.bicep' = if (!skipRoleGrants && !empty(sqlShareRg) && sqlShareRgDistinct) {
  name: 'console-sql-database-share-rbac'
  scope: resourceGroup(sqlShareRg)
  params: {
    consolePrincipalId: identity.outputs.uamiConsolePrincipalId
    skipRoleGrants: skipRoleGrants
  }
}

// audit-T64 — Plan (preview) backing SQL database (Azure-native parity of
// Fabric Plan's auto-provisioned Fabric SQL database). Opt-in: only when
// loomPlanBackingSqlServer names an EXISTING Azure SQL logical server. Creates
// the serverless `loom-plan` database (dbo.loom_plan_cells is created
// idempotently by the writeback BFF). Deploys into the SQL server's RG.
// No Microsoft Fabric dependency — planning cells always persist to Cosmos
// first; this DB is the governed, queryable writeback target.
module planBackingSql '../shared/plan-backing-sql.bicep' = if (!empty(loomPlanBackingSqlServer)) {
  name: 'console-plan-backing-sql'
  scope: resourceGroup(!empty(loomSqlServerRg) ? loomSqlServerRg : loomDlzRg)
  params: {
    sqlServerName: split(loomPlanBackingSqlServer, '.')[0]
    databaseName: !empty(loomPlanBackingSqlDatabase) ? loomPlanBackingSqlDatabase : 'loom-plan'
    location: location
  }
}

// =====================================================================
// Compute & Storage scale tab — SQL DB Contributor on the SQL server RG so
// the Console UAMI can PATCH database compute SKUs (DTU / vCore / serverless).
// Delegated to its own module (principalId is a runtime output — BCP177).
// Opt-in: set loomAzureSqlServerRg to the RG holding your SQL logical servers.
// =====================================================================
module sqlRbac 'sql-rbac.bicep' = if (!empty(loomAzureSqlServerRg) && !skipRoleGrants) {
  name: 'console-sql-scale-rbac'
  scope: resourceGroup(loomAzureSqlServerRg)
  params: {
    consolePrincipalId: identity.outputs.uamiConsolePrincipalId
    skipRoleGrants: skipRoleGrants
  }
}

// Eventstream IoT Hub source — Reader + Event Hubs Data Receiver on the bound
// IoT Hub so the Console UAMI can resolve + receive from its built-in endpoint.
// Opt-in: only when loomIotHubResourceId names a hub (scoped to that hub's RG).
module iotHubRbac 'iothub-rbac.bicep' = if (!empty(loomIotHubResourceId) && !skipRoleGrants) {
  name: 'console-iothub-rbac'
  scope: resourceGroup(split(loomIotHubResourceId, '/')[4])
  params: {
    iotHubName: last(split(loomIotHubResourceId, '/'))
    consolePrincipalId: identity.outputs.uamiConsolePrincipalId
    skipRoleGrants: skipRoleGrants
  }
}

// Identity Picker Graph AppRole documentation/wiring. AppRoles are granted
// out-of-band by grant-identity-graph-approles.sh (ARM can't grant Graph
// AppRoles); this module surfaces the required grants + sovereign Graph
// endpoint as deterministic outputs for the post-deploy bootstrap.
module identityGraphRbac 'identity-graph-rbac.bicep' = if (loomIdentityPickerEnabled || loomSharepointShortcutsEnabled || loomDomainGroupProvisioningEnabled) {
  name: 'console-identity-graph-rbac'
  params: {
    consolePrincipalId: identity.outputs.uamiConsolePrincipalId
    boundary: boundary
    skipRoleGrants: skipRoleGrants
    workspaceM365LinkEnabled: loomWorkspaceM365LinkEnabled
    domainGroupProvisioningEnabled: loomDomainGroupProvisioningEnabled
    sharepointShortcutsEnabled: loomSharepointShortcutsEnabled
    identityPickerEnabled: loomIdentityPickerEnabled
  }
}

resource grafana 'Microsoft.Dashboard/grafana@2023-09-01' = if (managedGrafanaEnabled) {
  name: take('grafana-csa-loom-${location}', 23)
  location: location
  tags: complianceTags
  sku: {
    name: 'Standard'
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    apiKey: 'Enabled'
    deterministicOutboundIP: 'Disabled'
    publicNetworkAccess: 'Enabled'
    zoneRedundancy: 'Disabled'
  }
}

// Grafana Viewer (60921a7e-fef1-4a43-9b16-a26c52ad4769) for the Console UAMI —
// granted via a module (a role-assignment name must be calculable at deploy
// start, which a module output is not, but a module param is). NOTE: the role
// GUID lives in grafana-rbac.bicep; the previously-cited 60750a24-… is NOT a
// valid built-in role and caused RoleDefinitionDoesNotExist — corrected there.
module grafanaViewer 'grafana-rbac.bicep' = if (managedGrafanaEnabled) {
  name: 'console-grafana-viewer'
  params: {
    grafanaName: grafana.name
    consolePrincipalId: identity.outputs.uamiConsolePrincipalId
    skipRoleGrants: skipRoleGrants
  }
}

output pbiEmbeddedCapacityName string = pbiEmbeddedEnabled ? pbiEmbeddedCapacity.name : ''
output grafanaEndpoint string = managedGrafanaEnabled ? grafana.properties.endpoint : ''

output hubVnetId string = network.outputs.hubVnetId
output consoleUrl string = containerPlatform == 'containerApps'
  ? 'https://loom-console.${containerPlatformModule.outputs.caeDefaultDomain}'
  : 'https://loom-console.${location}.csa-loom.internal'

output mcpServerUrl string = containerPlatform == 'containerApps'
  ? 'https://loom-mcp.${containerPlatformModule.outputs.caeDefaultDomain}'
  : 'https://loom-mcp.${location}.csa-loom.internal'

output mcpBridgeUrl string = containerPlatform == 'containerApps'
  ? 'https://loom-mcp-bridge.${containerPlatformModule.outputs.caeDefaultDomain}'
  : 'https://loom-mcp-bridge.${location}.csa-loom.internal'

// Built-in MCP tool server (azure-functions/mcp-server) — empty until the
// Function code is published (deployAppsEnabled). The Console reads the same
// value as LOOM_BUILTIN_MCP_URL for one-click registration.
output builtinMcpUrl string = builtinMcpUrl
output builtinMcpApiKeySecretName string = loomBuiltinMcpActive ? loomBuiltinMcpApiKeySecretName : ''

// Purview endpoint uses the catalog module's own purviewEndpoint output (which
// is built from the SELF-HEALED purview region — catalog.bicep falls back to a
// Purview-supported region when the hub `location`, e.g. centralus, is not in the
// Purview availability set). Recomputing with `${location}` here would emit the
// wrong host for an unsupported hub region. Falls back to the location-derived
// host only when purviewEndpoint is empty (purview disabled).
output catalogEndpoint string = catalogPrimary == 'purview'
  ? (!empty(catalog.outputs.purviewEndpoint)
      ? catalog.outputs.purviewEndpoint
      : 'https://purview-csa-loom-${location}.purview.azure.${boundary == 'GCC-High' || boundary == 'IL5' ? 'us' : 'com'}')
  : (catalogPrimary == 'unity-catalog-managed'
      ? 'https://adb-csa-loom-${location}.azuredatabricks.${boundary == 'GCC-High' || boundary == 'IL5' ? 'us' : 'net'}'
      : 'https://atlas-csa-loom.${location}.aks.csa-loom.internal')

output keyVaultUri string = keyvault.outputs.keyVaultUri
output appInsightsConnectionString string = monitoring.outputs.appInsightsConnectionString
output acrLoginServer string = registry.outputs.acrLoginServer
output uamiConsoleId string = identity.outputs.uamiConsoleId
output uamiConsolePrincipalId string = identity.outputs.uamiConsolePrincipalId
output uamiConsoleName string = identity.outputs.uamiConsoleName
output uamiConsoleClientId string = identity.outputs.uamiConsoleClientId
output uamiOrchestratorId string = identity.outputs.uamiOrchestratorId
output uamiCopilotId string = identity.outputs.uamiCopilotId
output uamiMcpId string = identity.outputs.uamiMcpId
output uamiActivatorId string = identity.outputs.uamiActivatorId
output uamiActivatorPrincipalId string = identity.outputs.uamiActivatorPrincipalId

// ADX cluster system-assigned MI principal ID — threaded to the DLZ
// landing-zone module so eventhubs.bicep can grant it Azure Event Hubs Data
// Receiver (required for KQL-database Event Hub data connections). Empty when
// ADX is disabled or a BYO existing cluster is used (then bootstrap the grant
// manually — see docs/fiab/v3-tenant-bootstrap.md).
output adxClusterPrincipalId string = (adxEnabled && empty(existingAdxClusterName)) ? adxCluster!.outputs.clusterPrincipalId : ''
output uamiMirroringId string = identity.outputs.uamiMirroringId
output uamiDirectLakeId string = identity.outputs.uamiDirectLakeId

// AOAI (AIServices) account name the notebook AI-functions library calls for
// inference. Only emitted when THIS deployment created the account (Foundry hub
// path) so the orchestrator can grant the Spark identities the OpenAI User role
// in this RG; empty for the existing/external-account path (operator grants it).
// Gap B — feed the AOAI account name to aoai-spark-rbac.bicep so the DLZ Spark
// identities (Synapse MSI + Databricks Access Connector) get Cognitive Services
// OpenAI User on the REAL account. Precedence: dedicated agentFoundry account
// (the day-one default) > shared Foundry hub > reused existing account IN THE
// ADMIN RG. A cross-sub / external BYO account is left empty here (the RBAC
// module's `existing` ref is scoped to the admin RG, so it can't grant on an
// out-of-RG account — the operator grants that one manually, matching the
// module's documented note). Empty when AOAI is fully disabled → module no-ops.
output aiServicesAccountName string = agentFoundryEnabled
  ? agentFoundry!.outputs.accountNameOut
  : ((aiFoundryEnabled && empty(existingFoundryAccountName))
      ? aiFoundry!.outputs.aiServicesAccountName
      : ((!empty(existingFoundryAccountName) && (empty(existingFoundryRg) || existingFoundryRg == resourceGroup().name)) ? existingFoundryAccountName : ''))

// Pass-through for DLZs
output privateDnsZoneIds object = network.outputs.privateDnsZoneIds
output lawId string = monitoring.outputs.lawId
output appInsightsId string = monitoring.outputs.appInsightsId

// Access-pattern outputs (only meaningful when their flag is on)
output vpnGatewayPublicIp string = vpnGatewayEnabled ? vpnGateway.outputs.vpnPublicIp : ''
output appGatewayPublicFqdn string = (appGatewayEnabled && containerPlatform == 'containerApps' && deployAppsEnabled) ? appGateway.outputs.publicFqdn : ''
output frontDoorPublicUrl string = (frontDoorEnabled && containerPlatform == 'containerApps' && deployAppsEnabled) ? frontDoor.outputs.frontDoorPublicUrl : ''
var fdOn = frontDoorEnabled && containerPlatform == 'containerApps' && deployAppsEnabled
@description('Vanity console URL (empty if no vanity domain set).')
output vanityPublicUrl string = fdOn ? frontDoor.outputs.vanityPublicUrl : ''
@description('DNS the admin must add at their provider to activate the vanity domain: CNAME <vanityDomain> → vanityCnameTarget, and TXT vanityDnsTxtName → vanityValidationToken.')
output vanityCnameTarget string = fdOn ? frontDoor.outputs.vanityCnameTarget : ''
output vanityDnsTxtName string = fdOn ? frontDoor.outputs.vanityDnsTxtName : ''
output vanityValidationToken string = fdOn ? frontDoor.outputs.vanityValidationToken : ''

// label-propagation timer Function (F15). principalId is granted Cosmos DB
// Built-in Data Contributor in post-deploy bootstrap (grant-navigator-rbac.sh).
output labelPropagationFunctionName string = labelPropagationEnabled ? labelPropagation.outputs.siteName : ''
output labelPropagationPrincipalId string = labelPropagationEnabled ? labelPropagation.outputs.principalId : ''

// report-subscriptions timer Function. principalId is granted Cosmos DB
// Built-in Data Contributor + Storage Blob Data Contributor + Logic App
// Contributor (on the delivery workflow) in post-deploy bootstrap.
output reportSubscriptionsFunctionName string = reportSubscriptionsEnabled ? reportSubscriptions.outputs.siteName : ''
output reportSubscriptionsPrincipalId string = reportSubscriptionsEnabled ? reportSubscriptions.outputs.principalId : ''
output reportSubscriptionLogicAppName string = reportSubscriptionsEnabled ? reportSubscriptionLogicApp.outputs.workflowName : ''
// MAF orchestration tier (GCC-High / IL5). Internal endpoint the Console reads
// as LOOM_MAF_ENDPOINT; empty when the tier isn't active.
output copilotMafEndpoint string = copilotMafActive ? copilotMaf!.outputs.mafInternalEndpoint : ''
output copilotMafPrincipalId string = (copilotMafEnabled && (boundary == 'GCC-High' || boundary == 'IL5')) ? identity.outputs.uamiMafPrincipalId : ''
