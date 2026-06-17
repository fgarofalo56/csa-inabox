// CSA Loom — top-level orchestrator
// Deployment scope: subscription
// Per-boundary parameter set: params/{commercial,gcc,gcc-high,il5}.bicepparam
// Deployment mode: single-sub | multi-sub
//
// Status: SCAFFOLDED — module stubs in modules/admin-plane/ +
//                      modules/landing-zone/ + modules/shared/
//                      Real Bicep implementations land via PRP-02.

targetScope = 'subscription'

@description('Azure cloud environment')
@allowed(['AzureCloud', 'AzureUSGovernment'])
param environment string

@description('Primary region (e.g., eastus2 / usgovvirginia)')
param location string

@description('Cloud boundary')
@allowed(['Commercial', 'GCC', 'GCC-High', 'IL5'])
param boundary string

@description('AZURE_CLOUD two-value discriminator for the Console (AzureCloud | AzureUSGovernment). Empty (default) = derived from boundary. Threaded to the admin-plane module so GCC-High / IL5 deployments can set AzureUSGovernment explicitly without relying on the 4-way boundary mapping.')
@allowed(['', 'AzureCloud', 'AzureUSGovernment'])
param loomAzureCloud string = ''

@description('Deployment mode (LEGACY — kept for back-compat). single-sub / multi-sub map onto the explicit `topology` param below when `topology` is empty. Prefer setting `topology` directly.')
@allowed(['single-sub', 'multi-sub'])
param deploymentMode string

// ── audit-t156 — explicit topology modes + optional admin plane ──────────────
// Replaces the implicit "admin plane is always deployed" behavior with three
// explicit, named topologies. `deploymentMode` is still honored (mapped below)
// so existing param files / pipelines keep working unchanged.
//
//   single-sub  — dev/demo: admin plane + ONE in-sub DLZ (the current default,
//                 byte-identical to pre-t156 behavior).
//   tenant      — the DMLZ deployment: admin plane + ALL tenant-shared services
//                 ONLY. NO landing-zone resources (domains attach later via
//                 dlz-attach). This is the "one Loom frontend per tenant" deploy.
//   dlz-attach  — a domain landing zone ONLY, into the target sub(s). The admin
//                 plane is SKIPPED; the console / Front Door / Cosmos are NEVER
//                 deployed. Hub coordinates (hub VNet, LAW, App Insights, private
//                 DNS, Console/Activator UAMI principals, catalog endpoint) are
//                 supplied via `hubCoordinates` — the tenant deployment's
//                 `topologyManifest` output, surfaced by the orchestrator (t157).
@description('Explicit deployment topology. Empty (default) = derived from deploymentMode for back-compat (single-sub -> single-sub; multi-sub -> legacy admin-plane + multi-sub DLZ fan-out).')
@allowed(['', 'single-sub', 'tenant', 'dlz-attach'])
param topology string = ''

@description('dlz-attach ONLY: hub coordinates from the tenant (DMLZ) deployment topologyManifest output. REQUIRED when topology=dlz-attach (the admin plane is skipped, so the DLZ + cross-sub RBAC modules read the hub wiring from here instead of adminPlane.outputs). Shape: { adminPlaneRgName, hubVnetId, lawId, appInsightsConnectionString, privateDnsZoneIds, adxClusterPrincipalId, consolePrincipalId, consoleUamiName, consoleUamiAppId, consoleUamiResourceId, activatorPrincipalId, catalogEndpoint, aiServicesAccountName }. Ignored in single-sub / tenant / legacy modes (those read adminPlane.outputs).')
param hubCoordinates object = {}

@description('Container platform — Container Apps (Commercial/GCC) or AKS (GCC-H/IL5)')
@allowed(['containerApps', 'aks'])
param containerPlatform string

@description('Functions host SKU — FlexConsumption (Commercial/GCC) or EP1 (Gov)')
@allowed(['FlexConsumption', 'EP1'])
param functionsHostSku string

@description('APIM SKU — PremiumV2 (Commercial/GCC) or Premium (Gov)')
@allowed(['PremiumV2', 'Premium'])
param apimSku string

@description('Catalog primary backend')
@allowed(['unity-catalog-managed', 'purview', 'atlas-aks'])
param catalogPrimary string

@description('Agent orchestrator — Foundry Agent Service (Commercial/GCC) or MAF + AOAI direct (Gov)')
@allowed(['foundry-agent-service', 'maf'])
param agentOrchestrator string

@description('Capacity SKU equivalence (drives Databricks + ADX + Power BI sizing)')
@allowed(['F2', 'F4', 'F8', 'F32', 'F64', 'F128', 'F512'])
param capacitySku string

@description('Databricks Unity Catalog managed availability')
param databricksUnityCatalogEnabled bool

@description('Databricks ACCOUNT id (GUID). Set this to configure Unity Catalog by DEFAULT: the deploy creates/assigns the regional UC metastore + a default catalog and grants the Console UAMI account_admin, so Browse > Unity Catalog shows a real configured catalog. Requires a one-time human step making the Console UAMI a Databricks account admin (docs/fiab/catalog/metastores.md). Empty = UC enabled later via the post-deploy bootstrap workflow (never a hard deploy blocker). Commercial + GCC only.')
param databricksAccountId string = ''

@description('Databricks SQL Warehouse availability')
param databricksSqlWarehouseEnabled bool

@description('Foundry portal availability')
param foundryPortalEnabled bool

@description('Defender for Cloud AI Threat Protection availability')
param defenderForAIEnabled bool

@description('Purview Data Map availability (false at IL5)')
param purviewEnabled bool

@description('Cross-region Purview location (#229). Empty = hub location. Set to a known-Purview region (e.g. eastus2) when the hub region lacks Purview capacity (e.g. centralus). Threaded to admin-plane → catalog.bicep so the account + LOOM_PURVIEW_ACCOUNT name + private endpoints all agree.')
param purviewLocation string = ''

@description('Purview account name (short, NOT full URL) to wire into the Loom Console. When empty, /admin/security Purview tab returns 503 with a structured remediation hint. Set this to an EXISTING Purview account name in the tenant — only one Enterprise-tier Purview is allowed per tenant, so most deployments REUSE the tenant-level account rather than provisioning a second one (which fails with `EnterpriseTenantAlreadyExists`).')
param loomPurviewAccount string = ''

@description('Enable Microsoft Information Protection reads via Microsoft Graph for the Console (sensitivity labels + label policies + apply-label evaluation). Requires the Console UAMI to be admin-consented for InformationProtectionPolicy.Read.All + SensitivityLabel.Evaluate. Defaults off — the bootstrap workflow flips the AppRoles, then operators re-deploy with this true.')
param loomMipEnabled bool = false

@description('Enable sensitivity-label + label-policy CRUD (create/edit/delete) via the SCC PowerShell sidecar (azure-functions/scc-labels). Microsoft Graph has no write surface for labels/policies, so CRUD runs through Security & Compliance PowerShell with certificate-based app auth (Exchange.ManageAsApp + Compliance Administrator). Defaults off — bootstrap provisions the SCC app + auth cert, then operators re-deploy with this true. Label/policy READS work regardless; only CRUD is gated.')
param loomMipAdminEnabled bool = false

@description('Entra app (client) id for the SCC labels sidecar. Set by bootstrap after the SCC app + cert are created.')
param sccAppId string = ''

@description('Auth certificate thumbprint for the SCC labels sidecar (WEBSITE_LOAD_CERTIFICATES).')
param sccCertThumbprint string = ''

@description('Tenant onmicrosoft.com domain for Connect-IPPSSession -Organization. Empty falls back to the deployment tenant default at bootstrap.')
param sccOrganization string = ''

@description('Optional SCC PowerShell ConnectionUri override for sovereign clouds (Gov/GCC-High/DoD).')
param sccConnectionUri string = ''

@description('Enable Purview DLP reads via Microsoft Graph for the Console (DLP policies + rules + alerts + simulate). Defaults ON — the post-deploy bootstrap grants Console UAMI Policy.Read.All + SecurityAlert.Read.All by default, so the /admin/security DLP tab is wired out of the box. DLP alerts + violations (security/alerts_v2, GA in every cloud) light up as soon as admin consent is issued; the policy-list segment (informationProtection/dataLossPreventionPolicies, /beta) and simulate are preview-gated and surface a precise honest MessageBar where unavailable. The Azure-native restrict-access enforcement (Restrict tab → ADLS/Synapse/ADX revokes) needs no Graph at all.')
param loomDlpEnabled bool = true

@description('Enable DLP policy CRUD (create/edit/delete DLP compliance policies + rules) via the SCC PowerShell sidecar. Microsoft Graph has no DLP write API, so authoring runs through Get/New/Set/Remove-DlpCompliancePolicy via Security & Compliance PowerShell (Exchange.ManageAsApp + Compliance Administrator — the same app + cert as label CRUD). Defaults off — DLP READS/alerts/violations + the Azure-native Restrict-access tab keep working; only create/edit/delete is gated until bootstrap provisions the SCC app + auth cert, after which operators re-deploy with this true.')
param loomDlpAdminEnabled bool = false

@description('Enable the Power BI Admin InformationProtection.setLabels API for /admin/batch-labeling Power BI propagation. Requires loomMipEnabled=true plus the Console UAMI to be a Fabric Administrator (a one-time M365/Entra admin action, not an ARM role). Defaults off; batch labeling still writes Cosmos + Purview when false.')
param loomPowerBiAdminLabels bool = false

@description('HTTPS XMLA endpoint for semantic-model authoring surfaces that need the XMLA write surface (Automatic aggregations). Azure-native default: an Azure Analysis Services server (https://<server>.asazure.windows.net/xmla, or .asazure.usgovcloudapi.net in Gov). A Power BI Premium / Fabric capacity XMLA endpoint is an opt-in alternative selected by URL. Empty = the Aggregations surface honest-gates (no Fabric dependency).')
param loomPowerbiXmlaEndpoint string = ''

@description('Enable the reusable Identity Picker (Entra user/group/service-principal search + transitive nested-group resolution) via Microsoft Graph. Requires the Console UAMI to be admin-consented for User.Read.All + Group.Read.All + Application.Read.All (scripts/csa-loom/grant-identity-graph-approles.sh). Defaults off — the bootstrap workflow flips the AppRoles, then operators re-deploy with this true. When false /api/governance/identities/search returns 503 with the exact remediation.')
param loomIdentityPickerEnabled bool = false

@description('Enable per-domain Entra security-group provisioning for the D2 domain-admin / domain-contributor RBAC tiers. When true, creating a business domain can auto-create its loom-domain-<id>-admins + loom-domain-<id>-contributors security groups via Microsoft Graph, and /admin/permissions (Domain access) can bind them. Requires the Console UAMI admin-consented for Group.ReadWrite.All (scripts/csa-loom/grant-identity-graph-approles.sh). Defaults off — domains still work via the legacy admins[]/contributors model; when false POST /api/admin/domains?provisionGroups returns 503 with the exact remediation. Passed to the admin plane → LOOM_DOMAIN_GROUP_PROVISIONING.')
param loomDomainGroupProvisioningEnabled bool = false

@description('Enable OneLake shortcuts to SharePoint document libraries / OneDrive folders via Microsoft Graph (lakehouse editor → New shortcut → SharePoint / OneDrive). Requires the Console UAMI admin-consented for Sites.Read.All + Files.Read.All (scripts/csa-loom/grant-shortcut-graph-approles.sh). Defaults off — the bootstrap workflow flips the AppRoles, then operators re-deploy with this true. When false the SharePoint source renders but browse/create return 503 with the exact remediation (no mock data). Azure-native parity with Fabric OneLake OneDrive/SharePoint shortcuts; NO Fabric dependency.')
param loomSharepointShortcutsEnabled bool = false

@description('Apache Atlas on AKS deployment (IL5 only)')
param atlasOnAksEnabled bool = false

@description('Grant the Console UAMI "Storage Account Contributor" on each DLZ storage account so the OneLake Lifecycle Management rules editor can read/write blob lifecycle policies (managementPolicies/default). Off by default.')
param consolePrincipalNeedsLifecycleWrite bool = false

@description('Grant the Console UAMI "Storage Account Contributor" on each DLZ storage account so the Customer-Managed Keys (F14) editor can PATCH encryption.keyVaultProperties. Shares the lifecycle grant. Off by default.')
param consolePrincipalNeedsCmkBind bool = false

@description('OpenAI region for chat models')
param openaiLocation string

@description('OpenAI region for embeddings (usgovarizona in Gov)')
param openaiEmbeddingsLocation string

@description('OpenAI chat model')
param openaiChatModel string

@description('OpenAI embeddings model')
param openaiEmbeddingsModel string

@description('Power BI SKU (P-SKU for GCC; F-SKU elsewhere)')
param powerBiSku string

// ── Analytics report embed (F21 Usage "Open analytics" + F2 Govern "View more") ──
// Per-cloud, opt-in OVER the always-on native Fluent charts (no-fabric-dependency.md).
// Forwarded to the admin-plane module so a push-button deploy can default the
// embed KIND (Commercial/GCC → powerbi, GCC-High/IL5 → grafana). The report /
// dashboard ids + UAMI workspace membership + the "SP can use Power BI APIs"
// tenant setting are post-deploy admin actions, so the BFF honestly gates (503)
// until they are supplied — see docs/fiab/v3-tenant-bootstrap.md#usage-analytics-embed.
@description('Deploy a Power BI Embedded (A1) capacity for the Govern/Usage embedded reports (Commercial / GCC).')
param pbiEmbeddedEnabled bool = false
@description('Deploy Azure Managed Grafana for the Govern/Usage embedded dashboards (GCC-High / IL5).')
param managedGrafanaEnabled bool = false
@description('LOOM_USAGE_REPORT_KIND for /admin/usage "Open analytics". "powerbi" (Commercial/GCC), "grafana" (GCC-High/IL5), or empty (native charts only).')
@allowed([ '', 'powerbi', 'grafana' ])
param loomUsageReportKind string = ''
@description('Power BI workspace id holding the usage report (when loomUsageReportKind=powerbi).')
param loomUsagePbiWorkspaceId string = ''
@description('Power BI report id to embed in the Usage "Open analytics" panel (when loomUsageReportKind=powerbi).')
param loomUsagePbiReportId string = ''
@description('Managed Grafana dashboard UID for the Usage "Open analytics" panel (when loomUsageReportKind=grafana).')
param loomGrafanaUsageDashboardUid string = ''
@description('LOOM_REPORT_KIND for the Govern Admin "View more" report. "powerbi", "grafana", or empty.')
@allowed([ '', 'powerbi', 'grafana' ])
param loomReportKind string = ''
@description('Power BI workspace id holding the governance report (when loomReportKind=powerbi).')
param loomGovernPbiWorkspaceId string = ''
@description('Power BI report id to embed in the Govern Admin "View more" (when loomReportKind=powerbi).')
param loomGovernPbiReportId string = ''
@description('Managed Grafana dashboard UID for the Govern Admin "View more" (when loomReportKind=grafana).')
param loomGrafanaDashboardUid string = ''

@description('Storage requires CMK (true at IL5)')
param storageRequireCmk bool = false

@description('Soft-delete retention days for ADLS Gen2 blob/directory recovery (OneLake Recycle bin restore window). 1–365. Default 30. GA all clouds.')
@minValue(1)
@maxValue(365)
param recycleRetentionDays int = 30

@description('Key Vault Premium HSM isolated (true at IL5)')
param keyVaultHsmIsolated bool = false

@description('Admin Plane subscription ID — defaults to deployment sub')
param adminPlaneSubId string = subscription().subscriptionId

@description('DLZ subscription IDs (multi-sub mode only)')
param dlzSubscriptionIds array = []

@description('DLZ domain names (parallel to dlzSubscriptionIds)')
param dlzDomainNames array = []

