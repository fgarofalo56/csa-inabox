/**
 * R30 fragment — the 'azure-services' domain slice of GATE_META (formerly part of the
 * lib/gates/registry.ts monolith; entries sit in the same domain as their
 * ENV_CHECKS spec in lib/admin/env-checks/azure-services.ts). ./index.ts merges every
 * fragment into the same exported GATE_META shape (public API unchanged).
 * Import ONLY from './types' here — never './index' (barrel-cycle rule).
 */
import { L, type GateMeta } from './types';

export const AZURE_SERVICES_GATE_META: Record<string, GateMeta> = {
  // ── azure services ──
  'svc-synapse': {
    surfaces: [
      { path: '/items/warehouse', label: 'Warehouse editor' },
      { path: '/items/notebook', label: 'Notebooks (Synapse Spark)' },
      { path: '/items/data-pipeline', label: 'Pipelines' },
      { path: '/api/items/warehouse/*', label: 'Warehouse BFF routes' },
    ],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_SYNAPSE_WORKSPACE: L.synapse },
    legacyCodes: ['synapse_not_configured', 'not_configured:LOOM_SYNAPSE_WORKSPACE'],
  },
  'svc-adx': {
    surfaces: [
      { path: '/items/kql-database', label: 'KQL database editor' },
      { path: '/items/eventhouse', label: 'Eventhouse editor' },
      { path: '/items/kql-dashboard', label: 'Real-Time dashboards' },
      { path: '/items/graph', label: 'Graph (ADX Kusto graph)' },
    ],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_KUSTO_CLUSTER_URI: L.adxUri },
    legacyCodes: ['kusto_not_configured', 'adx_not_configured'],
  },
  'svc-eventhubs': {
    surfaces: [
      { path: '/items/eventstream', label: 'Eventstream editor' },
      { path: '/api/items/eventstream/*', label: 'Eventstream BFF routes' },
    ],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_EVENTHUB_NAMESPACE: L.eventhubs },
    legacyCodes: ['eventhubs_not_configured'],
  },
  'svc-adls': {
    surfaces: [
      { path: '/items/lakehouse', label: 'Lakehouse editor' },
      { path: '/onelake', label: 'OneLake catalog' },
      { path: '/api/onelake/*', label: 'OneLake storage routes' },
    ],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_ADLS_ACCOUNT: L.storage },
    legacyCodes: ['adls_not_configured'],
  },
  'svc-aisearch': {
    surfaces: [
      { path: '/items/ai-search-index', label: 'AI Search index editor' },
      { path: '/api/search/*', label: 'RAG index routes' },
    ],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_AI_SEARCH_SERVICE: L.aisearch },
    legacyCodes: ['ai_search_not_configured', 'search_not_configured'],
  },
  'svc-aoai': {
    surfaces: [
      { path: '/copilot', label: 'Copilot console' },
      { path: '/learn', label: 'Learning Hub help agent' },
      { path: '/api/copilot/*', label: 'Copilot orchestrate/complete routes' },
      { path: '/items/report', label: 'Report Copilot' },
      { path: '/items/notebook', label: 'Notebook assist' },
    ],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_AOAI_ENDPOINT: L.aoaiEndpoint, LOOM_AOAI_DEPLOYMENT: L.aoaiDeployment },
    legacyCodes: ['no_aoai', 'aoai_not_configured'],
  },
  'svc-ai-enrich': {
    surfaces: [
      { path: '/items/data-pipeline', label: 'AI enrichment pipeline activities' },
      { path: '/api/enrich/*', label: 'AI enrich preview routes' },
    ],
    fixit: { kind: 'env-picker' },
    autoResolveNote: 'Falls back to the shared multi-service Azure AI Services (Foundry) account — fully functional with zero per-service endpoints set.',
  },
  'svc-monitor-alerts': {
    surfaces: [
      { path: '/items/activator', label: 'Activator (alert rules)' },
      { path: '/monitor', label: 'Monitor hub — Alerts' },
    ],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_LOG_ANALYTICS_RESOURCE_ID: L.law },
    legacyCodes: ['monitor_not_configured'],
  },
  'svc-adf': {
    surfaces: [
      { path: '/items/mirrored-database', label: 'Mirrored database (ADF CDC)' },
      { path: '/api/adf/*', label: 'ADF CDC routes' },
    ],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_ADF_FACTORY: L.adf },
    legacyCodes: ['adf_not_configured', 'not_configured:LOOM_ADF_FACTORY'],
  },
  'svc-posture-refresh': {
    surfaces: [{ path: '/governance', label: 'Govern tab (posture pre-warm)' }],
    fixit: { kind: 'env-picker' },
  },
  purview: {
    surfaces: [
      { path: '/governance/catalog', label: 'Unified catalog (Purview mirror)' },
      { path: '/governance/scans', label: 'Scans & sources' },
      { path: '/admin/security', label: 'Security & governance' },
    ],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_PURVIEW_ACCOUNT: L.purview },
    legacyCodes: ['purview_not_configured'],
  },
  'usage-embed': {
    surfaces: [{ path: '/admin/usage', label: 'Usage analytics — embedded report' }],
    fixit: { kind: 'wizard' },
    loaders: { LOOM_GRAFANA_ENDPOINT: L.grafana },
  },
  'govern-embed': {
    surfaces: [{ path: '/governance', label: 'Governance analytics — embedded report' }],
    fixit: { kind: 'wizard' },
  },
  'org-visuals': {
    surfaces: [{ path: '/admin/org-visuals', label: 'Organizational visuals' }, { path: '/admin/embed-codes', label: 'Embed codes' }],
    fixit: { kind: 'env-picker' },
    autoResolveNote: 'Auto-derived by bicep from the DLZ storage account on a push-button deploy.',
  },
  'audit-la-workspace': {
    surfaces: [{ path: '/admin/audit-logs', label: 'Audit logs — Log Analytics source' }],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_LOG_ANALYTICS_WORKSPACE_ID: L.lawCustomerId },
    autoResolveNote: 'Auto-derived from the monitoring module (LAW customerId) on a push-button deploy.',
  },
  'svc-databricks': {
    surfaces: [
      { path: '/items/notebook', label: 'Notebooks (Databricks backend)' },
      { path: '/items/sql-warehouse', label: 'Databricks SQL' },
      { path: '/admin/domains', label: 'Unity Catalog mirror' },
    ],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_DATABRICKS_HOSTNAME: L.databricks },
    legacyCodes: ['databricks_not_configured', 'not_configured:LOOM_DATABRICKS_HOSTNAME'],
  },
  'svc-activator-adx-scope': {
    surfaces: [{ path: '/items/activator', label: 'Activator — ADX continuous evaluation' }],
    fixit: { kind: 'env-picker' },
  },
  'svc-lcu-autopilot': {
    surfaces: [{ path: '/admin/autopilot', label: 'LCU-Autopilot (self-driving FinOps)' }],
    fixit: { kind: 'env-picker' },
    autoResolveNote: "Unset → the autopilot runs in 'propose' mode and the LCU ceiling auto-derives from peak; both are fully-functional defaults, not a gap.",
  },
  // C1 — the FinOps cost-pull stack. The role is the real gap (env is
  // auto-wired): Fix-it 'role-grant' with the bicep-granted Cost Management
  // Reader; LOOM_BILLING_SCOPE stays a free-text setting (billing-account /
  // enrollment scopes are tenant-level Microsoft.Billing paths, NOT
  // subscription-ARM enumerable, so no resource loader exists for it).
  'svc-cost-management': {
    surfaces: [
      { path: '/monitor', label: 'Monitor hub — Cost tab' },
      { path: '/admin/usage-chargeback', label: 'Usage & chargeback (FinOps)' },
      { path: '/admin/capacity', label: 'Capacity — $/mo cost column' },
    ],
    fixit: {
      kind: 'role-grant',
      grantNote: 'Grant the Console UAMI "Cost Management Reader" at subscription scope. The push-button deploy grants it automatically (main.bicep console-cost-management-reader → modules/admin-plane/cost-management-reader-rbac.bicep); on an existing estate re-run the deploy with skipRoleGrants=false or run the pre-filled az script. For a billing-account / EA-enrollment rollup, set LOOM_BILLING_SCOPE to the Microsoft.Billing scope path (free-text — billing scopes are not subscription-ARM enumerable).',
    },
    legacyCodes: ['cost_query_failed'],
    autoResolveNote: 'A push-button deploy auto-wires LOOM_SUBSCRIPTION_ID AND bicep-grants Cost Management Reader — cost/chargeback is default-ON with zero operator input; LOOM_BILLING_SCOPE only widens the rollup scope.',
  },
  'svc-azure-maps': {
    surfaces: [
      { path: '/items/report', label: 'Report Map visual' },
      { path: '/items/graph', label: 'Geo map canvases' },
    ],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_AZURE_MAPS_CLIENT_ID: L.maps },
    legacyCodes: ['maps_not_configured'],
  },
  'svc-loom-capacity-broker': {
    surfaces: [{ path: '/admin/usage-chargeback', label: 'LCU admission control (scale-out)' }],
    fixit: { kind: 'env-picker' },
    autoResolveNote: 'Unset → job submission proceeds unthrottled (the broker constrains, it never blocks the platform).',
  },
  // ── wave-3 (G2): the promoted bespoke gates ──
  'svc-aas': {
    surfaces: [
      { path: '/items/semantic-model', label: 'Semantic model — AAS fast path' },
      { path: '/items/report', label: 'Report DAX (AAS)' },
    ],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_AAS_SERVER: L.aas },
    autoResolveNote: 'The Loom-native tabular layer (LOOM_SEMANTIC_BACKEND=loom-native, always emitted) is the default engine and satisfies this gate — semantic models / reports work with zero config. Azure Analysis Services is an OPT-IN fast path (Commercial/GCC only; unavailable in GCC-High / IL5). Fix-it only applies where AAS exists.',
    legacyCodes: ['aas_not_configured', 'AAS_NOT_IN_GOV', 'xmla_not_configured'],
  },
  'svc-aml': {
    surfaces: [
      { path: '/items/automl', label: 'AutoML editor' },
      { path: '/items/ml-model', label: 'ML model train/deploy' },
    ],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_AML_WORKSPACE: L.aml },
    legacyCodes: ['aml_not_configured', 'automl_not_configured'],
  },
  'svc-model-serving': {
    surfaces: [
      { path: '/items/model-serving-endpoint', label: 'Model serving endpoint editor' },
      { path: '/api/items/model-serving-endpoint/*', label: 'Model serving BFF routes' },
    ],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_AML_WORKSPACE: L.aml, LOOM_DATABRICKS_HOSTNAME: L.databricks },
    autoResolveNote: 'A push-button deploy wires the Azure ML / Foundry workspace (LOOM_AML_WORKSPACE), so serving works day-one on the Azure-native path. Databricks Mosaic serving is opt-in via LOOM_MODEL_SERVING_BACKEND=databricks + LOOM_DATABRICKS_HOSTNAME.',
    legacyCodes: ['model_serving_not_configured'],
  },
  'svc-fine-tuning': {
    surfaces: [
      { path: '/items/fine-tuning-job', label: 'Fine-tuning job editor' },
      { path: '/api/items/fine-tuning-job/*', label: 'Fine-tuning BFF routes' },
    ],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_AOAI_ACCOUNT: L.aoaiAccount, LOOM_AOAI_ENDPOINT: L.aoaiEndpoint },
    autoResolveNote: 'A push-button deploy provisions the AI Foundry AIServices/OpenAI account (LOOM_AOAI_ACCOUNT / LOOM_FOUNDRY_NAME), so Azure OpenAI fine-tuning works day-one on the Azure-native path. Databricks Mosaic AI fine-tuning is opt-in via LOOM_FINETUNE_BACKEND=databricks + LOOM_DATABRICKS_HOSTNAME.',
    legacyCodes: ['fine_tuning_not_configured'],
  },
  'svc-feature-store': {
    surfaces: [
      { path: '/items/feature-table', label: 'Feature table editor' },
      { path: '/api/items/feature-table/*', label: 'Feature Store BFF routes' },
    ],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_DATABRICKS_HOSTNAME: L.databricks, LOOM_PGVECTOR_HOST: L.pgFqdn },
    autoResolveNote: 'Feature tables author on the Azure-native offline backend by DEFAULT — Unity Catalog (LOOM_DATABRICKS_HOSTNAME) on Commercial, or set LOOM_FEATURE_STORE_BACKEND=postgres for the sovereign OSS-UC + Azure Database for PostgreSQL path (Gov). Online serving (feature-lookup-at-inference) uses Lakebase/pgvector (LOOM_PGVECTOR_HOST + LOOM_POSTGRES_AAD_USER). No Microsoft Fabric required.',
    legacyCodes: ['feature_store_not_configured'],
  },
  'svc-databricks-sql': {
    // Databricks SQL Warehouses do NOT exist in Azure Government (MS Learn:
    // "Databricks SQL is not available in Azure Government regions"). This is an
    // opt-in backend only — the DQ monitor + MDM surfaces run on a multi-backend
    // engine (kusto default / synapse), so the capability is fully present in
    // Gov without it. In GCC-High this gate stays optional + unmet by design.
    surfaces: [
      { path: '/governance/data-quality', label: 'DQ monitor' },
      { path: '/governance/mdm', label: 'MDM match-merge' },
    ],
    fixit: { kind: 'env-picker' },
    legacyCodes: ['warehouse_not_configured', 'dq_monitor_not_configured', 'mdm_not_configured'],
  },
  'svc-synapse-spark-pool': {
    surfaces: [
      { path: '/items/ml-model', label: 'ML model predict' },
      { path: '/scheduler', label: 'Scheduled job run adapters' },
    ],
    fixit: { kind: 'env-picker' },
    legacyCodes: ['synapse_spark_pool_not_configured', 'spark_not_configured', 'run_adapters_not_configured'],
  },
  'svc-cosmos-vcore': {
    surfaces: [{ path: '/items/ai-search-index', label: 'Mongo vCore vector search' }],
    fixit: { kind: 'env-picker' },
    legacyCodes: ['cosmos_vcore_not_configured'],
  },
  'svc-eventgrid-topics': {
    surfaces: [{ path: '/items/event-grid-topic', label: 'Event Grid topic editor' }],
    fixit: { kind: 'env-picker' },
    legacyCodes: ['eventgrid_not_configured'],
  },
  'svc-webhooks-eventgrid': {
    surfaces: [{ path: '/admin/webhooks', label: 'Event subscriptions (EG transport)' }],
    fixit: { kind: 'env-picker' },
    autoResolveNote: 'Webhooks deliver via HMAC-signed direct HTTPS by default — Event Grid is an optional alternative transport.',
  },
  'svc-report-subscriptions': {
    // WS-C2: scheduled report-subscription delivery. The Subscriptions panel
    // saves to Cosmos regardless; actual scheduled delivery needs the timer
    // Function + Logic App. Registered here so the honest delivery gate is
    // discoverable on the Admin gate page with a Fix-it (G2).
    surfaces: [{ path: '/items/report', label: 'Report → Subscriptions (scheduled delivery)' }],
    fixit: { kind: 'env-picker' },
    autoResolveNote: 'Subscriptions you save are stored in Cosmos and begin delivering automatically once the report-subscriptions Function + Logic App are deployed (reportSubscriptionsEnabled=true). No Fabric required.',
    legacyCodes: ['report_subscription_delivery_not_configured', 'subscription_delivery_not_configured'],
  },
  'svc-servicebus': {
    surfaces: [{ path: '/items/service-bus-namespace', label: 'Service Bus namespace editor' }],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_SERVICEBUS_NAMESPACE: L.servicebus },
    legacyCodes: ['servicebus_not_configured'],
  },
  'svc-iothub': {
    surfaces: [{ path: '/items/iot-hub', label: 'IoT Hub editor' }],
    fixit: { kind: 'env-picker' },
    legacyCodes: ['iothub_not_configured'],
  },
  'svc-digital-twins': {
    surfaces: [
      { path: '/items/digital-twin', label: 'Digital Twin Builder (ADX graph-twin)' },
      { path: '/api/items/digital-twin/*', label: 'Twin materialize / graph query / time-series (ADX)' },
    ],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_KUSTO_CLUSTER_URI: L.adxUri, LOOM_ADT_ENDPOINT: L.adt },
    autoResolveNote: 'Digital twins run on the ADX graph-twin (make-graph / graph-match) by default — LOOM_KUSTO_CLUSTER_URI is emitted whenever ADX is deployed (adxEnabled=true), so the gate is satisfied with zero Azure Digital Twins dependency. ADT (unavailable in GCC-High) is a Commercial-only opt-in alternate.',
    legacyCodes: ['adt_not_configured'],
  },
  'svc-batch': {
    surfaces: [{ path: '/items/batch-pool', label: 'Batch pool editor' }],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_BATCH_ACCOUNT: L.batch },
    legacyCodes: ['batch_not_configured'],
  },
  'svc-postgres-flex': {
    surfaces: [{ path: '/items/postgres-flexible-server', label: 'Postgres Flexible Server editor' }],
    fixit: { kind: 'env-picker' },
    legacyCodes: ['postgres_flex_not_configured'],
  },
  'svc-pgvector': {
    surfaces: [{ path: '/items/ai-search-index', label: 'pgvector backend' }],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_PGVECTOR_HOST: L.pgFqdn },
    legacyCodes: ['pgvector_not_configured'],
  },
  'svc-shir': {
    surfaces: [{ path: '/admin/scaling', label: 'SHIR scale-to-0 controls' }],
    fixit: { kind: 'env-picker' },
    legacyCodes: ['shir_not_configured', 'purview_shir_not_configured'],
  },
  'svc-rti-export': {
    surfaces: [{ path: '/items/eventhouse', label: 'Eventhouse continuous export' }],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_RTI_EXPORT_ADLS: L.storage },
    legacyCodes: ['rti_export_not_configured'],
  },
  'svc-eh-schema-registry': {
    surfaces: [{ path: '/items/event-schema-set', label: 'Event schema set editor' }],
    fixit: { kind: 'env-picker' },
    legacyCodes: ['schema_registry_not_configured'],
  },
  'svc-dataverse': {
    surfaces: [{ path: '/items/power-app', label: 'Power Platform / Dataverse tables' }],
    fixit: { kind: 'wizard', grantNote: 'Requires the operator-run Power Platform SP grant (scripts/csa-loom/grant-powerplatform-sp.sh) — the S2S app must be added as an application user in the environment.' },
    legacyCodes: ['dataverse_not_configured', 'powerplatform_not_configured'],
  },
  'svc-lakebase': {
    surfaces: [{ path: '/items/lakebase-postgres', label: 'Lakebase Postgres editor' }],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_DATABRICKS_HOSTNAME: L.databricks },
    legacyCodes: ['lakebase_not_configured'],
  },
  // ── health-coverage convergence (#2093) — the audit-added backend specs ──
  'svc-powerplatform': {
    surfaces: [{ path: '/items/power-app', label: 'Power Platform control plane (power-* items)' }],
    fixit: { kind: 'role-grant', grantNote: 'A Power Platform admin must register the Console UAMI as a management app (New-PowerAppManagementApp; scripts/csa-loom/grant-powerplatform-sp.ps1) — a one-time tenant action, not an env write.' },
  },
  'svc-stream-analytics': {
    surfaces: [{ path: '/items/eventstream', label: 'Eventstream processing (ASA jobs)' }],
    fixit: { kind: 'env-picker' },
  },
  'svc-azure-sql': {
    surfaces: [
      { path: '/items/sql-database', label: 'SQL database items' },
      { path: '/items/mirrored-database', label: 'Mirroring source ops' },
    ],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_AZURE_SQL_DEFAULT_SERVER: L.sqlServer },
    legacyCodes: ['sql_default_server_not_configured'],
  },
  'svc-postgres': {
    surfaces: [{ path: '/items/lakebase-postgres', label: 'Lakebase / pgvector Postgres host' }],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_POSTGRES_HOST: L.pgFqdn },
  },
  'svc-eventgrid': {
    surfaces: [{ path: '/admin/webhooks', label: 'Business-event topics' }],
    fixit: { kind: 'env-picker' },
  },
};
