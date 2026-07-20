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
  | 'workloads';

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
  LOOM_MSAL_CLIENT_ID: '<entra-app-client-id>',
  LOOM_MSAL_CLIENT_SECRET: '<entra-app-client-secret-from-key-vault>',
  LOOM_MSAL_TENANT_ID: CTX.tenant,
  LOOM_ENTRA_CLIENT_ID: '<entra-app-client-id>',
  LOOM_ENTRA_TENANT_ID: CTX.tenant,
  LOOM_UAMI_CLIENT_ID: '<uami-client-id>',
  LOOM_COSMOS_ENDPOINT: 'https://<account>.documents.azure.com:443/',
  LOOM_COSMOS_DATABASE: 'loom',
  LOOM_SUBSCRIPTION_ID: '<subscription-id>',
  LOOM_DLZ_RG: '<dlz-resource-group>',
  LOOM_ADMIN_RG: '<admin-resource-group>',
  LOOM_TENANT_ADMIN_OID: '<your-entra-user-object-id>',
  LOOM_SYNAPSE_WORKSPACE: '<synapse-workspace-name>',
  LOOM_SYNAPSE_DEDICATED_POOL: '<dedicated-sql-pool-name>',
  LOOM_KUSTO_CLUSTER_URI: 'https://<adx-cluster>.<region>.kusto.<cloud-suffix>',
  LOOM_KUSTO_DEFAULT_DB: 'loomdb-default',
  LOOM_EVENTHUB_NAMESPACE: '<eventhubs-namespace>',
  LOOM_ADLS_ACCOUNT: '<adls-gen2-account-name>',
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
  LOOM_DBT_RUNNER_URL: 'https://loom-dbt-runner.<aca-env-domain>',
  LOOM_APPROVAL_LOGIC_APP_NAME: '<logic-app-name (pipeline approvals)>',
  LOOM_SHIR_VMSS_NAME: '<shir-vmss-name>',
  LOOM_PURVIEW_SHIR_VMSS_NAME: '<purview-shir-vmss-name>',
  LOOM_RTI_EXPORT_ADLS: 'https://<account>.dfs.<storage-suffix>/<container>',
  LOOM_SAMPLE_ADLS: 'https://<account>.dfs.<storage-suffix>/samples',
  LOOM_CSV_IMPORTS_URL: 'https://<account>.blob.<storage-suffix>/csv-imports',
  LOOM_EH_SCHEMA_GROUP: '<event-hubs-schema-registry-group>',
  LOOM_WS_IDENTITY_SUB: CTX.sub,
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

