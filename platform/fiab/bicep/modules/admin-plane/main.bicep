// CSA Loom — Admin Plane orchestrator
// Deployment scope: resource group (rg-csa-loom-admin-<region>)

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Cloud boundary (Commercial / GCC / GCC-High / IL5)')
@allowed(['Commercial', 'GCC', 'GCC-High', 'IL5'])
param boundary string

@description('AZURE_CLOUD two-value discriminator. When non-empty, overrides the AZURE_CLOUD env var regardless of boundary. Commercial / GCC deployments pass AzureCloud; GCC-High / IL5 deployments pass AzureUSGovernment. When empty (default), AZURE_CLOUD is derived from boundary (GCC-High|IL5 → AzureUSGovernment; otherwise AzureCloud).')
@allowed(['', 'AzureCloud', 'AzureUSGovernment'])
param loomAzureCloud string = ''

@description('Container platform — containerApps or aks')
@allowed(['containerApps', 'aks'])
param containerPlatform string

@description('Functions host SKU. Reserved for v3.x — declared so the orchestrator contract is stable while the Functions host wiring is deferred.')
#disable-next-line no-unused-params
param functionsHostSku string

@description('APIM SKU')
param apimSku string

@description('Catalog primary')
param catalogPrimary string

@description('Agent orchestrator')
param agentOrchestrator string

@description('Capacity SKU. Reserved for v3.x — Fabric/Power BI capacity sizing parameter; wired downstream once landing-zone capacity module lands.')
#disable-next-line no-unused-params
param capacitySku string

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

@description('Notebook per-cell execution backend (F16). Azure-native default is Synapse Spark Livy. Set to "databricks" to opt into the Databricks Execution Context API, or "aml-ci" to execute against an Azure ML Compute-Instance Jupyter kernel (listNotebookAccessToken → Jupyter contents + kernel WebSocket; reuses LOOM_AML_*/LOOM_FOUNDRY_* + LOOM_SUBSCRIPTION_ID, no new vars). Must NOT be "databricks" at IL5.')
@allowed(['', 'synapse', 'databricks', 'aml-ci'])
param loomNotebookBackend string = ''

@description('Cloud authorization tier (e.g. "IL5"). When IL5, the notebook editor blocks the Databricks opt-in (Databricks Gov is not IL5-authorized) and falls back to Synapse Livy.')
param loomCloudTier string = ''

@description('Enable rich display() visualization for notebook cells (F-DS). When true, the BFF injects the ai-display.py helper as Livy session statement 0 so display(df) renders the Loom interactive grid + chart recommendations. Azure-native (Synapse Spark) — no Fabric dependency. When false/unset, display(df) falls back to the kernel built-in table.')
param loomRichDisplay bool = true

@description('Maximum rows sampled for the display() rich visualization grid + client-side chart aggregation (full-dataset aggregation still fires a real Spark job). Default 5000.')
@minValue(100)
@maxValue(20000)
param loomDisplaySampleRows int = 5000

@description('OpenAI region for chat. Reserved for v3.x — multi-region OpenAI deployment wiring (per-model regional pinning) is deferred.')
#disable-next-line no-unused-params
param openaiLocation string

@description('OpenAI region for embeddings. Reserved for v3.x — see openaiLocation note above.')
#disable-next-line no-unused-params
param openaiEmbeddingsLocation string

@description('OpenAI chat model. Reserved for v3.x — explicit deployment-name pinning is handled inside ai-foundry.bicep today.')
#disable-next-line no-unused-params
param openaiChatModel string

@description('OpenAI embeddings model. Reserved for v3.x — see openaiChatModel note above.')
#disable-next-line no-unused-params
param openaiEmbeddingsModel string

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

@description('Deploy the dedicated AI Foundry Agent Service account (aifndry-loom-<location>) with the loom-agents project + chat/embedding model deployments. Backs LOOM_FOUNDRY_PROJECT_ENDPOINT / LOOM_AOAI_* for the Agent Service. Independent of aiFoundryEnabled.')
param agentFoundryEnabled bool = false

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

@description('AAS SKU (Standard tier). S1 (~$160/mo) is the minimum that supports the data-plane refresh REST API with a service-principal admin.')
@allowed(['S0', 'S1', 'S2', 'S4', 'S8', 'S9'])
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

@description('Container image tag per app (loom-console, loom-mcp, loom-orchestrator, loom-activator, loom-mirroring, loom-direct-lake-shim, loom-copilot-maf). Default v0.1; override per release.')
param appImageTags object = {
  console: 'v0.1'
  mcp: 'v0.1'
  orchestrator: 'v0.1'
  activator: 'v0.1'
  mirroring: 'v0.1'
  directLake: 'v0.1'
  maf: 'v0.1'
}

@description('Deploy the MAF (Gov AOAI-direct) orchestration-tier Container App (loom-copilot-maf). Only honored in GCC-High / IL5 with containerPlatform==containerApps + deployAppsEnabled. Requires the loom-copilot-maf image pushed to ACR first.')
param copilotMafEnabled bool = false

