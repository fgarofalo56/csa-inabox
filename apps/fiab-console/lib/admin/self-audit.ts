/**
 * CSA Loom self-audit / health engine.
 *
 * A self-review of the running console: does it actually have everything it
 * needs — identity, data plane, the Azure services each workload calls,
 * permissions, and security posture — wired, deployed, and reachable?
 *
 * Every check is REAL (per .claude/rules/no-vaporware.md):
 *   - env-presence checks ARE the real feature gates (the per-client
 *     *ConfigGate() helpers check exactly these vars),
 *   - live probes hit the actual service (Cosmos / AOAI) and detect 401/403,
 *   - the bootstrap-admin check mirrors lib/auth/feature-gate.isTenantAdmin.
 *
 * Each result carries a precise remediation. Where the fix is safe to apply
 * from the running console identity (e.g. createIfNotExists the Cosmos
 * containers) it exposes a `fixId` the healer can apply with admin approval.
 * Deploy-time fixes (env vars, RBAC grants needing elevated rights) are NOT
 * faked — they return the exact command / bicep param + redeploy:true so the
 * healer surfaces it for the admin instead of pretending to fix it.
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
  | 'ai-copilot';

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
  // ── new surfaces / data-plane day-one config (this expansion) ──
  LOOM_DATABRICKS_HOSTNAME: 'adb-<workspace-id>.<n>.azuredatabricks.net',
  LOOM_PURVIEW_UC_ENDPOINT: 'https://<purview-account>.purview.azure.com',
  LOOM_DLP_ENABLED: 'true',
  // MCP catalog deploy backend (Container Apps env the deploy route mounts into).
  LOOM_ACA_ENV_ID: '/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.App/managedEnvironments/<aca-env>',
  LOOM_ACA_ENV_DOMAIN: '<aca-env-default-domain>.<region>.azurecontainerapps.io',
  LOOM_BUILTIN_MCP_URL: 'https://<loom-builtin-mcp-host>',
};

/** Pick the concrete env vars an admin should set from a missing-list that may
 * contain `A | B` anyOf groups — choose the first (preferred) var of each group. */
function varsToSet(missing: string[]): string[] {
  return missing.map((m) => (m.includes(' | ') ? m.split(' | ')[0].trim() : m.trim()));
}

/** Build portal steps + a pre-filled PowerShell snippet that sets the given env
 * vars on the Console container app (the most common Loom fix). */
function envVarFix(vars: string[]): { portalSteps: string[]; fixScript: string } {
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
}

function evalEnv(spec: EnvSpec): CheckResult {
  const missing: string[] = [];
  for (const k of spec.required || []) if (!has(k)) missing.push(k);
  for (const group of spec.anyOf || []) if (!group.some(has)) missing.push(group.join(' | '));
  const ok = missing.length === 0;
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
    anyOf: [['LOOM_AOAI_ENDPOINT', 'LOOM_FOUNDRY_PROJECT_ENDPOINT', 'LOOM_FOUNDRY_ENDPOINT']], warnOnMiss: true,
    remediation: 'Set LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT (or a Foundry project endpoint) so Copilot, the help agent, and data agents have a model. Deploy a model from the AI Foundry hub if none exists.',
    provisionedBy: 'modules/admin-plane (agentFoundryEnabled / aiFoundryEnabled) → AIServices account + project → apps[] env',
    role: 'Cognitive Services OpenAI User (UAMI) on the AOAI/Foundry account',
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
];

