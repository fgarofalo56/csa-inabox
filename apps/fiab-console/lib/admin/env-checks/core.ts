// R30 — registry fragment split: this file is the former lib/admin/env-checks.ts
// MINUS the ENV_CHECKS array, which now lives in per-domain fragments beside it
// (./identity, ./data-plane, …) merged by ./index.ts. Fragments import ONLY
// from this core module (never the index — barrel-cycle rule).
/**
 * CSA Loom declarative config layer — types, deployment context, value hints,
 * and the ENV_CHECKS env-presence specs + evalEnv evaluator.
 *
 * PURE data + functions with ZERO server-only imports so it is safe to import
 * from CLIENT components (the gate registry lib/gates/registry.ts and the
 * shared HonestGate component derive from these). The live probes / audit
 * engine stay in lib/admin/self-audit.ts (server-only — they lazy-import the
 * Azure clients and the copilot orchestrator, which reach next/headers via
 * the session module and must never enter a client bundle).
 *
 * Split out of self-audit.ts for the G2 gate registry; self-audit re-exports
 * everything here so existing imports keep working.
 */
export type AuditStatus = 'pass' | 'warn' | 'fail';
export type AuditSeverity = 'critical' | 'recommended' | 'optional';
export type AuditCategory =
  | 'identity'
  | 'data-plane'
  | 'azure-services'
  | 'permissions'
  | 'security'
  | 'enrichment'
  | 'builders'
  | 'catalog-governance'
  | 'ai-copilot'
  | 'workloads'
  | 'observability';

export interface CheckResult {
  id: string;
  category: AuditCategory;
  title: string;
  severity: AuditSeverity;
  status: AuditStatus;
  /** What the check observed. */
  detail: string;
  /** Exact action to resolve a warn/fail. */
  remediation?: string;
  /** Set when the healer can apply a safe runtime fix (admin-approved). */
  fixId?: string;
  /** True when the only resolution is a redeploy / RBAC grant (not runtime). */
  redeploy?: boolean;
  /** Optional doc/portal link. */
  docs?: string;
  /** Step-by-step fix via the Azure portal (UI path). Present on warn/fail. */
  portalSteps?: string[];
  /** Copy-paste-ready PowerShell (Az CLI) fix, pre-filled with this deployment's
   * resource group / app / subscription / identity. Present on warn/fail. */
  fixScript?: string;
}

const env = (k: string) => (process.env[k] || '').trim();
const has = (k: string) => env(k).length > 0;
const anyHas = (...ks: string[]) => ks.some(has);

// ── deployment context (used to pre-fill the copy-paste fix scripts) ─────────
// Resolved from the live env so the PowerShell a user copies already targets
// THIS deployment — only the missing value the admin owns is left as a <token>.
export const CTX = {
  app: env('LOOM_CONSOLE_APP_NAME') || 'loom-console',
  // The Console container app lives in the ADMIN resource group. Do NOT fall back
  // to LOOM_DLZ_RG here — that produced fix scripts targeting the DLZ RG
  // (`az containerapp update --resource-group <dlz-rg>` → "containerapp loom-console
  // does not exist"). Admin-plane fixes must target the admin RG; only the env-var
  // VALUE_HINT placeholder is used when LOOM_ADMIN_RG is unset.
  adminRg: env('LOOM_ADMIN_RG') || '<admin-resource-group>',
  dlzRg: env('LOOM_DLZ_RG') || '<dlz-resource-group>',
  sub: env('LOOM_SUBSCRIPTION_ID') || '<subscription-id>',
  uamiClientId: env('LOOM_UAMI_CLIENT_ID') || '<uami-client-id>',
  tenant: env('LOOM_ENTRA_TENANT_ID') || env('AZURE_TENANT_ID') || '<tenant-id>',
  cosmosAccount: env('LOOM_COSMOS_ACCOUNT')
    || (env('LOOM_COSMOS_ENDPOINT').match(/https:\/\/([^.]+)\./)?.[1])
    || '<cosmos-account-name>',
};

