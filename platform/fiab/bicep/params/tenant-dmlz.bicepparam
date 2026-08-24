// CSA Loom — FedCiv estate: TENANT (console + shared) → DMLZ subscription
// =====================================================================
// audit-t162 — multi-sub live migration, phase 1 of 2.
//
// This param file deploys ONLY the admin plane (console + shared services +
// Front Door) into the FedCiv DMLZ subscription. The bureau Data Landing
// Zones are deployed SEPARATELY against their own subscriptions with
// params/dlz-attach.bicepparam — see docs/fiab/topology-migration.md.
//
// FedCiv estate (Azure Commercial / AzureCloud):
//   • DMLZ sub  <YOUR_SUBSCRIPTION_ID>  ← THIS deploy (console+shared)
//   • DLZ  sub  <YOUR_DLZ_SUBSCRIPTION_ID>  ← bureau DLZ (dlz-attach)
//   • Main sub  <YOUR_DEMO_SUBSCRIPTION_ID>  ← optional 2nd demo domain (dlz-attach)
//   • ALZ  sub  <YOUR_CONNECTIVITY_SUBSCRIPTION_ID>  ← platform/connectivity hub + DNS
//
// Deploy (sub-scoped — the --subscription IS what lands the admin plane in DMLZ;
// main.bicep always emits the admin-plane RG, adminPlaneSubId is default-only):
//   az deployment sub create \
//     --subscription <YOUR_SUBSCRIPTION_ID> \
//     --location eastus2 \
//     -f platform/fiab/bicep/main.bicep \
//     -p platform/fiab/bicep/params/tenant-dmlz.bicepparam
//
// Modelled on commercial-full.bicepparam (FedCiv = Azure Commercial, not Gov)
// so every flag main.bicep accepts is set explicitly (no-vaporware: no freeform
// config). The dlz[] for-loop is a deliberate NO-OP here (empty arrays) so this
// deploy produces the console + shared services + Front Door and NOTHING else;
// the bureau DLZ attaches afterward via the standalone landing-zone module.

using '../main.bicep'

param environment = 'AzureCloud'
param location = 'eastus2'
param boundary = 'Commercial'

// PHASE-1 SPLIT: multi-sub mode, but the DLZ for-loop is intentionally empty.
// main.bicep ALWAYS deploys the admin plane (console + shared) regardless of
// these arrays, so an empty dlzSubscriptionIds/dlzDomainNames yields exactly
// "console + shared into DMLZ" and the bureau DLZ deploys standalone next.
param deploymentMode = 'multi-sub'
param dlzSubscriptionIds = []
param dlzDomainNames = []

// Cross-sub Setup Orchestrator. On, so the Console UAMI is granted Contributor
// on the DMLZ sub (and any spoke subs once added) — needed for the live
// cross-sub deploy/scale paths and the Setup Wizard's real ARM submit. The
// dlz[] loop being empty means no spoke-RBAC modules fire on this deploy.
param setupOrchestratorEnabled = bool(readEnvironmentVariable('LOOM_SETUP_ORCHESTRATOR_ENABLED', 'true'))
param setupTemplateUri = readEnvironmentVariable('LOOM_SETUP_TEMPLATE_URI', '')

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
param databricksAccountId = readEnvironmentVariable('LOOM_DATABRICKS_ACCOUNT_ID', '')

// Security
param defenderForAIEnabled = true
// Governance deploy-readiness (#229): Purview Data Map is ON BY DEFAULT (opt-out).
// A fresh tenant-mode hub now provisions + wires + PE-protects the classic Data
// Map account so /governance + /admin/security work on first login. Opt OUT with
// LOOM_PURVIEW_ENABLED=false, or REUSE an existing account by setting
// LOOM_PURVIEW_ACCOUNT to its short name (reuse takes precedence over provision).
// LOOM_PURVIEW_LOCATION lets you pin the account to a known-Purview region when
// the hub region lacks capacity (empty = hub location).
param purviewEnabled = bool(readEnvironmentVariable('LOOM_PURVIEW_ENABLED', 'true'))
param loomPurviewAccount = readEnvironmentVariable('LOOM_PURVIEW_ACCOUNT', '')
param purviewLocation = readEnvironmentVariable('LOOM_PURVIEW_LOCATION', '')
param loomMipEnabled = bool(readEnvironmentVariable('LOOM_MIP_ENABLED', 'true'))
param loomDlpEnabled = bool(readEnvironmentVariable('LOOM_DLP_ENABLED', 'true'))
param loomDlpAdminEnabled = bool(readEnvironmentVariable('LOOM_DLP_ADMIN_ENABLED', 'false'))
param loomIdentityPickerEnabled = bool(readEnvironmentVariable('LOOM_IDENTITY_PICKER_ENABLED', 'false'))
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