// =====================================================================
// dlz-attach coordinates (audit-t157)
//
// 'dlz-attach' (see the `topology` param above) attaches ONE new Data Landing
// Zone in `targetSubscriptionId` to an ALREADY-deployed hub. The Admin Plane
// module is NOT deployed (it is impossible to stamp a second Console) — the DLZ
// reads the existing hub's coordinates from the hub* parameters below, which the
// orchestrator fills from the Cosmos `tenant-topology` doc written at
// tenant-deploy time.
// =====================================================================
@description('dlz-attach: subscription the NEW Data Landing Zone is provisioned into. The orchestrator identity must hold Contributor here. NOTE: this is NOT the scoping control — the deployment MUST be submitted AT this subscription scope (az deployment sub create --subscription <id> / orchestrator subscription_id), because the dlz-attach RG + module use single-arg resourceGroup() and bind to the deployment subscription. This param is echoed back (dlzAttachTargetSubscriptionId) so the bootstrap/attach contract is self-describing; it does not relocate the deployment by itself.')
param targetSubscriptionId string = ''

@description('dlz-attach: domain name of the single DLZ being attached (rg-csa-loom-dlz-<attachDomainName>-<location>).')
param attachDomainName string = ''

// ── Hub coordinates (dlz-attach only) — sourced from the Cosmos tenant-topology
// doc the tenant deploy wrote. For topology=='tenant' these are read from the
// adminPlane module outputs and these params are ignored.
@description('dlz-attach: existing hub VNet resource id (for peering / DNS link).')
param hubVnetId string = ''

@description('dlz-attach: existing hub Log Analytics workspace resource id.')
param hubLawId string = ''

@description('dlz-attach: existing hub App Insights connection string.')
param hubAppInsightsConnectionString string = ''

@description('dlz-attach: existing hub private DNS zone id map (synapseSql, adf, …).')
param hubPrivateDnsZoneIdsAttach object = {}

@description('dlz-attach: resource-group name of the existing hub shared ADX cluster.')
param hubAdxClusterRgName string = ''

@description('dlz-attach: principal id of the existing hub shared ADX cluster identity.')
param hubAdxClusterPrincipalId string = ''

@description('dlz-attach: existing hub catalog (Purview/OneLake) endpoint.')
param hubCatalogEndpoint string = ''

@description('dlz-attach: existing hub AI Services / AOAI account name (for notebook AI RBAC).')
param hubAiServicesAccountName string = ''

@description('dlz-attach: existing hub Console UAMI principal id.')
param hubConsolePrincipalId string = ''

@description('dlz-attach: existing hub Console UAMI name.')
param hubConsoleUamiName string = ''

@description('dlz-attach: existing hub Console UAMI client (app) id.')
param hubConsoleUamiAppId string = ''

@description('dlz-attach: existing hub Console UAMI resource id (used as the UC bootstrap script identity).')
param hubConsoleUamiId string = ''

@description('dlz-attach: existing hub Activator UAMI principal id.')
param hubActivatorPrincipalId string = ''

@description('dlz-attach: subscription id of the EXISTING hub (admin plane). REQUIRED for the cross-sub hub-side VNet peering + hub console DLZ env wiring, since the dlz-attach deployment is submitted at the DLZ subscription scope and those two integration pieces must land in the HUB sub. Empty (default) falls back first to hubCoordinates.adminPlaneSubId, then to adminPlaneSubId (the deployment sub) for the single-sub / same-sub case.')
param hubAdminSubscriptionId string = ''

@description('Admin Entra group object ID for FiaB Admins')
param adminEntraGroupId string

@description('Entra group object ID whose members bootstrap the Loom Feature-Permissions admin (bypass the gate before any grants exist). Passed to the admin plane → LOOM_TENANT_ADMIN_GROUP_ID.')
param loomTenantAdminGroupId string = ''

@description('Entra user object ID that bootstraps the Loom Feature-Permissions admin (single-user bootstrap). Passed to the admin plane → LOOM_TENANT_ADMIN_OID.')
param loomTenantAdminOid string = ''

@description('Hub VNet CIDR')
param hubVnetCidr string = '10.0.0.0/16'

@description('Compliance tags applied to every resource')
param complianceTags object

@description('Skip role-assignment grants — set true when re-provisioning an environment that already has the grants, to avoid RoleAssignmentExists.')
param skipRoleGrants bool = false

@description('Deploy Loom apps (Container Apps for Console/MCP/etc.). Requires container images in ACR — set false on initial provision, then true after CI image-build pipeline runs (PRP-16).')
param deployAppsEnabled bool = false

@description('Deploy AI Foundry Hub. Requires storage-account strategy; default off.')
param aiFoundryEnabled bool = false

@description('Deploy the dedicated AI Foundry Agent Service account (aifndry-loom-<location>) with the loom-agents project + chat/embedding model deployments. Backs LOOM_FOUNDRY_PROJECT_ENDPOINT + LOOM_AOAI_* so AI Functions, Copilot, and data-agent test-chat work out of the box. ON BY DEFAULT (opt-out) — set false to skip the AOAI account (the Copilot/data-agent/AI-functions surfaces then honest-gate). Independent of aiFoundryEnabled.')
param agentFoundryEnabled bool = true

@description('Inline-completion (ghost text) AOAI deployment name for notebook/SQL code cells (LOOM_AOAI_COMPLETION_DEPLOYMENT). Empty = ghost text uses the chat deployment (LOOM_AOAI_DEPLOYMENT). Set to a dedicated gpt-4o-mini slot for lower latency without consuming chat quota. Leave empty in GCC-High / IL5 regions where the model is unavailable.')
param loomAoaiCompletionDeployment string = ''

@description('Resource group of the AML workspace for MLflow experiment tracking (ml-experiment "Runs & metrics" tab). Empty → falls back to LOOM_FOUNDRY_RG.')
param loomAmlRg string = ''

@description('Deploy APIM (Premium) to back the API Marketplace. ON by default (opt-out) so a fresh deploy can publish/Try APIs on first login — ~30 min Premium provisioning. Set loomApimEnabled=false to skip.')
param loomApimEnabled bool = true

@description('DEPRECATED alias for loomApimEnabled, retained so existing .bicepparam files keep working. Now defaults true (was false). Set either flag false to opt out of APIM.')
param apimEnabled bool = true

@description('Deploy AI Search. Default off — capacity in eastus2 is intermittent.')
param aiSearchEnabled bool = false

@description('Deploy ADX shared cluster (admin-plane) + per-DLZ ADX databases. Backs the RTI editor family — Eventhouse, KQL Database, KQL Queryset, KQL Dashboard, Eventstream. Default on as of 2026-05-27 (sweep-rti). Set false to skip ~$140/mo Dev SKU cluster.')
param adxEnabled bool = true

@description('Provision a NEW Event Hubs namespace in each DLZ (Real-Time Intelligence: Eventstream sources, Data Explorer receive, Mirroring CDC transport, event-schema-set Avro enforcement). Default true (opt-out). Set false to skip the ~namespace cost — the Eventstream / Data Explorer navigators then honest-gate. To REUSE an existing namespace instead of provisioning, set existingEventHubNamespace (the new namespace is skipped and the Console binds to the existing one). Entra-only auth, private-endpoint + servicebus DNS by default.')
param loomEventHubEnabled bool = true

@description('Provision the per-DLZ Azure Stream Analytics starter job (backs the stream-analytics-job editor + the Eventstream transform node). Default true (opt-out). Set false to skip the streaming-units cost — the editor then surfaces an honest infra-gate naming LOOM_ASA_RG. Distinct from streamAnalyticsEnabled (the deploy-planner tile), which provisions a separate planner job.')
param loomStreamAnalyticsEnabled bool = true

// =====================================================================
// Data-engineering backend opt-out flags (default ON — provision new).
// Forwarded to BOTH the admin-plane (env-blank mirror) and every DLZ
// (provision gate) so a stock deploy is "everything on, opt-out".
// =====================================================================
@description('Provision the per-DLZ Synapse workspace (Serverless + dedicated + Spark loompool). Default ON. false skips Synapse + blanks LOOM_SYNAPSE_WORKSPACE so the editor honest-gates.')
param loomSynapseEnabled bool = true

@description('Provision the per-DLZ Databricks workspace (+ Access Connector + Unity Catalog when supported). Default ON. false skips Databricks + blanks LOOM_DATABRICKS_HOSTNAME.')
param loomDatabricksEnabled bool = true

@description('Provision the per-DLZ Azure Data Factory. Default ON. false skips ADF + blanks LOOM_ADF_NAME.')
param loomDataFactoryEnabled bool = true

@description('Provision the per-DLZ scaled self-hosted IR (VMSS scale-to-0). Default ON — a strong admin password is auto-generated into the deployment (see effShirAdminPassword) so SHIR provisions without manual input. false skips the SHIR VMSS + blanks LOOM_SHIR_VMSS_NAME.')
param loomSelfHostedIrEnabled bool = true

@description('Deploy a Gremlin-capable Cosmos DB account (EnableGremlin) + NoSQL vector account in each DLZ. Backs the cosmos-gremlin-graph (graph editor) and vector-store editors. Default on — the graph editor requires a Gremlin account at create-time (a NoSQL account cannot be converted). Set false to skip ~2 Cosmos accounts/DLZ.')
param cosmosGraphVectorEnabled bool = true

@description('Provision the Console\'s own SERVERLESS metadata Cosmos (the `loom` database the BFF reads/writes: items, workspaces, configs, copilot sessions, tenant-topology, …) in the hub for tenant/dlz-attach topologies. Default true (opt-out). Serverless removes the 25-container shared-throughput cap that broke workspaces/domains live. Disable ONLY when reusing an existing account via existingCosmosAccount — otherwise the Console env still points at LOOM_COSMOS_ENDPOINT and all item/config CRUD fails. Single-sub hosts this `loom` DB via the DLZ landing-zone cosmos.bicep instead, so this flag is a no-op there.')
param loomConsoleCosmosEnabled bool = true

@description('Deploy the Weave (Semantic Ontology) PostgreSQL + Apache AGE graph store in each DLZ. Backs Palantir-class ontology object/link/action instance write-back (the Ontology editor Objects / Write-back actions surfaces). Default on — Palantir-class ontology write-back requires the graph store. Set false to skip ~1 Burstable PG flexible server/DLZ.')
param weaveOntologyEnabled bool = true

@description('Deploy the shared Data API builder (DAB) preview runtime (loom-dab-preview Container App, public MCR image) that the DAB editor\'s live REST/GraphQL testers + publish probe point at via LOOM_DAB_PREVIEW_URL. Default on (opt-out) — the DAB engine serves /health + REST/GraphQL roots immediately on an empty-entities config, so DAB preview/publish work day-one; the SQL target defaults to the DLZ Synapse serverless endpoint (entity queries additionally require the Console UAMI SQL login — see scripts/csa-loom/grant-dab-sql.sh). Container Apps only. Set false to leave DAB preview/publish honestly config-gated on LOOM_DAB_PREVIEW_URL.')
param dabRuntimeEnabled bool = true

@description('Deploy the loom-dbt-runner Container App (dbt-core + dbt-synapse + dbt-fabric + ODBC Driver 18) that executes generated dbt projects against the Synapse dedicated SQL pool. Synapse has no native dbt task, so this runtime is required for Synapse dbt-job targets (the Databricks target runs natively as a Databricks Job dbt_task, no extra infra). Default on (opt-out), but the admin-plane only activates it when the loom-dbt-runner image is present in ACR (dbtRunnerImageReady); otherwise the dbt-job run surface stays honestly gated on LOOM_DBT_RUNNER_URL. Container Apps only.')
param dbtRunnerEnabled bool = true

@description('Set true once the loom-dbt-runner image has been built + pushed to ACR (scripts/csa-loom/build-dbt-runner.sh). Gates the live loom-dbt-runner Container App deployment so a clean first deploy (no image yet) does not fail on an unresolvable image ref — the dbt-job run surface honest-gates until the image is ready, then this flips on. Default false.')
param dbtRunnerImageReady bool = false

@description('Wire the org-visuals Blob container backing Embed codes (F22) + Organizational visuals (F23): the Console UAMI data-plane grants (Storage Blob Data Contributor on the container + Storage Blob Delegator at account scope for getUserDelegationKey) and the LOOM_ORG_VISUALS_URL env var. Default on (opt-out) — the org-visuals container itself is always created by landing-zone/storage.bicep (it is part of the foundational medallion account); this flag governs only the grant + env wiring. Set false to leave Embed codes / Org visuals honestly config-gated (no SAS minting). No Fabric/Power BI dependency.')
param loomOrgVisualsEnabled bool = true

@description('Deploy the MAF (Microsoft Agent Framework, Gov AOAI-direct) orchestration-tier Container App (loom-copilot-maf). Set true in the GCC-High / IL5 params. The admin-plane gates activation on boundary∈{GCC-High,IL5} + containerPlatform==containerApps + deployAppsEnabled, so it is a safe no-op on the AKS path (the Console copilot-orchestrator then uses its documented Gov AOAI-direct fallback). Requires the loom-copilot-maf image pushed to ACR first.')
param copilotMafEnabled bool = false

@description('Deploy the browser-driven Setup Orchestrator Container App (loom-setup-orchestrator) so the Setup Wizard\'s Deploy submits the real subscription-scoped ARM deployment (templateLink to main.json). On by default — the admin-plane activation gate additionally requires containerPlatform==containerApps + deployAppsEnabled, so it is a safe no-op on the AKS path (GCC-High / IL5 deploy the orchestrator via cluster GitOps). The loom-setup-orchestrator image is built by the standard release matrix. When enabled, the Setup Orchestrator identity (the Console UAMI) is granted Contributor on the Admin Plane subscription AND each multi-sub spoke subscription so it can deploy across subscriptions. Set false to skip the Container App + its grants.')
param setupOrchestratorEnabled bool = true

@description('templateLink URI to the compiled main.json the Setup Orchestrator submits (publish via `az bicep build -f platform/fiab/bicep/main.bicep`). Threaded to the orchestrator as LOOM_SETUP_TEMPLATE_URI. Empty = the orchestrator honestly fails the Deploy with the publish remediation rather than faking success.')
param setupTemplateUri string = ''

@description('Enable the headless CI Bearer-token path on the Loom deployment-pipeline routes so an Azure DevOps / GitHub Actions agent can drive deploys + management via the CSA Loom DevOps task (Fabric "fabric-devops-pipelines" parity). Off by default — Console-session callers always work; this only gates the token path, which fails closed when off. When true the Console gets LOOM_PIPELINE_CI_ENABLED=true plus the shared LOOM_INTERNAL_TOKEN as the default Bearer secret. Cloud-agnostic: the ADO task talks only to the tenant own Loom URL + Entra, never api.fabric.microsoft.com.')
param loomPipelineCiEnabled bool = false

// ---------- Bring-your-own existing services (reuse instead of provision-new) ----------
// Set any of these (via params/<boundary>.bicepparam readEnvironmentVariable('EXISTING_*',''))
// to reuse an EXISTING resource in any RG/sub instead of provisioning a new one.
// Empty → provision new per the matching *Enabled flag. See docs/fiab/bring-your-own-services.md.
@description('Reuse an existing AI Search service (name) instead of provisioning one.')
param existingAiSearchService string = ''
@description('Resource group of the existing AI Search service.')
param existingAiSearchRg string = ''
@description('Reuse an existing APIM service (name) instead of provisioning one.')
param existingApimName string = ''
@description('Resource group of the existing APIM service.')
param existingApimRg string = ''
@description('Reuse an existing ADX/Kusto cluster (name) instead of provisioning one.')
param existingAdxClusterName string = ''
@description('Resource group of the existing ADX cluster.')
param existingAdxClusterRg string = ''
@description('Reuse an existing AI Foundry / AOAI (AIServices) account (name) instead of provisioning the Foundry hub.')
param existingFoundryAccountName string = ''
@description('Resource group of the existing Foundry/AOAI account.')
param existingFoundryRg string = ''