// Shared internal trust token for the MAF → Console tool-dispatch callback.
// Deterministic on the admin RG so the value injected into BOTH the Console and
// the MAF app matches without a round-trip. Internal-network use only.
var loomInternalToken = guid(resourceGroup().id, 'loom-maf-internal-token-v1')

// MAF tier deploys only in Gov boundaries with Container Apps + app deploy on.
var copilotMafActive = copilotMafEnabled && (boundary == 'GCC-High' || boundary == 'IL5') && containerPlatform == 'containerApps' && deployAppsEnabled

@description('Loom version label shown in the UI (matches console image tag by convention).')
param loomVersion string = 'v0.1'

@description('Loom Synapse workspace name (for env-var wiring on loom-console). Default uses the single-sub DLZ convention.')
param loomSynapseWorkspace string = 'syn-loom-default-${location}'

@description('Loom Synapse Dedicated SQL pool name.')
param loomSynapseDedicatedPool string = 'loompool'

@description('Direct Lake warm-cache TTL in seconds. Semantic-model "Direct Lake query" requests within this window are served from the Power BI in-memory VertiPaq cache; older queries fall back transparently to Synapse Serverless OPENROWSET over the Gold Delta files. 0 = always Serverless. Default 3600 (1 hour).')
param loomDlCacheTtlSeconds int = 3600
@description('Entra group object ID whose members may run the Ops Admin Copilot ARM/config actions (scale capacity, toggle the Synapse outbound-access policy, create workspaces). Empty = any signed-in admin (matches the rest of the admin pane). Recommended: a dedicated "Loom Ops Admins" group. Membership is checked via Microsoft Graph transitiveMembers using the Console UAMI Group.Read.All AppRole (already granted by identity-graph-rbac).')
param loomOpsAdminEntraGroup string = ''

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

@description('Entra principal name the console identity is registered under in PostgreSQL (pgaadauth_create_principal). Empty = the PG Query tab shows an honest setup gate.')
param loomPostgresAadUser string = ''

@description('Loom Azure Data Factory name (for env-var wiring on loom-console — backs the ADF Pipeline/Dataset/Trigger editors).')
param loomAdfName string = 'adf-loom-default-${location}'

// NOTE: loomAasServer (AAS connection string used by both the semantic-model
// Power Query ingest refresh path AND the DAX tile / analysis-services
// backend path) is declared further below alongside loomSemanticBackend.

@description('Azure Analysis Services tabular model (database) name to refresh after the Power Query ingest lands Delta. Empty = AAS refresh gated.')
param loomAasModel string = ''

@description('Scaled self-hosted IR VMSS name (backs the SHIR metrics tile + scale controls). Defaults to the single-sub DLZ name; empty disables the SHIR surface (honest gate).')
param loomShirVmssName string = 'vmss-loom-shir-default'

@description('Loom Azure Data Factory resource group. Empty defaults to LOOM_DLZ_RG.')
param loomAdfRg string = ''

@description('Opt-in ADF CDC mirroring — name of the pre-existing ADF linked service for the relational SOURCE (Azure SQL / SQL Server / PostgreSQL). Empty = mirrored databases use the built-in CSV snapshot engine (still Azure-native, no Fabric).')
param loomMirrorSourceLinkedService string = ''

@description('Opt-in ADF CDC mirroring — name of the pre-existing ADF AzureBlobFS linked service pointing at the DLZ ADLS account (the Delta sink). Empty = mirrored databases use the built-in CSV snapshot engine.')
param loomMirrorAdlsLinkedService string = ''

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

@description('F4: Key Vault URI for schedule-time pipeline parameter overrides. Empty defaults to the admin-plane vault (Console UAMI already has Secrets Officer there). Set to a separate vault URI to source parameters from elsewhere (grant the Console identity "Key Vault Secrets User" on it).')
param loomParamKeyVaultUri string = ''

@description('Key Vault URI for external-source SHORTCUT credentials (S3/GCS/SAS/Synapse-Link). Empty defaults to the admin-plane vault (Console UAMI already has Secrets Officer there). Set to a separate vault to isolate shortcut credentials — keep it the SAME vault the shortcut engine binding reads, or unset to default.')
param loomShortcutKeyVaultUri string = ''

@description('Git integration — Azure DevOps host override for on-premises Azure DevOps Server (GCC-High / IL5 / DoD, where ADO Services is unavailable). Empty uses dev.azure.com (commercial/GCC). Example on-prem: https://tfs.agency.gov')
param loomAdoHost string = ''

@description('Git integration — GitHub Enterprise Server REST API base override. Empty uses api.github.com (commercial/GCC/GCC-High). Example GHES: https://github.agency.gov/api/v3')
param loomGitHubHost string = ''

@description('Git integration — Key Vault secret-name prefix for per-workspace PATs. Default loom-git-pat. Change only if sharing the vault with another system that uses the same prefix.')
param loomGitPatKvPrefix string = 'loom-git-pat'

@description('F4: Azure App Configuration endpoint for schedule-time pipeline parameter overrides. Empty disables the App Config source. Set to an App Configuration endpoint and grant the Console identity "App Configuration Data Reader" to enable.')
param loomParamAppConfigEndpoint string = ''

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