// ── live probes (best-effort; bounded) ──────────────────────────────────────
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms}ms`)), ms)),
  ]);
}

async function probeCosmos(): Promise<CheckResult> {
  const base = { id: 'probe-cosmos', category: 'data-plane' as const, title: 'Cosmos reachable + containers present', severity: 'critical' as const };
  if (!anyHas('LOOM_COSMOS_ENDPOINT', 'COSMOS_ENDPOINT')) {
    return { ...base, status: 'fail', detail: 'Cosmos endpoint not configured.', remediation: 'Set LOOM_COSMOS_ENDPOINT first.', redeploy: true };
  }
  try {
    const { featurePermissionsContainer } = await import('@/lib/azure/cosmos-client');
    await withTimeout(featurePermissionsContainer(), 8000); // triggers ensure() → createIfNotExists all
    return { ...base, status: 'pass', detail: 'Cosmos reachable; Loom containers present (createIfNotExists OK).' };
  } catch (e: any) {
    const msg = e?.message || String(e);
    const denied = /403|forbidden|not authorized/i.test(msg);
    const grantScript = [
      '# Grant the Console managed identity data-plane read/write on Cosmos.',
      '# Cosmos DB data-plane RBAC is assigned via CLI/ARM (NOT the portal IAM blade). Run in Cloud Shell / pwsh.',
      `az account set --subscription "${CTX.sub}"`,
      `$pid = az ad sp show --id "${CTX.uamiClientId}" --query id -o tsv`,
      `az cosmosdb sql role assignment create --account-name "${CTX.cosmosAccount}" --resource-group "${CTX.dlzRg}" --role-definition-id "00000000-0000-0000-0000-000000000002" --principal-id $pid --scope "/"`,
    ].join('\n');
    return {
      ...base, status: 'fail',
      detail: `Cosmos probe failed: ${msg}`,
      remediation: denied
        ? 'Grant the Console UAMI (LOOM_UAMI_CLIENT_ID) the "Cosmos DB Built-in Data Contributor" role on the account so it can read/write containers.'
        : 'Verify LOOM_COSMOS_ENDPOINT + network access (private endpoint / firewall) to the Cosmos account.',
      fixId: denied ? undefined : 'ensure-cosmos',
      redeploy: denied,
      portalSteps: denied
        ? [
            'Cosmos DB data-plane RBAC is assigned via CLI/ARM, not the portal Access control (IAM) blade — use the script below.',
            'It assigns the Console UAMI the built-in "Cosmos DB Built-in Data Contributor" role (id ...0002) at account scope.',
            'After it completes, return here and click Re-run audit.',
          ]
        : [
            `Azure portal → Cosmos DB account "${CTX.cosmosAccount}" → Networking.`,
            'Ensure a private endpoint exists for the Console subnet, or the Console outbound IP is allowed by the firewall.',
            'Confirm LOOM_COSMOS_ENDPOINT points at this account, then click Re-run audit.',
          ],
      fixScript: denied ? grantScript : `az account set --subscription "${CTX.sub}"\naz cosmosdb show --name "${CTX.cosmosAccount}" --resource-group "${CTX.dlzRg}" --query "{publicNetworkAccess:publicNetworkAccess, ipRules:ipRules, privateEndpoints:privateEndpointConnections[].name}"`,
    };
  }
}

async function probeAoai(): Promise<CheckResult> {
  const base = { id: 'probe-aoai', category: 'azure-services' as const, title: 'Copilot / agents model reachable', severity: 'recommended' as const };
  // Lazy import to avoid a static cycle with copilot-orchestrator (which
  // registers loom_self_audit → imports this module).
  const { resolveAoaiTarget, NoAoaiDeploymentError } = await import('@/lib/azure/copilot-orchestrator');
  try {
    const t = await withTimeout(resolveAoaiTarget(null), 8000);
    return { ...base, status: 'pass', detail: `AOAI target resolved: ${t.deployment} @ ${t.endpoint}.` };
  } catch (e: any) {
    if (e instanceof NoAoaiDeploymentError) {
      const fix = envVarFix(['LOOM_AOAI_ENDPOINT', 'LOOM_AOAI_DEPLOYMENT']);
      return {
        ...base, status: 'warn',
        detail: 'No AOAI model deployment resolved.',
        remediation: 'Deploy a model from the AI Foundry hub ("Quota + usage" → Deploy gpt-4o-mini), or set LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT. Copilot, the help agent, and data agents all use it.',
        redeploy: true,
        portalSteps: [
          'Azure AI Foundry portal → your hub/project → Deployments → "Deploy model".',
          'Pick a chat model (e.g. gpt-4o-mini), name the deployment, and Deploy.',
          `Then set LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT on the "${CTX.app}" container app (see the env-var portal steps), or use the script.`,
          'Re-run audit once the revision is live.',
        ],
        fixScript: [
          '# Option A — deploy a model with the CLI (replace <aoai-account> + <rg>):',
          `az account set --subscription "${CTX.sub}"`,
          'az cognitiveservices account deployment create --name "<aoai-account>" --resource-group "<rg>" --deployment-name "gpt-4o-mini" --model-name "gpt-4o-mini" --model-version "2024-07-18" --model-format OpenAI --sku-capacity 10 --sku-name "Standard"',
          '',
          '# Option B — point Loom at an existing deployment:',
          fix.fixScript.split('\n').slice(2).join('\n'),
        ].join('\n'),
      };
    }
    return {
      ...base, status: 'warn', detail: `AOAI probe failed: ${e?.message || String(e)}`,
      remediation: 'Verify the Foundry/AOAI endpoint + that the Console UAMI has "Cognitive Services OpenAI User" on the account.',
      redeploy: true,
      portalSteps: [
        'Azure portal → your Azure OpenAI / AI Foundry resource → Access control (IAM).',
        'Add role assignment → role "Cognitive Services OpenAI User".',
        `Assign access to → Managed identity → pick the Console UAMI (client id ${CTX.uamiClientId}). Review + assign.`,
        'Re-run audit (grant propagation can take a minute).',
      ],
      fixScript: [
        '# Grant the Console UAMI "Cognitive Services OpenAI User" on the AOAI/Foundry resource.',
        `az account set --subscription "${CTX.sub}"`,
        `$pid = az ad sp show --id "${CTX.uamiClientId}" --query id -o tsv`,
        'az role assignment create --assignee-object-id $pid --assignee-principal-type ServicePrincipal --role "Cognitive Services OpenAI User" --scope "<aoai-resource-id>"',
      ].join('\n'),
    };
  }
}

// ── live data-plane probes (best-effort; bounded). Each does a REAL check as
//    the Console managed identity and reports configured / role-gated / failing
//    with a precise remediation. Unset env ⇒ optional 'warn', never 'fail'. ────

async function probePurviewDataMap(): Promise<CheckResult> {
  const base = { id: 'probe-purview-datamap', category: 'catalog-governance' as const, title: 'Purview Data Map authorized (Domains mirror)', severity: 'optional' as const };
  if (!has('LOOM_PURVIEW_ACCOUNT')) {
    return {
      ...base, status: 'warn',
      detail: 'Purview not linked — Domains + data quality run Loom-native (Cosmos).',
      remediation: 'Set LOOM_PURVIEW_ACCOUNT to mirror Domains/glossary to a Purview account. Optional — the Domains library works without it.',
      redeploy: true,
    };
  }
  try {
    const { probePurview } = await import('@/lib/azure/purview-client');
    const r = await withTimeout(probePurview(), 8000);
    if (r.reason === 'live') {
      return { ...base, status: 'pass', detail: `Purview Data Map reachable + authorized (account ${r.account}).` };
    }
    if (r.reason === 'role_missing') {
      return {
        ...base, status: 'warn',
        detail: r.message || 'Purview answered 401/403 — the Console UAMI lacks a Data Map role.',
        remediation: 'Grant the Console UAMI "Data Curator" (or "Data Source Administrator") on the Purview root collection: run scripts/csa-loom/grant-purview-datamap-role.sh, or re-run the post-deploy bootstrap ("Grant Purview Data Map role"). Data Map RBAC is assigned in the Purview governance portal / data-plane, not the Azure IAM blade.',
        redeploy: true,
        portalSteps: [
          `Microsoft Purview governance portal → account "${r.account}" → Data map → Collections → root collection → Role assignments.`,
          'Add the Console UAMI (managed identity) as Data Curator (and Data Source Administrator if it will register sources).',
          'Return here and click Re-run audit (role propagation can take a minute).',
        ],
        fixScript: [
          '# Grant the Console UAMI a Purview Data Map role on the root collection.',
          `# Account: ${r.account}. Run scripts/csa-loom/grant-purview-datamap-role.sh, or via the Purview data-plane API.`,
          `az account set --subscription "${CTX.sub}"`,
          `$pid = az ad sp show --id "${CTX.uamiClientId}" --query id -o tsv`,
          'bash scripts/csa-loom/grant-purview-datamap-role.sh "$pid"   # assigns Data Curator on the root collection',
        ].join('\n'),
      };
    }
    // not_configured (with account set) or upstream_error → honest warn.
    return {
      ...base, status: 'warn',
      detail: r.message || `Purview probe returned ${r.reason}.`,
      remediation: 'Verify LOOM_PURVIEW_ACCOUNT names a reachable Purview account and the Console subnet can resolve <account>.purview.azure.{com|us}. Domains work Loom-native meanwhile.',
      redeploy: true,
    };
  } catch (e: any) {
    return {
      ...base, status: 'warn', detail: `Purview probe failed: ${e?.message || String(e)}`,
      remediation: 'Verify LOOM_PURVIEW_ACCOUNT + network reachability to the Purview data plane. Domains work Loom-native without it.',
      redeploy: true,
    };
  }
}