// ---- Cross-subscription (…Sub) dimension + remaining BYO services (full
// reuse-vs-new surface per docs/fiab/design/full-deployment-and-byo.md §4.2).
// All are forwarded to the admin-plane module, where they build the
// LOOM_<SVC>_SUB Console env vars + override the navigator binding when set.
// Emit these from scripts/csa-loom/byo-wizard.sh (the bicepparam generator).
@description('Subscription id of the existing AI Search service (cross-sub reuse).')
param existingAiSearchSub string = ''
@description('Subscription id of the existing APIM service (cross-sub reuse).')
param existingApimSub string = ''
@description('Subscription id of the existing ADX cluster (cross-sub reuse).')
param existingAdxClusterSub string = ''
@description('Subscription id of the existing Foundry/AOAI account (cross-sub reuse).')
param existingFoundrySub string = ''
@description('Chat deployment name on the REUSED existing AOAI account (from scan EXISTING_AOAI_CHAT_DEPLOYMENT). Wires LOOM_AOAI_DEPLOYMENT/_CHAT_DEPLOYMENT so Copilot / data-agent / AI-functions work against the existing account. Empty = the existing path stays honest-gated on the model.')
param existingFoundryChatDeployment string = ''
@description('Embedding deployment name on the REUSED existing AOAI account (from scan EXISTING_AOAI_EMBED_DEPLOYMENT). Wires LOOM_AOAI_EMBED_DEPLOYMENT.')
param existingFoundryEmbedDeployment string = ''
@description('Reuse an existing Microsoft Purview account (short name). Overrides loomPurviewAccount.')
param existingPurviewAccount string = ''
@description('Resource group of the existing Purview account.')
param existingPurviewRg string = ''
@description('Subscription id of the existing Purview account (cross-sub reuse).')
param existingPurviewSub string = ''
@description('Reuse an existing Synapse workspace (name) for the navigator.')
param existingSynapseWorkspace string = ''
@description('Resource group of the existing Synapse workspace.')
param existingSynapseRg string = ''
@description('Subscription id of the existing Synapse workspace (cross-sub reuse).')
param existingSynapseSub string = ''
@description('Reuse an existing Cosmos DB account (name) for the control-plane navigator.')
param existingCosmosAccount string = ''
@description('Resource group of the existing Cosmos account.')
param existingCosmosRg string = ''
@description('Subscription id of the existing Cosmos account (cross-sub reuse).')
param existingCosmosSub string = ''
@description('Reuse an existing Event Hubs namespace (name) for the Eventstream navigator.')
param existingEventHubNamespace string = ''
@description('Resource group of the existing Event Hubs namespace.')
param existingEventHubRg string = ''
@description('Subscription id of the existing Event Hubs namespace (cross-sub reuse).')
param existingEventHubSub string = ''
@description('Reuse an existing Azure Stream Analytics job (name) for the stream-analytics-job / Eventstream transform editors instead of provisioning the per-DLZ starter job. When set, loomStreamAnalyticsEnabled is forced off for the new starter job and the Console binds LOOM_ASA_RG/SUB + the job name to this existing job.')
param existingAsaJob string = ''
@description('Resource group of the existing Stream Analytics job.')
param existingAsaRg string = ''
@description('Subscription id of the existing Stream Analytics job (cross-sub reuse).')
param existingAsaSub string = ''
@description('Reuse an existing Databricks workspace (name) — informational for RBAC.')
param existingDatabricksWorkspace string = ''
@description('Resource group of the existing Databricks workspace.')
param existingDatabricksRg string = ''
@description('Subscription id of the existing Databricks workspace (cross-sub reuse).')
param existingDatabricksSub string = ''
@description('Reuse an existing Databricks workspace hostname (adb-*.azuredatabricks.net). Overrides the navigator binding; the byo-wizard resolves this from workspaceUrl.')
param existingDatabricksHostname string = ''
@description('Reuse an existing Data Factory (name) for the Data Factory navigator / pipeline mounts.')
param existingAdfFactory string = ''
@description('Resource group of the existing Data Factory.')
param existingAdfRg string = ''
@description('Subscription id of the existing Data Factory (cross-sub reuse).')
param existingAdfSub string = ''

@description('Microsoft Fabric mode. DEFAULT false (Azure-native, no Fabric dependency per no-fabric-dependency.md). When false, no Fabric capacity/workspace is bound and loomDefaultFabricWorkspace is forced empty; the Console gates Fabric calls on UAMI authz and stays fully functional on Azure-native backends. Set true ONLY to opt into a bound Fabric workspace.')
param fabricEnabled bool = false

// ---------- Deploy-planner service toggles ----------
// Each flag wires a self-contained module under modules/deploy-planner/** that
// provisions a REAL Azure resource (secure-by-default: Entra-only auth where
// supported, public blob disabled, TLS 1.2). The deploy-planner catalog
// (apps/fiab-console/lib/components/deploy-planner/service-catalog.ts) maps its
// tiles to these flags so the visual plan and `az deployment sub create` stay
// in sync. All default false — opt-in per plan. Modules deploy into the DLZ RG
// (single-sub) so they sit alongside the lake + Cosmos data plane.

@description('Deploy an Azure Database for PostgreSQL Flexible Server (Entra-only auth) + starter DB.')
param postgresEnabled bool = false

@description('Deploy an Azure Database for MySQL Flexible Server + starter DB.')
param mysqlEnabled bool = false

@description('Deploy an Azure Cache for Redis (Basic C0, Entra auth enabled).')
param redisEnabled bool = false

@description('Deploy an Azure Event Grid custom topic (local-auth disabled).')
param eventGridEnabled bool = false

@description('Deploy an Azure Service Bus namespace (Standard, SAS disabled) + starter queue/topic.')
param serviceBusEnabled bool = false

@description('Deploy an Azure SignalR Service (Standard_S1, AAD-only).')
param signalrEnabled bool = false

@description('Deploy a Storage Queues account (StorageV2, shared-key disabled) + starter queue.')
param storageQueuesEnabled bool = false

@description('Deploy a multi-service Azure AI Services (Cognitive Services) account (Entra-only).')
param aiServicesEnabled bool = false

@description('Deploy a Document Intelligence (FormRecognizer) account (Entra-only).')
param documentIntelligenceEnabled bool = false

@description('Deploy a Content Safety account (Entra-only).')
param contentSafetyEnabled bool = false

@description('Deploy an Azure App Service (Linux B1 plan + web app, HTTPS-only).')
param appServiceEnabled bool = false

@description('Deploy an Azure Functions app (Consumption Linux plan + backing storage).')
param functionsEnabled bool = false

@description('Deploy an Azure Container Instances group (sample image, start/stop-able).')
param containerInstancesEnabled bool = false

@description('Deploy an Azure Stream Analytics job (Standard, created Stopped).')
param streamAnalyticsEnabled bool = false

@description('Deploy an Azure Data Factory (v2) for the ADF editors.')
param dataFactoryEnabled bool = false

@description('Deploy a Linux Virtual Machine (isolated VNet/subnet + NIC, NO public IP, SSH-key auth).')
param vmEnabled bool = false

@description('SSH public key (OpenSSH) for the deploy-planner VM admin user. Required to actually boot the VM; password auth is disabled.')
@secure()
param vmAdminSshPublicKey string = ''

@description('Deploy an Azure Batch account (BatchService mode) + backing auto-storage (managed-identity auth).')
param batchEnabled bool = false

@description('Deploy a Consumption Logic App (empty editable workflow).')
param logicAppsEnabled bool = false

@description('Deploy an Azure Static Web App (standalone, no repo link).')
param staticWebAppsEnabled bool = false

@description('Deploy an Azure CDN profile (Standard Microsoft).')
param cdnEnabled bool = false

@description('Deploy an internal Standard Load Balancer (isolated VNet/subnet + frontend/pool/probe/rule).')
param loadBalancerEnabled bool = false

@description('Deploy an Azure Firewall (Standard AZFW_VNet) in its own VNet with AzureFirewallSubnet + static public IP.')
param firewallEnabled bool = false

@description('Deploy a single-kind Computer Vision (CognitiveServices ComputerVision) account, Entra-only.')
param visionServicesEnabled bool = false

@description('Deploy a single-kind Speech Services (CognitiveServices SpeechServices) account, Entra-only.')
param speechServicesEnabled bool = false

@description('Deploy a single-kind Language (CognitiveServices TextAnalytics) account, Entra-only.')
param languageServicesEnabled bool = false

@description('Deploy an Azure Machine Learning workspace + its KV/Storage/AppInsights dependencies.')
param mlWorkspaceEnabled bool = false

@description('Enable Microsoft Defender for Cloud Standard pricing tiers on the subscription.')
param defenderCloudEnabled bool = false

@description('Assign a sample built-in audit policy at the subscription scope (Azure Policy navigator).')
param policyEnabled bool = false

// ---------- Deploy-planner per-resource config ----------
// SKU / tier / runtime knobs the Deployment planner's per-resource config panel
// writes into the generated .bicepparam, forwarded to the deploy-planner modules
// below so an exported plan applies the chosen SKU — not just module defaults.
// @allowed mirrors the module decorators (single source of truth) so an invalid
// value is rejected at compile time. Interdependent knobs (Redis family/capacity)
// are DERIVED here from the chosen SKU so every combination stays valid.

@description('Azure Cache for Redis SKU (deploy-planner). Family + capacity are derived to a valid pairing.')
@allowed(['Basic', 'Standard', 'Premium'])
param redisSkuName string = 'Basic'

@description('App Service plan SKU (deploy-planner).')
@allowed(['B1', 'B2', 'S1', 'P0v3', 'P1v3'])
param appServicePlanSku string = 'B1'

@description('App Service Linux runtime stack (deploy-planner), e.g. NODE|20-lts, DOTNETCORE|8.0, PYTHON|3.12.')
param appServiceLinuxFxVersion string = 'NODE|20-lts'

@description('Azure Functions worker runtime (deploy-planner).')
@allowed(['node', 'python', 'dotnet-isolated', 'java'])
param functionsWorkerRuntime string = 'node'

@description('Azure Functions Linux runtime version (deploy-planner), e.g. Node|20, Python|3.12.')
param functionsLinuxFxVersion string = 'Node|20'

@description('PostgreSQL Flexible Server major version (deploy-planner).')
@allowed(['13', '14', '15', '16'])
param postgresVersion string = '16'

@description('PostgreSQL Flexible Server storage size in GB (deploy-planner).')
@allowed([32, 64, 128, 256, 512])
param postgresStorageSizeGB int = 32

@description('MySQL Flexible Server version (deploy-planner).')
@allowed(['5.7', '8.0.21'])
param mysqlVersion string = '8.0.21'

@description('MySQL Flexible Server storage size in GB (deploy-planner).')
@minValue(20)
@maxValue(16384)
param mysqlStorageSizeGB int = 20

@description('Service Bus namespace SKU (deploy-planner). Basic is excluded — the module provisions a starter topic, which Basic does not support.')
@allowed(['Standard', 'Premium'])
param serviceBusSkuName string = 'Standard'

@description('Azure Firewall tier (deploy-planner).')
@allowed(['Standard', 'Premium'])
param firewallTier string = 'Standard'

@description('Stream Analytics starting streaming units (deploy-planner).')
@allowed([1, 3, 6, 12, 18, 24, 30, 36, 42, 48])
param streamAnalyticsStreamingUnits int = 3

// Derive a valid Redis family + capacity for the chosen SKU (Premium uses the
// P family starting at capacity 1; Basic/Standard use the C family at 0).
var redisIsPremium = redisSkuName == 'Premium'
var redisSkuFamily = redisIsPremium ? 'P' : 'C'
var redisSkuCapacity = redisIsPremium ? 1 : 0

// ---------- User access patterns ----------

@description('Deploy a P2S VPN Gateway (AAD-auth, OpenVPN) in the hub VNet. ~30 min provisioning, ~$30/mo. Default off.')
param vpnGatewayEnabled bool = false

@description('Deploy Application Gateway v2 + WAF in front of the Console. ~15 min provisioning, ~$250/mo. Default off.')
param appGatewayEnabled bool = false

@description('Deploy Front Door Premium with Private Link to the ACA env. ~5 min provisioning + manual PE approval, ~$330/mo. Default off.')
param frontDoorEnabled bool = false

@description('Optional vanity URL for the console (e.g. csa-loom.contoso.ai) — set in the Setup Wizard. Creates a Front Door managed-cert custom domain; the deploy outputs the CNAME + _dnsauth TXT to add at your DNS provider. Empty = use the generated Front Door host.')
param loomVanityDomain string = ''

// Standalone Azure ML workspace coordinates for the AML control-plane
// navigator (aml-client.ts / resolveAmlTarget). All optional — empty values
// fall back to the AI Foundry hub env (LOOM_FOUNDRY_*) + the deployment
// subscription in the resolver, so existing deployments are unaffected.
@description('AML workspace name for the standalone AML client (LOOM_AML_WORKSPACE). Empty falls back to the AI Foundry hub name.')
param loomAmlWorkspace string = ''

@description('Resource group of the AML workspace (LOOM_AML_RESOURCE_GROUP). Empty falls back to LOOM_FOUNDRY_RG.')
param loomAmlResourceGroup string = ''

@description('Subscription id of the AML workspace (LOOM_AML_SUBSCRIPTION). Empty falls back to the deployment subscription.')
param loomAmlSubscription string = ''

@description('Primary region of the AML workspace (LOOM_AML_REGION). Empty falls back to the deployment location.')
param loomAmlRegion string = ''

@description('Azure OpenAI account endpoint or name for the SQL editor Copilot (LOOM_AZURE_OPENAI_ENDPOINT — Fix / Explain / NL→T-SQL + inline ghost text). Empty derives from the Foundry Agent Service account when agentFoundryEnabled=true; empty + Foundry off → the SQL Copilot pane shows an honest gate naming this var + the Cognitive Services OpenAI User role.')
param loomAzureOpenAiEndpoint string = ''

@description('Azure OpenAI Chat Completions API version (LOOM_AOAI_API_VERSION) for the Copilot / data-agent orchestrators. Default 2024-10-21; advance for o-series reasoning models. The data-plane host is derived per sovereign boundary from environment(), so this value is cloud-invariant.')
param loomAoaiApiVersion string = '2024-10-21'

@description('Entra app client ID for Loom Console MSAL. When empty, Console runs unauth.')
param loomMsalClientId string = ''

@description('Entra app client secret for Loom Console MSAL. Stored in Container App secret store.')
@secure()
param loomMsalClientSecret string = ''

@description('Session cookie secret (HKDF input). Empty → admin-plane derives a stable per-RG GUID so sign-ins survive redeploys; set LOOM_SESSION_SECRET for a tenant-managed secret.')
@secure()
param loomSessionSecret string = ''

@description('Entra app-registration (MSAL) provisioning config — ONE object to stay under the admin-plane 256-param limit. Fields: enabled (default true — provision the app reg + client secret + stable SESSION_SECRET in KV so a fresh deploy signs in on first login, GH #1383; opt-out → unauth/BYO via loomMsalClientId); scriptIdentityId / scriptIdentityClientId (UAMI with Graph app-admin for the in-bicep deploymentScript — empty → the post-deploy bootstrap provisions it); scriptSubnetId (VNet-inject the script to reach the PE-locked KV); consoleHosts (comma-separated redirect-URI hosts, no scheme).')
param loomMsalAppReg object = {
  enabled: true
  scriptIdentityId: ''
  scriptIdentityClientId: ''
  scriptSubnetId: ''
  consoleHosts: ''
}

@description('Data mirroring backend selector (LOOM_MIRROR_BACKEND). Default adf-cdc (Azure-native CDC to ADLS Bronze, NO Fabric). synapse-link is Azure-native too; fabric is opt-in only and additionally requires loomDefaultFabricWorkspace.')
@allowed(['adf-cdc', 'synapse-link', 'fabric'])
param loomMirrorBackend string = 'adf-cdc'