@description('Loom Event Hubs namespace name (backs the Event Hubs namespace navigator in the Eventstream editor). Defaults to the single-sub DLZ convention evhns-loom-default-<region> emitted by modules/landing-zone/eventhubs.bicep; override for multi-domain deployments. Empty surfaces the navigator config gate.')
param loomEventHubNamespace string = 'evhns-loom-default-${location}'

@description('Loom Event Hubs resource group. Empty defaults to LOOM_DLZ_RG.')
param loomEventHubRg string = ''

@description('Loom Event Hubs subscription ID. Empty defaults to LOOM_SUBSCRIPTION_ID.')
param loomEventHubSub string = ''

@description('Event Hubs Schema Registry schema group name for server-side Avro compatibility enforcement of event-schema-set registrations. When set, the console delegates schema registration to EH Schema Registry (data-plane PUT) and the service enforces compatibility on PUT. Leave empty to use the in-process Avro validator (the Azure-native default; no Fabric, no extra infra). Live default: loom-schemas, created by modules/landing-zone/eventhubs.bicep.')
param loomEhSchemaGroup string = ''

@description('RTI hub catalog — extra subscription IDs (comma-separated) to include in cross-subscription stream discovery via Azure Resource Graph, beyond the deployment subscription. The Console UAMI needs Reader at each subscription scope.')
param loomExtraSubscriptions string = ''

@description('Optional ARM resource ID of a default IoT Hub for ADX data connections (KQL Database → Add data connection wizard). When set, the IoT Hub picker pre-selects this hub; when empty, the wizard discovers all IoT Hubs visible to the Loom identity via Resource Graph. The ADX cluster system-assigned managed identity must hold "IoT Hub Contributor" (role ID 4763167e-fb37-48bb-8710-0fcd9d82e439, grants Microsoft.Devices/IotHubs/IotHubKeys/read) at the target IoT Hub scope for device-to-cloud ingestion to succeed — because the hub is user-selected at runtime, that grant is a one-time operator action surfaced as an honest-gate MessageBar in the editor.')
param loomIotHubResourceId string = ''

@description('Loom Alert Rules resource group (for monitoring alerts/rules). Empty defaults to LOOM_DLZ_RG.')
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

@description('Azure ML workspace name backing the notebook AML path (deploy-planner mlWorkspace module). Empty → the AML notebook toggle honest-gates (LOOM_AML_WORKSPACE unset).')
param amlWorkspaceName string = ''
@description('Resource group of the Azure ML workspace. Empty defaults to this admin RG.')
param amlWorkspaceRg string = ''

// Effective "reuse-or-new" identities used for Console env wiring below.
var byoAiSearchRg = !empty(existingAiSearchRg) ? existingAiSearchRg : resourceGroup().name
var byoApimRg     = !empty(existingApimRg) ? existingApimRg : resourceGroup().name
var byoAdxRg      = !empty(existingAdxClusterRg) ? existingAdxClusterRg : resourceGroup().name
var byoFoundryRg  = !empty(existingFoundryRg) ? existingFoundryRg : resourceGroup().name
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
@description('Azure Maps account name (e.g. maps-csa-loom-xyz). When empty, the geo-map / map editors fall back to OSM and surface the honest-gate MessageBar.')
param loomAzureMapsAccount string = ''
@description('Azure Maps primary key secret name in Key Vault (default: loom-azure-maps-primary-key). The Console reads this via secretRef.')
param loomAzureMapsKeySecretName string = 'loom-azure-maps-primary-key'

@description('Purview account name (short, NOT full URL) — e.g. "purview-csa-loom-eastus2". When empty, /admin/security Purview tab + /api/items/data-product/*/register-purview return HTTP 503 with a structured remediation hint.')
param loomPurviewAccount string = ''

@description('Enable Microsoft Information Protection (sensitivity labels / label policies) calls via Microsoft Graph. Requires the Console UAMI to have InformationProtectionPolicy.Read.All admin-consented. When false, /admin/security Information Protection tab returns 503.')
param loomMipEnabled bool = false

@description('Enable Purview DLP (policies / rules / alerts / simulate) calls via Microsoft Graph. Requires Console UAMI Policy.Read.All + SecurityAlert.Read.All admin-consented. When false, /admin/security DLP tab returns 503.')
param loomDlpEnabled bool = false

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

// =====================================================================
// Phase 2 — RBAC tenant-admin bootstrap + install-time provisioning targets
// =====================================================================

@description('Entra group oid(s) — comma-separated — whose members bypass the Loom Feature Permissions gate. Bootstrap admins need this set OR loomTenantAdminOid to manage /admin/permissions before any grants exist.')
param loomTenantAdminGroupId string = ''

@description('Entra user oid that bypasses the Loom Feature Permissions gate. Used in single-user bootstrap scenarios. Members of loomTenantAdminGroupId are recommended for production.')
param loomTenantAdminOid string = ''

@description('Default Fabric/Power BI workspace id the Phase-2 install engine uses when a Loom workspace has no bound Fabric group yet. Optional — the wizard prompts when missing.')
param loomDefaultFabricWorkspace string = ''