async function probeGovernanceSearchIndex(): Promise<CheckResult> {
  const base = { id: 'probe-search-governance-index', category: 'catalog-governance' as const, title: 'AI Search governance index (loom-governance-items)', severity: 'optional' as const };
  if (!has('LOOM_AI_SEARCH_SERVICE')) {
    return {
      ...base, status: 'warn',
      detail: 'AI Search not configured — the governance catalog falls back to Cosmos.',
      remediation: 'Set LOOM_AI_SEARCH_SERVICE to enable the loom-governance-items index. The governance catalog degrades to Cosmos CONTAINS without it.',
      redeploy: true,
    };
  }
  try {
    const { ensureGovernanceCatalogIndex } = await import('@/lib/azure/governance-catalog-index');
    const r = await withTimeout(ensureGovernanceCatalogIndex(), 8000);
    if (r.ok) {
      return { ...base, status: 'pass', detail: r.created ? 'loom-governance-items index created (was absent) — now present.' : 'loom-governance-items index present on the search service.' };
    }
    const denied = /401|403|forbidden|not authorized/i.test(r.error || '');
    return {
      ...base, status: 'warn',
      detail: `Governance index check failed: ${r.error || 'unknown'}.`,
      remediation: denied
        ? 'Grant the Console UAMI "Search Index Data Contributor" + "Search Service Contributor" on the AI Search service so it can create/read the loom-governance-items index. Or run scripts/csa-loom/ensure-search-index.sh.'
        : 'Verify LOOM_AI_SEARCH_SERVICE + network access to the search service, then re-run. scripts/csa-loom/ensure-search-index.sh provisions the index.',
      redeploy: denied,
      portalSteps: denied
        ? [
            `Azure portal → AI Search service "${env('LOOM_AI_SEARCH_SERVICE')}" → Access control (IAM).`,
            'Add role assignment → "Search Index Data Contributor" AND "Search Service Contributor" → Managed identity → the Console UAMI.',
            'Re-run audit (grant propagation can take a minute).',
          ]
        : undefined,
      fixScript: [
        '# Ensure the loom-governance-items index exists (idempotent).',
        'bash scripts/csa-loom/ensure-search-index.sh',
        '',
        '# If the failure was 401/403, grant the Console UAMI search data-plane RBAC first:',
        `az account set --subscription "${CTX.sub}"`,
        `$pid = az ad sp show --id "${CTX.uamiClientId}" --query id -o tsv`,
        'az role assignment create --assignee-object-id $pid --assignee-principal-type ServicePrincipal --role "Search Index Data Contributor" --scope "<ai-search-resource-id>"',
      ].join('\n'),
    };
  } catch (e: any) {
    return {
      ...base, status: 'warn', detail: `Governance index probe failed: ${e?.message || String(e)}`,
      remediation: 'Verify LOOM_AI_SEARCH_SERVICE + the Console UAMI search RBAC, then re-run. scripts/csa-loom/ensure-search-index.sh provisions the index.',
      redeploy: true,
    };
  }
}