@description('Existing Azure Maps account name to bind for the Geo editors (LOOM_AZURE_MAPS_ACCOUNT). Empty deploys a fresh Gen2 account on Commercial/GCC (azureMapsEnabled), or leaves Geo in its honest-gate state on GCC-High/IL5. Passed through to the admin-plane module.')
param loomAzureMapsAccount string = ''

@description('Deploy a fresh Azure Maps Gen2 account for the Geo editors. ON by default (opt-out) on Commercial/GCC — the admin-plane module also boundary-gates. Set loomMapsEnabled=false (or on GCC-High/IL5 where Azure Maps is unavailable) to skip; Geo then falls back to its honest-gate or a bound loomAzureMapsAccount. Passed through to the admin-plane module.')
param loomMapsEnabled bool = true

@description('DEPRECATED alias for loomMapsEnabled, retained so existing .bicepparam files keep working (GCC-High / IL5 set it false). Set either flag false to skip Azure Maps. Passed through to the admin-plane module.')
param azureMapsEnabled bool = true

@description('Deploy the hub Azure Firewall (admin-plane egress filtering). ON by default (opt-out). Distinct from firewallEnabled (deploy-planner). Set loomFirewallEnabled=false to skip — nothing consumes the hub firewall; disabling avoids FirewallPolicyUpdateFailed on reconcile.')
param loomFirewallEnabled bool = true

@description('DEPRECATED alias for loomFirewallEnabled, retained so existing .bicepparam files keep working. Set either flag false to skip the hub firewall.')
param hubFirewallEnabled bool = true

@description('Opt-in ADF CDC mirroring — pre-existing ADF linked service for the relational SOURCE (Azure SQL / SQL Server). Empty = built-in CSV snapshot engine (Azure-native, no Fabric).')
param loomMirrorSourceLinkedService string = ''

@description('Opt-in ADF CDC/Copy mirroring — pre-existing ADF AzureBlobFS linked service pointing at the DLZ ADLS account (Delta/Parquet sink). Empty = built-in snapshot engine.')
param loomMirrorAdlsLinkedService string = ''

@description('Opt-in ADF Copy mirroring — pre-existing ADF Snowflake linked service (credential in Key Vault). Empty = falls back to loomMirrorSourceLinkedService. Snowflake → ADF Copy → ADLS Bronze Parquet, NO Fabric.')
param loomMirrorSnowflakeLinkedService string = ''

@description('Refresh cadence for the ADF Copy backend schedule trigger (Snowflake): 15min | 1h | 4h | daily | on-demand. Default 1h.')
@allowed(['15min', '1h', '4h', 'daily', 'on-demand'])
param loomMirrorCopyCadence string = '1h'

@description('Default Fabric/Power BI workspace id (LOOM_DEFAULT_FABRIC_WORKSPACE). Leave EMPTY (default) for the Azure-native path — Fabric is strictly opt-in (per no-fabric-dependency.md) and only used when a *-backend env is also set to fabric.')
param loomDefaultFabricWorkspace string = ''

@description('Local admin password for the scaled self-hosted IR (SHIR) VMSS nodes in each DLZ. Empty → a strong password is auto-generated into the deployment (effShirAdminPassword) so the SHIR provisions by default per deploy-readiness; supply a Key-Vault-backed secret to override. The VMSS stays at capacity 0 (scale-to-0) so the credential is never used interactively — nothing needs to RDP.')
@secure()
param shirAdminPassword string = ''

// Auto-generate a complexity-satisfying SHIR admin password when none is
// supplied, so loomSelfHostedIrEnabled=true provisions the VMSS on a stock
// deploy (a VMSS requires a local credential). Derived deterministically from
// resource ids — uniqueString returns 13 lowercase alphanumerics; toUpper +
// the literal suffix add upper/lower/digit/symbol classes for Windows policy.
// The VMSS is private + scale-to-0, so this is never an interactive login.
var effShirAdminPassword = !empty(shirAdminPassword)
  ? shirAdminPassword
  : '${toUpper(substring(uniqueString(subscription().subscriptionId, 'loom-shir'), 0, 9))}${substring(uniqueString(deployment().name, 'loom-shir-lower'), 0, 9)}!7xQ'

@description('Loom version label shown in the UI (/admin/updates) + on /api/version. Wired to LOOM_VERSION / NEXT_PUBLIC_LOOM_VERSION. Default tracks the release-please manifest version (.release-please-manifest.json); a release/build pipeline should pass the exact tag (e.g. --parameters loomVersion=0.42.3). Bump this default when the major.minor release line advances so a clean default deploy never shows a stale "v0.1".')
param loomVersion string = '0.42.0'

@description('Container image tag per app (overridable per release).')
param appImageTags object = {
  console: 'v0.1'
  mcp: 'v0.1'
  mcpBridge: 'v0.1'
  orchestrator: 'v0.1'
  activator: 'v0.1'
  mirroring: 'v0.1'
  directLake: 'v0.1'
  // setupOrchestrator + maf are referenced by the admin-plane module when
  // deployAppsEnabled (setup-orchestrator + MAF tier Container Apps). They were
  // missing here, so the forwarded object lacked the keys and the apps-enabled
  // deploy failed ("property 'setupOrchestrator' doesn't exist"). Keep in sync
  // with modules/admin-plane/main.bicep appImageTags.
  setupOrchestrator: 'v0.1'
  maf: 'v0.1'
}

// =====================================================================
// Resource group for Admin Plane
// =====================================================================

// audit-t156 — topology resolution. Map the legacy deploymentMode onto the
// explicit topology when `topology` is unset, then derive the gating booleans
// every module below keys off. single-sub stays byte-identical to pre-t156.
//   effectiveTopology  single-sub | tenant | dlz-attach | multi-sub (legacy)
var effectiveTopology = empty(topology) ? deploymentMode : topology
// The admin plane (console + hub + ALL tenant-shared services) deploys in every
// topology EXCEPT dlz-attach, where it must already exist (coordinates arrive
// via hubCoordinates).
var deployAdminPlane = effectiveTopology != 'dlz-attach'
// Landing zones deploy in every topology EXCEPT tenant (DMLZ-only).
var deployLandingZones = effectiveTopology != 'tenant'
// single-sub uses the in-sub singleDlz module; legacy multi-sub + dlz-attach use
// the cross-sub dlz[for] fan-out over dlzSubscriptionIds.
var useSingleDlz = deployLandingZones && effectiveTopology == 'single-sub'
var useMultiDlz = deployLandingZones && effectiveTopology != 'single-sub'

// audit-t156 — the admin-plane RG name. dlz-attach may point at the EXISTING
// tenant admin-plane RG (from hubCoordinates.adminPlaneRgName) so cross-RG
// references resolve; otherwise it's the computed per-region name.
var adminPlaneRgName = (!deployAdminPlane && !empty(string(hubCoordinates.?adminPlaneRgName ?? ''))) ? string(hubCoordinates.adminPlaneRgName) : 'rg-csa-loom-admin-${location}'

// T95 — Cosmos data-plane host suffixes, sovereign-cloud-specific. The DLZ
// cosmos-graph-vector module computes the same suffixes; we mirror them here
// so the deterministic-name endpoints wired into the Console env (below) match
// the accounts the module actually deploys. Commercial/GCC → azure.com;
// GCC-High/IL5 (Azure US Government) → azure.us.
var gremlinHostSuffix = (boundary == 'GCC-High' || boundary == 'IL5') ? 'gremlin.cosmos.azure.us' : 'gremlin.cosmos.azure.com'
var cosmosDocSuffix = (boundary == 'GCC-High' || boundary == 'IL5') ? 'azure.us' : 'azure.com'
// Weave (Semantic Ontology) PG flexible-server data-plane host suffix, mirrored
// from postgres-weave.bicep so the deterministic-name FQDN wired into the Console
// env (LOOM_WEAVE_PG_FQDN, below) matches the server the DLZ module deploys.
// Commercial/GCC → postgres.database.azure.com; GCC-High/IL5 → .usgovcloudapi.net.
var pgHostSuffix = (boundary == 'GCC-High' || boundary == 'IL5') ? 'postgres.database.usgovcloudapi.net' : 'postgres.database.azure.com'
// Databricks ACCOUNT control-plane host (accounts.azuredatabricks.*), forwarded
// to the Console as LOOM_DATABRICKS_ACCOUNT_HOST so the Catalog → Metastores UC
// account API (list/assign) and the bootstrap deploymentScript both target the
// correct sovereign endpoint. Commercial + GCC run in Azure public cloud
// (accounts.azuredatabricks.net); Azure US Government (GCC-High/IL5) uses the
// .us host. UC itself is only enabled on Commercial/GCC (landing-zone
// dlzUcSupported), so the .us branch is defensive — the env is harmless when
// no account id is set.
var databricksAccountHost = (boundary == 'GCC-High' || boundary == 'IL5') ? 'accounts.azuredatabricks.us' : 'accounts.azuredatabricks.net'

resource adminPlaneRg 'Microsoft.Resources/resourceGroups@2024-03-01' = if (deployAdminPlane) {
  name: adminPlaneRgName
  location: location
  tags: complianceTags
}

// =====================================================================
// Admin Plane deployment (Hub VNet + Console + MCP + Copilot + ...)
// =====================================================================