@description('OPT-IN ONLY: route the cross-item Copilot through a real Fabric/Power BI Copilot capacity workspace. The empty default keeps the Copilot 100% Azure-native (Azure OpenAI) with NO Fabric/Power BI call — no Fabric workspace required (per no-fabric-dependency.md). Set to "fabric" AND provide loomDefaultFabricWorkspace to opt in: the orchestrator then validates the bound workspace via api.fabric.microsoft.com before each session (LLM inference still runs on Azure OpenAI; Fabric Copilot exposes no public invocation API). Ignored in GCC-High / IL5 — Fabric Copilot is not supported in sovereign clouds.')
@allowed(['', 'fabric'])
param loomCopilotBackend string = ''

@description('Phase-2 warehouse provisioner backend. synapse-dedicated (default) runs DDL against the dedicated Synapse pool via TDS+AAD; fabric-warehouse is on the v3.5 roadmap.')
@allowed(['synapse-dedicated', 'fabric-warehouse'])
param loomWarehouseBackend string = 'synapse-dedicated'

// =====================================================================
// Azure-native backend selectors (no-fabric-dependency)
// =====================================================================

@description('Azure Data Lake Storage Gen2 bronze container name. Default: bronze.')
param loomBronzeContainer string = 'bronze'

@description('Pipeline orchestrator backend selector. Default: synapse. Alternatives: adf, fabric.')
@allowed(['synapse', 'adf', 'fabric'])
param loomPipelineBackend string = 'synapse'

@description('Event ingestion backend selector. Default: eventhubs (Azure Event Hubs). Alternatives: fabric.')
@allowed(['eventhubs', 'fabric'])
param loomEventBackend string = 'eventhubs'

@description('Activator rule backend selector. Default: azure-monitor (Azure Monitor). Alternatives: fabric.')
@allowed(['azure-monitor', 'fabric'])
param loomActivatorBackend string = 'azure-monitor'

@description('Default Log Analytics custom-log table the Azure-native Activator targets for entity-change triggers (e.g. ontology entity-change rules). Empty uses the code default AppEvents_CL.')
param loomActivatorDefaultTable string = 'AppEvents_CL'

@description('Dashboard backend selector. Default: adx (Azure Data Explorer/Kusto). Alternatives: fabric.')
@allowed(['adx', 'fabric'])
param loomDashboardBackend string = 'adx'

@description('Data mirroring backend selector. Default: adf-cdc (Azure Data Factory Change Data Capture). Alternatives: synapse-link, fabric.')
@allowed(['adf-cdc', 'synapse-link', 'fabric'])
param loomMirrorBackend string = 'adf-cdc'

@description('Lakehouse storage backend selector. Default: adls (Azure Data Lake Storage Gen2). Alternatives: fabric.')
@allowed(['adls', 'fabric'])
param loomLakehouseBackend string = 'adls'

@description('OneLake catalog Explore-tab backend selector (LOOM_CATALOG_BACKEND). Default: azure (AI Search loom-governance-items index, falling back to Cosmos when AI Search is not deployed — no Fabric/OneLake REST on the default path). Alternative: fabric (opt-in OneLake REST; additionally gated by sovereign-cloud reachability).')
@allowed(['azure', 'fabric'])
param loomCatalogBackend string = 'azure'

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

@description('Azure Analysis Services SKU when loomSemanticBackend=analysis-services. B1=Basic (cheapest with SLA), S0=Standard, D1=Developer (no SLA). AAS is Commercial/GCC only — never deployed at GCC-High / IL5 (the orchestrator guards on boundary).')
@allowed(['B1', 'B2', 'S0', 'S1', 'S2', 'S4', 'D1'])
param loomAasSku string = 'B1'

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

@description('Azure Analysis Services SKU. D1 = Developer (no SLA, test). B/S = Basic/Standard (prod).')
@allowed(['D1', 'B1', 'B2', 'S0', 'S1', 'S2', 'S4', 'S8', 'S9'])
param aasSku string = 'D1'

@description('BI backend selector for the Report editor. Empty (default) = Loom-native renderer that queries the bound Azure Analysis Services model with DAX (no Power BI / Fabric workspace required). Set to powerbi to opt into the Power BI embed (requires the Console UAMI registered in a Power BI workspace).')
@allowed(['', 'powerbi'])
param loomBiBackend string = ''



@description('Purview Unified Catalog account name (or per-tenant -api host) backing the F22 data-product adapter. When set alongside loomDataproductsBackend="unified-catalog" on the Commercial boundary, the Console routes data-product CRUD through the Unified Catalog REST API (https://api.purview-service.microsoft.com) instead of Cosmos. Leave empty on GCC / GCC-High / IL5 — the factory ignores it and uses Cosmos regardless. Independent of loomPurviewAccount (the classic Data Map account).')
param loomPurviewUnifiedAccount string = ''

@description('Governance Domains (F4) backend selector. cosmos (default) uses the Cosmos governance-domains container + best-effort Purview classic-collection mirror — works with NO Fabric workspace. fabric is opt-in (Commercial/GCC only; the BFF rejects it at IL5) and drives Fabric Admin /v1/admin/domains.')
@allowed(['cosmos', 'fabric'])
param loomDomainsBackend string = 'cosmos'