async function probeDatabricks(): Promise<CheckResult> {
  const base = { id: 'probe-databricks', category: 'azure-services' as const, title: 'Databricks reachable (notebooks / SQL / Warp)', severity: 'optional' as const };
  const { databricksConfigGate, listWarehouses } = await import('@/lib/azure/databricks-client');
  if (databricksConfigGate()) {
    return {
      ...base, status: 'warn',
      detail: 'Databricks not configured — Synapse covers the same notebook / SQL workloads.',
      remediation: 'Set LOOM_DATABRICKS_HOSTNAME (workspace hostname, no scheme) to enable Databricks-backed notebooks, SQL, and Warp run targets. Optional — Synapse is an alternative.',
      redeploy: true,
    };
  }
  try {
    await withTimeout(listWarehouses(), 8000);
    return { ...base, status: 'pass', detail: `Databricks reachable + authorized (${env('LOOM_DATABRICKS_HOSTNAME')}).` };
  } catch (e: any) {
    const msg = e?.message || String(e);
    const network = /unauthorized network access|403|ip|private|firewall|access denied/i.test(msg);
    return {
      ...base, status: 'warn',
      detail: `Databricks probe failed: ${msg}`,
      remediation: network
        ? 'Databricks rejected the call as "Unauthorized network access" — the workspace IP access list / private link is blocking the Console outbound. Add a private endpoint for the Console subnet or allow the Console egress IP in the Databricks workspace network settings (issue #1466). Also confirm the Console UAMI is SCIM-provisioned into the workspace.'
        : 'Verify LOOM_DATABRICKS_HOSTNAME and that the Console UAMI is SCIM-provisioned into the Databricks workspace with workspace access.',
      redeploy: true,
      docs: 'https://learn.microsoft.com/azure/databricks/security/network/',
      portalSteps: network
        ? [
            `Azure portal → Databricks workspace (${env('LOOM_DATABRICKS_HOSTNAME')}) → Networking.`,
            'Add a private endpoint for the Console subnet, or add the Console outbound IP to the workspace IP access list.',
            'Confirm the Console UAMI is SCIM-provisioned (Admin Console → Identity and access → Service principals).',
            'Re-run audit.',
          ]
        : undefined,
    };
  }
}