module adminPlane 'modules/admin-plane/main.bicep' = if (deployAdminPlane) {
  name: 'admin-plane'
  scope: adminPlaneRg
  params: {
    location: location
    boundary: boundary
    loomAzureCloud: loomAzureCloud
    containerPlatform: containerPlatform
    // NOTE: functionsHostSku / capacitySku / openai* are NOT passed to the
    // admin-plane module. They are reserved-for-v3.x values consumed elsewhere
    // (capacitySku → landing-zone + capacity modules; openai* → ai-foundry);
    // the admin-plane module declared them only as unused pass-throughs, which
    // pushed it over the 256-parameter ARM/Bicep limit (max-params Error). They
    // are dropped here so admin-plane/main.bicep builds clean.
    apimSku: apimSku
    catalogPrimary: catalogPrimary
    agentOrchestrator: agentOrchestrator
    foundryPortalEnabled: foundryPortalEnabled
    defenderForAIEnabled: defenderForAIEnabled
    purviewEnabled: purviewEnabled
    atlasOnAksEnabled: atlasOnAksEnabled
    databricksUnityCatalogEnabled: databricksUnityCatalogEnabled
    // Databricks ACCOUNT API → Console. Forwarding the account GUID makes the
    // Catalog → Metastores "Unity Catalog" Section a REAL configured UC by
    // default: isAccountApiConfigured() returns true, so Browse can list the
    // account metastores + one-click attach (no manual env patch). Empty leaves
    // the account-admin attach honestly gated — registration/listing still work.
    // The host follows the sovereign cloud (Commercial/GCC → .net; US Gov → .us).
    loomDatabricksAccountId: databricksAccountId
    loomDatabricksAccountHost: empty(databricksAccountId) ? '' : databricksAccountHost
    keyVaultHsmIsolated: keyVaultHsmIsolated
    consolePrincipalNeedsCmkBind: consolePrincipalNeedsCmkBind
    adminEntraGroupId: adminEntraGroupId
    loomTenantAdminGroupId: loomTenantAdminGroupId
    loomTenantAdminOid: loomTenantAdminOid
    hubVnetCidr: hubVnetCidr
    complianceTags: complianceTags
    skipRoleGrants: skipRoleGrants
    recycleRetentionDays: recycleRetentionDays
    deployAppsEnabled: deployAppsEnabled
    aiFoundryEnabled: aiFoundryEnabled
    contentSafetyEnabled: contentSafetyEnabled
    agentFoundryEnabled: agentFoundryEnabled
    loomAoaiCompletionDeployment: loomAoaiCompletionDeployment
    loomAmlRg: loomAmlRg
    apimEnabled: (loomApimEnabled && apimEnabled)
    aiSearchEnabled: aiSearchEnabled
    adxEnabled: adxEnabled
    copilotMafEnabled: copilotMafEnabled
    setupOrchestratorEnabled: setupOrchestratorEnabled
    setupTemplateUri: setupTemplateUri
    loomPipelineCiEnabled: loomPipelineCiEnabled
    existingAiSearchService: existingAiSearchService
    existingAiSearchRg: existingAiSearchRg
    existingApimName: existingApimName
    existingApimRg: existingApimRg
    existingAdxClusterName: existingAdxClusterName
    existingAdxClusterRg: existingAdxClusterRg
    existingFoundryAccountName: existingFoundryAccountName
    existingFoundryRg: existingFoundryRg
    // Consolidated BYO overrides (cross-sub …Sub + Purview/Synapse/Cosmos/
    // EventHubs/Databricks) — one object param keeps admin-plane under Bicep's
    // 256-param ceiling. Emitted by scripts/csa-loom/byo-wizard.sh.
    byoExisting: {
      aiSearchSub: existingAiSearchSub
      apimSub: existingApimSub
      adxClusterSub: existingAdxClusterSub
      foundrySub: existingFoundrySub
      // Deployment names on a REUSED existing AOAI account (Gap A) so the
      // Console env wires the full AOAI surface, not just the account name.
      foundryChatDeployment: existingFoundryChatDeployment
      foundryEmbedDeployment: existingFoundryEmbedDeployment
      purviewAccount: existingPurviewAccount
      purviewRg: existingPurviewRg
      purviewSub: existingPurviewSub
      // #229 cross-region Purview location (empty = hub location). Carried on the
      // BYO object to stay under admin-plane's 256-param ceiling.
      purviewLocation: purviewLocation
      synapseWorkspace: existingSynapseWorkspace
      synapseRg: existingSynapseRg
      synapseSub: existingSynapseSub
      cosmosAccount: existingCosmosAccount
      cosmosRg: existingCosmosRg
      cosmosSub: existingCosmosSub
      eventHubNamespace: existingEventHubNamespace
      eventHubRg: existingEventHubRg
      eventHubSub: existingEventHubSub
      databricksWorkspace: existingDatabricksWorkspace
      databricksRg: existingDatabricksRg
      databricksSub: existingDatabricksSub
      databricksHostname: existingDatabricksHostname
      adfFactory: existingAdfFactory
      adfRg: existingAdfRg
      adfSub: existingAdfSub
      // Data-engineering opt-out mirrors (default true) — admin-plane blanks the
      // matching LOOM_* env var when a DLZ backend is disabled, so the editor
      // honest-gates instead of 502-ing. Carried here to stay under the 256-param ceiling.
      deSynapse: loomSynapseEnabled
      deDatabricks: loomDatabricksEnabled
      deAdf: loomDataFactoryEnabled
      deShir: loomSelfHostedIrEnabled
    }
    // Azure ML workspace for the notebook AML path. Name is the deterministic
    // deploy-planner ml-workspace.bicep name (uniqueString over the DLZ RG), so
    // we wire it WITHOUT referencing dpMlWorkspace.outputs (that module depends
    // on adminPlane's UAMI principal — referencing its output here would create
    // a cycle). Empty when the module isn't enabled → AML toggle honest-gates.
    amlWorkspaceName: (useSingleDlz && mlWorkspaceEnabled) ? take('aml-loom-${uniqueString(singleDlzRg.id)}', 33) : ''
    amlWorkspaceRg: (useSingleDlz && mlWorkspaceEnabled) ? singleDlzRg.name : ''
    vpnGatewayEnabled: vpnGatewayEnabled
    appGatewayEnabled: appGatewayEnabled
    frontDoorEnabled: frontDoorEnabled
    loomVanityDomain: loomVanityDomain
    // Single-sub: the DLZ ADLS account name is deterministic over singleDlzRg
    // (matches landing-zone/storage.bicep's saName) so the Console binds to the
    // real account — LOOM_ADLS_ACCOUNT / LOOM_*_URL / LOOM_ORG_VISUALS_URL all
    // resolve and the org-visuals RBAC grant targets it. MUST be empty in
    // multi-sub: singleDlzRg is NOT deployed there, so deriving from its .id
    // would yield a phantom `saloomdefault…` account — emitting env vars that
    // point at a non-existent account (Embed codes / Org visuals SAS minting
    // would 500 instead of showing the honest config gate). Empty here makes
    // those panes honest-gate; operators wire multi-sub DLZ accounts post-deploy
    // via scripts/csa-loom/patch-navigator-env.sh (same pattern as the Cosmos
    // endpoints below).
    loomStorageAccount: useSingleDlz ? take('saloomdefault${uniqueString(singleDlzRg.id)}', 24) : ''
    // Tenant/multi-sub: no LOCAL DLZ exists yet (DLZs attach later), so the ADX
    // cluster's DLZ-scoped Event Hub / storage grants must NOT fire — they would
    // target the non-existent rg-csa-loom-dlz-single-<loc> RG (ResourceGroupNotFound).
    // Empty in non-single-sub so the grants skip; the DLZ applies them on attach.
    loomEventHubNamespace: (useSingleDlz && loomEventHubEnabled) ? 'evhns-loom-default-${location}' : ''
    loomDlzRg: useSingleDlz ? singleDlzRg.name : adminPlaneRgName
    // Stream Analytics navigator binding. Single-sub: the starter job + its
    // Stream-Analytics-Contributor grant live in the DLZ RG, so LOOM_ASA_RG must
    // point there for the stream-analytics-job editor + the Eventstream transform
    // node to work first-try (G1: previously empty → 501). When reusing an
    // existing job, bind to its RG/SUB/name instead; empty when ASA is disabled or
    // for tenant/multi-sub (the console can't bind one DLZ's job — patched post-
    // deploy via patch-navigator-env.sh).
    loomAsaRg: !empty(existingAsaJob) ? existingAsaRg : ((useSingleDlz && loomStreamAnalyticsEnabled) ? singleDlzRg.name : '')
    loomAsaSub: !empty(existingAsaJob) ? existingAsaSub : ''
    loomAsaJobName: !empty(existingAsaJob) ? existingAsaJob : 'asa-loom-default-${location}'
    loomCosmosAccount: take('cosmos-loom-default-${uniqueString(singleDlzRg.id)}', 44)
    // Tenant/dlz-attach: no local DLZ hosts the Console's `loom` Cosmos, so the
    // admin plane provisions it in the hub (else the Console points at a missing
    // account and all item/config CRUD fails). useSingleDlz already deploys it
    // via the DLZ cosmos.bicep; BYO Cosmos overrides both. loomConsoleCosmosEnabled
    // (default true) is the opt-out flag — disabling it is only valid alongside a
    // BYO existingCosmosAccount (the empty() guard already enforces that).
    deployConsoleCosmos: loomConsoleCosmosEnabled && !useSingleDlz && empty(existingCosmosAccount)
    // Forward the Cosmos data-plane endpoints to the Console so the vector-store
    // and graph editors bind to the deployed accounts by default (no manual
    // config). The DLZ `cosmos-graph-vector` module (cosmosGraphVectorEnabled,
    // default on) creates a dedicated Gremlin account + a dedicated NoSQL vector
    // account, named deterministically as `cosmos-loom-gremlin-default-<uniq>`
    // and `cosmos-loom-vec-default-<uniq>` over the DLZ RG id. We compute those
    // names inline here rather than reading singleDlz.outputs.* because
    // `adminPlane` deploys BEFORE `singleDlz` (and singleDlz depends on
    // adminPlane outputs) — referencing the DLZ output would create a cycle.
    // This is the same deterministic-name pattern used for amlWorkspaceName /
    // loomCosmosAccount above. Database/graph names match the module's literals
    // (loom-graph / default / loom-vectors / docs-vec); they are NOT optional —
    // the gremlin client defaults to graphdb/graph which the module never
    // creates, so a bare endpoint would target a non-existent db/graph.
    // Multi-sub mode can't be wired from a single admin-plane (one Console env,
    // N DLZs) — operators run scripts/csa-loom/patch-navigator-env.sh there.
    loomCosmosVectorEndpoint: (useSingleDlz && cosmosGraphVectorEnabled) ? 'https://${take('cosmos-loom-vec-default-${uniqueString(singleDlzRg.id)}', 44)}.documents.${cosmosDocSuffix}:443/' : ''
    loomCosmosVectorDatabase: (useSingleDlz && cosmosGraphVectorEnabled) ? 'loom-vectors' : ''
    loomCosmosVectorContainer: (useSingleDlz && cosmosGraphVectorEnabled) ? 'docs-vec' : ''
    loomCosmosGremlinEndpoint: (useSingleDlz && cosmosGraphVectorEnabled) ? 'wss://${take('cosmos-loom-gremlin-default-${uniqueString(singleDlzRg.id)}', 44)}.${gremlinHostSuffix}:443/' : ''
    loomCosmosGremlinDatabase: (useSingleDlz && cosmosGraphVectorEnabled) ? 'loom-graph' : ''
    loomCosmosGremlinGraph: (useSingleDlz && cosmosGraphVectorEnabled) ? 'default' : ''
    // Weave (Semantic Ontology) graph store — the DLZ postgres-weave module
    // (weaveOntologyEnabled, default on) provisions a PG flexible server named
    // deterministically as psql-loom-weave-default-<uniq> (max 63) over the DLZ
    // RG id, with a starter db loom-weave + the Apache AGE extension. We compute
    // the FQDN inline (NOT via singleDlz.outputs — landing-zone consumes
    // adminPlane's UAMI, so referencing its outputs here would create a cycle),
    // the same deterministic-name pattern as the Cosmos endpoints above. The
    // graph name (loom_ontology) matches the post-deploy bootstrap create_graph.
    // Multi-sub can't be wired from a single admin-plane — operators run
    // scripts/csa-loom/patch-navigator-env.sh (same as the Cosmos endpoints).
    loomWeavePgFqdn: (useSingleDlz && weaveOntologyEnabled) ? '${take('psql-loom-weave-default-${uniqueString(singleDlzRg.id)}', 63)}.${pgHostSuffix}' : ''
    loomWeavePgDatabase: (useSingleDlz && weaveOntologyEnabled) ? 'loom-weave' : ''
    loomWeaveGraph: (useSingleDlz && weaveOntologyEnabled) ? 'loom_ontology' : ''
    // DAB preview runtime (loom-dab-preview) — default-on. SQL target defaults to
    // the DLZ Synapse serverless SQL endpoint (deterministic workspace name, same
    // pattern as loomSynapseWorkspace below); the DAB engine boots healthy on an
    // empty-entities config so REST/GraphQL/publish preview work day-one. Entity
    // queries also need the Console UAMI SQL login (grant-dab-sql.sh). Empty FQDN
    // when Synapse is off → admin-plane skips DAB + honest-gates the editor.
    dabRuntimeEnabled: dabRuntimeEnabled
    dabSqlServerFqdn: (dabRuntimeEnabled && loomSynapseEnabled) ? 'syn-loom-default-${location}-ondemand.sql.azuresynapse.net' : ''
    dabSqlDatabase: (dabRuntimeEnabled && loomSynapseEnabled) ? 'master' : ''
    // dbt-runner (loom-dbt-runner) — default-on but image-gated: the admin-plane
    // only deploys the Container App when the image is present in ACR.
    dbtRunnerEnabled: (dbtRunnerEnabled && dbtRunnerImageReady)
    // Bind the console's warehouse/SQL env (LOOM_SYNAPSE_WORKSPACE /
    // LOOM_SYNAPSE_DEDICATED_POOL) to the DLZ Synapse workspace + dedicated pool
    // the landing-zone provisions (synapse.bicep: 'syn-loom-${domainName}-${location}'
    // with domainName='default', dedicatedPoolName='loompool'). Computed
    // deterministically (NOT via singleDlz.outputs — landing-zone consumes
    // adminPlane's UAMI, so referencing its outputs here would create a cycle).
    // This makes the warehouse access-policy grant target the real pool; without
    // it the binding silently relies on the admin-plane default matching.
    loomSynapseWorkspace: 'syn-loom-default-${location}'
    loomSynapseDedicatedPool: 'loompool'
    loomPurviewAccount: loomPurviewAccount
    loomMipEnabled: loomMipEnabled
    loomMipAdminEnabled: loomMipAdminEnabled
    sccAppId: sccAppId
    sccCertThumbprint: sccCertThumbprint
    sccOrganization: sccOrganization
    sccConnectionUri: sccConnectionUri
    loomDlpEnabled: loomDlpEnabled
    loomDlpAdminEnabled: loomDlpAdminEnabled
    loomPowerBiAdminLabels: loomPowerBiAdminLabels
    loomPowerbiXmlaEndpoint: loomPowerbiXmlaEndpoint
    loomIdentityPickerEnabled: loomIdentityPickerEnabled
    loomDomainGroupProvisioningEnabled: loomDomainGroupProvisioningEnabled
    loomSharepointShortcutsEnabled: loomSharepointShortcutsEnabled
    loomMsalClientId: loomMsalClientId
    loomMsalClientSecret: loomMsalClientSecret
    loomSessionSecret: loomSessionSecret
    loomMsalAppReg: loomMsalAppReg
    loomMirrorBackend: loomMirrorBackend
    loomAzureMapsAccount: loomAzureMapsAccount
    azureMapsEnabled: (loomMapsEnabled && azureMapsEnabled)
    firewallEnabled: (loomFirewallEnabled && hubFirewallEnabled)
    loomMirrorSourceLinkedService: loomMirrorSourceLinkedService
    loomMirrorAdlsLinkedService: loomMirrorAdlsLinkedService
    loomMirrorSnowflakeLinkedService: loomMirrorSnowflakeLinkedService
    loomMirrorCopyCadence: loomMirrorCopyCadence
    // No-Fabric mode (default): force the bound workspace empty so nothing
    // hard-depends on a Fabric capacity/workspace (no-fabric-dependency.md). Set
    // fabricEnabled=true ONLY to opt into a bound Fabric workspace.
    loomDefaultFabricWorkspace: fabricEnabled ? loomDefaultFabricWorkspace : ''
    loomVersion: loomVersion
    appImageTags: appImageTags
    // Standalone AML workspace coords for the AML control-plane navigator.
    loomAmlWorkspace: loomAmlWorkspace
    loomAmlResourceGroup: loomAmlResourceGroup
    loomAmlSubscription: loomAmlSubscription
    loomAmlRegion: loomAmlRegion
    // Azure OpenAI endpoint for the SQL editor Copilot (Fix/Explain/NL→T-SQL).
    loomAzureOpenAiEndpoint: loomAzureOpenAiEndpoint
    loomAoaiApiVersion: loomAoaiApiVersion
    // Analytics report embed (F21 Usage / F2 Govern) — per-cloud, opt-in over the
    // native charts. The KIND can be defaulted by the param file; the BFF honestly
    // gates until the report/dashboard ids + UAMI membership are supplied.
    pbiEmbeddedEnabled: pbiEmbeddedEnabled
    managedGrafanaEnabled: managedGrafanaEnabled
    loomUsageReportKind: loomUsageReportKind
    loomUsagePbiWorkspaceId: loomUsagePbiWorkspaceId
    loomUsagePbiReportId: loomUsagePbiReportId
    loomGrafanaUsageDashboardUid: loomGrafanaUsageDashboardUid
    loomReportKind: loomReportKind
    loomGovernPbiWorkspaceId: loomGovernPbiWorkspaceId
    loomGovernPbiReportId: loomGovernPbiReportId
    loomGrafanaDashboardUid: loomGrafanaDashboardUid
    // Azure-native backend selectors (no-fabric-dependency) + the org-visuals
    // opt-out, bundled into ONE object so the admin-plane module stays under the
    // ARM 256-parameter limit (admin-plane cannot take another scalar param).
    // Mirrors admin-plane/main.bicep's loomBackends default key-for-key; the
    // orgVisuals key is driven by the operator-facing loomOrgVisualsEnabled flag
    // (default true → 'enabled'; false → the Embed codes / Org visuals panes
    // honest-gate while the medallion lake stays wired).
    loomBackends: {
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
      orgVisuals: loomOrgVisualsEnabled ? 'enabled' : 'disabled'
    }
  }
}

// audit-t156 — hub coordinates the DLZ + cross-sub RBAC modules consume. When
// the admin plane is deployed in THIS deployment (single-sub / tenant / legacy
// multi-sub) they come from adminPlane.outputs (guarded by deployAdminPlane via
// the ?: operator so the reference is never evaluated in dlz-attach, per the ARM
// `if` short-circuit). In dlz-attach the admin plane is skipped and the values
// arrive as the `hubCoordinates` object (the tenant deployment's topologyManifest
// output, surfaced by the orchestrator). Routing every DLZ/RBAC consumer through
// `hub.*` instead of adminPlane.outputs.* is what makes dlz-attach deploy with
// ZERO console/Front Door/Cosmos resources.
//
// audit-t156 — `topology=dlz-attach` makes `hubCoordinates` REQUIRED (the admin
// plane is skipped, so there is no `adminPlane.outputs.*` to read; every hub
// field is sourced from the tenant DMLZ deploy's topologyManifest.hub, passed in
// as `hubCoordinates`). This resolves to the supplied hub VNet id, or '' when
// absent. In single-sub / tenant / legacy modes deployAdminPlane is true and the
// `var hub` ternary below reads adminPlane outputs instead, so this value is
// unused there. NOTE: an earlier revision tried to "fail loudly" here by
// dereferencing a non-existent property whose name was the operator message —
// ARM evaluates every `var` eagerly at validate/what-if time, so that broke
// ALL topologies (incl. tenant), not just an under-specified dlz-attach. The
// precondition is now enforced upstream in the setup orchestrator (which
// assembles hubCoordinates); a dlz-attach run with empty hub coordinates fails
// honestly at the first landing-zone resource that needs hub.hubVnetId.
var dlzAttachHubVnetId = string(hubCoordinates.?hubVnetId ?? '')
var hub = deployAdminPlane ? {
  hubVnetId: adminPlane!.outputs.hubVnetId
  lawId: adminPlane!.outputs.lawId
  appInsightsConnectionString: adminPlane!.outputs.appInsightsConnectionString
  privateDnsZoneIds: adminPlane!.outputs.privateDnsZoneIds
  adxClusterPrincipalId: adminPlane!.outputs.adxClusterPrincipalId
  consolePrincipalId: adminPlane!.outputs.uamiConsolePrincipalId
  consoleUamiName: adminPlane!.outputs.uamiConsoleName
  consoleUamiAppId: adminPlane!.outputs.uamiConsoleClientId
  consoleUamiResourceId: adminPlane!.outputs.uamiConsoleId
  activatorPrincipalId: adminPlane!.outputs.uamiActivatorPrincipalId
  catalogEndpoint: adminPlane!.outputs.catalogEndpoint
  aiServicesAccountName: adminPlane!.outputs.aiServicesAccountName
} : {
  hubVnetId: dlzAttachHubVnetId
  lawId: string(hubCoordinates.?lawId ?? '')
  appInsightsConnectionString: string(hubCoordinates.?appInsightsConnectionString ?? '')
  privateDnsZoneIds: (hubCoordinates.?privateDnsZoneIds ?? {})
  adxClusterPrincipalId: string(hubCoordinates.?adxClusterPrincipalId ?? '')
  consolePrincipalId: string(hubCoordinates.?consolePrincipalId ?? '')
  consoleUamiName: string(hubCoordinates.?consoleUamiName ?? '')
  consoleUamiAppId: string(hubCoordinates.?consoleUamiAppId ?? '')
  consoleUamiResourceId: string(hubCoordinates.?consoleUamiResourceId ?? '')
  activatorPrincipalId: string(hubCoordinates.?activatorPrincipalId ?? '')
  catalogEndpoint: string(hubCoordinates.?catalogEndpoint ?? '')
  aiServicesAccountName: string(hubCoordinates.?aiServicesAccountName ?? '')
}