// Analytics report embed — Commercial → Power BI. Native Fluent charts always
// work; the embedded-report path honestly gates (503 + exact follow-up) until
// workspace/report ids + Console-UAMI membership are supplied post-deploy.
param loomUsageReportKind     = readEnvironmentVariable('LOOM_USAGE_REPORT_KIND', 'powerbi')
param loomUsagePbiWorkspaceId = readEnvironmentVariable('LOOM_USAGE_PBI_WORKSPACE_ID', '')
param loomUsagePbiReportId    = readEnvironmentVariable('LOOM_USAGE_PBI_REPORT_ID', '')
param loomReportKind          = readEnvironmentVariable('LOOM_REPORT_KIND', 'powerbi')
param loomGovernPbiWorkspaceId = readEnvironmentVariable('LOOM_GOVERN_PBI_WORKSPACE_ID', '')
param loomGovernPbiReportId    = readEnvironmentVariable('LOOM_GOVERN_PBI_REPORT_ID', '')
param pbiEmbeddedEnabled       = bool(readEnvironmentVariable('LOOM_PBI_EMBEDDED_ENABLED', 'false'))

// Network — DMLZ hub. Must not overlap the bureau-DLZ spoke CIDR (10.100.0.0/16)
// nor the ALZ connectivity hub. Override LOOM_HUB_VNET_CIDR if the ALZ hub owns
// a different range and this DMLZ hub peers under it.
param hubVnetCidr = readEnvironmentVariable('LOOM_HUB_VNET_CIDR', '10.0.0.0/16')

// Identity — FedCiv Loom Admins group (object id). Required: supply via env.
param adminEntraGroupId = readEnvironmentVariable('LOOM_ADMIN_ENTRA_GROUP_ID', '')

// Feature-Permissions bootstrap admin — members open /admin/* before grants
// exist. Defaults to the Loom Admins group; set LOOM_TENANT_ADMIN_OID to a
// specific user OID for a reliable single-user bootstrap.
// #3090 — read LOOM_ADMIN_ENTRA_GROUP_ID directly rather than referencing
// `adminEntraGroupId`. A paramfile reference resolves to THIS FILE's compile-
// time expression, never to a `--parameters adminEntraGroupId=…` CLI override,
// so the old form emitted an EXPLICIT '' and shut /admin/* for every user.
param loomTenantAdminGroupId = readEnvironmentVariable('LOOM_TENANT_ADMIN_GROUP_ID', readEnvironmentVariable('LOOM_ADMIN_ENTRA_GROUP_ID', ''))
param loomTenantAdminOid = readEnvironmentVariable('LOOM_TENANT_ADMIN_OID', '')