async function probeDeltaSharing(): Promise<CheckResult> {
  const base = { id: 'probe-delta-sharing', category: 'azure-services' as const, title: 'Delta Sharing — inbound providers + publishing', severity: 'recommended' as const };
  if (!has('LOOM_DATABRICKS_HOSTNAME') && !has('LOOM_DATABRICKS_HOSTNAMES')) {
    return {
      ...base, status: 'warn',
      detail: 'Databricks / Unity Catalog not bound — Delta Sharing needs a Databricks workspace.',
      remediation: 'Set LOOM_DATABRICKS_HOSTNAME to enable the Marketplace "Data shares" flow (subscribe to inbound Delta shares from an activation file + publish outbound shares). Delta Sharing is an Azure Databricks Unity Catalog feature (no Fabric dependency).',
      redeploy: true,
    };
  }
  // The grant SQL/script, pre-filled with THIS deployment's UAMI principal — the
  // one-step fix a Databricks metastore admin runs (the UAMI cannot self-grant).
  const grantScript = [
    '# Grant the Console UAMI the Unity Catalog metastore SHARING privileges so the',
    '# Marketplace "Data shares" flow works end-to-end — inbound: CREATE PROVIDER',
    '# (register the share from an activation file) + CREATE CATALOG (subscribe =',
    '# create a catalog from the share so you can query it); outbound: CREATE SHARE',
    '# + CREATE RECIPIENT. Run as a Databricks METASTORE ADMIN (the UAMI cannot',
    '# grant itself). Paste in a Databricks SQL editor / notebook, or use',
    '# scripts/csa-loom/grant-databricks-delta-sharing.sh.',
    `GRANT CREATE PROVIDER  ON METASTORE TO \`${CTX.uamiClientId}\`;`,
    `GRANT CREATE CATALOG   ON METASTORE TO \`${CTX.uamiClientId}\`;`,
    `GRANT CREATE SHARE     ON METASTORE TO \`${CTX.uamiClientId}\`;`,
    `GRANT CREATE RECIPIENT ON METASTORE TO \`${CTX.uamiClientId}\`;`,
  ].join('\n');
  const portalSteps = [
    `Open the Databricks workspace SQL editor (or a notebook) as a metastore admin: https://${env('LOOM_DATABRICKS_HOSTNAME')}.`,
    'Run the three GRANT statements below (they grant the Console UAMI CREATE PROVIDER / SHARE / RECIPIENT on the metastore).',
    'Inbound (adding a share from an activation file) needs CREATE PROVIDER; publishing outbound needs CREATE SHARE + CREATE RECIPIENT.',
    'Return here and click Re-run audit — this check turns green once the grant lands.',
  ];
  let r: import('@/lib/azure/unity-catalog-client').DeltaSharingReadiness;
  try {
    const { deltaSharingReadiness } = await import('@/lib/azure/unity-catalog-client');
    r = await withTimeout(deltaSharingReadiness(), 8000);
  } catch (e: any) {
    return {
      ...base, status: 'warn',
      detail: `Delta Sharing readiness probe failed: ${e?.message || String(e)}`,
      remediation: 'Confirm the Console UAMI is SCIM-provisioned into the Databricks workspace and the workspace is reachable, then grant the metastore sharing privileges (below).',
      redeploy: true, portalSteps, fixScript: grantScript,
    };
  }
  if (r.reason === 'not_configured') {
    return { ...base, status: 'warn', detail: r.message || 'Databricks not bound.', remediation: 'Set LOOM_DATABRICKS_HOSTNAME to enable Delta Sharing.', redeploy: true };
  }
  if (r.reason === 'unreachable') {
    return { ...base, status: 'warn', detail: r.message || 'Unity Catalog metastore unreachable.', remediation: 'Verify the workspace is network-reachable and the Console UAMI is SCIM-provisioned into it.', redeploy: true, docs: 'https://learn.microsoft.com/azure/databricks/data-sharing/' };
  }
  if (r.reason === 'ready') {
    return {
      ...base, status: 'pass',
      detail: `Delta Sharing ready on metastore '${r.metastoreName}' — the Console UAMI can add inbound providers (activation-file shares) and publish outbound shares/recipients. Open (token) sharing scope: ${r.externalSharingEnabled ? 'enabled (INTERNAL_AND_EXTERNAL)' : 'internal-only'}.`,
      docs: 'https://learn.microsoft.com/azure/databricks/data-sharing/',
    };
  }
  // privileges_missing — the live error the operator hit (CREATE PROVIDER denied).
  const p = r.privileges;
  return {
    ...base, status: 'warn',
    detail: `The Console UAMI lacks Unity Catalog metastore sharing privileges on '${r.metastoreName || 'the metastore'}' (CREATE PROVIDER: ${p.createProvider ? 'yes' : 'NO'}, CREATE CATALOG: ${p.createCatalog ? 'yes' : 'NO'}, CREATE SHARE: ${p.createShare ? 'yes' : 'NO'}, CREATE RECIPIENT: ${p.createRecipient ? 'yes' : 'NO'}). Adding an inbound share from an activation file needs CREATE PROVIDER; SUBSCRIBING (create a catalog from the share so you can query it) needs CREATE CATALOG.${r.message ? ' ' + r.message : ''}`,
    remediation: 'A Databricks metastore admin grants the Console UAMI CREATE PROVIDER / SHARE / RECIPIENT on the metastore — the UAMI cannot self-grant. Run scripts/csa-loom/grant-databricks-delta-sharing.sh, or paste the SQL below in a Databricks SQL editor as metastore admin. This grant should be applied day-one by the post-deploy bootstrap.',
    redeploy: true, portalSteps, fixScript: grantScript,
    docs: 'https://learn.microsoft.com/azure/databricks/data-governance/unity-catalog/manage-privileges/',
  };
}

