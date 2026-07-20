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

// The declarative layer (types, CTX, VALUE_HINT, EnvSpec, evalEnv, ENV_CHECKS)
// lives in ./env-checks — a PURE module with zero server-only imports so the
// client-safe gate registry (lib/gates/registry.ts) can consume it without
// dragging the probes' lazy Azure/copilot imports (and next/headers) into a
// client bundle. Re-exported here so every existing self-audit import keeps
// working unchanged.
export * from './env-checks';
import {
  CTX,
  VALUE_HINT,
  ENV_CHECKS,
  evalEnv,
  envVarFix,
  type AuditCategory,
  type AuditSeverity,
  type AuditStatus,
  type CheckResult,
  type EnvSpec,
} from './env-checks';

const env = (k: string) => (process.env[k] || '').trim();
const has = (k: string) => env(k).length > 0;
const anyHas = (...ks: string[]) => ks.some(has);

/**
 * Build a full ARM resource id from the Loom env vars for a service, so the
 * remediation `--scope` is pre-filled (no <…-resource-id> placeholder for the
 * admin to hand-edit — .claude/rules rule #70). Returns the placeholder ONLY
 * when Loom genuinely doesn't have the coordinates (honest gate, no fabrication).
 */
function armResourceId(
  subKeys: string[], rgKeys: string[], nameKeys: string[], provider: string, placeholder: string,
): string {
  const first = (ks: string[]) => ks.map(env).find((v) => v.length > 0) || '';
  const sub = first(subKeys), rg = first(rgKeys), name = first(nameKeys);
  if (!sub || !rg || !name) return placeholder;
  return `/subscriptions/${sub}/resourceGroups/${rg}/providers/${provider}/${name}`;
}
/** AOAI/Foundry Cognitive Services account resource id (or honest placeholder). */
function aoaiResourceId(): string {
  return armResourceId(
    ['LOOM_AOAI_SUB', 'LOOM_SUBSCRIPTION_ID'], ['LOOM_AOAI_RG', 'LOOM_ADMIN_RG'],
    ['LOOM_AOAI_ACCOUNT'], 'Microsoft.CognitiveServices/accounts', '<aoai-resource-id>',
  );
}
/** Azure AI Search service resource id (or honest placeholder). */
function aiSearchResourceId(): string {
  return armResourceId(
    ['LOOM_AI_SEARCH_SUB', 'LOOM_SUBSCRIPTION_ID'], ['LOOM_AI_SEARCH_RG', 'LOOM_ADMIN_RG'],
    ['LOOM_AI_SEARCH_SERVICE'], 'Microsoft.Search/searchServices', '<ai-search-resource-id>',
  );
}
// ── live probes (best-effort; bounded) ──────────────────────────────────────
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms}ms`)), ms)),
  ]);
}

/** Exported for the healer integration test (fail → heal → re-probe green). */
export async function probeCosmos(): Promise<CheckResult> {
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
        `az role assignment create --assignee-object-id $pid --assignee-principal-type ServicePrincipal --role "Cognitive Services OpenAI User" --scope "${aoaiResourceId()}"`,
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
      fixId: denied ? undefined : 'ensure-search-index',
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
        `az role assignment create --assignee-object-id $pid --assignee-principal-type ServicePrincipal --role "Search Index Data Contributor" --scope "${aiSearchResourceId()}"`,
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
  // DLP is ON by default (opt-out). Only an explicit LOOM_DLP_ENABLED=false
  // disables the live Graph DLP reads — flag that as a deliberate opt-out.
  if (env('LOOM_DLP_ENABLED') === 'false') {
    return {
      ...base, status: 'warn',
      detail: 'DLP/Information-Protection Graph integration explicitly disabled (LOOM_DLP_ENABLED=false).',
      remediation: 'Remove LOOM_DLP_ENABLED=false (DLP defaults ON) AND grant the Console UAMI the Graph app roles SecurityAlert.Read.All + SecurityIncident.Read.All + InformationProtectionPolicy.Read.All (scripts/csa-loom/grant-graph-approles.sh), then a Tenant Admin grants admin consent. The Loom-native policy library authors + saves regardless.',
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
  // Extended probes (wave-3 coverage: ADLS/Synapse/ADX/Event Hubs/ADF/ARM/LA/
  // Graph/Power Platform/Service Bus/APIM/KV + the Loom runtime substrates) run
  // in the same parallel wave. Helpers are injected — no module cycle.
  const { runExtraProbes } = await import('./health-probes');
  const [cosmos, aoai, purviewMap, searchGov, databricks, deltaSharing, dlpRoles, posture, extra] = await Promise.all([
    probeCosmos(),
    probeAoai(),
    probePurviewDataMap(),
    probeGovernanceSearchIndex(),
    probeDatabricks(),
    probeDeltaSharing(),
    probeDlpGraphRoles(),
    probePostureFunction(),
    runExtraProbes({ ctx: CTX, envVarFix }),
  ]);
  results.push(cosmos, aoai, purviewMap, searchGov, databricks, deltaSharing, dlpRoles, posture, ...extra, ...securityChecks());

  // STRUCTURAL coverage (auto-expanding): one aggregated check per workload
  // family in the item-type catalog + one per registered external gate. A new
  // family with no mapping turns RED here and fails the CI coverage guard.
  const { familyCoverageChecks, gateRegistryChecks } = await import('./health-coverage');
  results.push(...(await familyCoverageChecks(results)), ...(await gateRegistryChecks()));

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
  'ensure-search-index':
    'Would call ensureGovernanceCatalogIndex(): create the loom-governance-items index on the configured AI Search service if absent (idempotent — an existing index is left untouched).',
  'ensure-spark-lease-container':
    'Would call createIfNotExists for the spark-warm-leases Cosmos container (the cross-replica warm Spark pool lease registry). Idempotent.',
  'ensure-eventhub-consumer-group':
    'Would createIfNotExists a "loom" consumer group on the default eventstream Event Hub (ensure the hub exists, then ensure the consumer group). Idempotent — an existing hub / group is left untouched.',
  'ensure-adx-default-db':
    'Would createIfNotExists the default KQL database (LOOM_KUSTO_DEFAULT_DB) on the configured ADX cluster. Idempotent — an existing database is left untouched.',
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
    case 'ensure-search-index': {
      try {
        const { ensureGovernanceCatalogIndex } = await import('@/lib/azure/governance-catalog-index');
        const r = await ensureGovernanceCatalogIndex();
        return r.ok
          ? { ok: true, detail: r.created ? 'loom-governance-items index created on the AI Search service.' : 'loom-governance-items index already present (no change needed).' }
          : { ok: false, detail: `Could not ensure the governance index: ${r.error || 'unknown error'}. If this is a 401/403, grant the Console UAMI "Search Index Data Contributor" + "Search Service Contributor" first (not runtime-fixable).` };
      } catch (e: any) {
        return { ok: false, detail: `Could not ensure the governance index: ${e?.message || String(e)}` };
      }
    }
    case 'ensure-spark-lease-container': {
      try {
        const m = await import('@/lib/azure/cosmos-client');
        await m.sparkWarmLeasesContainer(); // ensure() → createIfNotExists
        return { ok: true, detail: 'spark-warm-leases Cosmos container ensured (createIfNotExists).' };
      } catch (e: any) {
        return { ok: false, detail: `Could not ensure the spark-warm-leases container: ${e?.message || String(e)}` };
      }
    }
    case 'ensure-eventhub-consumer-group': {
      // Idempotent createIfNotExists: the Console UAMI (Event Hubs Data Owner +
      // Contributor on the namespace) can create the hub + consumer group at
      // runtime. A leader-only continuous-eval / eventstream consumer needs a
      // dedicated group; a missing one silently drops reads.
      try {
        const eh = await import('@/lib/azure/eventhubs-client');
        const gate = eh.eventhubsConfigGate();
        if (gate) return { ok: false, detail: `Event Hubs not configured (missing ${gate.missing}) — not runtime-fixable; set the env + redeploy.` };
        const cfg = eh.readEventHubsConfig();
        const hub = (process.env.LOOM_EVENTHUB_DEFAULT_HUB || process.env.LOOM_EVENTSTREAM_HUB || 'loom-eventstream').trim();
        const group = (process.env.LOOM_EVENTHUB_CONSUMER_GROUP || 'loom').trim();
        await eh.ensureEventHub(cfg, { name: hub, partitionCount: 4, messageRetentionInDays: 1 });
        await eh.ensureConsumerGroup(cfg, hub, group);
        return { ok: true, detail: `Consumer group "${group}" ensured on Event Hub "${hub}" (createIfNotExists — existing left untouched).` };
      } catch (e: any) {
        const msg = e?.message || String(e);
        return { ok: false, detail: `Could not ensure the consumer group: ${msg}${/401|403/.test(msg) ? ' — grant the Console UAMI "Azure Event Hubs Data Owner" + Contributor on the namespace first (not runtime-fixable).' : ''}` };
      }
    }
    case 'ensure-adx-default-db': {
      // Idempotent createOrUpdate of the default KQL database on the ADX cluster.
      try {
        const kc = await import('@/lib/azure/kusto-client');
        if (!process.env.LOOM_KUSTO_CLUSTER_URI) return { ok: false, detail: 'ADX cluster not configured (LOOM_KUSTO_CLUSTER_URI unset) — not runtime-fixable; set the env + redeploy.' };
        const db = kc.defaultDatabase();
        const r = await kc.createDatabase(db);
        return { ok: true, detail: `ADX default database "${db}" ensured (${r.provisioningState}) on the configured cluster.` };
      } catch (e: any) {
        const msg = e?.message || String(e);
        return { ok: false, detail: `Could not ensure the ADX default database: ${msg}${/401|403/.test(msg) ? ' — grant the Console UAMI "Contributor" on the ADX cluster first (not runtime-fixable).' : ''}` };
      }
    }
    default:
      return { ok: false, detail: `Fix '${fixId}' is not a runtime-applicable action. Apply the listed remediation (env var / RBAC grant) and redeploy.` };
  }
}