// ---------------------------------------------------------------------
// Copy Job watermark control table (F14 — Fabric Copy job parity)
// ---------------------------------------------------------------------

@description('FQDN of the Azure SQL server holding the copy-job watermark control table (dbo.copy_watermark), e.g. sql-loom-ctrl.database.windows.net. Empty = incremental copy surfaces an honest-gate MessageBar; full copy still works.')
param loomCopyJobControlSqlServer string = ''

@description('Database name for the copy-job watermark control table.')
param loomCopyJobControlSqlDb string = 'loom-control'

@description('Deploy the copy-job control table + stored procedure (and grant the ADF factory + console UAMI) via a deployment script. Requires loomCopyJobControlSqlServer set and the console UAMI configured as an Entra admin on that SQL server.')
param copyJobControlEnabled bool = false

@description('Dataflow Gen2 (Power Query) backend selector. Default: adf (Azure-native WranglingDataFlow on ADF Spark — no Fabric). fabric is opt-in and additionally requires LOOM_DEFAULT_FABRIC_WORKSPACE.')
@allowed(['adf', 'fabric'])
param loomDataflowBackend string = 'adf'

@description('Data-products store backend. Default empty → Cosmos (Azure-native DEFAULT; data products catalog in the Loom Cosmos `dataproducts` container, NO Microsoft Fabric / Purview-unified-catalog dependency). Set to "unified-catalog" to opt into the Purview Unified Catalog path, which throws an honest gate on a classic Data Map account.')
@allowed(['', 'cosmos', 'unified-catalog'])
param loomDataproductsBackend string = ''

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
    // /monitor Logs (KQL) tab — Console UAMI gets Log Analytics Reader on the LAW.
    consolePrincipalId: identity.outputs.uamiConsolePrincipalId
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
    consolePrincipalNeedsCmkRole: consolePrincipalNeedsCmkBind
    skipRoleGrants: skipRoleGrants
    privateEndpointSubnetId: network.outputs.privateEndpointsSubnetId
    privateDnsZoneVaultId: network.outputs.privateDnsZoneIds.keyvault
    workspaceId: monitoring.outputs.lawId
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