// Loom version + image tags
param loomVersion = readEnvironmentVariable('LOOM_VERSION', 'v3.0')
param appImageTags = {
  console: readEnvironmentVariable('LOOM_CONSOLE_TAG', 'v3.0')
  mcp: readEnvironmentVariable('LOOM_MCP_TAG', 'v0.7')
  orchestrator: readEnvironmentVariable('LOOM_ORCHESTRATOR_TAG', 'v0.7')
  activator: readEnvironmentVariable('LOOM_ACTIVATOR_TAG', 'v0.7')
  mirroring: readEnvironmentVariable('LOOM_MIRRORING_TAG', 'v0.7')
  directLake: readEnvironmentVariable('LOOM_DIRECTLAKE_TAG', 'v0.7')
  // ── THESE KEYS MUST BE PRESENT (measured 2026-08-06; CORRECTED 2026-08-07) ──
  // A .bicepparam object assignment REPLACES the template default, it does not
  // merge — and main.bicep forwards this bag to admin-plane VERBATIM (no union).
  // admin-plane/main.bicep reads these five with a PLAIN `.` (no `.?`), one of
  // them (mcpBridge) inside the `apps` array literal passed to appDeployments.
  //
  // SEVERITY FOR *THIS* FILE: **would abort on any apps-enabled invocation; no
  // such invocation has ever been observed.** All five derefs are gated on
  // `deployAppsEnabled` (appDeployments' condition; admin-plane L688/691/724/740),
  // and this file declares `param deployAppsEnabled = true` below — so unlike
  // commercial-full (whose every caller overrides it to false) nothing here
  // disables the app tier. But this param file has NO automated caller at all:
  // it is operator/manual-only, so the abort was never empirically observed.
  // Stated precisely because "was broken" and "would break on first use" are
  // different claims and only the second is supported (deploy-integrity R7).
  // Guarded by scripts/ci/check-appimagetags-coverage.mjs.
  mcpBridge: readEnvironmentVariable('LOOM_MCP_BRIDGE_TAG', 'v0.1')
  setupOrchestrator: readEnvironmentVariable('LOOM_SETUP_ORCHESTRATOR_TAG', 'v0.1')
  maf: readEnvironmentVariable('LOOM_MAF_TAG', 'v0.1')
  scriptRunner: readEnvironmentVariable('LOOM_SCRIPT_RUNNER_TAG', 'v0.1')
  wrangler: readEnvironmentVariable('LOOM_WRANGLER_TAG', 'v0.1')
  // loom-duckdb — deployed by default (duckdbTierActive). Same value the
  // module's `?? 'v0.1'` fallback already produced; stated explicitly so the
  // tag the template pulls is visible next to the producer that stamps it
  // (.github/workflows/full-app-deploy-commercial.yml, `tag` input default v0.1).
  duckdb: readEnvironmentVariable('LOOM_DUCKDB_TAG', 'v0.1')
  // DEFAULT-ON data-plane tier (2026-07-28). This topology runs
  // containerPlatform='containerApps' + deployAppsEnabled=true, so
  // admin-plane/main.bicep deploys loom-migrate + loom-risingwave here too and
  // pulls these tags. A .bicepparam assignment REPLACES the object, so the keys
  // have to be listed explicitly to give operators the env lever (the template
  // otherwise falls back to `?? 'v0.1'`). Both images must be in the estate's
  // ACR before an apps-enabled deploy — build with
  // build-fiab-images-acr-tasks.yml (boundary matches the estate's cloud).
  loomMigrate: readEnvironmentVariable('LOOM_MIGRATE_TAG', 'v0.1')
  risingwave: readEnvironmentVariable('LOOM_RISINGWAVE_TAG', 'v0.1')
  // loom-directlake (#3291) -- the HYP-5 Direct Lake columnar scan/frame service,
  // DEFAULT-ON via compute/loom-directlake-app.bicep. A SEPARATE key from
  // `directLake` above, which pins the loom-direct-lake-shim image: two apps,
  // two repos, one key would recreate the #2775 defect.
  directLakeSvc: readEnvironmentVariable('LOOM_DIRECTLAKE_SVC_TAG', 'v0.1')
  // loom-unity (#2681) — the Unity-Catalog-compatible OSS metastore.
  // admin-plane/main.bicep now deploys it DEFAULT-ON on every boundary (it was
  // an out-of-band standalone entrypoint before), so this image is a hard
  // prerequisite of the apps phase — a missing manifest fails the Container App
  // PUT with MANIFEST_UNKNOWN, not just the feature.
  unity: readEnvironmentVariable('LOOM_UNITY_TAG', 'v0.1')
}

// MSAL — passed from env (don't commit secrets to disk)
param loomMsalClientId = readEnvironmentVariable('LOOM_MSAL_CLIENT_ID', '')
param loomMsalClientSecret = readEnvironmentVariable('LOOM_MSAL_CLIENT_SECRET', '')
param loomSessionSecret = readEnvironmentVariable('LOOM_SESSION_SECRET', '')

// ---------- Bring-your-own existing services ----------
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
// ── #3446 — Azure Maps BYO/adopt env names, ALL THREE SPELLINGS ──────────────
// Loom's own producers disagree about what the Maps reuse env vars are called,
// and until this change the .bicepparam files read exactly ONE of the three, so
// setting either of the other two was silently inert. Measured on this tree:
//
//   apps/fiab-console/lib/deploy/adoption-catalog.ts:508
//       legacyEnv { name: 'EXISTING_AZURE_MAPS_ACCOUNT', rg: 'EXISTING_AZURE_MAPS_RG',
//                   sub: 'EXISTING_AZURE_MAPS_SUB' }            ← what params read
//   apps/fiab-console/lib/setup/scan-services.ts:205
//       envName: 'EXISTING_AZURE_MAPS'  (rg/sub DO match)        ← Setup Wizard scan
//   apps/fiab-console/app/api/setup/discover-services/route.ts:101
//       { name: 'EXISTING_MAPS', rg: 'EXISTING_MAPS_RG', sub: 'EXISTING_MAPS_SUB' }
//   scripts/csa-loom/scan-and-deploy.sh:186   (same EXISTING_MAPS triple)
//
// So the drift is not one variable: the third spelling diverges on rg and sub
// TOO, which is why bridging only the name would still bind an adopted account
// to the wrong resource group. All three are accepted here, name/rg/sub each.
//
// PARAMS-SIDE bridge on purpose: making the producers agree means editing
// scan-services.ts / discover-services/route.ts, which this change does not own.
// Accepting every spelling is strictly additive — no operator who set the
// canonical EXISTING_AZURE_MAPS_ACCOUNT sees any change — and it keeps the
// canonical literals present so check-adoption-catalog-sync.mjs's A10 check
// (catalog legacyEnv names must still be read by commercial-full.bicepparam)
// keeps passing. Precedence is canonical-first, so a tree that sets two
// spellings resolves deterministically rather than by union() ordering.
var mapsAdoptName = !empty(readEnvironmentVariable('EXISTING_AZURE_MAPS_ACCOUNT', ''))
  ? readEnvironmentVariable('EXISTING_AZURE_MAPS_ACCOUNT', '')
  : (!empty(readEnvironmentVariable('EXISTING_AZURE_MAPS', ''))
      ? readEnvironmentVariable('EXISTING_AZURE_MAPS', '')
      : readEnvironmentVariable('EXISTING_MAPS', ''))