// Private DNS zone object the DLZ modules dereference (.synapseSql / .adf).
// Defaults to {} in dlz-attach when not supplied so the safe-deref below holds.
var hubPrivateDnsZoneIds = hub.privateDnsZoneIds

// dlz-attach hub coordinates — effective values. The orchestrator (Setup Wizard
// deploy API) passes the individual hub* params (read from the Cosmos
// tenant-topology doc); a direct bicep invocation can instead pass the whole
// `hubCoordinates` object (the tenant deploy's topologyManifest.hub). Each value
// prefers the explicit individual param and falls back to the hubCoordinates-
// resolved `hub` var, so BOTH input styles work. Without this, a hubCoordinates-
// only dlz-attach left adminPlaneHubVnetId empty → VNet peering failed with
// LinkedInvalidPropertyId (empty remoteVirtualNetwork.id).
var effHubVnetId = !empty(hubVnetId) ? hubVnetId : hub.hubVnetId
var effHubLawId = !empty(hubLawId) ? hubLawId : hub.lawId
var effHubAppInsightsConnectionString = !empty(hubAppInsightsConnectionString) ? hubAppInsightsConnectionString : hub.appInsightsConnectionString
var effHubPrivateDnsZoneIds = !empty(hubPrivateDnsZoneIdsAttach) ? hubPrivateDnsZoneIdsAttach : hub.privateDnsZoneIds
var effHubAdxClusterRgName = !empty(hubAdxClusterRgName) ? hubAdxClusterRgName : adminPlaneRgName
var effHubAdxClusterPrincipalId = !empty(hubAdxClusterPrincipalId) ? hubAdxClusterPrincipalId : hub.adxClusterPrincipalId
var effHubActivatorPrincipalId = !empty(hubActivatorPrincipalId) ? hubActivatorPrincipalId : hub.activatorPrincipalId
var effHubConsolePrincipalId = !empty(hubConsolePrincipalId) ? hubConsolePrincipalId : hub.consolePrincipalId
var effHubConsoleUamiName = !empty(hubConsoleUamiName) ? hubConsoleUamiName : hub.consoleUamiName
var effHubConsoleUamiAppId = !empty(hubConsoleUamiAppId) ? hubConsoleUamiAppId : hub.consoleUamiAppId
var effHubConsoleUamiId = !empty(hubConsoleUamiId) ? hubConsoleUamiId : hub.consoleUamiResourceId
var effHubCatalogEndpoint = !empty(hubCatalogEndpoint) ? hubCatalogEndpoint : hub.catalogEndpoint

// ── dlz-attach cross-sub integration (hub-side peering + hub-console env) ──────
// Hub subscription id for the cross-sub modules below. Prefer the explicit param,
// then hubCoordinates.adminPlaneSubId, then the deployment-sub adminPlaneSubId
// (same-sub fallback). The hub admin RG name is already resolved as
// `adminPlaneRgName` (from hubCoordinates.adminPlaneRgName).
var effHubSubscriptionId = !empty(hubAdminSubscriptionId) ? hubAdminSubscriptionId : (!empty(string(hubCoordinates.?adminPlaneSubId ?? '')) ? string(hubCoordinates.adminPlaneSubId) : adminPlaneSubId)
// Hub VNet NAME (last segment of the hub VNet resource id) for the reverse peering.
var effHubVnetName = !empty(effHubVnetId) ? last(split(effHubVnetId, '/')) : ''
// Start-of-deployment-computable guards for the two cross-sub modules. The `if`
// condition cannot reference `eff*`/`hub` (they fold in adminPlane.outputs, which
// are unknown at deployment start → BCP177). In dlz-attach the admin plane is
// never deployed, so these guards read ONLY the dlz-attach input params, which
// IS what dlz-attach always provides (individual hub* params OR hubCoordinates).
var dlzAttachHasHubVnet = !empty(hubVnetId) || !empty(string(hubCoordinates.?hubVnetId ?? ''))
var dlzAttachHasHubConsoleUami = !empty(hubConsoleUamiId) || !empty(string(hubCoordinates.?consoleUamiResourceId ?? ''))

// audit-t156 — DLZ inventory for the topologyManifest output. for-expressions
// must be the direct value of a var (BCP138), so the multi-sub fan-out list is
// built here and combined with the single-sub case via a plain ternary.
var topologyManifestDlzsMulti = [for (subId, i) in dlzSubscriptionIds: {
  domainName: dlzDomainNames[i]
  subscriptionId: subId
  resourceGroup: 'rg-csa-loom-dlz-${dlzDomainNames[i]}-${location}'
}]
var topologyManifestDlzsSingle = [
  {
    domainName: 'default'
    subscriptionId: adminPlaneSubId
    resourceGroup: 'rg-csa-loom-dlz-single-${location}'
  }
]
var topologyManifestDlzs = useSingleDlz ? topologyManifestDlzsSingle : (deployLandingZones ? topologyManifestDlzsMulti : [])

// =====================================================================
// Data Landing Zone resource groups (created here so DLZ modules can target them)
// =====================================================================

resource singleDlzRg 'Microsoft.Resources/resourceGroups@2024-03-01' = if (useSingleDlz) {
  name: 'rg-csa-loom-dlz-single-${location}'
  location: location
  tags: complianceTags
}

// =====================================================================
// Data Landing Zone(s)
//
// Single-sub mode: 1 DLZ in same sub as Admin Plane
// Multi-sub mode:  per-DLZ subs, one module per element of dlzSubscriptionIds
// =====================================================================

// Single-sub: 1 DLZ in same sub
module singleDlz 'modules/landing-zone/main.bicep' = if (useSingleDlz) {
  name: 'dlz-single'
  scope: singleDlzRg
  params: {
    location: location
    boundary: boundary
    domainName: 'default'
    containerPlatform: containerPlatform
    capacitySku: capacitySku
    adminPlaneHubVnetId: hub.hubVnetId
    adminPlaneLawId: hub.lawId
    adminPlaneAppInsightsConnectionString: hub.appInsightsConnectionString
    adminPlanePrivateDnsZoneIds: hubPrivateDnsZoneIds
    adminPlaneAdxClusterRgName: adminPlaneRgName
    adxEnabled: adxEnabled
    loomSynapseEnabled: loomSynapseEnabled
    loomDatabricksEnabled: loomDatabricksEnabled
    loomDataFactoryEnabled: loomDataFactoryEnabled
    loomSelfHostedIrEnabled: loomSelfHostedIrEnabled
    adxClusterPrincipalId: hub.adxClusterPrincipalId
    adminEntraGroupId: adminEntraGroupId
    activatorPrincipalId: hub.activatorPrincipalId
    consolePrincipalId: hub.consolePrincipalId
    consoleUamiName: hub.consoleUamiName
    consoleUamiAppId: hub.consoleUamiAppId
    synapseSqlPrivateDnsZoneId: string(hubPrivateDnsZoneIds.?synapseSql ?? '')
    adfPrivateDnsZoneId: string(hubPrivateDnsZoneIds.?adf ?? '')
    catalogEndpoint: hub.catalogEndpoint
    databricksUnityCatalogEnabled: databricksUnityCatalogEnabled
    databricksSqlWarehouseEnabled: databricksSqlWarehouseEnabled
    databricksAccountId: databricksAccountId
    databricksUcScriptUamiId: hub.consoleUamiResourceId
    storageRequireCmk: storageRequireCmk
    powerBiSku: powerBiSku
    complianceTags: complianceTags
    skipRoleGrants: skipRoleGrants
    consolePrincipalNeedsLifecycleWrite: consolePrincipalNeedsLifecycleWrite
    consolePrincipalNeedsCmkBind: consolePrincipalNeedsCmkBind
    shirAdminPassword: effShirAdminPassword
    recycleRetentionDays: recycleRetentionDays
    cosmosGraphVectorEnabled: cosmosGraphVectorEnabled
    weaveOntologyEnabled: weaveOntologyEnabled
    // RTI (Real-Time Intelligence) opt-out flags + existing-namespace reuse.
    // Single-sub: the Eventstream/Data Explorer navigators bind to this DLZ's
    // namespace, so reuse-an-existing skips provisioning here AND the admin-plane
    // env points at the reused namespace (existingEventHubNamespace below).
    loomEventHubEnabled: loomEventHubEnabled
    existingEventHubNamespaceName: existingEventHubNamespace
    enableStreamAnalytics: loomStreamAnalyticsEnabled && empty(existingAsaJob)
  }
}

// F8 (Manage Policies) / T14 — let the Console UAMI assign container-scoped
// Storage Blob Data roles on the lake account when an access request is
// approved. Constrained RBAC-Administrator (data-plane roles only) — see the
// module header. Scoped to the DLZ RG where the storage account lives.
module singleDlzAccessPolicyRbac 'modules/admin-plane/access-policy-rbac.bicep' = if (useSingleDlz) {
  name: 'dlz-single-access-policy-rbac'
  scope: singleDlzRg
  params: {
    consolePrincipalId: hub.consolePrincipalId
    storageAccountName: singleDlz!.outputs.storageAccountName
    skipRoleGrants: skipRoleGrants
  }
}

// F16 (Notebook AI functions) — grant the DLZ Spark identities (Synapse
// workspace MSI + Databricks Access Connector MSI) Cognitive Services OpenAI
// User on the admin-plane AOAI account, so ai.summarize / classify / extract /
// translate / sentiment in a PySpark/pandas notebook cell can call AOAI. The
// AOAI account lives in the Admin Plane RG (deployed before the DLZ), so the
// grant is made here (orchestrator) at admin-plane scope, fed the Spark
// identities from the DLZ outputs. The module no-ops (its role assignments are
// guarded on !empty(aiServicesAccountName)) when admin-plane used an existing
// external AOAI account — the operator grants the role manually then.
module singleDlzAoaiSparkRbac 'modules/admin-plane/aoai-spark-rbac.bicep' = if (useSingleDlz) {
  name: 'dlz-single-aoai-spark-rbac'
  scope: resourceGroup(adminPlaneRgName)
  params: {
    aiServicesAccountName: hub.aiServicesAccountName
    synapseWorkspacePrincipalId: singleDlz!.outputs.synapseManagedIdentityPrincipalId
    databricksAccessConnectorPrincipalId: singleDlz!.outputs.databricksAccessConnectorPrincipalId
    skipRoleGrants: skipRoleGrants
  }
}

// Multi-sub: per-DLZ in separate subs

// NOTE: caller is responsible for creating the per-DLZ RGs in the
// target subs before this deployment runs (typically via a bootstrap
// PowerShell or az CLI script — see scripts/csa-loom/bootstrap-dlz-rgs.sh).
@batchSize(1)
module dlz 'modules/landing-zone/main.bicep' = [for (subId, i) in dlzSubscriptionIds: if (useMultiDlz) {
  name: 'dlz-${i}'
  scope: resourceGroup(subId, 'rg-csa-loom-dlz-${dlzDomainNames[i]}-${location}')
  params: {
    location: location
    boundary: boundary
    domainName: dlzDomainNames[i]
    containerPlatform: containerPlatform
    capacitySku: capacitySku
    adminPlaneHubVnetId: hub.hubVnetId
    adminPlaneLawId: hub.lawId
    adminPlaneAppInsightsConnectionString: hub.appInsightsConnectionString
    adminPlanePrivateDnsZoneIds: hubPrivateDnsZoneIds
    adminPlaneAdxClusterRgName: adminPlaneRgName
    adxEnabled: adxEnabled
    loomSynapseEnabled: loomSynapseEnabled
    loomDatabricksEnabled: loomDatabricksEnabled
    loomDataFactoryEnabled: loomDataFactoryEnabled
    loomSelfHostedIrEnabled: loomSelfHostedIrEnabled
    adxClusterPrincipalId: hub.adxClusterPrincipalId
    adminEntraGroupId: adminEntraGroupId
    activatorPrincipalId: hub.activatorPrincipalId
    consolePrincipalId: hub.consolePrincipalId
    consoleUamiName: hub.consoleUamiName
    consoleUamiAppId: hub.consoleUamiAppId
    synapseSqlPrivateDnsZoneId: string(hubPrivateDnsZoneIds.?synapseSql ?? '')
    adfPrivateDnsZoneId: string(hubPrivateDnsZoneIds.?adf ?? '')
    catalogEndpoint: hub.catalogEndpoint
    databricksUnityCatalogEnabled: databricksUnityCatalogEnabled
    databricksSqlWarehouseEnabled: databricksSqlWarehouseEnabled
    databricksAccountId: databricksAccountId
    databricksUcScriptUamiId: hub.consoleUamiResourceId
    storageRequireCmk: storageRequireCmk
    powerBiSku: powerBiSku
    complianceTags: complianceTags
    skipRoleGrants: skipRoleGrants
    consolePrincipalNeedsLifecycleWrite: consolePrincipalNeedsLifecycleWrite
    consolePrincipalNeedsCmkBind: consolePrincipalNeedsCmkBind
    shirAdminPassword: effShirAdminPassword
    recycleRetentionDays: recycleRetentionDays
    cosmosGraphVectorEnabled: cosmosGraphVectorEnabled
    weaveOntologyEnabled: weaveOntologyEnabled
    // RTI opt-out flags. Multi-sub: each DLZ provisions its OWN Event Hubs
    // namespace + Stream Analytics job (existingEventHubNamespace is the hub-
    // navigator binding, not a per-DLZ skip), so only the enable flags forward.
    loomEventHubEnabled: loomEventHubEnabled
    enableStreamAnalytics: loomStreamAnalyticsEnabled
  }
}]

// Multi-sub: per-DLZ access-policy RBAC-Admin grant (F8 / T14), one per DLZ.
@batchSize(1)
module dlzAccessPolicyRbac 'modules/admin-plane/access-policy-rbac.bicep' = [for (subId, i) in dlzSubscriptionIds: if (useMultiDlz) {
  name: 'dlz-${i}-access-policy-rbac'
  scope: resourceGroup(subId, 'rg-csa-loom-dlz-${dlzDomainNames[i]}-${location}')
  params: {
    consolePrincipalId: hub.consolePrincipalId
    storageAccountName: dlz[i]!.outputs.storageAccountName
    skipRoleGrants: skipRoleGrants
  }
}]

// Multi-sub: per-DLZ item-create Contributor grant (audit-t159 domain-aware
// resource routing). The Console UAMI lives in the admin sub; this grants it
// Contributor on each domain DLZ resource group (in the DLZ's own subscription)
// so domain-scoped item-create ARM PUTs — lakehouse/warehouse/eventhouse/
// notebook/mirroring — succeed instead of 403'ing cross-sub. Mirrors the RG-name
// contract `rg-csa-loom-dlz-{domain}-{location}` used by the dlz / dlzAccessPolicyRbac
// loops above + scripts/csa-loom/bootstrap-dlz-rgs.sh; resolved at runtime by
// apps/fiab-console/lib/azure/topology.ts → resolveDeployTarget.
@batchSize(1)
module dlzItemCreateRbac 'modules/admin-plane/dlz-attach-itemcreate-rbac.bicep' = [for (subId, i) in dlzSubscriptionIds: if (deploymentMode == 'multi-sub') {
  name: 'dlz-${i}-itemcreate-rbac'
  scope: resourceGroup(subId, 'rg-csa-loom-dlz-${dlzDomainNames[i]}-${location}')
  params: {
    consolePrincipalId: adminPlane.outputs.uamiConsolePrincipalId
    skipRoleGrants: skipRoleGrants
  }
}]