// Friendly placeholder for the value an admin must supply for a given env var.
export const VALUE_HINT: Record<string, string> = {
  SESSION_SECRET: '<32+char-random-secret-from-key-vault>',
  LOOM_AUTOPILOT_MODE: 'propose  (or auto)',
  LOOM_CAPACITY_LCU: '<lcu-ceiling-e.g.-500>  (unset = auto-derive from peak)',
  LOOM_MSAL_CLIENT_ID: '<entra-app-client-id>',
  LOOM_MSAL_CLIENT_SECRET: '<entra-app-client-secret-from-key-vault>',
  LOOM_MSAL_TENANT_ID: CTX.tenant,
  LOOM_ENTRA_CLIENT_ID: '<entra-app-client-id>',
  LOOM_ENTRA_TENANT_ID: CTX.tenant,
  LOOM_UAMI_CLIENT_ID: '<uami-client-id>',
  LOOM_COSMOS_ENDPOINT: 'https://<account>.documents.azure.com:443/',
  LOOM_COSMOS_DATABASE: 'loom',
  LOOM_SUBSCRIPTION_ID: '<subscription-id>',
  // C1 — optional widener for the FinOps cost rollup (per-subscription default).
  LOOM_BILLING_SCOPE: '/providers/Microsoft.Billing/billingAccounts/<billing-account-id>  (unset = per Loom subscription)',
  // C2 — FinOps forecast tuning (fully-functional defaults; svc-cost-forecast).
  LOOM_COST_FORECAST_HORIZON_DAYS: '30  (forecast days, 1–90)',
  LOOM_COST_FORECAST_METHOD: 'auto (default) | api | linear | seasonal',
  // C3 — cost-anomaly monitor (default-ON; svc-cost-anomaly-monitor).
  LOOM_COST_ANOMALY_ENABLED: 'true  (default; false = opt out of the scheduled cost-anomaly monitor)',
  // A11 — FAULTED Spark-pool auto-recovery (default-ON; svc-spark-autorecover).
  LOOM_SPARK_AUTORECOVER_ENABLED: 'true  (default; false = detect + alert only, manual recreate)',
  LOOM_SPARK_RECOVER_MAX_ATTEMPTS: '3  (recreate attempts per pool in a 6h thrash window)',
  // A12 — Spark session quota / vCore budget ceiling (default-ON; svc-spark-vcore-budget).
  LOOM_SPARK_VCORE_BUDGET: '400  (max estimated active Spark vCores before refusing a new session; 0 = unlimited)',
  LOOM_SPARK_TENANT_SESSION_MAX: '50  (max concurrent active Spark sessions; 0 = unlimited)',
  // A13 — Spark chaos-drill harness (default OFF; svc-spark-chaos-drill).
  LOOM_SPARK_CHAOS_ENABLED: 'false  (default; true = enable fault injection in a NON-PROD drill only)',
  LOOM_DLZ_RG: '<dlz-resource-group>',
  LOOM_ADMIN_RG: '<admin-resource-group>',
  LOOM_TENANT_ADMIN_OID: '<your-entra-user-object-id>',
  LOOM_SYNAPSE_WORKSPACE: '<synapse-workspace-name>',
  LOOM_SYNAPSE_DEDICATED_POOL: '<dedicated-sql-pool-name>',
  LOOM_KUSTO_CLUSTER_URI: 'https://<adx-cluster>.<region>.kusto.<cloud-suffix>',
  LOOM_KUSTO_DEFAULT_DB: 'loomdb-default',
  LOOM_EVENTHUB_NAMESPACE: '<eventhubs-namespace>',
  LOOM_ADLS_ACCOUNT: '<adls-gen2-account-name>',
  // N1 — Iceberg REST Catalog (internal-ingress Unity Catalog OSS container).
  LOOM_ICEBERG_CATALOG_URL: 'https://iceberg-catalog.internal.<cae-default-domain>  (unset = dual metadata still emitted to your lake; no catalog discovery)',
  LOOM_AI_SEARCH_SERVICE: '<ai-search-service-name>',
  LOOM_POSTURE_FUNCTION_URL: 'https://func-loom-posture-refresh-<hash>.azurewebsites.net',
  LOOM_AOAI_ENDPOINT: 'https://<aoai-or-foundry>.openai.azure.com/',
  LOOM_AOAI_DEPLOYMENT: 'gpt-4o-mini',
  // WS-1.1 — model tier router deployments (mini / strong). Bicep wires both
  // from the Foundry project's best-per-cloud model (availability matrix).
  LOOM_AOAI_MINI_DEPLOYMENT: 'gpt-4.1-mini',
  LOOM_AOAI_STRONG_DEPLOYMENT: 'gpt-5.6 (Commercial) / gpt-5.2 (Gov) / gpt-4.1 (floor)',
  LOOM_AOAI_VISION_DEPLOYMENT: '<opt-in gpt-4o vision deployment for multimodal AI columns>',
  LOOM_LOG_ANALYTICS_RESOURCE_ID: '/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.OperationalInsights/workspaces/<law>',
  LOOM_ALERT_RG: env('LOOM_ADMIN_RG') || '<alert-resource-group (defaults to the admin RG)>',
  // S1 — the ONE shared derived alert sink (O1 convention): the
  // loom-default-alerts action group from monitoring-default-alerts.bicep.
  LOOM_ALERT_ACTION_GROUP_ID: '/subscriptions/<sub>/resourceGroups/<admin-rg>/providers/Microsoft.Insights/actionGroups/loom-default-alerts',
  LOOM_SECRET_EXPIRY_WARN_DAYS: '60',
  LOOM_ADF_FACTORY: '<data-factory-name>',
  LOOM_PURVIEW_ACCOUNT: '<purview-account-name>',
  LOOM_GRAPH_USERS_ENABLED: 'true',
  // Usage analytics embed (F21) + Govern embed (F2) — per-cloud report backend.
  // Day-one default is Azure Managed Grafana (Fabric-free): bicep deploys Grafana
  // (managedGrafanaEnabled) and the post-deploy bootstrap creates the two stable
  // dashboards (uids loom-governance / loom-usage) from platform/fiab/grafana/.
  // Power BI is the opt-in alternative (Commercial/GCC) — swap the KIND + ids below.
  LOOM_USAGE_REPORT_KIND: 'grafana',
  LOOM_GRAFANA_USAGE_DASHBOARD_UID: 'loom-usage',
  LOOM_GRAFANA_ENDPOINT: 'https://<name>-<hash>.<region>.grafana.azure.com',
  LOOM_REPORT_KIND: 'grafana',
  LOOM_GRAFANA_DASHBOARD_UID: 'loom-governance',
  // Opt-in Power BI alternative (set LOOM_*_REPORT_KIND=powerbi to use):
  LOOM_USAGE_PBI_WORKSPACE_ID: '<power-bi-workspace-guid>',
  LOOM_USAGE_PBI_REPORT_ID: '<power-bi-report-guid>',
  LOOM_GOVERN_PBI_WORKSPACE_ID: '<power-bi-workspace-guid>',
  LOOM_GOVERN_PBI_REPORT_ID: '<power-bi-report-guid>',
  // Derived by bicep (org-visuals URL from the storage account; LAW customerId
  // from the monitoring module). Operators normally never set these by hand.
  LOOM_ORG_VISUALS_URL: 'https://<adls-account>.blob.<storage-suffix>/org-visuals',
  LOOM_LOG_ANALYTICS_WORKSPACE_ID: '<log-analytics-workspace-customer-id-guid>',
  // RUM1 — client-side real-user monitoring (default-ON; observabilityConfig bag).
  LOOM_RUM_ENABLED: 'true  (default; false = opt out of browser RUM capture)',
  LOOM_RUM_SAMPLE_RATE: '100  (percent of browser sessions sampled, 0-100)',
  APPLICATIONINSIGHTS_CONNECTION_STRING: 'InstrumentationKey=<guid>;IngestionEndpoint=https://<region>.in.applicationinsights.<cloud-suffix>/;…  (derived from the monitoring module)',
  // SIEM audit stream (BR-SIEM) — DCE ingestion endpoint + DCR immutable id.
  LOOM_AUDIT_DCR_ENDPOINT: 'https://dce-loom-audit-<region>-<hash>.<region>.ingest.monitor.azure.com',
  LOOM_AUDIT_DCR_ID: 'dcr-<32-hex-immutable-id>',
  // ── new surfaces / data-plane day-one config (this expansion) ──
  LOOM_DATABRICKS_HOSTNAME: 'adb-<workspace-id>.<n>.azuredatabricks.net',
  LOOM_PURVIEW_UC_ENDPOINT: 'https://<purview-account>.purview.azure.com (.purview.azure.us in Gov)',
  // Optional operator override for the classic Data Map data-plane base URL.
  // Default (unset): ARM-derived properties.endpoints → cloud-aware convention
  // host (purview-endpoints.ts). Set only for custom DNS / unenumerated clouds.
  LOOM_PURVIEW_ENDPOINT: 'https://<purview-account>.purview.azure.com (.purview.azure.us in Gov)',
  LOOM_DLP_ENABLED: 'true',
  // MCP catalog deploy backend (Container Apps env the deploy route mounts into).
  LOOM_ACA_ENV_ID: '/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.App/managedEnvironments/<aca-env>',
  LOOM_ACA_ENV_DOMAIN: '<aca-env-default-domain>.<region>.azurecontainerapps.io',
  LOOM_BUILTIN_MCP_URL: 'https://<loom-builtin-mcp-host>',
  // WS-5.2 — A2A OUTBOUND egress allow-list (the gov-safe egress profile). Comma-
  // separated external A2A host suffixes a Loom agent may delegate OUT to. UNSET =
  // outbound A2A disabled (the sovereign / air-gapped default); inbound A2A works
  // regardless. Runtime-only knob (no bicep resource).
  LOOM_A2A_EGRESS_ALLOW: 'partner-agents.example.com,agents.contoso.com',
  // ── wave-2 coverage: builder/publish/networking env the earlier checks missed
  //    (env-config derives its editable whitelist from ENV_CHECKS, so a var
  //    absent there is silently dropped by PUT /api/admin/env-config) ──
  LOOM_SWA_SUBSCRIPTION_ID: CTX.sub,
  LOOM_SWA_RESOURCE_GROUP: '<swa-resource-group>',
  LOOM_SWA_RG: '<swa-resource-group>',
  LOOM_SWA_LOCATION: 'eastus2',
  LOOM_LOCATION: '<azure-region (e.g. centralus)>',
  LOOM_ADX_ALERT_SCOPE: '/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Kusto/clusters/<adx-cluster>',
  LOOM_PE_SUBNET_ID: '/subscriptions/<sub>/resourceGroups/<networking-rg>/providers/Microsoft.Network/virtualNetworks/<hub-vnet>/subnets/snet-private-endpoints',
  LOOM_PLAN_BACKING_SQL_SERVER: '<sql-logical-server>.database.windows.net',
  LOOM_PLAN_BACKING_SQL_DATABASE: 'loom-plan-writeback',
  LOOM_DAB_PREVIEW_URL: 'https://loom-dab-preview.<aca-env-domain>',
  LOOM_UDF_FUNCTION_BASE: 'https://<udf-function-app>.azurewebsites.net',
  LOOM_ONELAKE_SECURITY_ACL: 'true',
  LOOM_MAPS_BACKEND: 'azure-maps',
  LOOM_AZURE_MAPS_CLIENT_ID: '<azure-maps-account-uniqueId-guid>',
  LOOM_AZURE_MAPS_KEY: '<azure-maps-shared-key (Commercial only; prefer AAD)>',
  // OSS MapLibre (GCC-High / sovereign) — self-hosted tileserver-gl style URL,
  // read server-side + proxied in-VNet through /api/maps/tiles (bicep-emitted).
  LOOM_MAPS_TILE_URL: 'https://loom-maps-tiles.<aca-env-domain>/style.json',
  // ── wave-3 (G2 gate registry) — every remaining bespoke *_not_configured
  //    gate promoted into the declarative registry ──
  LOOM_AAS_SERVER: 'asazure://<region>.asazure.windows.net/<server>',
  LOOM_AAS_XMLA_ENDPOINT: 'asazure://<region>.asazure.windows.net/<server>',
  LOOM_POWERBI_XMLA_ENDPOINT: 'powerbi://api.powerbi.com/v1.0/myorg/<workspace> (opt-in only)',
  LOOM_AML_WORKSPACE: '<azure-ml-workspace-name>',
  LOOM_AML_REGION: '<azure-ml-workspace-region (e.g. centralus)>',
  // WS-1.2 — model-serving backend selector. Default (unset) = Azure ML managed
  // online endpoints (Azure-native, Gov-safe). Set to 'databricks' to use
  // Databricks Mosaic AI Model Serving (opt-in) with LOOM_DATABRICKS_HOSTNAME.
  LOOM_MODEL_SERVING_BACKEND: 'aml (default) | databricks',
  // WS-1.3 — LLM fine-tuning. LOOM_FINETUNE_BACKEND selects the backend (default
  // unset = Azure OpenAI / AI Foundry fine-tuning, Gov-safe; 'databricks' opts
  // into Mosaic AI FT). LOOM_AOAI_ACCOUNT names the AIServices/OpenAI account the
  // fine-tuning + model-deployment REST target (else discovered in LOOM_FOUNDRY_RG).
  LOOM_FINETUNE_BACKEND: 'aoai (default) | databricks',
  LOOM_AOAI_ACCOUNT: '<aiservices-or-openai-account-name>',
  // WS-2.1 — feature-store offline backend selector. Default (unset) = Unity
  // Catalog (Databricks) on Commercial, auto-switching to PostgreSQL for the
  // sovereign OSS-UC / Gov path. Set to 'postgres' to force the sovereign path.
  LOOM_FEATURE_STORE_BACKEND: 'databricks (default) | postgres',
  LOOM_APIM_NAME: '<apim-service-name>',
  LOOM_APIM_RG: '<apim-resource-group (defaults to the admin RG)>',
  LOOM_MIP_ENABLED: 'true',
  LOOM_DLP_ADMIN_ENABLED: 'true',
  LOOM_AOAI_EMBED_DEPLOYMENT: 'text-embedding-3-small',
  LOOM_DATABRICKS_SQL_WAREHOUSE_ID: '<databricks-sql-warehouse-id>',
  LOOM_SYNAPSE_SPARK_POOL: 'loompool',
  LOOM_COSMOS_VCORE_CONNECTION_STRING: '<mongodb+srv connection string from Key Vault>',
  LOOM_KEY_VAULT_URI: 'https://<vault-name>.vault.<cloud-suffix>/',
  LOOM_SHORTCUT_KEYVAULT: 'https://<vault-name>.vault.<cloud-suffix>/',
  LOOM_EVENTGRID_SUB: CTX.sub,
  LOOM_EVENTGRID_TOPIC_ENDPOINT: 'https://<topic>.<region>-1.eventgrid.azure.net/api/events',
  LOOM_EVENTGRID_TOPIC_KEY: '<event-grid-topic-access-key-from-key-vault>',
  LOOM_SERVICEBUS_NAMESPACE: '<servicebus-namespace>',
  LOOM_IOTHUB_SUB: CTX.sub,
  LOOM_ADT_ENDPOINT: 'https://<digital-twins-instance>.api.<region>.digitaltwins.azure.net',
  LOOM_AIRFLOW_ENDPOINT: 'https://<airflow-web-app>.azurewebsites.net',
  LOOM_BATCH_ACCOUNT: '<azure-batch-account-name>',
  LOOM_COPYJOB_CONTROL_SQL_SERVER: '<sql-logical-server>.database.windows.net',
  LOOM_POSTGRES_AAD_USER: '<entra-admin-login-for-postgres-flexible-server>',
  LOOM_PGVECTOR_HOST: '<postgres-flexible-server>.postgres.database.azure.com',
  LOOM_WEAVE_PG_FQDN: '<postgres-flexible-server>.postgres.database.azure.com',
  // N11 / N12 tuning knobs — unset is the fully-functional default (2 / 2).
  LOOM_GRAPHRAG_MAX_HOPS: '2   (1–4; ontology traversal depth for GraphRAG grounding)',
  LOOM_NL2SQL_REPAIR_MAX_ATTEMPTS: '2   (0–5; 0 disables the self-healing repair loop)',
  LOOM_DBT_RUNNER_URL: 'https://loom-dbt-runner.<aca-env-domain>',
  // N4 — the dual-engine (dbt-core + SQLMesh) transformation runtime behind the
  // transformation-project item's plan / apply / run / diff / environments.
  LOOM_TRANSFORM_RUNNER_URL: 'https://loom-transform-runner.<aca-env-domain>',
  // L2 — Synapse-Spark OpenLineage ingest (rev-2 security redesign): per-pool
  // Entra bearer (default) or per-workspace minted token; NEVER one global
  // static secret. The endpoint is the in-VNet console URL the pool posts to.
  LOOM_OPENLINEAGE_AUTH_MODE: 'entra  (or workspace-token)',
  LOOM_OPENLINEAGE_ENDPOINT: 'https://loom-console.<aca-env-domain>/api/lineage/openlineage',
  LOOM_OPENLINEAGE_POOL_PRINCIPALS: '<pool-app-client-id>=<workspace-id>[,...]  (entra mode; minted by openlineage-pool-setup.sh)',
  LOOM_APPROVAL_LOGIC_APP_NAME: '<logic-app-name (pipeline approvals)>',
  LOOM_SHIR_VMSS_NAME: '<shir-vmss-name>',
  LOOM_PURVIEW_SHIR_VMSS_NAME: '<purview-shir-vmss-name>',
  LOOM_RTI_EXPORT_ADLS: 'https://<account>.dfs.<storage-suffix>/<container>',
  LOOM_SAMPLE_ADLS: 'https://<account>.dfs.<storage-suffix>/samples',
  LOOM_CSV_IMPORTS_URL: 'https://<account>.blob.<storage-suffix>/csv-imports',
  LOOM_EH_SCHEMA_GROUP: '<event-hubs-schema-registry-group>',
  LOOM_WS_IDENTITY_SUB: CTX.sub,
  // I1 — per-workspace managed identity (shadow → enforce). Default off.
  LOOM_WORKSPACE_IDENTITY_MODE: 'off (default) | shadow | enforce',
  LOOM_WS_IDENTITY_RG: CTX.dlzRg,
  LOOM_DATAVERSE_CLIENT_ID: '<dataverse-s2s-app-client-id>',
  LOOM_DATAVERSE_CLIENT_SECRET: '<dataverse-s2s-app-secret-from-key-vault>',
  LOOM_FEEDBACK_GITHUB_TOKEN: '<github-fine-grained-pat-from-key-vault>',
  LOOM_WORKSPACE_M365_LINK: 'true',
  LOOM_SHAREPOINT_SHORTCUTS_ENABLED: 'true',
  LOOM_IQ_MCP_ENABLED: 'true',
  LOOM_PARAM_KEYVAULT: 'https://<vault-name>.vault.<cloud-suffix>/',
  LOOM_PARAM_APPCONFIG: 'https://<appconfig-name>.azconfig.io',
  LOOM_WRANGLER_ENDPOINT: 'https://loom-wrangler.<aca-env-domain>',
  LOOM_SILVER_URL: 'https://<account>.dfs.<storage-suffix>/silver',
  LOOM_GOLD_URL: 'https://<account>.dfs.<storage-suffix>/gold',
  LOOM_LAKEBASE_BACKEND: 'databricks',
  // ── Hyperscale band (HYP-16) — internal ACA app URLs + shared Redis host ──
  LOOM_ONELAKE_URL: 'https://loom-onelake.<aca-env-domain>',
  LOOM_DIRECTLAKE_URL: 'https://loom-directlake.<aca-env-domain>',
  LOOM_BROKER_URL: 'https://loom-capacity-broker.<aca-env-domain>',
  LOOM_BROKER_REDIS: '<hband-redis-host>.redis.cache.windows.net:6380',
  // ── Warm Spark pool cross-replica lease store (PSR-3) ──
  LOOM_SPARK_POOL_REDIS: '<hband-redis-host>.redis.cache.windows.net:6380',
  LOOM_SPARK_POOL_LEASE_CONTAINER: 'spark-warm-leases',
  // ── wave-3 coverage: backends the earlier checks missed entirely (see
  //    docs/fiab/health-coverage-audit.md — semantic/AAS, AML, APIM, Power
  //    Platform, Key Vault, Service Bus, Stream Analytics, Azure SQL, Postgres,
  //    Event Grid, Batch, result-cache Redis) ──
  LOOM_AAS_SERVER_NAME: '<analysis-services-server-name>',
  LOOM_AML_RESOURCE_GROUP: '<aml-resource-group>',
  LOOM_KEY_VAULT_NAME: '<vault-name>',
  LOOM_SERVICEBUS_RG: '<servicebus-resource-group (defaults to the DLZ RG)>',
  LOOM_ASA_RG: '<stream-analytics-resource-group (defaults to the DLZ RG)>',
  LOOM_AZURE_SQL_DEFAULT_SERVER: '<sql-logical-server>.database.windows.net',
  LOOM_POSTGRES_HOST: '<postgres-flexible-server>.postgres.database.azure.com',
  LOOM_EVENTGRID_BUSINESS_TOPIC: '<eventgrid-custom-topic-name>',
  LOOM_EVENTGRID_RG: '<eventgrid-resource-group (defaults to the DLZ RG)>',
  LOOM_RESULT_CACHE_REDIS: '<redis-host>.redis.cache.windows.net:6380',
  LOOM_PAGINATED_RENDER_URL: 'https://<paginated-report-renderer-function>.azurewebsites.net',
  // ── V1 synthetic user-journey monitoring (loom-next-level WS-V) ──
  LOOM_SYNTHETIC_MONITOR_ENABLED: 'true',
  LOOM_UAT_RESULTS_ACCOUNT: '<storage-account-name (the DLZ ADLS account by default)>',
  LOOM_UAT_RESULTS_CONTAINER: 'uat-results',
  SYNTHETIC_LOGIN_UPN: '<synthetic-automation-account-upn (least-privilege, one Loom test workspace)>',
  SYNTHETIC_LOGIN_SECRET: '<automation-account-password-from-key-vault (kv secret synthetic-login-secret)>',
  // (LOOM_ALERT_ACTION_GROUP_ID hint lives with the S1 secret-expiry block above.)
};