// =====================================================================
// 7. AI Search
// =====================================================================

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
    skuTier: aasSku == 'D1' ? 'Development' : (startsWith(aasSku, 'B') ? 'Basic' : 'Standard')
    aasDatabase: 'LoomComposite'
    consolePrincipalId: identity.outputs.uamiConsolePrincipalId
    // RLS/OLS Security tab: when an operator supplies a dedicated SPN it becomes
    // the AAS data-plane admin (LOOM_AAS_CLIENT_ID authors roles over XMLA).
    // Otherwise the Console UAMI is the sole admin (composite-model path).
    aasAdminUpn: !empty(aasSpnClientId) ? 'app:${aasSpnClientId}@${tenant().tenantId}' : 'app:${identity.outputs.uamiConsoleClientId}@${tenant().tenantId}'
    skipRoleGrants: skipRoleGrants
    tags: complianceTags
  }
}
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
module orgVisualsRbac '../landing-zone/org-visuals-rbac.bicep' = if (!skipRoleGrants && !empty(loomStorageAccount)) {
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
    atlasOnAksEnabled: atlasOnAksEnabled
    adminEntraGroupId: adminEntraGroupId
    consolePrincipalId: identity.outputs.uamiConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    privateEndpointSubnetId: network.outputs.privateEndpointsSubnetId
    aksClusterId: containerPlatform == 'aks' ? containerPlatformModule.outputs.aksId : ''
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

module appDeployments 'app-deployments.bicep' = if (containerPlatform == 'containerApps' && deployAppsEnabled) {
  name: 'app-deployments'
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
        env: concat(
          [
            { name: 'LOOM_VERSION', value: loomVersion }
            { name: 'NEXT_PUBLIC_LOOM_VERSION', value: loomVersion }
            { name: 'LOOM_SUBSCRIPTION_ID', value: subscription().subscriptionId }
            { name: 'LOOM_ADMIN_RG', value: resourceGroup().name }
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
            { name: 'LOOM_LOG_ANALYTICS_RESOURCE_ID', value: monitoring.outputs.lawId }
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
            { name: 'LOOM_SYNAPSE_WORKSPACE', value: loomSynapseWorkspace }
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
            { name: 'LOOM_KEY_VAULT_URI', value: keyvault.outputs.keyVaultUri }
            // F14 Customer-Managed Keys — the ARM resource id of the admin-plane
            // Key Vault (scopes the KV Crypto role check) and the Console UAMI
            // resource id used as the storage account's CMK encryption identity.
            { name: 'LOOM_KEY_VAULT_ID', value: keyvault.outputs.keyVaultId }
            { name: 'LOOM_UAMI_RESOURCE_ID', value: identity.outputs.uamiConsoleId }
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
            { name: 'LOOM_ADF_NAME', value: loomAdfName }
            { name: 'LOOM_ADF_RG', value: !empty(loomAdfRg) ? loomAdfRg : loomDlzRg }
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
            { name: 'LOOM_SHIR_VMSS_NAME', value: loomShirVmssName }
            // Capacity & compute → Scale & manage drawer → AKS node-pool scaling.
            // Only populated on the AKS container platform (GCC-High / IL5); on
            // Commercial / GCC these are empty and the drawer's AKS section
            // honest-gates (503). LOOM_AKS_RG defaults to this admin RG (where the
            // AKS cluster lives) — aks-arm-client.ts reads both + LOOM_SUBSCRIPTION_ID.
            { name: 'LOOM_AKS_CLUSTER_NAME', value: containerPlatform == 'aks' ? containerPlatformModule.outputs.aksName : '' }
            { name: 'LOOM_AKS_RG', value: containerPlatform == 'aks' ? resourceGroup().name : '' }
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
            { name: 'LOOM_EVENTHUB_NAMESPACE', value: loomEventHubNamespace }
            { name: 'LOOM_EH_SCHEMA_GROUP', value: loomEhSchemaGroup }
            { name: 'LOOM_EVENTHUB_RG', value: loomEventHubRg }
            { name: 'LOOM_EVENTHUB_SUB', value: loomEventHubSub }
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
            { name: 'LOOM_EVENTHUB_NAMESPACE_RESOURCE_ID', value: !empty(workspaceMonitorEventHubNamespaceId) ? workspaceMonitorEventHubNamespaceId : (empty(loomEventHubNamespace) ? '' : '/subscriptions/${empty(loomEventHubSub) ? subscription().subscriptionId : loomEventHubSub}/resourceGroups/${empty(loomEventHubRg) ? loomDlzRg : loomEventHubRg}/providers/Microsoft.EventHub/namespaces/${loomEventHubNamespace}') }
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
            { name: 'LOOM_DATABRICKS_HOSTNAME', value: loomDatabricksHostname }
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
            // OneLake catalog Explore-tab backend (azure=AI Search/Cosmos default; fabric=opt-in OneLake REST).
            { name: 'LOOM_CATALOG_BACKEND', value: loomCatalogBackend }
            // APIM navigator (apis/products/named-values/backends/subscriptions) + marketplace.
            { name: 'LOOM_APIM_NAME',          value: !empty(existingApimName) ? existingApimName : (apimEnabled ? apim!.outputs.apimName : '') }
            { name: 'LOOM_APIM_RG',            value: !empty(existingApimName) ? byoApimRg : (apimEnabled ? resourceGroup().name : '') }
            // Cosmos DB control-plane navigator (databases/containers/sprocs). This
            // is the USER-navigated account (distinct from Loom's own store at
            // LOOM_COSMOS_ENDPOINT) and lives in the DLZ RG. Requires the Console
            // UAMI to hold "DocumentDB Account Contributor" (granted in cosmos.bicep).
            { name: 'LOOM_COSMOS_ACCOUNT',     value: loomCosmosAccount }
            { name: 'LOOM_COSMOS_ACCOUNT_RG',  value: !empty(loomCosmosAccountRg) ? loomCosmosAccountRg : loomDlzRg }
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
            { name: 'LOOM_AZURE_MAPS_ACCOUNT',       value: loomAzureMapsAccount }
            { name: 'LOOM_KUSTO_CLUSTER',            value: !empty(existingAdxClusterName) ? existingAdxClusterName : (adxEnabled ? adxCluster!.outputs.clusterName : '') }
            { name: 'NEXT_PUBLIC_LOOM_KUSTO_CLUSTER', value: !empty(existingAdxClusterName) ? existingAdxClusterName : (adxEnabled ? adxCluster!.outputs.clusterName : '') }
            // Phase 2 — RBAC tenant-admin bootstrap + install-time provisioning targets
            { name: 'LOOM_TENANT_ADMIN_GROUP_ID', value: loomTenantAdminGroupId }
            { name: 'LOOM_TENANT_ADMIN_OID', value: loomTenantAdminOid }
            { name: 'LOOM_DEFAULT_FABRIC_WORKSPACE', value: loomDefaultFabricWorkspace }
            { name: 'LOOM_WAREHOUSE_BACKEND', value: loomWarehouseBackend }
            // ----------------------------------------------------------------
            // Azure-native backend selectors (no-fabric-dependency)
            // ----------------------------------------------------------------
            { name: 'LOOM_BRONZE_CONTAINER', value: loomBronzeContainer }
            { name: 'LOOM_PIPELINE_BACKEND', value: loomPipelineBackend }
            { name: 'LOOM_EVENT_BACKEND', value: loomEventBackend }
            { name: 'LOOM_ACTIVATOR_BACKEND', value: loomActivatorBackend }
            { name: 'LOOM_ACTIVATOR_DEFAULT_TABLE', value: loomActivatorDefaultTable }
            { name: 'LOOM_DASHBOARD_BACKEND', value: loomDashboardBackend }
            { name: 'LOOM_MIRROR_BACKEND', value: loomMirrorBackend }
            { name: 'LOOM_LAKEHOUSE_BACKEND', value: loomLakehouseBackend }
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
            { name: 'LOOM_DATAFLOW_BACKEND', value: loomDataflowBackend }
            // Report editor BI backend. Empty (default) → Loom-native renderer
            // that queries the bound AAS model with DAX (no Power BI / Fabric).
            // 'powerbi' opts into the Power BI embed. NEXT_PUBLIC_ mirror lets
            // the client editor branch without a round-trip. (no-fabric-dependency.md)
            { name: 'LOOM_BI_BACKEND', value: loomBiBackend }
            { name: 'NEXT_PUBLIC_LOOM_BI_BACKEND', value: loomBiBackend }
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
            { name: 'LOOM_DATAPRODUCTS_BACKEND', value: loomDataproductsBackend }
            // F4 Governance Domains — Cosmos CRUD + Purview mirror (default) or
            // opt-in Fabric Admin. LOOM_DOMAIN_IMAGES_URL points at the F4 domain
            // gallery blob endpoint emitted by catalog.bicep ('' when Purview/
            // catalog storage is not deployed — the editor shows an honest gate).
            { name: 'LOOM_DOMAINS_BACKEND', value: loomDomainsBackend }
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
          !empty(loomAzureMapsAccount) ? [
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
            // Blob Delegator (account) by org-visuals-rbac.bicep. Only emitted
            // when an ADLS account is configured; otherwise the panes show their
            // honest gate. No Fabric/Power BI dependency.
            { name: 'LOOM_ORG_VISUALS_URL', value: 'https://${loomStorageAccount}.blob.${environment().suffixes.storage}/org-visuals' }
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
          //   2. purview-csa-loom-<location> when `purviewEnabled = true`
          //      and no explicit account name was supplied
          // ----------------------------------------------------------------
          !empty(loomPurviewAccount) ? [
            { name: 'LOOM_PURVIEW_ACCOUNT', value: loomPurviewAccount }
          ] : (purviewEnabled ? [
            { name: 'LOOM_PURVIEW_ACCOUNT', value: 'purview-csa-loom-${location}' }
          ] : []),
          // Purview Unified Catalog data-plane endpoint + API version — used by
          // the data-product creation wizard (/api/data-products,
          // /api/governance-domains) to register data products + list business
          // domains. STRICTLY OPT-IN: empty when no Purview account is bound, in
          // which case the wizard saves the draft to Loom's Cosmos store and
          // shows an honest "not registered in Purview" hint (no gate; the item
          // is 100% functional Azure-native per no-fabric-dependency.md). The UC
          // API is Commercial-only today; GCC/GCC-High/IL5 fall back to the
          // Cosmos governance-domain list automatically.
          !empty(loomPurviewAccount) ? [
            { name: 'LOOM_PURVIEW_UC_ENDPOINT', value: 'https://${loomPurviewAccount}.purview.azure.com' }
            { name: 'LOOM_PURVIEW_UC_API_VERSION', value: '2026-03-20-preview' }
          ] : (purviewEnabled ? [
            { name: 'LOOM_PURVIEW_UC_ENDPOINT', value: 'https://purview-csa-loom-${location}.purview.azure.com' }
            { name: 'LOOM_PURVIEW_UC_API_VERSION', value: '2026-03-20-preview' }
          ] : []),
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
            { name: 'LOOM_DATABRICKS_HOSTNAMES', value: loomDatabricksHostname }
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
          ],
          !empty(loomMsalClientId) ? [
            { name: 'LOOM_MSAL_CLIENT_ID', value: loomMsalClientId }
            { name: 'LOOM_MSAL_CLIENT_SECRET', secretRef: 'loom-msal-client-secret' }
            // NOTE: do NOT map this secret to AZURE_CLIENT_SECRET — the Console
            // authenticates to Azure with its MANAGED IDENTITY (AZURE_CLIENT_ID /
            // LOOM_UAMI_CLIENT_ID below). Setting AZURE_CLIENT_SECRET makes
            // @azure/identity's EnvironmentCredential attempt a client-secret
            // login with the UAMI client id → AADSTS7000232 (MSI can't use a
            // secret), which breaks Cost/Monitor/Defender calls. MSAL + Dataverse
            // read LOOM_MSAL_CLIENT_SECRET / LOOM_DATAVERSE_CLIENT_SECRET instead.
            { name: 'SESSION_SECRET', secretRef: 'session-secret' }
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
            { name: 'LOOM_DATAVERSE_CLIENT_ID', value: loomMsalClientId }
            { name: 'LOOM_DATAVERSE_CLIENT_SECRET', secretRef: 'loom-msal-client-secret' }
            { name: 'LOOM_DATAVERSE_TENANT_ID', value: tenant().tenantId }
            // AI Foundry model-hosting account — used by the hub editor's
            // Models / Quota / Keys / Networking / RBAC tabs and the
            // data-agent test chat. Empty when AI Foundry isn't deployed.
            { name: 'LOOM_FOUNDRY_RG', value: byoFoundryRg }
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
            { name: 'LOOM_FOUNDRY_PROJECT_ID',       value: agentFoundryEnabled ? agentFoundry!.outputs.projectId : ((aiFoundryEnabled && empty(existingFoundryAccountName)) ? aiFoundry!.outputs.projectId : '') }
            { name: 'LOOM_FOUNDRY_PROJECT_NAME',     value: agentFoundryEnabled ? agentFoundry!.outputs.projectNameOut : '' }
            // AOAI inference endpoint + model deployment names for the Agent
            // Service account. Consumed by the AOAI clients (chat + embeddings).
            // AOAI inference endpoint + model deployment names. Sourced from the
            // dedicated Agent Service account when present, else from the shared
            // Foundry hub (so the AI Functions Gov/AOAI path works on a hub-only
            // deploy — the deployment is then discovered from the hub connections
            // by resolveAoaiTarget()).
            { name: 'LOOM_AOAI_ENDPOINT',          value: agentFoundryEnabled ? agentFoundry!.outputs.aoaiEndpoint : ((aiFoundryEnabled && empty(existingFoundryAccountName)) ? aiFoundry!.outputs.aoaiInferenceEndpoint : '') }
            { name: 'LOOM_AOAI_CHAT_DEPLOYMENT',   value: agentFoundryEnabled ? agentFoundry!.outputs.chatDeployment : '' }
            // The copilot/data-agent orchestrators read LOOM_AOAI_DEPLOYMENT (not
            // the _CHAT_ variant) to resolve the model — keep both in sync so the
            // Copilot/data-agent chat works out of the box (the "no AOAI model"
            // gap was exactly this name mismatch on the live deploy).
            { name: 'LOOM_AOAI_DEPLOYMENT',        value: agentFoundryEnabled ? agentFoundry!.outputs.chatDeployment : '' }
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
            { name: 'LOOM_AOAI_EMBED_DEPLOYMENT',  value: agentFoundryEnabled ? agentFoundry!.outputs.embedDeployment : '' }
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
            { name: 'LOOM_AZURE_OPENAI_ENDPOINT',  value: !empty(loomAzureOpenAiEndpoint) ? loomAzureOpenAiEndpoint : (agentFoundryEnabled ? agentFoundry!.outputs.aoaiEndpoint : '') }
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
          ],
          // MAF orchestration tier (GCC-High / IL5). When the loom-copilot-maf
          // Container App deploys, set LOOM_MAF_ENDPOINT so copilot-orchestrator
          // auto-routes Gov turns to it, plus the shared internal token used to
          // authenticate the MAF → Console tool-dispatch callback.
          copilotMafActive ? [
            { name: 'LOOM_MAF_ENDPOINT', value: copilotMaf!.outputs.mafInternalEndpoint }
            { name: 'LOOM_INTERNAL_TOKEN', secretRef: 'loom-internal-token' }
          ] : []
        )
        secrets: concat(
          !empty(loomMsalClientId) ? [
            { name: 'loom-msal-client-secret', value: loomMsalClientSecret }
            { name: 'session-secret', value: empty(loomSessionSecret) ? guid(resourceGroup().id, 'loom-session-secret-v1') : loomSessionSecret }
          ] : [],
          !empty(loomAzureMapsAccount) ? [
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
          // callback (GCC-High / IL5). Same deterministic value the MAF app gets.
          copilotMafActive ? [
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
      }
      {
        name: 'loom-setup-orchestrator'
        image: 'loom-setup-orchestrator:${appImageTags.orchestrator}'
        uamiId: identity.outputs.uamiOrchestratorId
        uamiClientId: identity.outputs.uamiOrchestratorClientId
        ingressPort: 8000
        external: false
        healthPath: '/health'
        tier: 'orchestrator'
        minReplicas: 1
        maxReplicas: 3
        env: [
          { name: 'AGENT_ORCHESTRATOR', value: agentOrchestrator }
          { name: 'MCP_ENDPOINT', value: 'http://loom-mcp:8080' }
        ]
      }
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
module sqlDatabaseShareRbac 'sql-database-share-rbac.bicep' = if (!skipRoleGrants) {
  name: 'console-sql-database-share-rbac'
  scope: resourceGroup(!empty(loomSqlServerRg) ? loomSqlServerRg : loomDlzRg)
  params: {
    consolePrincipalId: identity.outputs.uamiConsolePrincipalId
    skipRoleGrants: skipRoleGrants
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
module identityGraphRbac 'identity-graph-rbac.bicep' = if (loomIdentityPickerEnabled) {
  name: 'console-identity-graph-rbac'
  params: {
    consolePrincipalId: identity.outputs.uamiConsolePrincipalId
    boundary: boundary
    skipRoleGrants: skipRoleGrants
    workspaceM365LinkEnabled: loomWorkspaceM365LinkEnabled
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

// Grafana Viewer (60750a24-ce75-4119-aa84-5b8f3c5db3e0) for the Console UAMI —
// granted via a module (a role-assignment name must be calculable at deploy
// start, which a module output is not, but a module param is).
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

output catalogEndpoint string = catalogPrimary == 'purview'
  ? 'https://purview-csa-loom-${location}.purview.azure.${boundary == 'GCC-High' || boundary == 'IL5' ? 'us' : 'com'}'
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
output aiServicesAccountName string = (aiFoundryEnabled && empty(existingFoundryAccountName)) ? aiFoundry!.outputs.aiServicesAccountName : ''

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