// =====================================================================
// DLZ-ATTACH topology (audit-t157)
//
// Add ONE new Data Landing Zone to an ALREADY-deployed hub. This deployment is
// submitted by the Setup Orchestrator AT the target subscription scope, so
// subscription() resolves to targetSubscriptionId and the DLZ RG is created
// locally. The Admin Plane is NOT deployed (topology gate) — the DLZ wires into
// the existing hub via the hub* coordinate params the orchestrator fills from
// the Cosmos `tenant-topology` doc. No second Console is ever stamped.
//
// The orchestrator identity must already hold Contributor on this subscription
// to submit this deployment — the orchestrator surfaces the exact
// `az role assignment create` command when the grant is missing (its RBAC
// honest gate), so there is no chicken-and-egg in-template grant here.
// =====================================================================
resource dlzAttachRg 'Microsoft.Resources/resourceGroups@2024-03-01' = if (topology == 'dlz-attach') {
  name: 'rg-csa-loom-dlz-${attachDomainName}-${location}'
  location: location
  tags: complianceTags
}

module dlzAttach 'modules/landing-zone/main.bicep' = if (topology == 'dlz-attach') {
  name: 'dlz-attach-${attachDomainName}'
  scope: resourceGroup('rg-csa-loom-dlz-${attachDomainName}-${location}')
  dependsOn: [
    dlzAttachRg
  ]
  params: {
    location: location
    boundary: boundary
    domainName: attachDomainName
    containerPlatform: containerPlatform
    capacitySku: capacitySku
    adminPlaneHubVnetId: effHubVnetId
    adminPlaneLawId: effHubLawId
    adminPlaneAppInsightsConnectionString: effHubAppInsightsConnectionString
    adminPlanePrivateDnsZoneIds: effHubPrivateDnsZoneIds
    adminPlaneAdxClusterRgName: effHubAdxClusterRgName
    // dlz-attach: the hub's shared ADX cluster lives in the DMLZ subscription while
    // this DLZ deploys from the DLZ subscription. ARM cannot create the per-domain
    // database via a cross-SUBSCRIPTION nested deployment (the RG-scoped DB
    // deployment can't carry the required `location`, and Bicep won't emit/allow one
    // for a cross-sub RG module). Per adx-cluster.bicep, the per-domain ADX database
    // (and follower attach) is created at RUNTIME via the Console's KQL-database /
    // follower API against the shared cluster — no deploy-time bicep resource is
    // needed. So the deploy-time ADX DB is skipped here; every other DLZ backend
    // (ADLS, Synapse, Databricks, Event Hubs, Cosmos) is in-sub and deploys normally.
    adxEnabled: false
    loomSynapseEnabled: loomSynapseEnabled
    loomDatabricksEnabled: loomDatabricksEnabled
    loomDataFactoryEnabled: loomDataFactoryEnabled
    loomSelfHostedIrEnabled: loomSelfHostedIrEnabled
    adxClusterPrincipalId: effHubAdxClusterPrincipalId
    adminEntraGroupId: adminEntraGroupId
    activatorPrincipalId: effHubActivatorPrincipalId
    consolePrincipalId: effHubConsolePrincipalId
    consoleUamiName: effHubConsoleUamiName
    consoleUamiAppId: effHubConsoleUamiAppId
    synapseSqlPrivateDnsZoneId: effHubPrivateDnsZoneIds.?synapseSql ?? ''
    adfPrivateDnsZoneId: effHubPrivateDnsZoneIds.?adf ?? ''
    catalogEndpoint: effHubCatalogEndpoint
    databricksUnityCatalogEnabled: databricksUnityCatalogEnabled
    databricksSqlWarehouseEnabled: databricksSqlWarehouseEnabled
    databricksAccountId: databricksAccountId
    databricksUcScriptUamiId: effHubConsoleUamiId
    storageRequireCmk: storageRequireCmk
    powerBiSku: powerBiSku
    complianceTags: complianceTags
    skipRoleGrants: skipRoleGrants
    consolePrincipalNeedsLifecycleWrite: consolePrincipalNeedsLifecycleWrite
    consolePrincipalNeedsCmkBind: consolePrincipalNeedsCmkBind
    shirAdminPassword: effShirAdminPassword
    recycleRetentionDays: recycleRetentionDays
    cosmosGraphVectorEnabled: cosmosGraphVectorEnabled
    weaveOntologyEnabled: weaveOntologyEnabled
    // RTI opt-out flags. dlz-attach: the attached DLZ provisions its own Event
    // Hubs namespace + Stream Analytics starter job (ADX DB is created at runtime
    // — see adxEnabled:false above), so only the enable flags forward.
    loomEventHubEnabled: loomEventHubEnabled
    enableStreamAnalytics: loomStreamAnalyticsEnabled
  }
}

// dlz-attach: grant the existing hub Console UAMI the constrained
// RBAC-Administrator (data-plane role assignments only) on the attached DLZ's
// storage account, so access-request approvals can grant container-scoped
// Storage Blob Data roles — same as the single-sub / multi-sub paths.
module dlzAttachAccessPolicyRbac 'modules/admin-plane/access-policy-rbac.bicep' = if (topology == 'dlz-attach') {
  name: 'dlz-attach-access-policy-rbac'
  scope: resourceGroup('rg-csa-loom-dlz-${attachDomainName}-${location}')
  params: {
    consolePrincipalId: effHubConsolePrincipalId
    storageAccountName: dlzAttach!.outputs.storageAccountName
    skipRoleGrants: skipRoleGrants
  }
}

// dlz-attach: grant the existing hub Console UAMI the org-visuals data-plane
// grants on the NEWLY-ATTACHED DLZ's storage account — Storage Blob Data
// Contributor (org-visuals container scope: upload/read/delete embed-code +
// custom-visual bundles) + Storage Blob Delegator (account scope:
// getUserDelegationKey for the read-only embed SAS). In single-sub the admin
// plane's orgVisualsRbac module already does this against the local DLZ account;
// in dlz-attach the admin plane is NOT redeployed, so without this the attached
// account's org-visuals container has no grant and Embed codes / Org visuals
// 500 on SAS minting. The matching env (LOOM_ORG_VISUALS_URL) is wired post-
// attach by the bootstrap (cross-deployment-timing constraint — admin-plane
// already deployed; mirror of the Cosmos/Weave endpoint pattern). Gated on the
// same loomOrgVisualsEnabled opt-out. The org-visuals container is created by
// the attached DLZ's storage.bicep.
module dlzAttachOrgVisualsRbac 'modules/landing-zone/org-visuals-rbac.bicep' = if (topology == 'dlz-attach' && loomOrgVisualsEnabled && !skipRoleGrants) {
  name: 'dlz-attach-org-visuals-rbac'
  scope: resourceGroup('rg-csa-loom-dlz-${attachDomainName}-${location}')
  params: {
    storageAccountName: dlzAttach!.outputs.storageAccountName
    consolePrincipalId: effHubConsolePrincipalId
    skipRoleGrants: skipRoleGrants
  }
}

// BUG 1 FIX — dlz-attach: create the REVERSE hub→DLZ VNet peering in the HUB
// VNet, in the HUB subscription. The DLZ→hub peering is made inside the DLZ VNet
// by landing-zone/network.bicep, but on a cross-sub attach the deployment runs at
// the DLZ subscription scope and never touches the hub VNet, so the peering stays
// "Initiated" and the hub console can't route to the private DLZ resources. This
// cross-sub module (scope = hub admin RG/sub) adds the missing half so the
// peering reaches "Connected". Guard reads only the dlz-attach input params
// (start-of-deployment computable — eff*/hub fold in adminPlane.outputs).
module dlzAttachHubPeering 'modules/landing-zone/hub-side-peering.bicep' = if (topology == 'dlz-attach' && dlzAttachHasHubVnet) {
  name: 'dlz-attach-hub-peering-${attachDomainName}'
  scope: resourceGroup(effHubSubscriptionId, adminPlaneRgName)
  params: {
    hubVnetName: effHubVnetName
    dlzSpokeVnetId: dlzAttach!.outputs.spokeVnetId
    domainName: attachDomainName
  }
}

// BUG 2 FIX — dlz-attach: wire the hub console's DLZ data-plane env vars
// (LOOM_ADLS_ACCOUNT / LOOM_LANDING_URL / LOOM_BRONZE_URL / LOOM_SILVER_URL /
// LOOM_GOLD_URL / LOOM_SYNAPSE_WORKSPACE) onto the ALREADY-DEPLOYED hub console.
// In single-sub these are baked into the console container app definition from
// singleDlz.outputs; in dlz-attach the admin plane / console is never redeployed,
// so without this the lakehouse/notebook/warehouse editors honest-gate on the hub
// even though the DLZ data plane is live. Runs a cross-sub deploymentScript
// (scope = hub admin RG/sub) as the hub Console UAMI doing an ADDITIVE
// `az containerapp update --set-env-vars`. The values are also emitted as outputs
// (below) so the orchestrator/bootstrap can verify or re-apply them. Guarded on
// having the hub Console UAMI resource id (start-computable param-only guard);
// on AKS boundaries (no Container App) it is skipped (the cluster GitOps path
// sets env instead) via the containerApps check.
module dlzAttachHubConsoleEnv 'modules/landing-zone/hub-console-dlz-env.bicep' = if (topology == 'dlz-attach' && containerPlatform == 'containerApps' && dlzAttachHasHubConsoleUami) {
  name: 'dlz-attach-hub-console-env-${attachDomainName}'
  scope: resourceGroup(effHubSubscriptionId, adminPlaneRgName)
  params: {
    location: location
    consoleAppName: 'loom-console'
    scriptUamiId: effHubConsoleUamiId
    dlzAdlsAccount: dlzAttach!.outputs.storageAccountName
    dlzSynapseWorkspace: loomSynapseEnabled ? dlzAttach!.outputs.synapseWorkspaceName : ''
    complianceTags: complianceTags
  }
}


// real, self-contained Azure resource into the DLZ RG when its flag is on.
// consolePrincipalId wires the Loom Console UAMI so the matching navigator
// /editor can drive the resource over Entra-only data/control planes.
// =====================================================================

var dpConsolePrincipalId = hub.consolePrincipalId

module dpPostgres 'modules/deploy-planner/postgres.bicep' = if (useSingleDlz && postgresEnabled) {
  name: 'dp-postgres'
  scope: singleDlzRg
  params: {
    location: location
    postgresVersion: postgresVersion
    storageSizeGB: postgresStorageSizeGB
    entraAdminObjectId: dpConsolePrincipalId
    entraAdminName: hub.consoleUamiName
    complianceTags: complianceTags
  }
}

module dpMysql 'modules/deploy-planner/mysql.bicep' = if (useSingleDlz && mysqlEnabled) {
  name: 'dp-mysql'
  scope: singleDlzRg
  params: {
    location: location
    mysqlVersion: mysqlVersion
    storageSizeGB: mysqlStorageSizeGB
    entraAdminObjectId: dpConsolePrincipalId
    entraAdminName: hub.consoleUamiName
    complianceTags: complianceTags
  }
}

module dpRedis 'modules/deploy-planner/redis.bicep' = if (useSingleDlz && redisEnabled) {
  name: 'dp-redis'
  scope: singleDlzRg
  params: {
    location: location
    skuName: redisSkuName
    skuFamily: redisSkuFamily
    skuCapacity: redisSkuCapacity
    consolePrincipalId: dpConsolePrincipalId
    complianceTags: complianceTags
  }
}

module dpEventGrid 'modules/deploy-planner/event-grid.bicep' = if (useSingleDlz && eventGridEnabled) {
  name: 'dp-eventgrid'
  scope: singleDlzRg
  params: {
    location: location
    consolePrincipalId: dpConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
  }
}

module dpServiceBus 'modules/deploy-planner/service-bus.bicep' = if (useSingleDlz && serviceBusEnabled) {
  name: 'dp-servicebus'
  scope: singleDlzRg
  params: {
    location: location
    skuName: serviceBusSkuName
    consolePrincipalId: dpConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
  }
}

module dpSignalr 'modules/deploy-planner/signalr.bicep' = if (useSingleDlz && signalrEnabled) {
  name: 'dp-signalr'
  scope: singleDlzRg
  params: {
    location: location
    consolePrincipalId: dpConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
  }
}

module dpStorageQueues 'modules/deploy-planner/storage-queues.bicep' = if (useSingleDlz && storageQueuesEnabled) {
  name: 'dp-storagequeues'
  scope: singleDlzRg
  params: {
    location: location
    consolePrincipalId: dpConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
  }
}

module dpAiServices 'modules/deploy-planner/cognitive-account.bicep' = if (useSingleDlz && aiServicesEnabled) {
  name: 'dp-aiservices'
  scope: singleDlzRg
  params: {
    location: location
    kind: 'CognitiveServices'
    nameFragment: 'aiservices'
    consolePrincipalId: dpConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
  }
}

module dpDocIntel 'modules/deploy-planner/cognitive-account.bicep' = if (useSingleDlz && documentIntelligenceEnabled) {
  name: 'dp-docintel'
  scope: singleDlzRg
  params: {
    location: location
    kind: 'FormRecognizer'
    nameFragment: 'docintel'
    consolePrincipalId: dpConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
  }
}

module dpContentSafety 'modules/deploy-planner/cognitive-account.bicep' = if (useSingleDlz && contentSafetyEnabled) {
  name: 'dp-contentsafety'
  scope: singleDlzRg
  params: {
    location: location
    kind: 'ContentSafety'
    nameFragment: 'contentsafety'
    consolePrincipalId: dpConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
  }
}

module dpAppService 'modules/deploy-planner/app-service.bicep' = if (useSingleDlz && appServiceEnabled) {
  name: 'dp-appservice'
  scope: singleDlzRg
  params: {
    location: location
    planSku: appServicePlanSku
    linuxFxVersion: appServiceLinuxFxVersion
    consolePrincipalId: dpConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
  }
}

module dpFunctions 'modules/deploy-planner/functions.bicep' = if (useSingleDlz && functionsEnabled) {
  name: 'dp-functions'
  scope: singleDlzRg
  params: {
    location: location
    functionsWorkerRuntime: functionsWorkerRuntime
    linuxFxVersion: functionsLinuxFxVersion
    consolePrincipalId: dpConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
  }
}

module dpContainerInstances 'modules/deploy-planner/container-instances.bicep' = if (useSingleDlz && containerInstancesEnabled) {
  name: 'dp-aci'
  scope: singleDlzRg
  params: {
    location: location
    consolePrincipalId: dpConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
  }
}

module dpStreamAnalytics 'modules/deploy-planner/stream-analytics.bicep' = if (useSingleDlz && streamAnalyticsEnabled) {
  name: 'dp-streamanalytics'
  scope: singleDlzRg
  params: {
    location: location
    startingStreamingUnits: streamAnalyticsStreamingUnits
    consolePrincipalId: dpConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
  }
}

module dpDataFactory 'modules/deploy-planner/data-factory.bicep' = if (useSingleDlz && dataFactoryEnabled) {
  name: 'dp-datafactory'
  scope: singleDlzRg
  params: {
    location: location
    consolePrincipalId: dpConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
  }
}

module dpVm 'modules/deploy-planner/virtual-machine.bicep' = if (useSingleDlz && vmEnabled) {
  name: 'dp-vm'
  scope: singleDlzRg
  params: {
    location: location
    adminSshPublicKey: vmAdminSshPublicKey
    consolePrincipalId: dpConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
  }
}

module dpBatch 'modules/deploy-planner/batch.bicep' = if (useSingleDlz && batchEnabled) {
  name: 'dp-batch'
  scope: singleDlzRg
  params: {
    location: location
    consolePrincipalId: dpConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
  }
}

module dpLogicApps 'modules/deploy-planner/logic-app.bicep' = if (useSingleDlz && logicAppsEnabled) {
  name: 'dp-logicapps'
  scope: singleDlzRg
  params: {
    location: location
    consolePrincipalId: dpConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
  }
}

module dpStaticWebApps 'modules/deploy-planner/static-web-app.bicep' = if (useSingleDlz && staticWebAppsEnabled) {
  name: 'dp-staticwebapps'
  scope: singleDlzRg
  params: {
    location: location
    consolePrincipalId: dpConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
  }
}