/** Pick the concrete env vars an admin should set from a missing-list that may
 * contain `A | B` anyOf groups — choose the first (preferred) var of each group. */
function varsToSet(missing: string[]): string[] {
  return missing.map((m) => (m.includes(' | ') ? m.split(' | ')[0].trim() : m.trim()));
}

/** Build portal steps + a pre-filled PowerShell snippet that sets the given env
 * vars on the Console container app (the most common Loom fix). Exported for
 * the extended probes (lib/admin/health-probes.ts — injected, no cycle). */
export function envVarFix(vars: string[]): { portalSteps: string[]; fixScript: string } {
  const setArgs = vars.map((v) => `"${v}=${VALUE_HINT[v] || `<set-${v}>`}"`).join(' ');
  const portalSteps = [
    `Azure portal → Container Apps → open "${CTX.app}" (resource group "${CTX.adminRg}").`,
    'In the left menu choose Application → Containers, then select "Edit and deploy".',
    'Open the Environment variables tab.',
    `Add or update: ${vars.join(', ')} — set each to your value, then click Save.`,
    'Confirm "Create" to roll a new revision; the change is live in ~1–2 minutes.',
    'Return here and click Re-run audit — the check turns green once the revision is active.',
  ];
  const fixScript = [
    '# CSA Loom — set the missing config on the Console container app, then it auto-rolls a new revision.',
    '# Run in Azure Cloud Shell (PowerShell) or local pwsh with the Az CLI. Replace any <...> with your value.',
    `az account set --subscription "${CTX.sub}"`,
    `az containerapp update --name "${CTX.app}" --resource-group "${CTX.adminRg}" \``,
    `  --set-env-vars ${setArgs}`,
  ].join('\n');
  return { portalSteps, fixScript };
}