async function probeDlpGraphRoles(): Promise<CheckResult> {
  const base = { id: 'probe-dlp-graph-roles', category: 'catalog-governance' as const, title: 'DLP / Information-Protection Graph roles', severity: 'optional' as const };
  if (env('LOOM_DLP_ENABLED') !== 'true') {
    return {
      ...base, status: 'warn',
      detail: 'DLP/Information-Protection Graph integration disabled (LOOM_DLP_ENABLED ≠ true).',
      remediation: 'Set LOOM_DLP_ENABLED=true AND grant the Console UAMI the Graph app roles SecurityAlert.Read.All + SecurityIncident.Read.All + InformationProtectionPolicy.Read.All (scripts/csa-loom/grant-graph-approles.sh), then a Tenant Admin grants admin consent. Optional — classifications/labels work Loom-native without it.',
      redeploy: true,
      docs: 'https://learn.microsoft.com/graph/permissions-reference',
    };
  }
  try {
    const { listDlpViolations } = await import('@/lib/azure/dlp-graph-client');
    await withTimeout(listDlpViolations({ top: 1 }), 8000);
    return { ...base, status: 'pass', detail: 'Graph security/DLP reachable — the Console UAMI holds the required app roles + admin consent.' };
  } catch (e: any) {
    const msg = e?.message || String(e);
    const roleGap = /missing application roles|securityalert\.read\.all|403|401|consent/i.test(msg);
    return {
      ...base, status: 'warn',
      detail: roleGap ? `Graph rejected the DLP read — missing roles or admin consent: ${msg}` : `DLP Graph probe inconclusive: ${msg}`,
      remediation: 'Grant the Console UAMI Graph app roles SecurityAlert.Read.All + SecurityIncident.Read.All + InformationProtectionPolicy.Read.All (scripts/csa-loom/grant-graph-approles.sh), then a Tenant Admin issues admin consent (Entra → Enterprise applications → Console UAMI → Permissions). Some tenants only expose security/alerts_v2 (not the /beta DLP policy segment) — the route surfaces that honestly.',
      redeploy: true,
      docs: 'https://learn.microsoft.com/graph/permissions-reference#securityalertreadall',
      fixScript: [
        '# Grant the Console UAMI the Graph DLP/security app roles, then a Tenant Admin admin-consents.',
        `az account set --subscription "${CTX.sub}"`,
        'bash scripts/csa-loom/grant-graph-approles.sh   # SecurityAlert.Read.All + SecurityIncident.Read.All + InformationProtectionPolicy.Read.All',
        '# Then: Entra admin center → Enterprise applications → Console UAMI → Permissions → Grant admin consent.',
      ].join('\n'),
    };
  }
}

