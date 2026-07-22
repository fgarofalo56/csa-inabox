/**
 * R30 fragment — the 'azure-services' domain slice of ENV_CHECKS (formerly part of the
 * lib/admin/env-checks.ts monolith). An env-adding item edits ONLY its own
 * domain fragment; ./index.ts merges every fragment into the same exported
 * ENV_CHECKS array (public API unchanged). Import ONLY from './core' here —
 * never './index' (barrel-cycle rule, WS-E1 gotcha).
 */
import type { EnvSpec } from './core';

export const AZURE_SERVICES_ENV_CHECKS: EnvSpec[] = [
  // ── azure services (optional workloads → warn, not fail) ──
  {
    id: 'svc-synapse', category: 'azure-services', title: 'Synapse (warehouse / notebooks / pipelines)', severity: 'recommended',
    required: ['LOOM_SYNAPSE_WORKSPACE'], warnOnMiss: true,
    remediation: 'Set LOOM_SYNAPSE_WORKSPACE (+ LOOM_SYNAPSE_DEDICATED_POOL for warehouse) to enable Synapse-backed warehouse, notebook, and pipeline items.',
    provisionedBy: 'modules/landing-zone/synapse.bicep → admin-plane forwards loomSynapseWorkspace / loomSynapseDedicatedPool',
    role: 'Synapse Administrator (UAMI) on the workspace',
  },
  {
    id: 'svc-adx', category: 'azure-services', title: 'Azure Data Explorer (KQL / Real-Time)', severity: 'recommended',
    required: ['LOOM_KUSTO_CLUSTER_URI'], warnOnMiss: true,
    remediation: 'Set LOOM_KUSTO_CLUSTER_URI (+ LOOM_KUSTO_DEFAULT_DB) to enable KQL databases, eventhouses, and Real-Time dashboards.',
    provisionedBy: 'modules/landing-zone (adxEnabled) → ADX cluster + per-DLZ DB → apps[] env',
    role: 'AllDatabasesViewer / Database Admin (UAMI) on the ADX cluster',
  },
  {
    id: 'svc-eventhubs', category: 'azure-services', title: 'Event Hubs (eventstream)', severity: 'recommended',
    required: ['LOOM_EVENTHUB_NAMESPACE'], warnOnMiss: true,
    remediation: 'Set LOOM_EVENTHUB_NAMESPACE (+ LOOM_EVENTHUB_RG/SUB) to enable the Azure-native eventstream backend.',
    provisionedBy: 'modules/landing-zone (Event Hubs namespace) → apps[] env',
    role: 'Azure Event Hubs Data Owner (UAMI) on the namespace',
  },
  {
    id: 'svc-report-subscriptions', category: 'azure-services', title: 'Report-subscription scheduled delivery', severity: 'optional',
    required: ['LOOM_REPORT_SUBSCRIPTIONS_FUNCTION', 'LOOM_SUBSCRIPTION_LOGIC_APP_NAME'], warnOnMiss: true,
    remediation: 'Scheduled report delivery needs the report-subscriptions timer Function (LOOM_REPORT_SUBSCRIPTIONS_FUNCTION) + the delivery Logic App (LOOM_SUBSCRIPTION_LOGIC_APP_NAME). Deploy admin-plane/main.bicep with reportSubscriptionsEnabled=true (report-subscriptions-function.bicep + integration/report-subscription-logicapp.bicep), then authorize the Logic App\'s Office 365 connection in the portal. Subscriptions save to Cosmos regardless and begin delivering once the Function is live. No Microsoft Fabric required.',
    provisionedBy: 'modules/admin-plane/report-subscriptions-function.bicep + modules/integration/report-subscription-logicapp.bicep (reportSubscriptionsEnabled) → apps[] env',
    role: 'Function reads Cosmos (report-subscriptions) as the Console UAMI; Logic App uses an authorized Office 365 connection to deliver',
  },
  {
    id: 'svc-adls', category: 'azure-services', title: 'ADLS Gen2 (lakehouse / Bronze)', severity: 'recommended',
    anyOf: [['LOOM_ADLS_ACCOUNT', 'LOOM_LANDING_URL', 'LOOM_BRONZE_URL']], warnOnMiss: true,
    remediation: 'Set LOOM_ADLS_ACCOUNT (or the LOOM_{LANDING,BRONZE,SILVER,GOLD}_URL DLZ container URLs) to enable the Azure-native lakehouse + mirror Bronze sink.',
    provisionedBy: 'modules/landing-zone/storage.bicep → admin-plane forwards loomStorageAccount → apps[] env',
    role: 'Storage Blob Data Contributor (UAMI) on the DLZ account',
  },
  {
    id: 'svc-aisearch', category: 'azure-services', title: 'Azure AI Search (RAG indexes)', severity: 'optional',
    required: ['LOOM_AI_SEARCH_SERVICE'], warnOnMiss: true,
    remediation: 'Set LOOM_AI_SEARCH_SERVICE to enable AI Search index items + RAG apps.',
    provisionedBy: 'modules/admin-plane (aiSearchEnabled=true) → AI Search service → apps[] env',
    role: 'Search Index Data Contributor + Search Service Contributor (UAMI)',
  },
  {
    id: 'svc-aoai', category: 'azure-services', title: 'Azure OpenAI / Foundry (Copilot + agents)', severity: 'recommended',
    anyOf: [
      ['LOOM_AOAI_ENDPOINT', 'LOOM_FOUNDRY_PROJECT_ENDPOINT', 'LOOM_FOUNDRY_ENDPOINT'],
      // The model deployment name (a Foundry project endpoint can resolve its
      // own default deployment, hence the either/or with the project endpoint).
      ['LOOM_AOAI_DEPLOYMENT', 'LOOM_FOUNDRY_PROJECT_ENDPOINT'],
    ], warnOnMiss: true,
    remediation: 'Set LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT (or a Foundry project endpoint) so Copilot, the help agent, and data agents have a model. Deploy a model from the AI Foundry hub if none exists.',
    provisionedBy: 'modules/admin-plane (agentFoundryEnabled / aiFoundryEnabled) → AIServices account + project → apps[] env',
    role: 'Cognitive Services OpenAI User (UAMI) on the AOAI/Foundry account',
    // X-MATRIX: AOAI IS in Gov (openai.azure.us via cogScope()/getOpenAiSuffix())
    // but the model/version catalog lags Commercial — 'limited', never a gate.
    availability: {
      commercial: 'ga', gccHigh: 'limited', il5: 'limited',
      fallbackNote: 'Azure OpenAI is available in Azure Government (openai.azure.us) with a reduced model catalog that lags Commercial — the tier router selects from the Gov-available deployments; verify the exact model list per deployment.',
    },
  },
  {
    // SVC-1 / SVC-8 — AI-enrichment pipeline activities (Document Intelligence,
    // Vision, Language, Translator, Content Safety). Each endpoint is a wiring
    // selector for its cognitive account; unset → honest infra gate on the AI
    // enrich canvas node + preview route (default-ON / opt-out per WAVES.md).
    id: 'svc-ai-enrich', category: 'azure-services', title: 'Azure AI enrichment (pipeline AI activities)', severity: 'optional',
    required: [
      'LOOM_DOCINTEL_ENDPOINT', 'LOOM_VISION_ENDPOINT', 'LOOM_LANGUAGE_ENDPOINT',
      'LOOM_TRANSLATOR_ENDPOINT', 'LOOM_CONTENT_SAFETY_ENDPOINT',
    ],
    warnOnMiss: true,
    // Default-ON / opt-out (loom_default_on_opt_out): each AI-enrich data-plane
    // client falls back to the SHARED multi-service Azure AI Services (Foundry)
    // account — an AIServices-kind account serves Document Intelligence, Vision,
    // Language, Translator, and Content Safety on the same cognitiveservices.*
    // host (this is the very endpoint bicep derives these per-service vars from,
    // `loomAiEnrichEndpoint`). So an UNSET per-service endpoint loses ZERO
    // function — the activities run against the shared account. The dedicated
    // single-kind accounts below are the optional scale-out. Marked
    // optionalDefault so a correct default posture is a pass, not a gap.
    optionalDefault: true,
    optionalDefaultDetail: 'the AI-enrichment activities (Document Intelligence / Vision / Language / Translator / Content Safety) run against the shared multi-service Azure AI Services (Foundry) account (LOOM_AOAI_ENDPOINT / LOOM_FOUNDRY_ENDPOINT). Set the per-service endpoints only to route to dedicated single-kind accounts.',
    remediation: 'AI-enrichment works out of the box against the shared Azure AI Services account (the same account that powers Copilot). To route a service to its OWN dedicated single-kind account, set LOOM_DOCINTEL_ENDPOINT / LOOM_VISION_ENDPOINT / LOOM_LANGUAGE_ENDPOINT / LOOM_TRANSLATOR_ENDPOINT / LOOM_CONTENT_SAFETY_ENDPOINT — each is independent, set only the ones you want to split out.',
    provisionedBy: 'platform/fiab/bicep/modules/admin-plane/main.bicep (all five derived from the agentFoundry / aiFoundry AIServices account = loomAiEnrichEndpoint, apps[] env ~4113-4129) — a fresh deploy fills them automatically; optional dedicated accounts via modules/deploy-planner/cognitive-account.bicep. Grant the Console UAMI + ADF factory MI "Cognitive Services User".',
    role: 'Cognitive Services User (Console UAMI + ADF factory managed identity) on the shared AI Services account (or each dedicated account)',
  },
  {
    id: 'svc-monitor-alerts', category: 'azure-services', title: 'Azure Monitor (Activator alerts)', severity: 'optional',
    required: ['LOOM_LOG_ANALYTICS_RESOURCE_ID'], anyOf: [['LOOM_ALERT_RG', 'LOOM_ADMIN_RG']], warnOnMiss: true,
    remediation: 'Set LOOM_LOG_ANALYTICS_RESOURCE_ID (alert query scope) + LOOM_ALERT_RG so the Azure-native Activator can create scheduled-query alert rules. A push-button deploy wires both day-one (LOOM_ALERT_RG defaults to the admin RG) and provisions a default alert set — Console availability, 5xx errors, replica restarts — plus a default action group (modules/admin-plane/monitoring-default-alerts.bicep), so /monitor Alerts shows a real default set out of the box.',
    provisionedBy: 'modules/admin-plane/main.bicep (monitoring module → apps[] env, auto-derived) + modules/admin-plane/monitoring-default-alerts.bicep (default alert rules + action group)',
    role: 'Monitoring Contributor (UAMI) on the alert resource group',
  },
  {
    id: 'svc-adf', category: 'azure-services', title: 'Azure Data Factory (mirror CDC)', severity: 'optional',
    anyOf: [['LOOM_ADF_FACTORY', 'LOOM_ADF_RG']], warnOnMiss: true,
    remediation: 'Set LOOM_ADF_FACTORY (+ LOOM_ADF_RG / LOOM_ADF_SUBSCRIPTION_ID) to enable the ADF-CDC mirrored-database backend (source SQL → ADLS Bronze).',
    provisionedBy: 'modules/landing-zone (ADF factory) → apps[] env',
    role: 'Data Factory Contributor (UAMI) on the factory',
  },
  {
    id: 'svc-posture-refresh', category: 'azure-services', title: 'Govern posture-refresh Function (on-open recompute)', severity: 'optional',
    required: ['LOOM_POSTURE_FUNCTION_URL'], warnOnMiss: true,
    remediation: 'Set LOOM_POSTURE_FUNCTION_URL to the posture-refresh Function base URL so the Govern tab recomputes data-owner posture on tab-open. Without it the Govern view still renders posture computed LIVE from Cosmos — only the on-open pre-warm is gated. The post-deploy bootstrap deploys azure-functions/posture-refresh/deploy/main.bicep, publishes the code, stores the host key in Key Vault (loom-posture-function-key → LOOM_POSTURE_FUNCTION_KEY secretRef), and sets this URL on the Console.',
    provisionedBy: 'azure-functions/posture-refresh/deploy/main.bicep → admin-plane param loomPostureFunctionUrl (apps[] env) + csa-loom-post-deploy-bootstrap "Govern posture-refresh Function" step',
    role: 'Cosmos DB Built-in Data Contributor (Function MI) on the Loom Cosmos account',
  },
  {
    id: 'purview', category: 'azure-services', title: 'Microsoft Purview (governance)', severity: 'optional',
    required: ['LOOM_PURVIEW_ACCOUNT'], warnOnMiss: true,
    remediation: 'Set LOOM_PURVIEW_ACCOUNT to link a Purview account. Domains + data-quality work Loom-native (Cosmos) without it; Purview adds the external mirror + scan plane.',
    provisionedBy: 'main.bicep (param loomPurviewAccount / purviewEnabled) → admin-plane apps[] env',
    role: 'Data Map "Data Reader" on the Purview root collection (scripts/csa-loom/grant-purview-datamap-role.sh)',
  },
  // ── usage / governance analytics embed (per-cloud, opt-in over native charts) ──
  {
    id: 'usage-embed', category: 'azure-services', title: 'Usage analytics embed (F21 — /admin/usage)', severity: 'optional',
    required: ['LOOM_USAGE_REPORT_KIND'],
    anyOf: [['LOOM_USAGE_PBI_WORKSPACE_ID', 'LOOM_USAGE_PBI_REPORT_ID', 'LOOM_GRAFANA_USAGE_DASHBOARD_UID', 'LOOM_GRAFANA_ENDPOINT']],
    warnOnMiss: true,
    remediation: 'Set LOOM_USAGE_REPORT_KIND=powerbi (Commercial/GCC) + LOOM_USAGE_PBI_WORKSPACE_ID + LOOM_USAGE_PBI_REPORT_ID, OR =grafana (GCC-High/IL5) + LOOM_GRAFANA_USAGE_DASHBOARD_UID (endpoint auto-wired from managedGrafanaEnabled). The native Fluent usage charts on /admin/usage always work without this — this only lights up the "Open analytics" embedded report.',
    docs: 'https://learn.microsoft.com/power-bi/developer/embedded/embedded-analytics-power-bi',
    provisionedBy: 'main.bicep (params loomUsageReportKind / loomUsagePbiWorkspaceId / loomUsagePbiReportId / loomGrafanaUsageDashboardUid) → modules/admin-plane/main.bicep apps[] env (lines ~2475-2490)',
    role: 'powerbi: Console UAMI = Power BI workspace Member + "Service principals can use Power BI APIs" tenant setting on. grafana: Grafana Viewer (UAMI) on the Managed Grafana instance.',
    // X-MATRIX (Grafana IL5 + Fabric/PBI): Managed Grafana is FedRAMP High GA but
    // Enterprise plugins/Essential tier are unsupported in Gov ('limited'); IL4/IL5
    // are NOT in compliance scope and Power BI embed is Fabric-family (opt-in only)
    // → 'unavailable' at IL5; the native Fluent usage charts always render.
    availability: {
      commercial: 'ga', gccHigh: 'limited', il5: 'unavailable',
      fallbackNote: 'Azure Managed Grafana is not in IL4/IL5 compliance scope and Power BI embed is Fabric-family (opt-in only, never a default path). The native Fluent usage charts on /admin/usage render regardless — for an embedded dashboard, self-host OSS Grafana in-cluster or use Loom-native dashboards over ADX (kql-dashboard-model).',
    },
  },
  {
    id: 'govern-embed', category: 'azure-services', title: 'Governance analytics embed (F2 — /governance Govern)', severity: 'optional',
    required: ['LOOM_REPORT_KIND'],
    anyOf: [['LOOM_GOVERN_PBI_WORKSPACE_ID', 'LOOM_GOVERN_PBI_REPORT_ID', 'LOOM_GRAFANA_DASHBOARD_UID']],
    warnOnMiss: true,
    remediation: 'Set LOOM_REPORT_KIND=powerbi (Commercial/GCC) + LOOM_GOVERN_PBI_WORKSPACE_ID + LOOM_GOVERN_PBI_REPORT_ID, OR =grafana (GCC-High/IL5) + LOOM_GRAFANA_DASHBOARD_UID. The native governance surface works without this — it only lights up the "View more" embedded report.',
    provisionedBy: 'main.bicep (params loomReportKind / loomGovernPbiWorkspaceId / loomGovernPbiReportId / loomGrafanaDashboardUid) → modules/admin-plane/main.bicep apps[] env (lines ~2455-2470)',
    role: 'powerbi: Console UAMI = Power BI workspace Member + "Service principals can use Power BI APIs" on. grafana: Grafana Viewer (UAMI).',
    // X-MATRIX (Grafana IL5 + Fabric/PBI) — same boundary facts as usage-embed.
    availability: {
      commercial: 'ga', gccHigh: 'limited', il5: 'unavailable',
      fallbackNote: 'Azure Managed Grafana is not in IL4/IL5 compliance scope and Power BI embed is Fabric-family (opt-in only, never a default path). The native governance surface renders regardless — for an embedded report, self-host OSS Grafana in-cluster or use Loom-native dashboards over ADX (kql-dashboard-model).',
    },
  },
  // ── derived (bicep auto-fills from another resource; operator rarely sets) ──
  {
    id: 'org-visuals', category: 'azure-services', title: 'Embed codes / Org visuals (F22/F23)', severity: 'optional',
    required: ['LOOM_ORG_VISUALS_URL'], warnOnMiss: true, derived: true,
    remediation: 'Auto-derived from the DLZ storage account (https://<account>.blob.<suffix>/org-visuals) when loomStorageAccount is known — single-sub fills it automatically. Multi-sub: set LOOM_ORG_VISUALS_URL to the org-visuals Blob container URL via scripts/csa-loom/patch-navigator-env.sh.',
    provisionedBy: 'modules/admin-plane/main.bicep line ~2360 (derived from loomStorageAccount) + landing-zone/org-visuals-rbac.bicep',
    role: 'Storage Blob Data Contributor (container) + Storage Blob Delegator (account) on the org-visuals container — landing-zone/org-visuals-rbac.bicep',
  },
  {
    id: 'audit-la-workspace', category: 'azure-services', title: 'Audit logs — Log Analytics workspace (/admin/audit-logs)', severity: 'optional',
    required: ['LOOM_LOG_ANALYTICS_WORKSPACE_ID'], warnOnMiss: true, derived: true,
    remediation: 'Auto-derived from the monitoring module (the Log Analytics workspace customerId) on a push-button deploy. If unset, /admin/audit-logs still shows Cosmos + Purview audit rows; set LOOM_LOG_ANALYTICS_WORKSPACE_ID (the workspace GUID) to add the Log Analytics source.',
    provisionedBy: 'modules/admin-plane/main.bicep line ~1780 (derived from monitoring.outputs.lawCustomerId)',
    role: 'Log Analytics Reader (UAMI) on the workspace',
  },
  {
    id: 'svc-databricks', category: 'azure-services', title: 'Azure Databricks (notebooks / SQL / Warp)', severity: 'optional',
    required: ['LOOM_DATABRICKS_HOSTNAME'], warnOnMiss: true,
    remediation: 'Set LOOM_DATABRICKS_HOSTNAME (the workspace hostname, no scheme) to enable Databricks-backed notebooks, SQL warehouses, and Warp run targets. Synapse covers the same workloads if you prefer not to deploy Databricks.',
    provisionedBy: 'modules/landing-zone (Databricks workspace) → admin-plane forwards loomDatabricksHostname → apps[] env',
    role: 'Databricks workspace access for the Console UAMI (SCIM-provisioned) + network reachability (private link / IP allowlist — see issue #1466)',
  },
  {
    id: 'svc-activator-adx-scope', category: 'azure-services', title: 'Activator — ADX continuous-evaluation scope', severity: 'optional',
    required: ['LOOM_ADX_ALERT_SCOPE'], warnOnMiss: true,
    remediation: 'Set LOOM_ADX_ALERT_SCOPE to the ADX cluster ARM resource id so Activator rules on Eventhouse/ADX sources get hands-off scheduled evaluation (an Azure Monitor scheduled-query rule scoped to the cluster), and grant the alert identity "Database Viewer" on the target database. Without it, ADX-sourced rules still evaluate on-demand via Trigger; Log Analytics sources evaluate continuously regardless.',
    provisionedBy: 'modules/admin-plane/adx-cluster.bicep (adxEnabled → the ADX cluster) → admin-plane/main.bicep apps[] env LOOM_ADX_ALERT_SCOPE (the cluster ARM id; a BYO cluster resolves via byoExisting) — auto-emitted on a push-button deploy',
    role: 'Database Viewer (alert identity) on the ADX database + Monitoring Contributor (Console UAMI) on LOOM_ALERT_RG',
  },
  {
    id: 'svc-azure-maps', category: 'azure-services', title: 'Map visuals / Geo (Azure Maps or OSS MapLibre)', severity: 'optional',
    required: ['LOOM_MAPS_BACKEND'],
    anyOf: [['LOOM_AZURE_MAPS_CLIENT_ID', 'LOOM_AZURE_MAPS_KEY', 'LOOM_MAPS_TILE_URL']],
    warnOnMiss: true,
    remediation: 'Two Azure-native/OSS paths, no Power BI / Fabric. Commercial/GCC: LOOM_MAPS_BACKEND=azure-maps + LOOM_AZURE_MAPS_CLIENT_ID (the Maps account uniqueId — Entra/AAD, PREFERRED; grant the Console UAMI "Azure Maps Data Reader") or LOOM_AZURE_MAPS_KEY (subscription key). GCC-High / sovereign (Azure Maps unavailable): LOOM_MAPS_BACKEND=maplibre + LOOM_MAPS_TILE_URL — the self-hosted OSS tileserver-gl (MapLibre GL) served in-VNet through the Console proxy; a Gov push-button deploy wires both. The aggregated location rows render without either.',
    provisionedBy: 'Commercial/GCC: modules/landing-zone/azure-maps.bicep (azureMapsEnabled → Gen2 account + "Azure Maps Data Reader" grant + mapsClientId output). GCC-High/IL5: modules/compute/loom-maps-app.bicep (tileserver-gl ACA app, internal ingress) → admin-plane emits LOOM_MAPS_BACKEND=maplibre + LOOM_MAPS_TILE_URL.',
    role: 'Azure Maps Data Reader (Console UAMI) on the Maps account (azure-maps path). The MapLibre path needs no credential — tiles are proxied in-VNet.',
    // X-MATRIX (Azure Maps): in FedRAMP High/IL4/IL5 compliance scope but with
    // account/region variance ('limited') — Loom ships the OSS MapLibre tile
    // server substitute in Gov to avoid it.
    availability: {
      commercial: 'ga', gccHigh: 'limited', il5: 'limited',
      fallbackNote: 'Azure Maps is in FedRAMP High/IL5 compliance scope with account/region variance — Gov deployments ship the self-hosted OSS MapLibre tile server instead (LOOM_MAPS_BACKEND=maplibre + LOOM_MAPS_TILE_URL, served in-VNet through the Console proxy).',
    },
  },
  {
    id: 'svc-loom-capacity-broker', category: 'azure-services', title: 'Loom Capacity Broker — LCU admission control (Hyperscale)', severity: 'optional',
    required: ['LOOM_BROKER_URL', 'LOOM_BROKER_REDIS'], warnOnMiss: true, optionalDefault: true,
    remediation: 'Set LOOM_BROKER_URL to the internal-ingress Loom Capacity Broker ACA app (synchronous POST /admit choke-point + smoothing/bursting/4-stage-throttle over an LCU timepoint ledger) and LOOM_BROKER_REDIS to <hband-redis-host>:6380 (the shared Azure Cache for Redis Premium ledger from compute/hband-shared.bicep). Deploy compute/loom-capacity-broker-app.bicep. Unset → job submission proceeds UNTHROTTLED with a MessageBar (default-ON posture — the broker constrains, it never blocks the platform if absent).',
    provisionedBy: 'modules/compute/hband-shared.bicep (uami-loom-capacity-broker + shared Redis timepoint ledger) + modules/compute/loom-capacity-broker-app.bicep (out-of-band) → LOOM_BROKER_URL / LOOM_BROKER_REDIS on the Console app',
    role: 'none (uami-loom-capacity-broker holds ZERO data-plane roles — it gates the caller, never proxies; Redis Data Contributor on the shared cache is wired by hband-shared.bicep)',
  },
  {
    // WS-10.1 LCU-Autopilot (BTB-2) — the self-driving FinOps knobs. Both are
    // fully-functional-by-default (optionalDefault): unset → the loop runs in
    // 'propose' mode (surfaces recommendations, actuates nothing) and the
    // capacity ceiling auto-derives from observed peak. Making them editable here
    // lets the autopilot ROLL LOOM_CAPACITY_LCU through env-apply (the right-size
    // actuator) and an admin bootstrap the default mode from /admin/env-config.
    id: 'svc-lcu-autopilot', category: 'azure-services', title: 'LCU-Autopilot — self-driving FinOps (idle-pause + capacity right-size)', severity: 'optional',
    required: ['LOOM_AUTOPILOT_MODE', 'LOOM_CAPACITY_LCU'], warnOnMiss: true, optionalDefault: true,
    optionalDefaultDetail: "the autopilot runs in 'propose' mode by default (LOOM_AUTOPILOT_MODE bicep default 'propose' — surfaces pause-idle/right-size recommendations with real $ impact, actuates nothing) and the LCU capacity ceiling auto-derives from observed peak + 25% headroom when LOOM_CAPACITY_LCU is unset. Set LOOM_AUTOPILOT_MODE=auto (per-tenant, from /admin/autopilot) to let it pause idle compute + roll the ceiling unattended.",
    remediation: "Set LOOM_AUTOPILOT_MODE ('auto' to let the loop actuate unattended, 'propose' to surface recommendations only — the per-tenant mode on /admin/autopilot overrides this bootstrap default) and LOOM_CAPACITY_LCU (the published LCU capacity ceiling; unset auto-derives from peak + 25% headroom). The autopilot reads real per-resource LCU + $ from the chargeback model (Cost Management Reader on the Console UAMI) and pauses idle Synapse/ADX compute via ARM. The push-button deploy wires LOOM_AUTOPILOT_MODE='propose' from admin-plane/main.bicep.",
    provisionedBy: "admin-plane/main.bicep apps[] env LOOM_AUTOPILOT_MODE (default 'propose') — LOOM_CAPACITY_LCU is a runtime tuning knob the autopilot right-sizes via env-apply",
    role: 'Cost Management Reader (Console UAMI) on the Loom subscription(s) for LCU $; the pause actuators reuse the existing Synapse/Kusto Contributor grants',
    // X-MATRIX (Cost-CSP): Cost Management + Query/Forecast REST is GA through
    // IL5, but Cost Management for CSPs and the Power BI template app are NOT
    // available in Gov ('limited', non-blocking note).
    availability: {
      commercial: 'ga', gccHigh: 'limited', il5: 'limited',
      fallbackNote: 'Cost Management (incl. the Query/Forecast REST API) is GA through IL5, but Cost Management for CSPs and the Cost Management Power BI template app are not supported in Azure Government — Loom reads the REST Query/Forecast API and renders cost/chargeback natively, never the PBI template app.',
    },
  },
  {
    // C1 (loom-next-level) — the FinOps cost-pull stack: /monitor Cost tab,
    // /admin/usage-chargeback + /admin/chargeback rollups, /admin/capacity
    // $/mo column. Default-ON per loom_default_on_opt_out: LOOM_SUBSCRIPTION_ID
    // is auto-wired by the push-button deploy AND the Cost Management Reader
    // grant is now bicep-provisioned, so cost pulls run day-one with zero
    // operator input — LOOM_BILLING_SCOPE is an optional widener only.
    id: 'svc-cost-management', category: 'azure-services', title: 'Cost Management (FinOps — cost / chargeback pulls)', severity: 'optional',
    anyOf: [['LOOM_BILLING_SCOPE', 'LOOM_SUBSCRIPTION_ID']], warnOnMiss: true,
    remediation: 'Cost pulls run per Loom subscription by default (LOOM_SUBSCRIPTION_ID — auto-wired by the push-button deploy) and the Console UAMI is granted "Cost Management Reader" at subscription scope by bicep (main.bicep console-cost-management-reader → modules/admin-plane/cost-management-reader-rbac.bicep), so cost/chargeback works day-one with no operator input. Optionally set LOOM_BILLING_SCOPE to a billing-account / enrollment / management-group scope (e.g. "/providers/Microsoft.Billing/billingAccounts/<id>") to roll the report up to a wider billing scope (required on some Gov EA/MCA enrollments).',
    provisionedBy: 'platform/fiab/bicep/main.bicep (console-cost-management-reader, skipRoleGrants-aware) → modules/admin-plane/cost-management-reader-rbac.bicep + modules/admin-plane/main.bicep apps[] env LOOM_SUBSCRIPTION_ID',
    role: 'Cost Management Reader (Console UAMI) at subscription scope — bicep-granted by cost-management-reader-rbac.bicep (role id 72fafb9e-0641-4937-9268-a91bfd8191a3, identical across Commercial / GCC-High / IL5)',
    // X-MATRIX (C1 per-cloud): Query/Forecast REST is GA in Commercial AND on
    // management.usgovcloudapi.net (GCC-High) for EA/PAYG offers — enrollment/CSP
    // scope variance is a config note, not an availability gap. IL5/air-gapped
    // enclaves cannot reach the Cost Management endpoint → CSV-export ingest
    // fallback (documented in the fallbackNote; the UI surfaces identically).
    availability: {
      commercial: 'ga', gccHigh: 'ga', il5: 'unavailable',
      fallbackNote: 'Azure Government (GCC-High): Cost Management Query/Forecast REST is GA on management.usgovcloudapi.net for EA/PAYG offers, but enrollment/CSP scope support varies — set LOOM_BILLING_SCOPE to the EA enrollment / billing-account scope when the per-subscription default returns no data. IL5/air-gapped: the Cost Management endpoint is typically unreachable — ingest the "Generate Cost Details Report" CSV export into ADLS and compute the rollups from it (the C1 cost-details-ingest design); the cost surfaces render identically from the ingested rollup.',
    },
  },
  {
    id: 'svc-databricks-sql', category: 'azure-services', title: 'Databricks SQL warehouse (DQ monitor / MDM / DLP schemas)', severity: 'optional',
    required: ['LOOM_DATABRICKS_SQL_WAREHOUSE_ID'], warnOnMiss: true,
    remediation: 'Set LOOM_DATABRICKS_SQL_WAREHOUSE_ID (with LOOM_DATABRICKS_HOSTNAME) so DQ monitoring, MDM match-merge, and governance DLP schema surfaces run against a real Databricks SQL warehouse (warehouseConfigGate). Synapse covers the warehouse item type without it.',
    provisionedBy: 'modules/landing-zone (Databricks workspace + SQL warehouse) → apps[] env',
    role: 'Databricks SQL access (Console UAMI, SCIM-provisioned)',
    // X-MATRIX (Databricks-SQL): region-limited in Azure Government ('limited',
    // non-blocking note) — Synapse dedicated SQL covers the warehouse workload.
    availability: {
      commercial: 'ga', gccHigh: 'limited', il5: 'limited',
      fallbackNote: 'Databricks SQL warehouses are region-limited in Azure Government — Synapse dedicated SQL covers the warehouse workload, and the DQ monitor / MDM engines run on the Kusto/Synapse backends by default.',
    },
  },
  {
    id: 'svc-synapse-spark-pool', category: 'azure-services', title: 'Synapse Spark pool (ML predict / scheduled runs)', severity: 'optional',
    required: ['LOOM_SYNAPSE_SPARK_POOL'], warnOnMiss: true,
    remediation: 'Set LOOM_SYNAPSE_SPARK_POOL (e.g. loompool) so ml-model predict and scheduled job run-adapters have a Spark compute target (synapse_spark_pool_not_configured).',
    provisionedBy: 'modules/landing-zone/synapse.bicep (Spark pool) → apps[] env LOOM_SYNAPSE_SPARK_POOL',
    role: 'Synapse Administrator (UAMI) on the workspace',
  },
  {
    id: 'svc-cosmos-vcore', category: 'azure-services', title: 'Cosmos DB for MongoDB vCore (vector search)', severity: 'optional',
    required: ['LOOM_COSMOS_VCORE_CONNECTION_STRING'], warnOnMiss: true,
    remediation: 'Set LOOM_COSMOS_VCORE_CONNECTION_STRING (Key Vault-sourced) to enable the Mongo vCore vector-search backend (cosmos_vcore_not_configured). AI Search covers vector workloads without it.',
    provisionedBy: 'modules/deploy-planner/cosmos-vcore.bicep → ACA secret → apps[] env',
    role: 'none (connection-string auth)',
  },
  {
    id: 'svc-eventgrid-topics', category: 'azure-services', title: 'Event Grid topics (real-time intelligence)', severity: 'optional',
    anyOf: [['LOOM_EVENTGRID_SUB', 'LOOM_SUBSCRIPTION_ID']], warnOnMiss: true,
    remediation: 'Set LOOM_EVENTGRID_SUB (falls back to LOOM_SUBSCRIPTION_ID) so the event-grid-topic editor can manage topics via ARM (eventgrid_not_configured).',
    provisionedBy: 'modules/landing-zone (Event Grid) → apps[] env',
    role: 'EventGrid Contributor (Console UAMI) on the RG',
  },
  {
    id: 'svc-webhooks-eventgrid', category: 'azure-services', title: 'Event subscriptions — Event Grid delivery', severity: 'optional',
    required: ['LOOM_EVENTGRID_TOPIC_ENDPOINT', 'LOOM_EVENTGRID_TOPIC_KEY'], warnOnMiss: true, optionalDefault: true,
    optionalDefaultDetail: 'outbound webhooks deliver via HMAC-SHA256-signed direct HTTPS by default — Event Grid is an optional alternative transport.',
    remediation: 'Webhook delivery works day-one via signed direct HTTPS. To route deliveries through Azure Event Grid instead, set LOOM_EVENTGRID_TOPIC_ENDPOINT + LOOM_EVENTGRID_TOPIC_KEY (custom topic + access key).',
    provisionedBy: 'modules/admin-plane/eventgrid-webhooks.bicep (custom topic) → apps[] env',
    role: 'none (topic key auth)',
  },
  {
    id: 'svc-iothub', category: 'azure-services', title: 'IoT Hub (iot-hub items)', severity: 'optional',
    anyOf: [['LOOM_IOTHUB_SUB', 'LOOM_SUBSCRIPTION_ID']], warnOnMiss: true,
    remediation: 'Set LOOM_IOTHUB_SUB (falls back to LOOM_SUBSCRIPTION_ID) so the IoT Hub editor can manage hubs via ARM (iothub_not_configured).',
    provisionedBy: 'modules/landing-zone (IoT Hub) → apps[] env',
    role: 'IoT Hub Data Contributor (Console UAMI)',
  },
  {
    id: 'svc-digital-twins', category: 'azure-services', title: 'Digital twins (ADX graph-twin — Azure-native default)', severity: 'optional',
    // Azure Digital Twins (ADT) is NOT available in GCC-High / IL5 / DoD, so it can
    // never be the default backing. The DEFAULT twin backend is the ADX graph-twin:
    // the Digital Twin Builder editor materializes entity/relationship types as
    // `DT_<key>_E_*` / `DT_<key>_R_*` tables on the shared Azure Data Explorer
    // cluster and explores them with the Kusto graph engine (make-graph /
    // graph-match) — every real op (materialize/query/time-series) runs against ADX
    // and is gated by LOOM_KUSTO_CLUSTER_URI (kustoConfigGate). That var is emitted
    // whenever ADX is deployed (adxEnabled=true, incl. gcc-high.bicepparam), so this
    // gate is satisfied on a Gov deploy with ZERO Azure Digital Twins dependency.
    // LOOM_ADT_ENDPOINT stays the strictly-opt-in Commercial alternate (unavailable
    // in GCC-High). Keeping both in the anyOf makes this an honest gate backed by a
    // real ADX graph-twin — no fake ADT instance — per no-fabric-dependency.md +
    // the gov 89/89 provision drive (2026-07-20). See
    // docs/fiab/gov-replacements/digital-twins-graph.md.
    anyOf: [['LOOM_ADT_ENDPOINT', 'LOOM_KUSTO_CLUSTER_URI']], warnOnMiss: true,
    remediation: 'Digital twins run on the Azure Data Explorer graph-twin (make-graph / graph-match) by DEFAULT — no Azure Digital Twins required (ADT is unavailable in GCC-High / IL5). Set LOOM_KUSTO_CLUSTER_URI to the shared ADX cluster (adxEnabled=true emits it automatically) and grant the Console UAMI Database Viewer/Ingestor so twin materialize + graph query run against ADX. Azure Digital Twins is a Commercial-only opt-in alternate (LOOM_ADT_ENDPOINT).',
    provisionedBy: 'modules/admin-plane/main.bicep (LOOM_KUSTO_CLUSTER_URI, emitted whenever adxEnabled/existingAdxClusterName — the ADX graph-twin default; + LOOM_TWIN_BACKEND=adx-graph marker); modules/integration/adt-instance.bicep → LOOM_ADT_ENDPOINT is the Commercial opt-in',
    role: 'Database Viewer/Ingestor (Console UAMI) on the ADX cluster for the default; Azure Digital Twins Data Owner only for the opt-in ADT alternate',
    // X-MATRIX (ADT): Azure Digital Twins is NOT available in GCC-High / IL5 —
    // 'unavailable' there. A configured ADX graph-twin (LOOM_KUSTO_CLUSTER_URI)
    // still satisfies the gate normally; only a MISSING check in Gov renders the
    // cloud-unavailable bar naming the ADX graph-twin default.
    availability: {
      commercial: 'ga', gccHigh: 'unavailable', il5: 'unavailable',
      fallbackNote: 'Azure Digital Twins is not available in GCC-High / IL5 — digital twins run on the Loom ADX graph-twin default (Kusto make-graph / graph-match over DT_* tables): deploy ADX (adxEnabled=true emits LOOM_KUSTO_CLUSTER_URI) and the Digital Twin Builder is fully functional with zero ADT dependency.',
    },
  },
  {
    id: 'svc-postgres-flex', category: 'azure-services', title: 'PostgreSQL Flexible Server (postgres items)', severity: 'optional',
    required: ['LOOM_POSTGRES_AAD_USER'], warnOnMiss: true,
    remediation: 'Set LOOM_POSTGRES_AAD_USER (the Entra admin login) so the postgres-flexible-server editor connects with AAD token auth (postgres_flex_not_configured).',
    provisionedBy: 'modules/deploy-planner/postgres-flexible.bicep → apps[] env',
    role: 'Entra admin (Console UAMI) on the flexible server',
  },
  {
    id: 'svc-pgvector', category: 'azure-services', title: 'pgvector (Postgres vector search)', severity: 'optional',
    required: ['LOOM_PGVECTOR_HOST'], warnOnMiss: true,
    remediation: 'Set LOOM_PGVECTOR_HOST to a Postgres Flexible Server with the pgvector extension to enable the Postgres vector backend (pgvector_not_configured). AI Search covers vector workloads without it.',
    provisionedBy: 'modules/deploy-planner/postgres-flexible.bicep (pgvector extension) → apps[] env',
    role: 'Entra AAD login (Console UAMI) on the server',
  },
  {
    id: 'svc-shir', category: 'azure-services', title: 'Self-hosted integration runtime (SHIR VMSS)', severity: 'optional',
    anyOf: [['LOOM_SHIR_VMSS_NAME', 'LOOM_PURVIEW_SHIR_VMSS_NAME']], warnOnMiss: true,
    remediation: 'Set LOOM_SHIR_VMSS_NAME (ADF/Synapse SHIR) and/or LOOM_PURVIEW_SHIR_VMSS_NAME (Purview scan SHIR) so the scale-to-0 SHIR controls can start/stop the VMSS (shir_not_configured).',
    provisionedBy: 'modules/landing-zone/shir-vmss.bicep → apps[] env',
    role: 'Virtual Machine Contributor (Console UAMI) on the VMSS RG',
  },
  {
    id: 'svc-rti-export', category: 'azure-services', title: 'Eventhouse continuous export (ADLS sink)', severity: 'optional',
    anyOf: [['LOOM_RTI_EXPORT_ADLS', 'LOOM_ADLS_ACCOUNT']], warnOnMiss: true,
    remediation: 'Set LOOM_RTI_EXPORT_ADLS (an ADLS container URL; falls back to the DLZ account) so eventhouse continuous export lands in a real lake path (rti_export_not_configured).',
    provisionedBy: 'modules/landing-zone/storage.bicep → apps[] env',
    role: 'Storage Blob Data Contributor (ADX cluster MI) on the sink container',
  },
  {
    id: 'svc-eh-schema-registry', category: 'azure-services', title: 'Event Hubs schema registry (event-schema-set)', severity: 'optional',
    required: ['LOOM_EH_SCHEMA_GROUP'], warnOnMiss: true,
    remediation: 'Set LOOM_EH_SCHEMA_GROUP (a schema group in the Event Hubs namespace) so event-schema-set items manage real registry schemas (schema_registry_not_configured).',
    provisionedBy: 'modules/landing-zone (Event Hubs namespace schema group) → apps[] env',
    role: 'Schema Registry Contributor (UAMI) on the namespace',
  },
  {
    id: 'svc-dataverse', category: 'azure-services', title: 'Dataverse (Power Platform tables)', severity: 'optional',
    required: ['LOOM_DATAVERSE_CLIENT_ID', 'LOOM_DATAVERSE_CLIENT_SECRET'], warnOnMiss: true,
    remediation: 'Set LOOM_DATAVERSE_CLIENT_ID + LOOM_DATAVERSE_CLIENT_SECRET (an S2S app registered in the Power Platform environment) so Dataverse table browsing works (dataverse_not_configured). Requires the operator-run Power Platform SP grant (scripts/csa-loom/grant-powerplatform-sp.sh).',
    provisionedBy: 'operator-run scripts/csa-loom/grant-powerplatform-sp.sh + Key Vault secret → apps[] env',
    role: 'Power Platform environment application user (S2S app)',
  },
  {
    id: 'svc-lakebase', category: 'azure-services', title: 'Lakebase (Postgres-on-lake)', severity: 'optional',
    anyOf: [['LOOM_LAKEBASE_BACKEND', 'LOOM_DATABRICKS_HOSTNAME']], warnOnMiss: true,
    remediation: 'Set LOOM_LAKEBASE_BACKEND=databricks (with LOOM_DATABRICKS_HOSTNAME) so lakebase-postgres items provision against the real Databricks Lakebase backend (lakebase_not_configured).',
    provisionedBy: 'modules/landing-zone (Databricks workspace) → apps[] env',
    role: 'Databricks workspace access (Console UAMI)',
  },
  // ── wave-3 coverage: backends with NO check at all until the coverage audit
  //    (docs/fiab/health-coverage-audit.md). Each is an honest env gate; the
  //    matching live probe (lib/admin/health-probes.ts) exercises the real call. ──
  {
    id: 'svc-aas', category: 'azure-services', title: 'Analysis Services (semantic-model fast path)', severity: 'optional',
    // The Loom-native tabular layer (LOOM_SEMANTIC_BACKEND, always emitted —
    // default 'loom-native') is the DEFAULT semantic engine and is fully
    // functional (Synapse-Serverless / loom-columnar). It satisfies this gate
    // on its own, so the semantic-model / report surfaces are never blocked by
    // the absence of a real Analysis Services server. AAS is an OPT-IN fast
    // path (Commercial/GCC only — NOT available in GCC-High / IL5 / DoD); when
    // present it is used, otherwise the Loom-native layer serves DAX-class
    // queries. Keeping LOOM_SEMANTIC_BACKEND in the anyOf makes this an honest,
    // always-satisfied gate (no fake AAS server), per no-fabric-dependency.md +
    // the gov 89/89 provision drive (2026-07-20).
    anyOf: [['LOOM_AAS_SERVER', 'LOOM_AAS_SERVER_NAME', 'LOOM_AAS_XMLA_ENDPOINT', 'LOOM_POWERBI_XMLA_ENDPOINT', 'LOOM_SEMANTIC_BACKEND']], warnOnMiss: true,
    remediation: 'The Loom-native tabular layer (LOOM_SEMANTIC_BACKEND, default "loom-native") is the DEFAULT engine and serves semantic models / reports fully — no configuration required. Azure Analysis Services is an OPTIONAL fast path (Commercial / GCC only; NOT available in GCC-High / IL5). To use it, set LOOM_AAS_SERVER (asazure://… URI) or LOOM_AAS_SERVER_NAME. No Power BI / Fabric required.',
    provisionedBy: 'modules/admin-plane/main.bicep (LOOM_SEMANTIC_BACKEND = loomSemanticBackend, always emitted — the Loom-native tabular default) + modules/admin-plane/aas.bicep (aasEnabled → the opt-in loom-aas fast-path server, Commercial/GCC only)',
    role: 'none for the Loom-native default; Analysis Services Admin (Console UAMI) on the opt-in AAS server (wired by the module)',
    // X-MATRIX (AAS): encoded per the X-MATRIX row (Commercial ✅ / GCC-High ❌ /
    // IL5 ❌ — the AAS_NOT_IN_GOV legacyCode posture the repo ships today).
    // NOTE: PRP ground-truth correction #1 says AAS IS GA in Azure Government
    // (FedRAMP High / IL4 / IL5, Learn-verified) — item A4 lifts this behind
    // verification and flips these two values to 'ga' in the same PR that
    // removes the isGovCloud() block. Until A4 lands, the structured value
    // matches the repo's actual behavior. The gate stays satisfied everywhere
    // via LOOM_SEMANTIC_BACKEND (always emitted), so this never blocks the
    // semantic-model / report surfaces.
    availability: {
      commercial: 'ga', gccHigh: 'unavailable', il5: 'unavailable',
      fallbackNote: 'Azure Analysis Services is not wired for Azure Government in this build — the Loom-native semantic layer (LOOM_SEMANTIC_BACKEND=loom-native, the default) serves semantic models and reports fully, with no AAS / Power BI / Fabric dependency.',
    },
  },
  {
    id: 'svc-aml', category: 'azure-services', title: 'Azure Machine Learning (ML models / AutoML / experiments)', severity: 'optional',
    anyOf: [['LOOM_AML_WORKSPACE', 'LOOM_FOUNDRY_NAME']], warnOnMiss: true,
    remediation: 'Set LOOM_AML_WORKSPACE (+ LOOM_AML_RESOURCE_GROUP; falls back to the AI Foundry hub via LOOM_FOUNDRY_NAME/LOOM_FOUNDRY_RG) so ml-model / ml-experiment / AutoML items have a workspace. The Data Science item family is gated on this.',
    provisionedBy: 'modules/admin-plane (aiFoundryEnabled → hub workspace) or a dedicated AML workspace → apps[] env (resolve-aml-target.ts)',
    role: 'AzureML Data Scientist + Contributor (Console UAMI) on the workspace',
  },
  {
    // WS-1.2 — Model Serving as a first-class item. The Azure-native DEFAULT
    // backend is Azure ML managed online endpoints (works in Gov *.api.ml.azure.us);
    // Databricks Mosaic AI Model Serving is the opt-in alternative selected via
    // LOOM_MODEL_SERVING_BACKEND=databricks + LOOM_DATABRICKS_HOSTNAME. The gate is
    // satisfied when ANY serving backend is addressable (or the operator has picked
    // one via the selector); the per-request servingConfigGate() gates precisely.
    // LOOM_MODEL_SERVING_BACKEND is the only NEW editable var here (the workspace /
    // hostname keys are shared with svc-aml / svc-databricks). No Fabric.
    id: 'svc-model-serving', category: 'azure-services', title: 'Model serving endpoints (Azure ML online endpoints / Databricks Mosaic)', severity: 'optional',
    anyOf: [['LOOM_AML_WORKSPACE', 'LOOM_FOUNDRY_NAME', 'LOOM_DATABRICKS_HOSTNAME', 'LOOM_MODEL_SERVING_BACKEND']], warnOnMiss: true,
    remediation: 'Model-serving endpoints run on Azure ML managed online endpoints by DEFAULT — set LOOM_AML_WORKSPACE (or rely on the AI Foundry hub via LOOM_FOUNDRY_NAME) and grant the Console UAMI "AzureML Data Scientist" on the workspace. To use Databricks Mosaic AI Model Serving instead, set LOOM_MODEL_SERVING_BACKEND=databricks + LOOM_DATABRICKS_HOSTNAME. No Microsoft Fabric required.',
    provisionedBy: 'modules/admin-plane (aiFoundryEnabled → AML/Foundry workspace) → apps[] env (LOOM_AML_WORKSPACE); LOOM_MODEL_SERVING_BACKEND selector defaults to the Azure ML path',
    role: 'AzureML Data Scientist + onlineEndpoints/listkeys/action (Console UAMI) on the AML workspace, OR Databricks serving access (SCIM) for the opt-in path',
    docs: 'https://learn.microsoft.com/azure/machine-learning/concept-endpoints-online',
  },
  {
    // WS-1.3 — LLM fine-tuning (fine-tuning-job item). The Azure-native DEFAULT is
    // Azure OpenAI in Azure AI Foundry fine-tuning, reached on the AOAI account
    // resolved by foundry-cs-client (LOOM_AOAI_ACCOUNT → LOOM_FOUNDRY_NAME →
    // discovery in LOOM_FOUNDRY_RG; Gov-correct *.openai.azure.us). Databricks
    // Mosaic AI fine-tuning is the opt-in alternative via LOOM_FINETUNE_BACKEND=
    // databricks. The gate is satisfied when an AOAI account is addressable (or a
    // backend is picked); the per-request fineTuneConfigGate() gates precisely.
    // LOOM_FINETUNE_BACKEND + LOOM_AOAI_ACCOUNT are the NEW editable vars here
    // (LOOM_AOAI_ENDPOINT / LOOM_FOUNDRY_NAME are shared with svc-aoai / svc-aml).
    // No Fabric.
    id: 'svc-fine-tuning', category: 'azure-services', title: 'LLM fine-tuning (Azure OpenAI / AI Foundry fine-tuning; Databricks Mosaic opt-in)', severity: 'optional',
    anyOf: [['LOOM_AOAI_ACCOUNT', 'LOOM_AOAI_ENDPOINT', 'LOOM_FOUNDRY_NAME', 'LOOM_FINETUNE_BACKEND']], warnOnMiss: true,
    remediation: 'Fine-tuning runs on Azure OpenAI in Azure AI Foundry by DEFAULT — ensure an AIServices/OpenAI account is resolvable (set LOOM_AOAI_ACCOUNT, or rely on the AI Foundry hub via LOOM_FOUNDRY_NAME / discovery in LOOM_FOUNDRY_RG) and grant the Console UAMI "Cognitive Services OpenAI Contributor" on it. To use Databricks Mosaic AI fine-tuning instead, set LOOM_FINETUNE_BACKEND=databricks + LOOM_DATABRICKS_HOSTNAME. No Microsoft Fabric required.',
    provisionedBy: 'modules/admin-plane/ai-foundry.bicep (AIServices/OpenAI account) → apps[] env (LOOM_AOAI_ACCOUNT / LOOM_FOUNDRY_NAME); LOOM_FINETUNE_BACKEND selector defaults to the Azure OpenAI path',
    role: 'Cognitive Services OpenAI Contributor (Console UAMI) on the AOAI account for fine-tuning + model deployment; Azure Content Safety access for the resulting-model safety-eval',
    docs: 'https://learn.microsoft.com/azure/ai-foundry/openai/how-to/fine-tuning',
  },
  {
    // WS-2.1 — Feature Store (feature-table item). Offline authoring + point-in-
    // time joins run on the Azure-native DEFAULT: Unity Catalog feature tables
    // (Databricks) on Commercial, or OSS-UC + Azure Database for PostgreSQL on the
    // sovereign / Gov path (LOOM_FEATURE_STORE_BACKEND=postgres). Online serving
    // (feature-lookup-at-inference) uses Lakebase/pgvector. The gate is satisfied
    // when ANY backend is addressable (or the operator picked one via the
    // selector); the per-request featureStoreConfigGate() / onlineStoreGate() gate
    // precisely. LOOM_FEATURE_STORE_BACKEND is the only NEW editable var here (the
    // hostname / pgvector keys are shared with svc-databricks / svc-postgres). No Fabric.
    id: 'svc-feature-store', category: 'azure-services', title: 'Feature Store (UC feature tables + pgvector online serving)', severity: 'optional',
    anyOf: [['LOOM_FEATURE_STORE_BACKEND', 'LOOM_DATABRICKS_HOSTNAME', 'LOOM_PGVECTOR_HOST']], warnOnMiss: true,
    remediation: 'Feature tables author on the Azure-native offline backend by DEFAULT — Unity Catalog (set LOOM_DATABRICKS_HOSTNAME) on Commercial, or set LOOM_FEATURE_STORE_BACKEND=postgres for the sovereign OSS-UC + Azure Database for PostgreSQL path (Gov). Online serving (feature-lookup-at-inference) uses Lakebase/pgvector — set LOOM_PGVECTOR_HOST + LOOM_POSTGRES_AAD_USER. No Microsoft Fabric required.',
    provisionedBy: 'modules/landing-zone (Databricks UC + postgres-flex) → apps[] env (LOOM_DATABRICKS_HOSTNAME / LOOM_PGVECTOR_HOST); LOOM_FEATURE_STORE_BACKEND selector defaults to the Unity Catalog path',
    role: 'Unity Catalog USE CATALOG/SCHEMA + CREATE TABLE (Console UAMI on the metastore) for the offline store; AAD principal on the PostgreSQL server for the online store',
    docs: 'https://learn.microsoft.com/azure/databricks/machine-learning/feature-store/',
  },
  {
    id: 'svc-powerplatform', category: 'azure-services', title: 'Power Platform control plane (power-* items / Copilot Studio)', severity: 'optional',
    required: ['LOOM_UAMI_CLIENT_ID'], warnOnMiss: true,
    remediation: 'The Power Platform BAP API authenticates as the Console UAMI (LOOM_UAMI_CLIENT_ID) — a Power Platform admin must also register it as a management app (New-PowerAppManagementApp; scripts/csa-loom/grant-powerplatform-sp.ps1). The live probe surfaces the known SP-not-allowed 403 with the exact one-time fix.',
    provisionedBy: 'modules/admin-plane/main.bicep (uami-console → apps[] env) + operator-run PP management-app registration',
    role: 'Power Platform management application (tenant admin registration) + Environment Admin where environments are managed',
  },
  {
    id: 'svc-servicebus', category: 'azure-services', title: 'Service Bus (queues / topics — business events)', severity: 'optional',
    required: ['LOOM_SERVICEBUS_NAMESPACE'], warnOnMiss: true,
    remediation: 'Set LOOM_SERVICEBUS_NAMESPACE (+ LOOM_SERVICEBUS_RG) to enable Service Bus queue/topic business-event routing. Event Grid / Event Hubs paths work without it.',
    provisionedBy: 'modules/landing-zone (Service Bus namespace) → apps[] env LOOM_SERVICEBUS_NAMESPACE',
    role: 'Azure Service Bus Data Owner (Console UAMI) on the namespace',
  },
  {
    id: 'svc-stream-analytics', category: 'azure-services', title: 'Stream Analytics (eventstream processing jobs)', severity: 'optional',
    anyOf: [['LOOM_ASA_RG', 'LOOM_DLZ_RG']], warnOnMiss: true,
    remediation: 'Set LOOM_ASA_RG (falls back to LOOM_DLZ_RG) so eventstream processing deploys real Stream Analytics jobs. Grant the Console UAMI Contributor on that RG.',
    provisionedBy: 'modules/landing-zone (DLZ RG) → apps[] env; ASA jobs are created on demand by the eventstream provisioner',
    role: 'Contributor (Console UAMI) on the Stream Analytics resource group',
  },
  {
    id: 'svc-azure-sql', category: 'azure-services', title: 'Azure SQL (SQL database items / mirroring source ops)', severity: 'optional',
    anyOf: [['LOOM_AZURE_SQL_DEFAULT_SERVER', 'LOOM_SUBSCRIPTION_ID']], warnOnMiss: true,
    remediation: 'Azure SQL item creates provision via ARM under LOOM_SUBSCRIPTION_ID; set LOOM_AZURE_SQL_DEFAULT_SERVER to bind existing-database flows to a default logical server. The Console UAMI needs an AAD login on target servers for data-plane ops (mirroring change-feed DDL).',
    provisionedBy: 'modules/deploy-planner/azure-sql.bicep (on-demand) → per-item state; default server via apps[] env',
    role: 'SQL Server Contributor (ARM) + AAD login with db_owner on managed databases (Console UAMI)',
  },
  {
    id: 'svc-postgres', category: 'azure-services', title: 'PostgreSQL Flexible Server (Lakebase / pgvector)', severity: 'optional',
    anyOf: [['LOOM_POSTGRES_HOST', 'LOOM_PGVECTOR_HOST']], warnOnMiss: true,
    remediation: 'Set LOOM_POSTGRES_HOST (Lakebase Postgres) and/or LOOM_PGVECTOR_HOST (vector store) with LOOM_POSTGRES_AAD_USER so lakebase-postgres items and the pgvector backend connect. AAD token auth — no password.',
    provisionedBy: 'modules/landing-zone/postgres-flex.bicep (postgresEnabled) → apps[] env LOOM_POSTGRES_HOST / LOOM_POSTGRES_AAD_USER',
    role: 'AAD administrator-created role for the Console UAMI on the server (azure_ad_user)',
  },
  {
    id: 'svc-eventgrid', category: 'azure-services', title: 'Event Grid (business-events topics / shims)', severity: 'optional',
    anyOf: [['LOOM_EVENTGRID_BUSINESS_TOPIC', 'LOOM_EVENTGRID_RG', 'LOOM_DLZ_RG']], warnOnMiss: true,
    remediation: 'Set LOOM_EVENTGRID_BUSINESS_TOPIC (custom topic for business events; RG falls back to LOOM_DLZ_RG). Grant the Console UAMI "EventGrid Contributor" on the RG and "EventGrid Data Sender" on the topic.',
    provisionedBy: 'modules/landing-zone (Event Grid custom topic) → apps[] env LOOM_EVENTGRID_BUSINESS_TOPIC',
    role: 'EventGrid Contributor (RG) + EventGrid Data Sender (topic) — Console UAMI',
  },
  {
    id: 'svc-batch', category: 'azure-services', title: 'Azure Batch (batch-pool compute items)', severity: 'optional',
    required: ['LOOM_BATCH_ACCOUNT'], warnOnMiss: true,
    remediation: 'Set LOOM_BATCH_ACCOUNT (+ LOOM_BATCH_RG) so batch-pool items manage real Azure Batch pools. Grant the Console UAMI Contributor on the Batch account.',
    provisionedBy: 'modules/landing-zone (batchEnabled → Batch account) → apps[] env LOOM_BATCH_ACCOUNT',
    role: 'Contributor (Console UAMI) on the Batch account',
  },
];