// ── X2 — structured per-service cloud availability ─────────────────────────
/**
 * Availability of the backing Azure service in one sovereign boundary:
 *   'ga'          — generally available; the surface renders + configures normally.
 *   'limited'     — available with limits/variance (region lag, reduced catalog,
 *                   tier restrictions). The surface renders NORMALLY plus a
 *                   NON-BLOCKING info note sourced from `fallbackNote` — never a
 *                   gate (round-3 clarification: only 'unavailable' gates).
 *   'unavailable' — the service does not exist in that cloud. A failing env
 *                   check becomes state 'cloud-unavailable' (distinct from
 *                   'blocked'): the honest MessageBar names the Azure-native /
 *                   OSS / Loom-native fallback with NO Fix-it (you cannot
 *                   provision the impossible) — a "Use the Loom-native
 *                   equivalent" CTA instead.
 */
export type Avail = 'ga' | 'limited' | 'unavailable';

/** Per-cloud availability descriptor for the service behind an EnvSpec (X2 —
 * turns the loom-next-level X-MATRIX into data so honest gates are automatic,
 * not hand-maintained prose). Keys align with detectLoomCloud(): Commercial +
 * GCC read `commercial` (GCC runs on Commercial Azure endpoints), GCC-High
 * reads `gccHigh`, DoD/IL5 read `il5`. */