async function probePostureFunction(): Promise<CheckResult> {
  const base = { id: 'probe-posture-function', category: 'catalog-governance' as const, title: 'Govern posture-refresh Function reachable', severity: 'optional' as const };
  const url = env('LOOM_POSTURE_FUNCTION_URL');
  if (!url) {
    return {
      ...base, status: 'warn',
      detail: 'Posture-refresh Function not configured — Govern still computes posture LIVE from Cosmos.',
      remediation: 'Set LOOM_POSTURE_FUNCTION_URL to the posture-refresh Function base URL for on-open pre-warm. Optional — the Govern view computes posture from Cosmos without it. The post-deploy bootstrap deploys + wires it (azure-functions/posture-refresh/deploy/main.bicep).',
      redeploy: true,
    };
  }
  try {
    // Reachability only — a HEAD/GET on the base host. A function host answers
    // (often 401 without a key, which still proves it is up + reachable); only a
    // network/DNS failure is a real miss.
    const probeUrl = url.replace(/\/+$/, '');
    const res = await withTimeout(fetch(probeUrl, { method: 'GET', redirect: 'manual' as RequestRedirect }), 8000);
    return { ...base, status: 'pass', detail: `Posture-refresh Function host reachable (HTTP ${res.status}).` };
  } catch (e: any) {
    return {
      ...base, status: 'warn',
      detail: `Posture-refresh Function unreachable: ${e?.message || String(e)}`,
      remediation: 'Verify LOOM_POSTURE_FUNCTION_URL points at a deployed Function host and the Console can reach it (private endpoint / outbound). The bootstrap deploys azure-functions/posture-refresh/deploy/main.bicep and stores the host key in Key Vault. Govern still works (Cosmos-computed) meanwhile.',
      redeploy: true,
    };
  }
}

// ── security posture (runtime-observable) ───────────────────────────────────
function securityChecks(): CheckResult[] {
  const out: CheckResult[] = [];
  const isProd = (env('NODE_ENV') || 'production') === 'production';
  out.push({
    id: 'sec-session-secret-strength', category: 'security', title: 'Session secret strength', severity: 'recommended',
    status: env('SESSION_SECRET').length >= 32 ? 'pass' : (has('SESSION_SECRET') ? 'warn' : 'fail'),
    detail: has('SESSION_SECRET') ? `${env('SESSION_SECRET').length} chars` : 'unset',
    remediation: 'Use a ≥32-char random SESSION_SECRET (resolved from Key Vault in CI).',
    redeploy: true,
  });
  out.push({
    id: 'sec-https', category: 'security', title: 'Secure cookies / HTTPS origin', severity: 'recommended',
    status: isProd ? 'pass' : 'warn',
    detail: isProd ? 'Running with NODE_ENV=production (secure cookies).' : `NODE_ENV=${env('NODE_ENV') || 'unset'} — cookies may not be marked Secure.`,
    remediation: 'Run the console with NODE_ENV=production behind HTTPS so session cookies are Secure + SameSite.',
  });
  out.push({
    id: 'sec-tenant-isolation', category: 'security', title: 'Tenant admin restriction set', severity: 'recommended',
    status: anyHas('LOOM_TENANT_ADMIN_OID', 'LOOM_TENANT_ADMIN_GROUP_ID') ? 'pass' : 'warn',
    detail: anyHas('LOOM_TENANT_ADMIN_OID', 'LOOM_TENANT_ADMIN_GROUP_ID') ? 'Bootstrap admin principal restricted.' : 'No bootstrap admin principal set — admin surfaces are unreachable until granted.',
    remediation: 'Set loomTenantAdminOid / loomTenantAdminGroupId so only your principal bootstraps admin.',
    redeploy: true,
  });
  return out;
}

export interface AuditReport {
  generatedAt: string;
  score: number;            // 0-100 weighted by severity
  summary: { pass: number; warn: number; fail: number; total: number; fixable: number };
  results: CheckResult[];
}