module dpCdn 'modules/deploy-planner/cdn.bicep' = if (useSingleDlz && cdnEnabled) {
  name: 'dp-cdn'
  scope: singleDlzRg
  params: {
    location: location
    consolePrincipalId: dpConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
  }
}

module dpLoadBalancer 'modules/deploy-planner/load-balancer.bicep' = if (useSingleDlz && loadBalancerEnabled) {
  name: 'dp-loadbalancer'
  scope: singleDlzRg
  params: {
    location: location
    consolePrincipalId: dpConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
  }
}

module dpFirewall 'modules/deploy-planner/firewall.bicep' = if (useSingleDlz && firewallEnabled) {
  name: 'dp-firewall'
  scope: singleDlzRg
  params: {
    location: location
    firewallTier: firewallTier
    consolePrincipalId: dpConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
  }
}

module dpVision 'modules/deploy-planner/cognitive-account.bicep' = if (useSingleDlz && visionServicesEnabled) {
  name: 'dp-vision'
  scope: singleDlzRg
  params: {
    location: location
    kind: 'ComputerVision'
    nameFragment: 'vision'
    consolePrincipalId: dpConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
  }
}

module dpSpeech 'modules/deploy-planner/cognitive-account.bicep' = if (useSingleDlz && speechServicesEnabled) {
  name: 'dp-speech'
  scope: singleDlzRg
  params: {
    location: location
    kind: 'SpeechServices'
    nameFragment: 'speech'
    consolePrincipalId: dpConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
  }
}

module dpLanguage 'modules/deploy-planner/cognitive-account.bicep' = if (useSingleDlz && languageServicesEnabled) {
  name: 'dp-language'
  scope: singleDlzRg
  params: {
    location: location
    kind: 'TextAnalytics'
    nameFragment: 'language'
    consolePrincipalId: dpConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
  }
}

module dpMlWorkspace 'modules/deploy-planner/ml-workspace.bicep' = if (useSingleDlz && mlWorkspaceEnabled) {
  name: 'dp-mlworkspace'
  scope: singleDlzRg
  params: {
    location: location
    consolePrincipalId: dpConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    complianceTags: complianceTags
  }
}

// Subscription-scoped deploy-planner toggles. Defender pricings + Azure Policy
// assignments are subscription resources, so these modules deploy at sub scope.
module dpDefenderCloud 'modules/deploy-planner/defender-cloud.bicep' = if (useSingleDlz && defenderCloudEnabled) {
  name: 'dp-defendercloud'
  scope: subscription()
}

module dpPolicy 'modules/deploy-planner/policy-assignment.bicep' = if (useSingleDlz && policyEnabled) {
  name: 'dp-policy'
  scope: subscription()
}

// Console UAMI → Monitoring Reader at subscription scope, so the /monitor tabs
// (metrics / activity / health / alerts) and the Activator run-history grid
// (Microsoft.AlertsManagement/alerts) read live control-plane observability.
module consoleMonitoringReaderRbac 'modules/admin-plane/monitoring-reader-rbac.bicep' = {
  name: 'console-monitoring-reader'
  scope: subscription()
  params: {
    consolePrincipalId: hub.consolePrincipalId
    skipRoleGrants: skipRoleGrants
  }
}

// Console UAMI → Cost Management Reader at subscription scope, so the
// /admin/capacity cost column (F5) + the /monitor Cost tab read live
// Microsoft.CostManagement spend per resource and the Loom-wide rollup.
module consoleCostReaderRbac 'modules/admin-plane/cost-management-reader-rbac.bicep' = {
  name: 'console-cost-management-reader'
  scope: subscription()
  params: {
    consolePrincipalId: hub.consolePrincipalId
    skipRoleGrants: skipRoleGrants
  }
}

// =====================================================================
// RTI hub cross-subscription discovery — Reader at SUBSCRIPTION scope.
//
// The Real-Time Intelligence hub catalog (/rti-hub -> GET /api/rti-hub) lists
// every Event Hub namespace, IoT Hub, and ADX cluster the Console UAMI can see
// via Azure Resource Graph. Resource Graph honors RBAC: rows are returned only
// for scopes where the principal has at least Reader. The UAMI's other grants
// are resource-group-scoped, so without a subscription-scoped Reader the graph
// query returns [] and the hub appears empty. Reader is read-only — the
// least-privilege grant that makes cross-RG discovery work.
//
// Split into its own subscription-scoped module so consolePrincipalId arrives
// as a plain start-time param (avoids BCP177/BCP120 on the roleAssignment
// name/if — same pattern as admin-plane/scaling-rbac.bicep).
// =====================================================================
module rtiHubRbac 'modules/admin-plane/rti-hub-rbac.bicep' = {
  name: 'rti-hub-rbac'
  scope: subscription()
  params: {
    consolePrincipalId: dpConsolePrincipalId
    skipRoleGrants: skipRoleGrants
  }
}

// =====================================================================
// Stream Analytics Query Tester — Console UAMI at SUBSCRIPTION scope.
//
// Authorizes the subscription/location-scoped CompileQuery / TestQuery /
// SampleInput actions the Eventstream transform builder + stream-analytics-job
// editor call to validate + test SAQL (deploy-readiness G2). The RG-scoped
// Stream Analytics Contributor grant (landing-zone/stream-analytics.bicep) does
// NOT cover these — they live above any RG. Granted by default so Compile/Run
// work on first login; skipped when ASA is opted out or skipRoleGrants is set.
// Subscription-scoped own module (dpConsolePrincipalId is a module OUTPUT →
// BCP177) — same pattern as rtiHubRbac above.
// =====================================================================
module asaQueryTesterRbac 'modules/admin-plane/asa-query-tester-rbac.bicep' = {
  name: 'asa-query-tester-rbac'
  scope: subscription()
  params: {
    consolePrincipalId: dpConsolePrincipalId
    skipRoleGrants: skipRoleGrants
    loomStreamAnalyticsEnabled: loomStreamAnalyticsEnabled
  }
}

// =====================================================================
// Setup Orchestrator deploy-auth — Contributor at SUBSCRIPTION scope.
//
// The Setup Orchestrator (setup-orchestrator.bicep) runs `az deployment sub
// create` AS the Console UAMI. To deploy a Data Landing Zone it needs
// Contributor at the TARGET subscription scope — for multi-sub rollouts that
// means Contributor on the Admin Plane (hub) sub AND every spoke sub in
// dlzSubscriptionIds. Both grants are made only when setupOrchestratorEnabled
// (the orchestrator principal arrives empty otherwise → the module no-ops).
// =====================================================================
module setupOrchestratorHubRbac 'modules/admin-plane/setup-orchestrator-rbac.bicep' = {
  name: 'setup-orchestrator-hub-rbac'
  scope: subscription()
  params: {
    orchestratorPrincipalId: setupOrchestratorEnabled ? dpConsolePrincipalId : ''
    skipRoleGrants: skipRoleGrants
  }
}

module setupOrchestratorSpokeRbac 'modules/admin-plane/setup-orchestrator-rbac.bicep' = [for (subId, i) in dlzSubscriptionIds: if (useMultiDlz && setupOrchestratorEnabled) {
  name: 'setup-orchestrator-spoke-rbac-${i}'
  scope: subscription(subId)
  params: {
    orchestratorPrincipalId: dpConsolePrincipalId
    skipRoleGrants: skipRoleGrants
  }
}]

output dlzSynapseWorkspaceName string = useSingleDlz ? singleDlz!.outputs.synapseWorkspaceName : ''
output dlzSynapseDedicatedPoolName string = useSingleDlz ? singleDlz!.outputs.synapseDedicatedPoolName : ''
output dlzResourceGroupName string = useSingleDlz ? singleDlz!.outputs.dlzResourceGroupName : ''
output dlzStorageAccountName string = useSingleDlz ? singleDlz!.outputs.storageAccountName : ''

// =====================================================================
// Outputs
//
// All hub outputs are topology-guarded: under dlz-attach the Admin Plane module
// is not deployed, so they resolve to '' (the hub already exists elsewhere).
// =====================================================================
// audit-t156 — admin-plane outputs are empty in dlz-attach (the admin plane is
// not deployed there). Guarded by deployAdminPlane via ?: so adminPlane.outputs
// is never referenced when the module is skipped.

output consoleUrl string = deployAdminPlane ? adminPlane!.outputs.consoleUrl : string(hubCoordinates.?consoleUrl ?? '')
output mcpServerUrl string = deployAdminPlane ? adminPlane!.outputs.mcpServerUrl : ''
output adminPlaneHubVnetId string = hub.hubVnetId
output adminPlaneRgName string = adminPlaneRgName

// Access-pattern outputs (empty unless their flag is on / admin plane deployed)
output vpnGatewayPublicIp string = deployAdminPlane ? adminPlane!.outputs.vpnGatewayPublicIp : ''
output appGatewayPublicFqdn string = deployAdminPlane ? adminPlane!.outputs.appGatewayPublicFqdn : ''
output frontDoorPublicUrl string = deployAdminPlane ? adminPlane!.outputs.frontDoorPublicUrl : ''
// Vanity URL + the DNS records the admin must add to activate it.
output vanityPublicUrl string = deployAdminPlane ? adminPlane!.outputs.vanityPublicUrl : ''
output vanityCnameTarget string = deployAdminPlane ? adminPlane!.outputs.vanityCnameTarget : ''
output vanityDnsTxtName string = deployAdminPlane ? adminPlane!.outputs.vanityDnsTxtName : ''
output vanityValidationToken string = deployAdminPlane ? adminPlane!.outputs.vanityValidationToken : ''

// =====================================================================
// audit-t156 — topologyManifest: what was deployed where, for the console to
// ingest (the orchestrator stores this in the Cosmos `tenant-topology` doc at
// tenant-deploy time; dlz-attach reads the hub coordinates back from it). It is
// a faithful record of the topology decision + the hub wiring + the DLZ(s) this
// deployment stood up — never aspirational (per no-vaporware.md).
// =====================================================================
output topologyManifest object = {
  topology: effectiveTopology
  deploymentMode: deploymentMode
  boundary: boundary
  location: location
  adminPlaneDeployed: deployAdminPlane
  adminPlaneSubId: adminPlaneSubId
  adminPlaneRgName: adminPlaneRgName
  landingZonesDeployed: deployLandingZones
  // Hub coordinates downstream dlz-attach deployments must echo back as params.
  hub: {
    hubVnetId: hub.hubVnetId
    lawId: hub.lawId
    appInsightsConnectionString: deployAdminPlane ? adminPlane!.outputs.appInsightsConnectionString : hub.appInsightsConnectionString
    privateDnsZoneIds: hubPrivateDnsZoneIds
    adxClusterPrincipalId: hub.adxClusterPrincipalId
    consolePrincipalId: hub.consolePrincipalId
    consoleUamiName: hub.consoleUamiName
    consoleUamiAppId: hub.consoleUamiAppId
    consoleUamiResourceId: hub.consoleUamiResourceId
    activatorPrincipalId: hub.activatorPrincipalId
    catalogEndpoint: hub.catalogEndpoint
    aiServicesAccountName: hub.aiServicesAccountName
  }
  consoleUrl: deployAdminPlane ? adminPlane!.outputs.consoleUrl : string(hubCoordinates.?consoleUrl ?? '')
  // Domain landing zones this deployment provisioned.
  dlzs: topologyManifestDlzs
}

output topology string = topology

// =====================================================================
// Tenant-topology coordinates (audit-t157)
//
// Emitted only for topology=='tenant'. The post-deploy bootstrap
// (scripts/csa-loom/write-tenant-topology.sh, invoked by
// post-deploy-bootstrap.sh) upserts these into the Cosmos `loom` DB
// `tenant-topology` doc, so a later `dlz-attach` deployment / the Setup Wizard
// "Add landing zone" flow can read the hub coordinates instead of having an
// operator free-type Azure resource ids.
// =====================================================================
output hubSubscriptionId string = subscription().subscriptionId
// Deployment coordinates the dlz-attach flow needs verbatim — emitted for every
// topology so write-tenant-topology.sh reads them directly instead of
// string-splitting adminPlaneRgName (which silently yielded '' for boundary).
output boundary string = boundary
output location string = location
output hubLawId string = topology == 'tenant' ? adminPlane!.outputs.lawId : ''
output hubAppInsightsConnectionString string = topology == 'tenant' ? adminPlane!.outputs.appInsightsConnectionString : ''
output hubPrivateDnsZoneIds object = topology == 'tenant' ? adminPlane!.outputs.privateDnsZoneIds : {}
output hubAdxClusterRgName string = topology == 'tenant' ? adminPlaneRgName : ''
output hubAdxClusterPrincipalId string = topology == 'tenant' ? adminPlane!.outputs.adxClusterPrincipalId : ''
output hubCatalogEndpoint string = topology == 'tenant' ? adminPlane!.outputs.catalogEndpoint : ''
output hubAiServicesAccountName string = topology == 'tenant' ? adminPlane!.outputs.aiServicesAccountName : ''
output hubConsolePrincipalId string = topology == 'tenant' ? adminPlane!.outputs.uamiConsolePrincipalId : ''
output hubConsoleUamiName string = topology == 'tenant' ? adminPlane!.outputs.uamiConsoleName : ''
output hubConsoleUamiAppId string = topology == 'tenant' ? adminPlane!.outputs.uamiConsoleClientId : ''
output hubConsoleUamiId string = topology == 'tenant' ? adminPlane!.outputs.uamiConsoleId : ''
output hubActivatorPrincipalId string = topology == 'tenant' ? adminPlane!.outputs.uamiActivatorPrincipalId : ''

// dlz-attach echo-back: the target sub + the hub AOAI account the post-attach
// notebook-AI (F16) RBAC grant must target on the hub side (a follow-up
// hub-scoped grant the orchestrator records). Emitting them keeps the attach
// contract self-describing for the bootstrap step.
output dlzAttachTargetSubscriptionId string = topology == 'dlz-attach' ? targetSubscriptionId : ''
output dlzAttachHubAiServicesAccountName string = topology == 'dlz-attach' ? hubAiServicesAccountName : ''

// dlz-attach echo-back: the EXACT hub-console DLZ env vars this attach wired (so
// the orchestrator can verify, or re-apply `az containerapp update --set-env-vars`
// on the hub console if the cross-sub deploymentScript was skipped/failed).
// Sourced from the hub-console env module's outputs (computed there to keep
// environment() out of the subscription-scoped main.bicep). Empty unless the
// module ran (dlz-attach + containerApps + hub Console UAMI present).
var dlzAttachConsoleEnvWired = topology == 'dlz-attach' && containerPlatform == 'containerApps' && dlzAttachHasHubConsoleUami
output dlzAttachConsoleAdlsAccount string = dlzAttachConsoleEnvWired ? dlzAttachHubConsoleEnv!.outputs.loomAdlsAccount : ''
output dlzAttachConsoleLandingUrl string = dlzAttachConsoleEnvWired ? dlzAttachHubConsoleEnv!.outputs.loomLandingUrl : ''
output dlzAttachConsoleBronzeUrl string = dlzAttachConsoleEnvWired ? dlzAttachHubConsoleEnv!.outputs.loomBronzeUrl : ''
output dlzAttachConsoleSilverUrl string = dlzAttachConsoleEnvWired ? dlzAttachHubConsoleEnv!.outputs.loomSilverUrl : ''
output dlzAttachConsoleGoldUrl string = dlzAttachConsoleEnvWired ? dlzAttachHubConsoleEnv!.outputs.loomGoldUrl : ''
output dlzAttachConsoleSynapseWorkspace string = dlzAttachConsoleEnvWired ? dlzAttachHubConsoleEnv!.outputs.loomSynapseWorkspace : ''
// dlz-attach echo-back: the hub-side peering name created in the hub VNet (so the
// orchestrator can poll for "Connected"). Empty unless the peering module ran.
output dlzAttachHubPeeringName string = (topology == 'dlz-attach' && dlzAttachHasHubVnet) ? dlzAttachHubPeering!.outputs.peeringName : ''