var mapsAdoptRg = !empty(readEnvironmentVariable('EXISTING_AZURE_MAPS_RG', ''))
  ? readEnvironmentVariable('EXISTING_AZURE_MAPS_RG', '')
  : readEnvironmentVariable('EXISTING_MAPS_RG', '')
var mapsAdoptSub = !empty(readEnvironmentVariable('EXISTING_AZURE_MAPS_SUB', ''))
  ? readEnvironmentVariable('EXISTING_AZURE_MAPS_SUB', '')
  : readEnvironmentVariable('EXISTING_MAPS_SUB', '')

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
  empty(mapsAdoptName) ? {} : { maps: { mode: 'adopt', target: { name: mapsAdoptName, rg: mapsAdoptRg, sub: mapsAdoptSub } } },
  empty(readEnvironmentVariable('EXISTING_AML_WORKSPACE', '')) ? {} : { aml: { mode: 'adopt', target: { name: readEnvironmentVariable('EXISTING_AML_WORKSPACE', ''), rg: readEnvironmentVariable('EXISTING_AML_RG', ''), sub: readEnvironmentVariable('EXISTING_AML_SUB', '') } } }
)
param adopt = union(legacyAdoptFromEnv, json(readEnvironmentVariable('LOOM_ADOPT_JSON', '{}')))
// No-Fabric mode is the DEFAULT (Azure-native, per no-fabric-dependency.md).
param fabricEnabled              = (toLower(readEnvironmentVariable('FABRIC_ENABLED', 'false')) == 'true')
// <<< BYO-WIZARD END

// Feature flags — full FedCiv console surface (mirrors commercial-full).
param deployAppsEnabled = true
param aiFoundryEnabled = true
param contentSafetyEnabled = true
param agentFoundryEnabled = true
param apimEnabled = true
param hubFirewallEnabled = true
// Day-one gap-closure (audit): flip the Azure-native service toggles ON so the
// console surfaces resolve without setup gates. FedCiv = Azure Commercial, so AAS
// is available. No Fabric / Power BI dependency on any default path.
param aiSearchEnabled = true
param aasEnabled = true
param managedGrafanaEnabled = true
param eventGridEnabled = true
param reportSubscriptionsEnabled = true
param logicAppsEnabled = true
param adxEnabled = true
param cosmosGraphVectorEnabled = true
// Console's own serverless metadata Cosmos (the `loom` DB the BFF reads/writes).
// On by default; the hub module fires for this tenant topology (no local DLZ to
// host it). Serverless removes the 25-container shared-throughput cap that broke
// workspaces/domains live. Auto-skips if a BYO existingCosmosAccount is supplied.
param loomConsoleCosmosEnabled = true
// Org-visuals (Embed codes F22 + Organizational visuals F23) — ON by default
// (opt-out). In tenant/dlz-attach the LOOM_ORG_VISUALS_URL env + Storage Blob
// Delegator grant are wired post-attach by csa-loom-post-deploy-bootstrap.yml.
param loomOrgVisualsEnabled = true
param vpnGatewayEnabled = true
param appGatewayEnabled = true
param mlWorkspaceEnabled = true

// Public ingress — Front Door Premium (Commercial-GA). This is the NEW public
// endpoint the cutover step re-points the vanity domain at. Vanity domain via
// env: the deploy outputs the CNAME + _dnsauth TXT to add at DNS.
param frontDoorEnabled = true
param loomVanityDomain = readEnvironmentVariable('LOOM_VANITY_DOMAIN', '')

// Tags
param complianceTags = {
  Environment: 'FedCiv'
  CSA_Loom: 'true'
  FedRAMP_Level: 'High'
  Data_Classification: 'CUI'
  Loom_Tier: 'admin-plane'
  Loom_Estate: 'fedciv-dmlz'
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