/** Run the full self-audit. `now` is passed in so the engine stays pure. */
export async function runSelfAudit(now: string): Promise<AuditReport> {
  const results: CheckResult[] = ENV_CHECKS.map(evalEnv);
  const [cosmos, aoai, purviewMap, searchGov, databricks, deltaSharing, dlpRoles, posture] = await Promise.all([
    probeCosmos(),
    probeAoai(),
    probePurviewDataMap(),
    probeGovernanceSearchIndex(),
    probeDatabricks(),
    probeDeltaSharing(),
    probeDlpGraphRoles(),
    probePostureFunction(),
  ]);
  results.push(cosmos, aoai, purviewMap, searchGov, databricks, deltaSharing, dlpRoles, posture, ...securityChecks());

  // Augment specific findings whose fix needs more than (or wasn't given) the
  // generic env-var recipe — RBAC/Graph grants, and the security env-checks.
  for (const r of results) {
    if (r.status === 'pass') continue;
    if (r.id === 'graph-users') {
      const grant = [
        '',
        '# Then grant the Console UAMI the Microsoft Graph Directory.Read.All application permission:',
        `$uami = az ad sp show --id "${CTX.uamiClientId}" --query id -o tsv`,
        '$graph = az ad sp show --id "00000000-0000-0000-c000-000000000000" --query id -o tsv',
        `$role = az ad sp show --id "00000000-0000-0000-c000-000000000000" --query "appRoles[?value=='Directory.Read.All'].id | [0]" -o tsv`,
        '$body = @{ principalId=$uami; resourceId=$graph; appRoleId=$role } | ConvertTo-Json',
        'az rest --method POST --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$uami/appRoleAssignments" --headers "Content-Type=application/json" --body $body',
      ].join('\n');
      r.fixScript = `${r.fixScript || ''}\n${grant}`;
      r.portalSteps = [
        ...(r.portalSteps || []),
        'Entra admin center → Enterprise applications → the Console UAMI → Permissions, or via Graph: grant Directory.Read.All (application) + admin consent (the script does this).',
      ];
    }
    if ((r.id === 'sec-tenant-isolation' || r.id === 'sec-session-secret-strength') && !r.fixScript) {
      const f = envVarFix(r.id === 'sec-tenant-isolation' ? ['LOOM_TENANT_ADMIN_OID'] : ['SESSION_SECRET']);
      r.portalSteps = f.portalSteps;
      r.fixScript = f.fixScript;
    }
  }

  const weight: Record<AuditSeverity, number> = { critical: 3, recommended: 2, optional: 1 };
  const scoreOf: Record<AuditStatus, number> = { pass: 1, warn: 0.5, fail: 0 };
  let num = 0, den = 0;
  for (const r of results) { num += weight[r.severity] * scoreOf[r.status]; den += weight[r.severity]; }
  const score = den ? Math.round((num / den) * 100) : 100;

  const summary = {
    pass: results.filter((r) => r.status === 'pass').length,
    warn: results.filter((r) => r.status === 'warn').length,
    fail: results.filter((r) => r.status === 'fail').length,
    total: results.length,
    fixable: results.filter((r) => r.fixId).length,
  };
  // Stable order: fails first, then warns, then pass; within, by category.
  const rank: Record<AuditStatus, number> = { fail: 0, warn: 1, pass: 2 };
  results.sort((a, b) => rank[a.status] - rank[b.status] || a.category.localeCompare(b.category) || a.title.localeCompare(b.title));
  return { generatedAt: now, score, summary, results };
}

// ── healer: runtime-safe fixes the console identity can actually apply ───────
export interface FixOutcome { ok: boolean; detail: string; dryRun?: boolean; }

/** Human description of what a runtime-safe fix WOULD do (for dry-run preview). */
const FIX_PLAN: Record<string, string> = {
  'ensure-cosmos':
    'Would call createIfNotExists for the Loom Cosmos database and every Loom container (feature-permissions, workspaces, items, …). Idempotent: existing containers are left untouched; only missing ones are created.',
};

/**
 * Apply a runtime-safe fix by id (admin-approved). When `dryRun` is true, no
 * change is made — the returned detail describes exactly what the fix WOULD do,
 * so the healer is demonstrable even when there is nothing to fix (fixable=0).
 */
export async function applyFix(fixId: string, opts: { dryRun?: boolean } = {}): Promise<FixOutcome> {
  if (opts.dryRun) {
    const plan = FIX_PLAN[fixId];
    return plan
      ? { ok: true, dryRun: true, detail: `Dry-run — no change applied. ${plan}` }
      : { ok: false, dryRun: true, detail: `Dry-run — fix '${fixId}' is not a runtime-applicable action. Its remediation (env var / RBAC grant) must be applied and redeployed.` };
  }
  switch (fixId) {
    case 'ensure-cosmos': {
      try {
        const m = await import('@/lib/azure/cosmos-client');
        // Touch a representative set of containers; each getter calls ensure()
        // which createIfNotExists the database + every Loom container.
        await m.featurePermissionsContainer();
        await m.workspacesContainer();
        await m.itemsContainer();
        return { ok: true, detail: 'Cosmos database + all Loom containers ensured (createIfNotExists).' };
      } catch (e: any) {
        return { ok: false, detail: `Could not ensure Cosmos containers: ${e?.message || String(e)}` };
      }
    }
    default:
      return { ok: false, detail: `Fix '${fixId}' is not a runtime-applicable action. Apply the listed remediation (env var / RBAC grant) and redeploy.` };
  }
}