export interface ServiceAvailability {
  commercial: Avail;
  gccHigh: Avail;
  il5: Avail;
  /** Names the exact Azure-native / OSS / Loom-native fallback for the
   * limited/unavailable clouds — surfaced verbatim on the honest gate / info
   * note. Required in practice whenever any cloud is not 'ga'. */
  fallbackNote?: string;
}

// ── env-presence check helper ──────────────────────────────────────────────
export interface EnvSpec {
  id: string;
  category: AuditCategory;
  title: string;
  severity: AuditSeverity;
  /** All of these must be present (or an anyOf group satisfied). */
  required?: string[];
  /** At least one of each inner group must be present. */
  anyOf?: string[][];
  remediation: string;
  docs?: string;
  /** When true a miss is a 'warn' (optional feature) instead of 'fail'. */
  warnOnMiss?: boolean;
  /** The bicep module (+ the param / line that emits it) that wires every var in
   * this spec on a push-button deploy. Surfaced on /admin/env-config so an unset
   * var names the exact IaC to provision it. */
  provisionedBy?: string;
  /** The exact Azure RBAC role / tenant action required for these vars to
   * function once set (e.g. "Power BI workspace Member (UAMI)"). Surfaced on the
   * env-config row next to the var. */
  role?: string;
  /** True when bicep AUTO-DERIVES these vars from another resource (e.g. the
   * org-visuals URL from the storage account, the LAW customerId from the
   * monitoring module) — so a fresh deploy fills them without operator input. The
   * env-config surface renders these with a third "derived" status, not a bare
   * "not set", because the operator normally never sets them by hand. */
  derived?: boolean;
  /** True when the UNSET state is the fully-functional, intended day-one default:
   * the console silently falls back to a built-in path with zero loss of function
   * (an optional scale-out substrate, not a configuration gap). Per
   * loom_default_on_opt_out the FEATURE is ON by default via that fallback, so an
   * unset var here is NOT a health defect — the check passes with an honest
   * "fallback active" detail and the optional upgrade step, and the env-config
   * surface counts it as configured (status 'default'). Reserved for genuine
   * silent-fallback substrates where an unset var loses ZERO function:
   *   - the Hyperscale-band OneLake/Direct Lake/Broker apps deployed out-of-band,
   *   - the AI-enrichment per-service endpoints — unset falls back to the shared
   *     multi-service Azure AI Services (Foundry) account (svc-ai-enrich), and
   *   - the SIEM audit-stream DCR — unset silently no-ops while the built-in
   *     Cosmos audit trail keeps every event (svc-audit-siem-stream).
   * NEVER use it for a service whose absence actually disables a feature. */
  optionalDefault?: boolean;
  /** Honest per-spec detail for the optionalDefault 'pass' state — names the exact
   * built-in fallback that keeps the feature 100% functional while the var is unset
   * (e.g. "falls back to the shared Azure AI Services account", "Cosmos audit trail
   * keeps every event"). Falls back to a generic H-band substrate message. */
  optionalDefaultDetail?: string;
  /** X2 — structured per-cloud availability of the BACKING Azure service
   * (from the loom-next-level X-MATRIX). Absent = 'ga' everywhere. Only
   * 'unavailable' in the active cloud produces the cloud-unavailable gate;
   * 'limited' is a non-blocking info note (see the Avail doc above). */
  availability?: ServiceAvailability;
}