/** The declarative env-presence checks (the backbone of the audit). */
export const ENV_CHECKS: EnvSpec[] = [
  // ── identity ──
  {
    id: 'session-secret', category: 'identity', title: 'Session signing secret', severity: 'critical',
    required: ['SESSION_SECRET'],
    remediation: 'Set SESSION_SECRET (resolved in CI from Key Vault by the deploy SP; never on disk). Without it sessions cannot be minted/verified.',
    provisionedBy: 'modules/admin-plane/main.bicep (param loomSessionSecret → ACA secret; empty → stable per-RG GUID)',
  },
  {
    id: 'entra-app', category: 'identity', title: 'Entra sign-in app (MSAL)', severity: 'critical',
    // The confidential client that performs interactive user login (lib/auth/msal.ts)
    // reads LOOM_MSAL_CLIENT_ID + LOOM_MSAL_CLIENT_SECRET — NOT AZURE_CLIENT_ID
    // (that is the Console UAMI, a managed identity that cannot do user login).
    // Keying the check on the MSAL vars matches what login actually requires so a
    // missing app-registration credential is reported honestly instead of looking
    // "configured" merely because the UAMI client id is set (PRP deploy-readiness
    // gap #2 — the same mis-keying the /auth/sign-in 503 gate had).
    required: ['LOOM_MSAL_CLIENT_ID', 'LOOM_MSAL_CLIENT_SECRET'],
    anyOf: [['AZURE_TENANT_ID', 'LOOM_MSAL_TENANT_ID']],
    remediation: 'Set LOOM_MSAL_CLIENT_ID + LOOM_MSAL_CLIENT_SECRET (the Entra app users sign in with) and AZURE_TENANT_ID. The push-button deploy provisions these automatically (loomMsalAppRegEnabled, default on) — re-run csa-loom-post-deploy-bootstrap.yml ("Provision MSAL app registration") or see docs/fiab/MSAL-handoff.md.',
    provisionedBy: 'modules/admin-plane/entra-app-registration.bicep (deploymentScript → app reg + secret in Key Vault) → loomMsalClientId / loom-msal-client-secret secretRef → apps[] env',
    role: 'Entra app registration with redirect URI for the Console host (reconciled by the deploy + bootstrap)',
  },
  {
    id: 'uami', category: 'identity', title: 'Console managed identity (UAMI)', severity: 'critical',
    required: ['LOOM_UAMI_CLIENT_ID'],
    remediation: 'Set LOOM_UAMI_CLIENT_ID to the user-assigned managed identity client id. Every Azure data-plane call authenticates as this identity.',
    provisionedBy: 'modules/admin-plane/main.bicep (uami-console resource → apps[] env, auto-derived)',
  },
  // ── data-plane (Cosmos = the Loom store; required to run at all) ──
  {
    id: 'cosmos-config', category: 'data-plane', title: 'Cosmos DB (Loom store)', severity: 'critical',
    anyOf: [['LOOM_COSMOS_ENDPOINT', 'COSMOS_ENDPOINT']],
    remediation: 'Set LOOM_COSMOS_ENDPOINT (and LOOM_COSMOS_DATABASE) — Cosmos holds every workspace, item, permission grant, and config. Loom cannot run without it.',
    docs: 'https://learn.microsoft.com/azure/cosmos-db/',
    provisionedBy: 'modules/landing-zone/main.bicep (cosmos account) → admin-plane forwards loomCosmosAccount → apps[] env',
    role: 'Cosmos DB Built-in Data Contributor (UAMI, assigned via CLI/ARM)',
  },
  {
    id: 'subscription', category: 'data-plane', title: 'Azure subscription + resource groups', severity: 'critical',
    required: ['LOOM_SUBSCRIPTION_ID'],
    anyOf: [['LOOM_DLZ_RG', 'LOOM_ADMIN_RG']],
    remediation: 'Set LOOM_SUBSCRIPTION_ID and at least one of LOOM_DLZ_RG / LOOM_ADMIN_RG so ARM discovery + scaling can target the deployment.',
    provisionedBy: 'modules/admin-plane/main.bicep (apps[] env, auto-derived from deployment scope)',
  },
  {
    id: 'domain-routing', category: 'permissions', title: 'Domain-aware item-create routing (multi-sub)', severity: 'recommended',
    // LOOM_SUBSCRIPTION_ID is the admin (DMLZ) sub + single-sub default; domain
    // DLZ subscriptions live in the Cosmos governance-domain registry
    // (domain.subscriptionIds), NOT in env — so this check verifies only the
    // single-sub default is wired. In multi-sub mode the Console UAMI also needs
    // Contributor on each domain DLZ RG (rg-csa-loom-dlz-{domain}-{location});
    // that grant is wired by the dlzItemCreateRbac loop and surfaced as an honest
    // gate by topology.ts when missing.
    required: ['LOOM_SUBSCRIPTION_ID'],
    warnOnMiss: true,
    remediation: 'Domain-scoped item-creates (lakehouse/warehouse/eventhouse/notebook/mirroring) route to the owning domain\'s DLZ subscription (governance-domain registry → domain.subscriptionIds[0]) via lib/azure/topology.ts → resolveDeployTarget; shared/tenant items (catalog/marketplace/governance) stay in the admin plane. For multi-sub, set each domain\'s subscriptionIds in the Domains admin UI and ensure the Console UAMI has Contributor on rg-csa-loom-dlz-{domain}-{location} in that sub (deployed by modules/admin-plane/dlz-attach-itemcreate-rbac.bicep). Single-sub deployments need no extra config — routing falls back to LOOM_SUBSCRIPTION_ID + LOOM_DLZ_RG.',
    provisionedBy: 'modules/admin-plane/dlz-attach-itemcreate-rbac.bicep (dlzItemCreateRbac loop in main.bicep, multi-sub mode)',
    role: 'Contributor (b24988ac-…) on each domain DLZ resource group (Console UAMI)',
  },
  // ── permissions ──
  {
    id: 'bootstrap-admin', category: 'permissions', title: 'Bootstrap tenant admin', severity: 'critical',
    anyOf: [['LOOM_TENANT_ADMIN_OID', 'LOOM_TENANT_ADMIN_GROUP_ID']],
    remediation: 'Set LOOM_TENANT_ADMIN_OID to your Entra user OID (or LOOM_TENANT_ADMIN_GROUP_ID to a group you are in) — deploy params loomTenantAdminOid / loomTenantAdminGroupId. Members bypass the feature-permission gate with full Admin; this is how the first admin gets in before any grants exist and fixes the "Access denied (403)" on /admin/permissions.',
    docs: '/admin/permissions',
    provisionedBy: 'main.bicep (params loomTenantAdminOid / loomTenantAdminGroupId) → admin-plane apps[] env',
  },
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
  },
  {
    // WS-1.1 — the model tier router's REASONING (strong) + MINI tiers. The
    // router (lib/foundry/model-tier-router.ts) is default-ON: it classifies
    // every copilot / agent / data-agent turn and, when a strong deployment is
    // wired, rides it for hard analytical/agentic turns (design / debug /
    // multi-step / tool-heavy / long-context) while cheap turns can ride mini.
    // When NO strong deployment is configured the router SILENTLY rides the
    // single default AOAI deployment (LOOM_AOAI_DEPLOYMENT) for every turn — the
    // turn still works, it just is not upshifted. optionalDefault so that
    // fully-functional posture is a pass (never a hard-fail), while the gate +
    // Fix-it stay discoverable on /admin/gates for an admin who wants best-per-
    // task routing. The strong tier binds to the BEST reasoning model the cloud
    // can serve (bicep miniDeployment/strongDeployment from the availability
    // matrix — Commercial gpt-5.6/gpt-5.5; Gov gpt-5.2/gpt-5.1/gpt-5; floor
    // gpt-4.1), so it works in Commercial AND Gov (*.openai.azure.us).
    id: 'svc-model-reasoning-tier', category: 'ai-copilot',
    title: 'Model tier router — reasoning (strong) + mini tiers', severity: 'optional',
    required: ['LOOM_AOAI_STRONG_DEPLOYMENT', 'LOOM_AOAI_MINI_DEPLOYMENT'],
    warnOnMiss: true,
    optionalDefault: true,
    optionalDefaultDetail: 'the model tier router rides the single resolved default AOAI deployment (LOOM_AOAI_DEPLOYMENT) for every turn — hard analytical turns are not upshifted to a stronger reasoning model, but every turn still works. Set LOOM_AOAI_STRONG_DEPLOYMENT (a reasoning-capable o-series / gpt-5-class deployment) so hard turns ride the reasoning tier, and LOOM_AOAI_MINI_DEPLOYMENT (a cheap model, e.g. gpt-4.1-mini) so lightweight turns ride mini.',
    remediation: 'Deploy a reasoning-capable model on the Foundry hub (Commercial: gpt-5.6 / gpt-5.5; Gov: gpt-5.2 / gpt-5.1 / gpt-5; floor gpt-4.1) and set LOOM_AOAI_STRONG_DEPLOYMENT to its deployment name so hard analytical/agentic turns route to it; set LOOM_AOAI_MINI_DEPLOYMENT to a cheap model (gpt-4.1-mini) for lightweight turns. A push-button deploy wires both from the Foundry project automatically. Opt out entirely with LOOM_MODEL_TIER_ROUTING_ENABLED=false or Admin → Copilot & Agents → Model tiers.',
    provisionedBy: 'modules/ai/foundry-project.bicep (miniDeployment / strongDeployment) → modules/admin-plane/main.bicep apps[] env (LOOM_AOAI_MINI_DEPLOYMENT / LOOM_AOAI_STRONG_DEPLOYMENT)',
    role: 'Cognitive Services OpenAI User (UAMI) on the AOAI/Foundry account',
    docs: 'docs/fiab/model-strategy.md',
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
  // ── enrichment ──
  {
    id: 'graph-users', category: 'enrichment', title: 'Microsoft Graph user enrichment', severity: 'optional',
    required: ['LOOM_GRAPH_USERS_ENABLED'], warnOnMiss: true,
    remediation: 'Set LOOM_GRAPH_USERS_ENABLED=true and grant the Console UAMI Directory.Read.All in Microsoft Graph to enrich the Users page with display name + department. Without it the page still shows UPN + activity + roles from Cosmos.',
    docs: 'https://learn.microsoft.com/graph/permissions-reference#directoryreadall',
    provisionedBy: 'modules/admin-plane/main.bicep (apps[] env) + post-deploy Graph grant',
    role: 'Microsoft Graph Directory.Read.All (application) granted to the Console UAMI',
  },
  {
    id: 'graph-group-sync', category: 'enrichment', title: 'Entra group sync (access-package group targets)', severity: 'optional',
    required: ['LOOM_GRAPH_GROUP_SYNC_ENABLED'], warnOnMiss: true, optionalDefault: true,
    remediation: 'Set LOOM_GRAPH_GROUP_SYNC_ENABLED=true and grant the Console UAMI Microsoft Graph Group.Read.All + GroupMember.Read.All (application, admin-consented) via scripts/csa-loom/grant-identity-graph-approles.sh to auto-reconcile Entra group-targeted access packages (member joins→grant, leaves→revoke). This is READ-ONLY on Entra — Loom never mutates tenant group membership. Without it, group-targeted packages still install and are requestable directly; only the automatic membership reconcile is gated. Everything else in access-governance is day-one-ON.',
    docs: 'https://learn.microsoft.com/entra/id-governance/entitlement-management-scenarios',
    provisionedBy: 'platform/fiab/bicep/modules/admin-plane/identity-graph-rbac.bicep (loomIdentityPickerEnabled) → apps[] env + post-deploy Graph grant',
    role: 'Microsoft Graph Group.Read.All + GroupMember.Read.All (application) granted to the Console UAMI',
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
  },
  {
    id: 'govern-embed', category: 'azure-services', title: 'Governance analytics embed (F2 — /governance Govern)', severity: 'optional',
    required: ['LOOM_REPORT_KIND'],
    anyOf: [['LOOM_GOVERN_PBI_WORKSPACE_ID', 'LOOM_GOVERN_PBI_REPORT_ID', 'LOOM_GRAFANA_DASHBOARD_UID']],
    warnOnMiss: true,
    remediation: 'Set LOOM_REPORT_KIND=powerbi (Commercial/GCC) + LOOM_GOVERN_PBI_WORKSPACE_ID + LOOM_GOVERN_PBI_REPORT_ID, OR =grafana (GCC-High/IL5) + LOOM_GRAFANA_DASHBOARD_UID. The native governance surface works without this — it only lights up the "View more" embedded report.',
    provisionedBy: 'main.bicep (params loomReportKind / loomGovernPbiWorkspaceId / loomGovernPbiReportId / loomGrafanaDashboardUid) → modules/admin-plane/main.bicep apps[] env (lines ~2455-2470)',
    role: 'powerbi: Console UAMI = Power BI workspace Member + "Service principals can use Power BI APIs" on. grafana: Grafana Viewer (UAMI).',
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

  // ── builders (new surfaces — each works Loom-native on Cosmos by default; the
  //    env below only lights up the Azure-backed *deploy/run* target) ──
  {
    id: 'svc-mcp-deploy', category: 'builders', title: 'MCP Servers — deploy backend (Container Apps)', severity: 'optional',
    // The catalog list + built-in MCP server work without this. Deploying a
    // catalog MCP server as its own Container App needs the ACA managed
    // environment coordinates the deploy route mounts the new app into.
    anyOf: [['LOOM_ACA_ENV_ID', 'LOOM_ACA_ENV_DOMAIN']], warnOnMiss: true,
    remediation: 'The MCP Servers catalog + built-in server work without this. To DEPLOY a catalog MCP server as a Container App, set LOOM_ACA_ENV_ID (the managed environment resource id) + LOOM_ACA_ENV_DOMAIN; the Console UAMI also needs Contributor on the admin RG and a Key Vault for the server secretRefs. POST /api/admin/mcp-servers/deploy reads these.',
    provisionedBy: 'modules/admin-plane/main.bicep (Container Apps managed environment → apps[] env LOOM_ACA_ENV_ID / LOOM_ACA_ENV_DOMAIN)',
    role: 'Contributor (Console UAMI) on the admin RG + Key Vault Secrets User on the MCP secrets vault',
  },
  {
    id: 'svc-warp-engine', category: 'builders', title: 'Warp transforms — SQL run target (Synapse / Databricks)', severity: 'recommended',
    // Transforms persist Loom-native (items container). Running a transform
    // needs a real SQL engine — Synapse serverless/dedicated TDS OR Databricks
    // SQL. Either satisfies the gate (no Fabric dependency).
    anyOf: [['LOOM_SYNAPSE_WORKSPACE', 'LOOM_DATABRICKS_HOSTNAME']], warnOnMiss: true,
    remediation: 'Warp saves transforms Loom-native (items store) without this. To RUN a visual transform, set a SQL engine: LOOM_SYNAPSE_WORKSPACE (Synapse serverless/dedicated TDS) and/or LOOM_DATABRICKS_HOSTNAME (Databricks SQL warehouse). GET /api/experience/warp/transforms enumerates the available run targets from these.',
    provisionedBy: 'modules/landing-zone/synapse.bicep (loomSynapseWorkspace) and/or modules/landing-zone (Databricks workspace → loomDatabricksHostname)',
    role: 'Synapse SQL Administrator (UAMI) and/or Databricks workspace access (UAMI) on the chosen engine',
  },

  // ── catalog & governance backends (new surfaces) ──
  {
    id: 'svc-deploy-planner', category: 'catalog-governance', title: 'Deployment planner — plan store (Cosmos)', severity: 'optional',
    // Plans live in the tenant-settings container (doc id deploy-plan:<tenant>),
    // so the Cosmos config + probe cover reachability. This check confirms the
    // Loom store is configured (the only requirement for the planner to persist).
    anyOf: [['LOOM_COSMOS_ENDPOINT', 'COSMOS_ENDPOINT']], warnOnMiss: true,
    remediation: 'The Deployment planner saves the subscription + service plan to the Loom store (Cosmos tenant-settings container, doc deploy-plan:<tenant>). It requires only a reachable Cosmos account — see the "Cosmos DB (Loom store)" check. No extra env.',
    provisionedBy: 'modules/landing-zone/main.bicep (cosmos account) → apps[] env LOOM_COSMOS_ENDPOINT',
    role: 'Cosmos DB Built-in Data Contributor (UAMI)',
  },
  {
    id: 'svc-org-visuals', category: 'catalog-governance', title: 'Organizational visuals — Blob store + metadata', severity: 'optional',
    // Metadata + enabled toggle live in the org-visuals Cosmos container; the
    // bundle bytes live in the org-visuals Blob container (LOOM_ORG_VISUALS_URL,
    // auto-derived by bicep). Without the Blob URL, listing/metadata still works
    // Loom-native but uploads have nowhere to land.
    required: ['LOOM_ORG_VISUALS_URL'], warnOnMiss: true,
    remediation: 'Set LOOM_ORG_VISUALS_URL (the org-visuals Blob container URL) so custom-visual (.pbiviz) uploads have a backing store; metadata + the enabled toggle persist in the org-visuals Cosmos container regardless. Bicep auto-derives this from the DLZ storage account on a push-button deploy.',
    provisionedBy: 'modules/admin-plane/main.bicep (derived from loomStorageAccount) + landing-zone/org-visuals-rbac.bicep',
    role: 'Storage Blob Data Contributor (UAMI) on the org-visuals container',
  },

  // ── AI & Copilot (new surfaces) ──
  {
    id: 'svc-learning-hub', category: 'ai-copilot', title: 'Learning Hub — help agent + sample-data install', severity: 'optional',
    // The Learning Hub help-copilot answers from an AOAI/Foundry model; the
    // use-case apps install + notebook-import provision into Synapse/Databricks
    // and seed sample data into ADLS. The model gate is the recommended one; the
    // probeAoai() live check below confirms a deployment actually resolves.
    anyOf: [['LOOM_AOAI_ENDPOINT', 'LOOM_FOUNDRY_PROJECT_ENDPOINT', 'LOOM_FOUNDRY_ENDPOINT']], warnOnMiss: true,
    remediation: 'The Learning Hub help agent needs an AOAI/Foundry model (set LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT or a Foundry project endpoint). The use-case apps install + notebook-import additionally provision into Synapse/Databricks + seed sample data into ADLS (see those service checks). The hub content + tutorials render Loom-native without a model — only the conversational help agent is gated.',
    provisionedBy: 'modules/admin-plane (agentFoundryEnabled / aiFoundryEnabled) → AIServices account + project → apps[] env',
    role: 'Cognitive Services OpenAI User (UAMI) on the AOAI/Foundry account',
  },
  {
    id: 'svc-mcp-catalog', category: 'ai-copilot', title: 'MCP Servers — built-in server', severity: 'optional',
    // The deployable catalog list is a static built-in module (lib/mcp/catalog.ts)
    // and always renders. The built-in Loom MCP server endpoint is the only env
    // that gates the "use the built-in server" path.
    required: ['LOOM_BUILTIN_MCP_URL'], warnOnMiss: true,
    remediation: 'The MCP Servers catalog list renders from the built-in module without config. Set LOOM_BUILTIN_MCP_URL to point at the deployed built-in Loom MCP server (the bootstrap deploys + wires it). Deploying additional catalog servers uses the Container Apps env — see the "MCP Servers — deploy backend" check.',
    provisionedBy: 'modules/admin-plane (built-in MCP Container App) → apps[] env LOOM_BUILTIN_MCP_URL',
    role: 'none (HTTP endpoint); deployed catalog servers use the MCP catalog UAMI',
  },
  {
    id: 'svc-databricks', category: 'azure-services', title: 'Azure Databricks (notebooks / SQL / Warp)', severity: 'optional',
    required: ['LOOM_DATABRICKS_HOSTNAME'], warnOnMiss: true,
    remediation: 'Set LOOM_DATABRICKS_HOSTNAME (the workspace hostname, no scheme) to enable Databricks-backed notebooks, SQL warehouses, and Warp run targets. Synapse covers the same workloads if you prefer not to deploy Databricks.',
    provisionedBy: 'modules/landing-zone (Databricks workspace) → admin-plane forwards loomDatabricksHostname → apps[] env',
    role: 'Databricks workspace access for the Console UAMI (SCIM-provisioned) + network reachability (private link / IP allowlist — see issue #1466)',
  },

  // ── wave-2 coverage: builder/publish/networking env the earlier checks missed.
  //    env-config.ts derives its EDITABLE_ENV whitelist from THESE specs — a var
  //    absent here is silently DROPPED by PUT /api/admin/env-config, so every
  //    runtime LOOM_ var a route reads must have a spec. ──
  {
    id: 'svc-swa-publish', category: 'builders', title: 'Static Web Apps publish (Workshop / Slate apps)', severity: 'optional',
    // The publish routes fall back: sub → LOOM_SUBSCRIPTION_ID, rg → LOOM_SWA_RG,
    // location → LOOM_LOCATION → 'eastus2' — hence the alias groups.
    anyOf: [
      ['LOOM_SWA_SUBSCRIPTION_ID', 'LOOM_SUBSCRIPTION_ID'],
      ['LOOM_SWA_RESOURCE_GROUP', 'LOOM_SWA_RG'],
      ['LOOM_SWA_LOCATION', 'LOOM_LOCATION'],
    ],
    warnOnMiss: true,
    remediation: 'Workshop and Slate apps PUBLISH to a real Azure Static Web App. Set LOOM_SWA_RESOURCE_GROUP (the resource group new SWAs deploy into; LOOM_SWA_SUBSCRIPTION_ID falls back to LOOM_SUBSCRIPTION_ID and LOOM_SWA_LOCATION defaults to eastus2) and grant the Console UAMI "Website Contributor" on that RG. The builders + in-editor Preview work without this — only one-click Publish is gated. No Microsoft Fabric required.',
    provisionedBy: 'modules/admin-plane/main.bicep apps[] env (LOOM_SWA_SUBSCRIPTION_ID / LOOM_SWA_RESOURCE_GROUP / LOOM_SWA_LOCATION — RG defaults to the admin RG, byoExisting.swaResourceGroup overrides) + swa-publish-rbac.bicep (Website Contributor grant); POST /api/items/{workshop-app,slate-app}/[id]/publish reads these',
    role: 'Website Contributor (Console UAMI) on the SWA resource group',
  },
  {
    id: 'svc-activator-adx-scope', category: 'azure-services', title: 'Activator — ADX continuous-evaluation scope', severity: 'optional',
    required: ['LOOM_ADX_ALERT_SCOPE'], warnOnMiss: true,
    remediation: 'Set LOOM_ADX_ALERT_SCOPE to the ADX cluster ARM resource id so Activator rules on Eventhouse/ADX sources get hands-off scheduled evaluation (an Azure Monitor scheduled-query rule scoped to the cluster), and grant the alert identity "Database Viewer" on the target database. Without it, ADX-sourced rules still evaluate on-demand via Trigger; Log Analytics sources evaluate continuously regardless.',
    provisionedBy: 'modules/admin-plane/adx-cluster.bicep (adxEnabled → the ADX cluster) → admin-plane/main.bicep apps[] env LOOM_ADX_ALERT_SCOPE (the cluster ARM id; a BYO cluster resolves via byoExisting) — auto-emitted on a push-button deploy',
    role: 'Database Viewer (alert identity) on the ADX database + Monitoring Contributor (Console UAMI) on LOOM_ALERT_RG',
  },
  {
    id: 'svc-pe-subnet', category: 'security', title: 'Managed private endpoints — PE subnet', severity: 'optional',
    required: ['LOOM_PE_SUBNET_ID'], warnOnMiss: true, derived: true,
    remediation: 'Auto-derived from the network module (snet-private-endpoints) on a push-button deploy. Set LOOM_PE_SUBNET_ID to the ARM id of the private-endpoints subnet so tenant admins can create self-service managed private endpoints (and workspace inbound-protection / outbound PE rules) from the admin Network page. The Console UAMI needs Network Contributor on the networking RG.',
    provisionedBy: 'modules/admin-plane/main.bicep (network.outputs.privateEndpointsSubnetId → apps[] env, auto-derived, line ~2353)',
    role: 'Network Contributor (Console UAMI) on the networking resource group (LOOM_NETWORKING_RG / LOOM_ADMIN_RG)',
  },
  {
    id: 'svc-plan-writeback', category: 'builders', title: 'Plan (preview) — Azure SQL writeback store', severity: 'optional',
    required: ['LOOM_PLAN_BACKING_SQL_SERVER', 'LOOM_PLAN_BACKING_SQL_DATABASE'], warnOnMiss: true, optionalDefault: true,
    remediation: 'Planning cells always persist Loom-native (Cosmos). To ALSO mirror them into a governed Azure SQL store (the Azure-native equivalent of Fabric\'s auto-provisioned Plan SQL database), deploy modules/shared/plan-backing-sql.bicep (or point at an existing DB) and set LOOM_PLAN_BACKING_SQL_SERVER + LOOM_PLAN_BACKING_SQL_DATABASE. Grant the Console UAMI db_ddladmin + db_datawriter on that database (AAD token auth — no SQL password). No Microsoft Fabric required.',
    provisionedBy: 'modules/shared/plan-backing-sql.bicep → admin-plane/main.bicep params loomPlanBackingSqlServer / loomPlanBackingSqlDatabase (apps[] env ~2579)',
    role: 'db_ddladmin + db_datawriter (Console UAMI AAD login) on the writeback database',
  },
  {
    id: 'svc-dab-runtime', category: 'builders', title: 'Data API builder — shared preview runtime', severity: 'optional',
    required: ['LOOM_DAB_PREVIEW_URL'], warnOnMiss: true, derived: true,
    remediation: 'Auto-wired on a push-button deploy (dabRuntimeEnabled, default on): the loom-dab-preview Container App URL lands in LOOM_DAB_PREVIEW_URL. It powers the DAB editor\'s live REST/GraphQL testers + publish probe, the ontology-sdk "Try it" runner, and Slate rest-dab queries. The builders render fully without it — only run-against-runtime calls are gated.',
    provisionedBy: 'modules/admin-plane/dab-runtime.bicep (dabRuntimeEnabled) → LOOM_DAB_PREVIEW_URL apps[] env (admin-plane/main.bicep ~3650)',
    role: 'none (HTTP endpoint); entity queries additionally need the Console UAMI SQL login — scripts/csa-loom/grant-dab-sql.sh',
  },
  {
    id: 'svc-udf-function', category: 'builders', title: 'User data functions — Azure Functions run target', severity: 'optional',
    required: ['LOOM_UDF_FUNCTION_BASE'], warnOnMiss: true,
    remediation: 'Set LOOM_UDF_FUNCTION_BASE to the shared Loom UDF runtime (or an Azure Function App) base URL (e.g. https://my-udf.azurewebsites.net) — the Azure-native invoke backend. The invoke route forwards the item\'s authored source (x-udf-source-b64) so the shared runtime executes THIS function, not a bundled sample. A per-item state.azureFunctionUrl overrides the base URL; a Fabric backend is opt-in ONLY via LOOM_UDF_BACKEND=fabric. The editor + code authoring work without it — only Invoke is gated.',
    provisionedBy: 'modules/admin-plane/udf-runtime.bicep (udfRuntimeEnabled, default on → the loom-udf-runtime Container App) → admin-plane/main.bicep apps[] env LOOM_UDF_FUNCTION_BASE (a BYO Functions host overrides via loomUdfFunctionBase); POST /api/items/user-data-function/[id]/invoke reads it',
    role: 'none (HTTPS endpoint); if the function requires a key, set state.functionKeySecret to the Key Vault secret name',
  },
  {
    id: 'svc-onelake-acl', category: 'security', title: 'OneLake security roles — ADLS ACL enforcement', severity: 'optional',
    required: ['LOOM_ONELAKE_SECURITY_ACL'], warnOnMiss: true,
    remediation: 'Set LOOM_ONELAKE_SECURITY_ACL=true so lakehouse OneLake-security roles are ENFORCED as real ADLS Gen2 POSIX ACLs on the Delta folders (deploy admin-plane + synapse.bicep with loomOnelakeSecurityEnabled=true). Requires the Console UAMI to hold "Storage Blob Data Owner" on the DLZ storage account and the LOOM_{LANDING,BRONZE,SILVER,GOLD}_URL container URLs to be set. Role definitions still author + persist without it — only ACL enforcement is gated.',
    provisionedBy: 'modules/admin-plane/main.bicep (param loomOnelakeSecurityEnabled → LOOM_ONELAKE_SECURITY_ACL, ~3484) + modules/landing-zone/synapse.bicep (Storage Blob Data Owner grant)',
    role: 'Storage Blob Data Owner (Console UAMI) on the DLZ storage account',
  },
  {
    id: 'svc-audit-siem-stream', category: 'security', title: 'SIEM audit stream — LoomAudit_CL DCR (BR-SIEM)', severity: 'optional',
    required: ['LOOM_AUDIT_DCR_ENDPOINT', 'LOOM_AUDIT_DCR_ID'], warnOnMiss: true,
    // Default-ON / opt-out (loom_default_on_opt_out): audit logging is fully ON
    // via the built-in Cosmos audit trail (/admin/audit-logs) regardless of these
    // vars — emitAuditEvent() silently no-ops when the DCR is unset, losing ZERO
    // audit records. The DCR only ADDS an optional external mirror (streaming to
    // the LoomAudit_CL table for Microsoft Sentinel / any SIEM). So an unset DCR
    // is the fully-functional intended default, not a gap. Marked optionalDefault.
    optionalDefault: true,
    optionalDefaultDetail: 'every admin-plane mutation is recorded in the built-in Cosmos audit trail (/admin/audit-logs). Setting LOOM_AUDIT_DCR_ENDPOINT + LOOM_AUDIT_DCR_ID additionally MIRRORS each event to the LoomAudit_CL table for Microsoft Sentinel / any SIEM.',
    remediation: 'Set LOOM_AUDIT_DCR_ENDPOINT (the DCE logs-ingestion endpoint) + LOOM_AUDIT_DCR_ID (the DCR immutable id) so every admin-plane mutation streams to the LoomAudit_CL custom table via the Azure Monitor Logs Ingestion API, where Microsoft Sentinel / any SIEM can alert continuously (docs/fiab/operations/siem-audit-stream.md). The push-button deploy wires both from modules/admin-plane/audit-stream.bicep. Without them the emitter silently no-ops — the Cosmos audit trail on /admin/audit-logs is unaffected. The Console UAMI needs "Monitoring Metrics Publisher" on the DCR (granted by the module).',
    provisionedBy: 'modules/admin-plane/audit-stream.bicep (DCE + DCR + LoomAudit_CL table) → admin-plane/main.bicep apps[] env LOOM_AUDIT_DCR_ENDPOINT / LOOM_AUDIT_DCR_ID',
    role: 'Monitoring Metrics Publisher (Console UAMI) on the audit DCR',
  },
  {
    id: 'svc-azure-maps', category: 'azure-services', title: 'Azure Maps (map visuals / Geo)', severity: 'optional',
    required: ['LOOM_MAPS_BACKEND'],
    anyOf: [['LOOM_AZURE_MAPS_CLIENT_ID', 'LOOM_AZURE_MAPS_KEY']],
    warnOnMiss: true,
    remediation: 'Set LOOM_MAPS_BACKEND=azure-maps plus a credential: LOOM_AZURE_MAPS_CLIENT_ID (the Maps account uniqueId — Entra/AAD path, gov-safe, PREFERRED; grant the Console UAMI "Azure Maps Data Reader") or LOOM_AZURE_MAPS_KEY (subscription key, Commercial only). Lights up the report Map visual + the graph/Geo map canvases; the aggregated location rows render without it. No Power BI / Fabric required.',
    provisionedBy: 'modules/landing-zone/azure-maps.bicep (azureMapsEnabled → Gen2 account + "Azure Maps Data Reader" grant + mapsClientId output)',
    role: 'Azure Maps Data Reader (Console UAMI) on the Maps account',
  },
  // ── Hyperscale band (HYP-16) — the three optional H-band substrate services.
  //    Each is default-OFF/opt-out: unset → the console lib client honest-503
  //    gates and SILENTLY falls back to the existing path (no Fabric gate, no
  //    regression). Deploy compute/hband-shared.bicep (shared Redis + UAMIs) then
  //    the per-service compute/loom-*-app.bicep, and set these on the Console app.
  {
    id: 'svc-loom-onelake', category: 'data-plane', title: 'Loom OneLake — unified namespace service (Hyperscale)', severity: 'optional',
    required: ['LOOM_ONELAKE_URL'], warnOnMiss: true, optionalDefault: true,
    remediation: 'Set LOOM_ONELAKE_URL to the internal-ingress Loom OneLake ACA app (loom://<workspace>/<item>.<type>/<path> namespace + shortcut + security + catalog resolver on ADLS Gen2 + Cosmos — no Microsoft Fabric / OneLake DNS). Deploy compute/loom-onelake-app.bicep on the shared substrate from compute/hband-shared.bicep. Unset → the lakehouse/shortcut/security editors use the existing per-item library path (adls-client / lakehouse-shortcuts / onelake-security-client) with no loss of function.',
    provisionedBy: 'modules/compute/hband-shared.bicep (shared UAMIs + Redis) + modules/compute/loom-onelake-app.bicep (out-of-band; admin-plane at 256-param ceiling) → LOOM_ONELAKE_URL on the Console app',
    role: 'Storage Blob Data Contributor (uami-loom-onelake) on the DLZ lake + Cosmos data-plane on the registry containers',
  },
  {
    id: 'svc-loom-directlake', category: 'data-plane', title: 'Loom Direct Lake — columnar cache/scan engine (Hyperscale)', severity: 'optional',
    required: ['LOOM_DIRECTLAKE_URL'], warnOnMiss: true, optionalDefault: true,
    remediation: 'Set LOOM_DIRECTLAKE_URL to the internal-ingress Loom Direct Lake ACA app (Arrow + delta-rs framing/transcoding + DuckDB/DataFusion scan; the OSS outcome-equivalent of Direct Lake — no VertiPaq, no Power BI). Also set LOOM_SEMANTIC_BACKEND=loom-columnar-cache to route DAX-class queries to it. Deploy compute/loom-directlake-app.bicep on compute/hband-shared.bicep. Unset → the semantic-model / report layer uses the AAS fast-path or the Synapse-Serverless cold path unchanged.',
    provisionedBy: 'modules/compute/hband-shared.bicep (uami-loom-directlake + shared Redis) + modules/compute/loom-directlake-app.bicep (out-of-band) → LOOM_DIRECTLAKE_URL on the Console app',
    role: 'Storage Blob Data Reader (uami-loom-directlake) on the DLZ lake; Redis Data Contributor on the shared cache (wired by hband-shared.bicep)',
  },
  {
    id: 'svc-loom-capacity-broker', category: 'azure-services', title: 'Loom Capacity Broker — LCU admission control (Hyperscale)', severity: 'optional',
    required: ['LOOM_BROKER_URL', 'LOOM_BROKER_REDIS'], warnOnMiss: true, optionalDefault: true,
    remediation: 'Set LOOM_BROKER_URL to the internal-ingress Loom Capacity Broker ACA app (synchronous POST /admit choke-point + smoothing/bursting/4-stage-throttle over an LCU timepoint ledger) and LOOM_BROKER_REDIS to <hband-redis-host>:6380 (the shared Azure Cache for Redis Premium ledger from compute/hband-shared.bicep). Deploy compute/loom-capacity-broker-app.bicep. Unset → job submission proceeds UNTHROTTLED with a MessageBar (default-ON posture — the broker constrains, it never blocks the platform if absent).',
    provisionedBy: 'modules/compute/hband-shared.bicep (uami-loom-capacity-broker + shared Redis timepoint ledger) + modules/compute/loom-capacity-broker-app.bicep (out-of-band) → LOOM_BROKER_URL / LOOM_BROKER_REDIS on the Console app',
    role: 'none (uami-loom-capacity-broker holds ZERO data-plane roles — it gates the caller, never proxies; Redis Data Contributor on the shared cache is wired by hband-shared.bicep)',
  },
  // ── wave-3 coverage (G2 gate registry): every remaining bespoke
  //    *_not_configured gate promoted into the declarative registry. Each spec
  //    makes its vars editable on /admin/env-config (EDITABLE_ENV derives from
  //    THESE), audited here, and resolvable from /admin/gates + the Fix-it
  //    wizard. All optional/warnOnMiss — a fresh minimal deploy is all-gates,
  //    zero-fails. Canonical producers: the per-client *ConfigGate() helpers. ──
  {
    id: 'svc-mip', category: 'security', title: 'Microsoft Information Protection (sensitivity labels)', severity: 'optional',
    required: ['LOOM_MIP_ENABLED'], warnOnMiss: true,
    remediation: 'Set LOOM_MIP_ENABLED=true and grant the Console UAMI Graph InformationProtectionPolicy.Read.All so label pickers read the tenant\'s real MIP labels (mip_not_configured). Loom-native labels work without it.',
    provisionedBy: 'modules/admin-plane/main.bicep (apps[] env) + post-deploy Graph grant',
    role: 'Microsoft Graph InformationProtectionPolicy.Read.All (application) on the Console UAMI',
  },
  {
    id: 'svc-dlp', category: 'security', title: 'Data Loss Prevention (Purview DLP)', severity: 'optional',
    anyOf: [['LOOM_DLP_ENABLED', 'LOOM_DLP_ADMIN_ENABLED']], warnOnMiss: true,
    remediation: 'Set LOOM_DLP_ENABLED=true (+ LOOM_DLP_ADMIN_ENABLED=true for the admin DLP panes) and grant the Graph DLP application roles so DLP policy surfaces drive the real Purview DLP plane (dlp_not_configured / dlp_admin_not_configured). The Loom-native policy library works without it.',
    provisionedBy: 'modules/admin-plane/main.bicep (apps[] env) + post-deploy Graph grant',
    role: 'Purview DLP Graph application roles on the Console UAMI',
  },
  {
    id: 'svc-purview-uc', category: 'catalog-governance', title: 'Purview Unified Catalog endpoint', severity: 'optional',
    required: ['LOOM_PURVIEW_UC_ENDPOINT'], warnOnMiss: true,
    remediation: 'Set LOOM_PURVIEW_UC_ENDPOINT (https://<account>.purview.azure.com) so unified-catalog surfaces call the Purview UC data plane. The classic Data Map path (LOOM_PURVIEW_ACCOUNT) works without it.',
    provisionedBy: 'main.bicep (purviewEnabled) → admin-plane apps[] env',
    role: 'Purview Data Map role (Console UAMI) on the root collection',
  },
  {
    id: 'svc-aoai-embeddings', category: 'ai-copilot', title: 'AOAI embeddings deployment (RAG / vector index)', severity: 'optional',
    required: ['LOOM_AOAI_EMBED_DEPLOYMENT'], warnOnMiss: true,
    remediation: 'Set LOOM_AOAI_EMBED_DEPLOYMENT (e.g. text-embedding-3-small) so Index-my-data and vector search can embed (embedding_not_configured). Deploy the model from the AI Foundry hub if absent.',
    provisionedBy: 'modules/admin-plane (agentFoundryEnabled → embedding model deployment) → apps[] env',
    role: 'Cognitive Services OpenAI User (UAMI) on the AOAI/Foundry account',
  },
  {
    id: 'svc-databricks-sql', category: 'azure-services', title: 'Databricks SQL warehouse (DQ monitor / MDM / DLP schemas)', severity: 'optional',
    required: ['LOOM_DATABRICKS_SQL_WAREHOUSE_ID'], warnOnMiss: true,
    remediation: 'Set LOOM_DATABRICKS_SQL_WAREHOUSE_ID (with LOOM_DATABRICKS_HOSTNAME) so DQ monitoring, MDM match-merge, and governance DLP schema surfaces run against a real Databricks SQL warehouse (warehouseConfigGate). Synapse covers the warehouse item type without it.',
    provisionedBy: 'modules/landing-zone (Databricks workspace + SQL warehouse) → apps[] env',
    role: 'Databricks SQL access (Console UAMI, SCIM-provisioned)',
  },
  {
    id: 'svc-synapse-spark-pool', category: 'azure-services', title: 'Synapse Spark pool (ML predict / scheduled runs)', severity: 'optional',
    required: ['LOOM_SYNAPSE_SPARK_POOL'], warnOnMiss: true,
    remediation: 'Set LOOM_SYNAPSE_SPARK_POOL (e.g. loompool) so ml-model predict and scheduled job run-adapters have a Spark compute target (synapse_spark_pool_not_configured).',
    provisionedBy: 'modules/landing-zone/synapse.bicep (Spark pool) → apps[] env LOOM_SYNAPSE_SPARK_POOL',
    role: 'Synapse Administrator (UAMI) on the workspace',
  },
  {
    id: 'svc-cosmos-control', category: 'data-plane', title: 'Cosmos DB control plane (versions / scaling / CMK)', severity: 'optional',
    required: ['LOOM_COSMOS_ACCOUNT'], anyOf: [['LOOM_DLZ_RG', 'LOOM_ADMIN_RG']], warnOnMiss: true,
    remediation: 'Set LOOM_COSMOS_ACCOUNT (+ the RG vars) so ARM control-plane operations (account scaling, CMK, item version restore) can target the Cosmos account (cosmosConfigGate). Distinct from the data-plane LOOM_COSMOS_ENDPOINT gate — both are needed for full coverage.',
    provisionedBy: 'modules/landing-zone/main.bicep (cosmos account) → apps[] env LOOM_COSMOS_ACCOUNT',
    role: 'Cosmos DB Operator / Contributor (Console UAMI) on the account',
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
  },
  {
    id: 'svc-airflow', category: 'builders', title: 'Managed Airflow (airflow-job items)', severity: 'optional',
    required: ['LOOM_AIRFLOW_ENDPOINT'], warnOnMiss: true,
    remediation: 'Set LOOM_AIRFLOW_ENDPOINT to the Airflow web endpoint so the airflow-job editor drives real DAG runs (airflow.bicep deploys it).',
    provisionedBy: 'modules/deploy-planner/airflow.bicep → apps[] env LOOM_AIRFLOW_ENDPOINT',
    role: 'Airflow API access (Console UAMI / basic auth via Key Vault)',
  },
  {
    id: 'svc-copyjob-control', category: 'builders', title: 'Copy job — watermark control store (Azure SQL)', severity: 'optional',
    required: ['LOOM_COPYJOB_CONTROL_SQL_SERVER'], warnOnMiss: true,
    remediation: 'Set LOOM_COPYJOB_CONTROL_SQL_SERVER (the Azure SQL logical server) so incremental copy jobs persist watermarks (copyjob_control_not_configured). Full-load copy jobs work without it.',
    provisionedBy: 'modules/shared/plan-backing-sql.bicep (shared control SQL) → apps[] env',
    role: 'db_datawriter (Console UAMI AAD login) on the control database',
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
    id: 'svc-weave-ontology', category: 'builders', title: 'Weave ontology store (Postgres)', severity: 'optional',
    required: ['LOOM_WEAVE_PG_FQDN'], warnOnMiss: true,
    remediation: 'Set LOOM_WEAVE_PG_FQDN so the Weave ontology store persists to its governed Postgres database (weave_ontology_not_configured).',
    provisionedBy: 'modules/deploy-planner/postgres-flexible.bicep → apps[] env LOOM_WEAVE_PG_FQDN',
    role: 'Entra AAD login (Console UAMI) on the server',
  },
  {
    id: 'svc-dbt', category: 'builders', title: 'dbt runner (dbt-project items)', severity: 'optional',
    required: ['LOOM_DBT_RUNNER_URL'], warnOnMiss: true,
    remediation: 'Set LOOM_DBT_RUNNER_URL to the deployed loom-dbt-runner Container App so dbt projects execute real runs (dbt_not_configured). Authoring works without it.',
    provisionedBy: 'modules/compute/dbt-runner-app.bicep → apps[] env LOOM_DBT_RUNNER_URL',
    role: 'none (in-VNet HTTP endpoint)',
  },
  {
    id: 'svc-approval-logicapp', category: 'builders', title: 'Pipeline approvals — Logic App', severity: 'optional',
    required: ['LOOM_APPROVAL_LOGIC_APP_NAME'], warnOnMiss: true,
    remediation: 'Set LOOM_APPROVAL_LOGIC_APP_NAME (+ LOOM_SUBSCRIPTION_ID) so pipeline approval activities trigger the real approval Logic App (approval_not_configured).',
    provisionedBy: 'modules/admin-plane/approval-logicapp.bicep → apps[] env',
    role: 'Logic App Contributor (Console UAMI) on the app',
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
    id: 'svc-sample-data', category: 'builders', title: 'Sample data seeds (Learning Hub / practice pipelines)', severity: 'optional',
    anyOf: [['LOOM_SAMPLE_ADLS', 'LOOM_ADLS_ACCOUNT']], warnOnMiss: true,
    remediation: 'Set LOOM_SAMPLE_ADLS (falls back to the DLZ account) so use-case app installs and practice pipelines seed real sample data (sample_adls_not_configured).',
    provisionedBy: 'modules/landing-zone/storage.bicep (samples container) → apps[] env',
    role: 'Storage Blob Data Contributor (UAMI)',
  },
  {
    id: 'svc-csv-imports', category: 'builders', title: 'Data products — CSV import store', severity: 'optional',
    required: ['LOOM_CSV_IMPORTS_URL'], warnOnMiss: true,
    remediation: 'Set LOOM_CSV_IMPORTS_URL (a Blob container URL) so data-product CSV imports have a landing store (csv_imports_not_configured).',
    provisionedBy: 'modules/landing-zone/storage.bicep (csv-imports container) → apps[] env',
    role: 'Storage Blob Data Contributor (UAMI) on the container',
  },
  {
    id: 'svc-eh-schema-registry', category: 'azure-services', title: 'Event Hubs schema registry (event-schema-set)', severity: 'optional',
    required: ['LOOM_EH_SCHEMA_GROUP'], warnOnMiss: true,
    remediation: 'Set LOOM_EH_SCHEMA_GROUP (a schema group in the Event Hubs namespace) so event-schema-set items manage real registry schemas (schema_registry_not_configured).',
    provisionedBy: 'modules/landing-zone (Event Hubs namespace schema group) → apps[] env',
    role: 'Schema Registry Contributor (UAMI) on the namespace',
  },
  {
    id: 'svc-workspace-identity', category: 'security', title: 'Workspace identity (per-workspace UAMI)', severity: 'optional',
    anyOf: [['LOOM_WS_IDENTITY_SUB', 'LOOM_SUBSCRIPTION_ID']], warnOnMiss: true,
    remediation: 'Set LOOM_WS_IDENTITY_SUB (falls back to LOOM_SUBSCRIPTION_ID) so workspace-identity creation provisions real per-workspace UAMIs (workspace_identity_not_configured).',
    provisionedBy: 'modules/admin-plane/main.bicep (apps[] env)',
    role: 'Managed Identity Contributor (Console UAMI) on the identity RG',
  },
  {
    id: 'svc-dataverse', category: 'azure-services', title: 'Dataverse (Power Platform tables)', severity: 'optional',
    required: ['LOOM_DATAVERSE_CLIENT_ID', 'LOOM_DATAVERSE_CLIENT_SECRET'], warnOnMiss: true,
    remediation: 'Set LOOM_DATAVERSE_CLIENT_ID + LOOM_DATAVERSE_CLIENT_SECRET (an S2S app registered in the Power Platform environment) so Dataverse table browsing works (dataverse_not_configured). Requires the operator-run Power Platform SP grant (scripts/csa-loom/grant-powerplatform-sp.sh).',
    provisionedBy: 'operator-run scripts/csa-loom/grant-powerplatform-sp.sh + Key Vault secret → apps[] env',
    role: 'Power Platform environment application user (S2S app)',
  },
  {
    id: 'svc-feedback-forwarding', category: 'builders', title: 'Feedback forwarding (GitHub issues)', severity: 'optional',
    required: ['LOOM_FEEDBACK_GITHUB_TOKEN'], warnOnMiss: true,
    remediation: 'Set LOOM_FEEDBACK_GITHUB_TOKEN (fine-grained PAT, Key Vault-sourced) so in-product feedback forwards to GitHub issues. The in-store feedback inbox works without it.',
    provisionedBy: 'ACA secret loom-feedback-github-token → apps[] env',
    role: 'GitHub fine-grained PAT (issues:write on the target repo)',
  },
  {
    id: 'svc-m365-link', category: 'enrichment', title: 'Workspace ↔ Microsoft 365 group link', severity: 'optional',
    required: ['LOOM_WORKSPACE_M365_LINK'], warnOnMiss: true,
    remediation: 'Set LOOM_WORKSPACE_M365_LINK=true and grant the Console UAMI Graph Group.ReadWrite.All so workspaces can bind to an M365 group for membership sync. Loom-native workspace roles work without it.',
    provisionedBy: 'modules/admin-plane/main.bicep (apps[] env) + post-deploy Graph grant',
    role: 'Microsoft Graph Group.ReadWrite.All (application) on the Console UAMI',
  },
  {
    id: 'svc-sharepoint-shortcuts', category: 'enrichment', title: 'OneDrive / SharePoint shortcuts', severity: 'optional',
    required: ['LOOM_SHAREPOINT_SHORTCUTS_ENABLED'], warnOnMiss: true,
    remediation: 'Set LOOM_SHAREPOINT_SHORTCUTS_ENABLED=true and grant the Console UAMI the Graph Files.Read.All app role so lakehouse shortcuts can browse OneDrive/SharePoint drives (graph_drive_not_configured). ADLS/S3 shortcuts work without it.',
    provisionedBy: 'modules/admin-plane/main.bicep (apps[] env) + post-deploy Graph grant',
    role: 'Microsoft Graph Files.Read.All (application) on the Console UAMI',
  },
  {
    id: 'svc-iq-mcp', category: 'ai-copilot', title: 'Fabric IQ MCP bridge', severity: 'optional',
    required: ['LOOM_IQ_MCP_ENABLED'], warnOnMiss: true,
    remediation: 'Set LOOM_IQ_MCP_ENABLED=true (+ LOOM_IQ_MCP_TOKEN when the bridge requires auth) so the IQ MCP panel exposes the ontology tools to Copilot. The built-in Loom tools work without it.',
    provisionedBy: 'modules/admin-plane (built-in MCP Container App) → apps[] env',
    role: 'none (HTTP endpoint; token via Key Vault when set)',
  },
  {
    id: 'svc-param-sources', category: 'builders', title: 'Pipeline parameter sources (Key Vault / App Config)', severity: 'optional',
    anyOf: [['LOOM_PARAM_KEYVAULT', 'LOOM_PARAM_APPCONFIG']], warnOnMiss: true,
    remediation: 'Set LOOM_PARAM_KEYVAULT (vault URI) and/or LOOM_PARAM_APPCONFIG (App Configuration endpoint) so pipeline parameters and trigger wizards can bind to secret/config sources. Inline parameters work without it.',
    provisionedBy: 'modules/admin-plane/main.bicep (Key Vault / App Config) → apps[] env',
    role: 'Key Vault Secrets User / App Configuration Data Reader (Console UAMI)',
  },
  {
    id: 'svc-data-wrangler', category: 'builders', title: 'Data Wrangler runtime', severity: 'optional',
    required: ['LOOM_WRANGLER_ENDPOINT'], warnOnMiss: true,
    remediation: 'Set LOOM_WRANGLER_ENDPOINT to the deployed loom-wrangler Container App so the Data Wrangler panel executes real transform previews. The notebook path works without it.',
    provisionedBy: 'modules/compute/wrangler-app.bicep → apps[] env LOOM_WRANGLER_ENDPOINT',
    role: 'none (in-VNet HTTP endpoint)',
  },
  {
    id: 'svc-medallion-layers', category: 'data-plane', title: 'Medallion layer URLs (Silver / Gold)', severity: 'optional',
    anyOf: [['LOOM_SILVER_URL', 'LOOM_GOLD_URL', 'LOOM_ADLS_ACCOUNT']], warnOnMiss: true,
    remediation: 'Set LOOM_SILVER_URL + LOOM_GOLD_URL (ADLS container URLs; derived from LOOM_ADLS_ACCOUNT when unset) so medallion-aware surfaces (direct-lake, dataflow runs, onelake paths) resolve every layer (gold_url_not_configured).',
    provisionedBy: 'modules/landing-zone/storage.bicep (silver/gold containers) → apps[] env',
    role: 'Storage Blob Data Contributor (UAMI) on the containers',
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
    id: 'svc-apim', category: 'builders', title: 'API Management (publish-as-API / API marketplace)', severity: 'optional',
    anyOf: [['LOOM_APIM_NAME', 'LOOM_APIM_RG', 'LOOM_SUBSCRIPTION_ID']], warnOnMiss: true,
    remediation: 'Set LOOM_SUBSCRIPTION_ID (LOOM_APIM_NAME / LOOM_APIM_RG default to the deployment names) so publish-as-API and the API marketplace can target the APIM service. The probe verifies the service actually resolves.',
    provisionedBy: 'modules/admin-plane (apimEnabled → APIM service) → apps[] env LOOM_APIM_NAME / LOOM_APIM_RG',
    role: 'API Management Service Contributor (Console UAMI) on the service',
  },
  {
    id: 'svc-powerplatform', category: 'azure-services', title: 'Power Platform control plane (power-* items / Copilot Studio)', severity: 'optional',
    required: ['LOOM_UAMI_CLIENT_ID'], warnOnMiss: true,
    remediation: 'The Power Platform BAP API authenticates as the Console UAMI (LOOM_UAMI_CLIENT_ID) — a Power Platform admin must also register it as a management app (New-PowerAppManagementApp; scripts/csa-loom/grant-powerplatform-sp.ps1). The live probe surfaces the known SP-not-allowed 403 with the exact one-time fix.',
    provisionedBy: 'modules/admin-plane/main.bicep (uami-console → apps[] env) + operator-run PP management-app registration',
    role: 'Power Platform management application (tenant admin registration) + Environment Admin where environments are managed',
  },
  {
    id: 'svc-keyvault', category: 'security', title: 'Key Vault (connection / shortcut / MCP secrets)', severity: 'recommended',
    anyOf: [['LOOM_KEY_VAULT_URI', 'LOOM_KEY_VAULT_URL', 'LOOM_KEY_VAULT_NAME', 'LOOM_SHORTCUT_KEYVAULT']], warnOnMiss: true,
    remediation: 'Set LOOM_KEY_VAULT_URI (or LOOM_KEY_VAULT_NAME) so shortcut external-source credentials, Git PATs, and MCP server secrets have a secret store. Grant the Console UAMI "Key Vault Secrets Officer" on the vault.',
    provisionedBy: 'modules/admin-plane/main.bicep (Key Vault + RBAC grant → apps[] env LOOM_KEY_VAULT_URI, auto-derived)',
    role: 'Key Vault Secrets Officer (Console UAMI) on the vault',
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
  {
    id: 'svc-redis-result-cache', category: 'data-plane', title: 'Result-cache Redis (ADX / query result cache)', severity: 'optional',
    required: ['LOOM_RESULT_CACHE_REDIS'], warnOnMiss: true, optionalDefault: true,
    optionalDefaultDetail: 'query result caching runs on the built-in in-memory per-replica cache with zero loss of function. Set LOOM_RESULT_CACHE_REDIS (the shared Azure Cache for Redis host) only to make the cache shared across Console replicas.',
    remediation: 'Set LOOM_RESULT_CACHE_REDIS to <redis-host>:6380 (the shared H-band Azure Cache for Redis) to upgrade the per-replica in-memory result cache to a shared cross-replica cache. Optional scale-out — the in-memory default is fully functional.',
    provisionedBy: 'modules/compute/hband-shared.bicep (shared Redis) → LOOM_RESULT_CACHE_REDIS on the Console app',
    role: 'Redis access key from Key Vault (LOOM_RESULT_CACHE_REDIS_PASSWORD secretRef) or AAD data-plane per module wiring',
  },
  {
    id: 'perf-spark-warm-pool-store', category: 'data-plane', title: 'Warm Spark pool — cross-replica lease store (PSR-3)', severity: 'optional',
    anyOf: [['LOOM_SPARK_POOL_LEASE_CONTAINER', 'LOOM_SPARK_POOL_REDIS']], warnOnMiss: true,
    remediation: 'The warm Spark session pool is DEFAULT-ON (instant notebook attach on a warm hit; opt out with LOOM_SPARK_POOL_ENABLED=0 or the /admin/performance kill switch). To make warm sessions SHARED across Console replicas, signal the shared H-band substrate: set LOOM_SPARK_POOL_REDIS to the shared Azure Cache for Redis host from compute/hband-shared.bicep (same value as LOOM_BROKER_REDIS), or set LOOM_SPARK_POOL_LEASE_CONTAINER to a Cosmos container name. Either turns on the cross-replica lease registry (the Cosmos spark-warm-leases container). Unset → the pool runs per-replica (still fully functional, just not shared).',
    provisionedBy: 'modules/landing-zone/cosmos.bicep (loomContainers → spark-warm-leases) + modules/compute/hband-shared.bicep (shared Redis substrate) → LOOM_SPARK_POOL_REDIS / LOOM_SPARK_POOL_LEASE_CONTAINER on the Console app',
    role: 'Cosmos DB Built-in Data Contributor (Console UAMI, already granted) on the loom database — the lease registry is a Cosmos container, no extra grant',
  },
];