export function evalEnv(spec: EnvSpec): CheckResult {
  const missing: string[] = [];
  for (const k of spec.required || []) if (!has(k)) missing.push(k);
  for (const group of spec.anyOf || []) if (!group.some(has)) missing.push(group.join(' | '));
  const ok = missing.length === 0;
  // Optional silent-fallback substrate (H-band): an unset var is the intended,
  // fully-functional day-one default — the console falls back to a built-in path
  // with no loss of function (loom_default_on_opt_out: the feature is ON via the
  // fallback). Report pass with an honest "fallback active" detail + the optional
  // scale-out step, so a correct default posture never drags the health score.
  if (!ok && spec.optionalDefault) {
    return {
      id: spec.id, category: spec.category, title: spec.title, severity: spec.severity,
      status: 'pass',
      detail: spec.optionalDefaultDetail
        ? `Built-in fallback active (fully functional) — ${spec.optionalDefaultDetail}`
        : `Built-in fallback active (fully functional) — the ${missing.join(', ')} scale-out substrate is optional and deployed out-of-band.`,
      remediation: spec.remediation,
      docs: spec.docs,
    };
  }
  const failStatus: AuditStatus = spec.warnOnMiss || spec.severity !== 'critical' ? 'warn' : 'fail';
  const fix = ok ? null : envVarFix(varsToSet(missing));
  return {
    id: spec.id,
    category: spec.category,
    title: spec.title,
    severity: spec.severity,
    status: ok ? 'pass' : failStatus,
    detail: ok ? 'Configured.' : `Missing: ${missing.join(', ')}.`,
    remediation: ok ? undefined : spec.remediation,
    redeploy: ok ? undefined : true,
    docs: spec.docs,
    portalSteps: fix?.portalSteps,
    fixScript: fix?.fixScript,
  };
}
