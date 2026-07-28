/**
 * CSA Loom self-audit — extended live probes (wave-3 coverage expansion).
 *
 * Each probe does a REAL, read-only call against the actual Azure backend as
 * the Console managed identity (per .claude/rules/no-vaporware.md — no
 * fabricated greens):
 *   - unconfigured        → honest 'warn' naming the exact env var (never fail
 *                           for an optional workload),
 *   - configured + works  → 'pass' with evidence from the real response,
 *   - configured + broken → 'warn'/'fail' with the precise remediation
 *                           (RBAC grant / network / resource), portal steps and
 *                           a pre-filled fix script where the fix is known.
 *
 * These fill the gap documented in docs/fiab/health-coverage-audit.md: before
 * this module only 8 of ~117 Azure clients had a live probe. All Azure clients
 * are imported LAZILY inside each probe so the module stays cheap to load and
 * unit tests can mock each client independently.
 *
 * Helpers (CTX / envVarFix) are INJECTED by runSelfAudit rather than imported
 * from ./self-audit, so there is no module cycle.
 */
import type { CheckResult } from './self-audit';

const env = (k: string) => (process.env[k] || '').trim();
const has = (k: string) => env(k).length > 0;
const anyHas = (...ks: string[]) => ks.some(has);

export interface ProbeHelpers {
  ctx: {
    app: string; adminRg: string; dlzRg: string; sub: string;
    uamiClientId: string; tenant: string; cosmosAccount: string;
  };
  envVarFix: (vars: string[]) => { portalSteps: string[]; fixScript: string };
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms}ms`)), ms)),
  ]);
}

const DENIED = /401|403|forbidden|unauthoriz|not authorized|access denied/i;

/** Pre-filled role-grant script for the Console UAMI on a resource scope. */
function grantScript(h: ProbeHelpers, role: string, scopeHint: string): string {
  return [
    `# Grant the Console UAMI "${role}" on ${scopeHint}.`,
    `az account set --subscription "${h.ctx.sub}"`,
    `$pid = az ad sp show --id "${h.ctx.uamiClientId}" --query id -o tsv`,
    `az role assignment create --assignee-object-id $pid --assignee-principal-type ServicePrincipal --role "${role}" --scope "${scopeHint}"`,
  ].join('\n');
}

function grantPortalSteps(h: ProbeHelpers, resourceHint: string, role: string): string[] {
  return [
    `Azure portal → ${resourceHint} → Access control (IAM).`,
    `Add role assignment → role "${role}" → Managed identity → the Console UAMI (client id ${h.ctx.uamiClientId}).`,
    'Review + assign, then return here and click Re-run audit (grant propagation can take a minute).',
  ];
}

// ── data plane ───────────────────────────────────────────────────────────────

async function probeAdls(h: ProbeHelpers): Promise<CheckResult> {
  const base = { id: 'probe-adls', category: 'data-plane' as const, title: 'ADLS Gen2 lake reachable + authorized (lakehouse)', severity: 'recommended' as const };
  try {
    const { hasConfiguredContainers, listContainers, getAccountName } = await import('@/lib/azure/adls-client');
    if (!hasConfiguredContainers()) {
      return {
        ...base, status: 'warn',
        detail: 'ADLS lake not configured — lakehouse items have no backing store.',
        remediation: 'Set LOOM_ADLS_ACCOUNT (or the LOOM_{LANDING,BRONZE,SILVER,GOLD}_URL container URLs). See the "ADLS Gen2 (lakehouse / Bronze)" check.',
        redeploy: true,
        ...h.envVarFix(['LOOM_ADLS_ACCOUNT']),
      };
    }
    const containers = await withTimeout(listContainers(), 6000);
    return { ...base, status: 'pass', detail: `Lake reachable + authorized (${getAccountName()}): ${containers.length} container(s) listed (${containers.slice(0, 5).map((c) => c.name).join(', ')}).` };
  } catch (e: any) {
    const msg = e?.message || String(e);
    const denied = DENIED.test(msg);
    return {
      ...base, status: denied ? 'fail' : 'warn',
      detail: `ADLS probe failed: ${msg}`,
      remediation: denied
        ? 'Grant the Console UAMI "Storage Blob Data Contributor" on the DLZ storage account (modules/landing-zone/storage.bicep wires this on a push-button deploy).'
        : 'Verify LOOM_ADLS_ACCOUNT / the container URLs and network reachability (private endpoint / firewall) from the Console subnet.',
      redeploy: true,
      portalSteps: denied ? grantPortalSteps(h, 'the DLZ storage account', 'Storage Blob Data Contributor') : undefined,
      fixScript: denied ? grantScript(h, 'Storage Blob Data Contributor', `/subscriptions/${h.ctx.sub}/resourceGroups/${h.ctx.dlzRg}/providers/Microsoft.Storage/storageAccounts/<adls-account>`) : undefined,
    };
  }
}

// ── azure services ───────────────────────────────────────────────────────────

async function probeSynapse(h: ProbeHelpers): Promise<CheckResult> {
  const base = { id: 'probe-synapse', category: 'azure-services' as const, title: 'Synapse workspace reachable + authorized', severity: 'recommended' as const };
  if (!has('LOOM_SYNAPSE_WORKSPACE')) {
    return {
      ...base, status: 'warn',
      detail: 'Synapse not configured — warehouse / notebook / pipeline items have no Synapse backend (Databricks covers notebooks/SQL if bound).',
      remediation: 'Set LOOM_SYNAPSE_WORKSPACE. See the "Synapse (warehouse / notebooks / pipelines)" check.',
      redeploy: true,
      ...h.envVarFix(['LOOM_SYNAPSE_WORKSPACE']),
    };
  }
  try {
    const { listSparkPools } = await import('@/lib/azure/synapse-dev-client');
    const pools = await withTimeout(listSparkPools(), 6000);
    return { ...base, status: 'pass', detail: `Synapse dev endpoint reachable + authorized (${env('LOOM_SYNAPSE_WORKSPACE')}): ${pools.length} Spark pool(s).` };
  } catch (e: any) {
    const msg = e?.message || String(e);
    const denied = DENIED.test(msg);
    return {
      ...base, status: 'warn',
      detail: `Synapse probe failed: ${msg}`,
      remediation: denied
        ? 'Grant the Console UAMI "Synapse Administrator" on the workspace (Synapse Studio → Manage → Access control), and Synapse SQL Admin for serverless DDL (scripts/csa-loom/grant-synapse-sql.sh).'
        : 'Verify LOOM_SYNAPSE_WORKSPACE and network reachability of the <workspace>.dev endpoint from the Console subnet.',
      redeploy: true,
      portalSteps: denied
        ? [
            `Synapse Studio (workspace "${env('LOOM_SYNAPSE_WORKSPACE')}") → Manage → Access control.`,
            `Add the Console UAMI (client id ${h.ctx.uamiClientId}) as Synapse Administrator.`,
            'Return here and click Re-run audit.',
          ]
        : undefined,
    };
  }
}

async function probeKusto(h: ProbeHelpers): Promise<CheckResult> {
  const base = { id: 'probe-kusto', category: 'azure-services' as const, title: 'Azure Data Explorer reachable + authorized (KQL / RTI)', severity: 'recommended' as const };
  try {
    const { kustoConfigGate, defaultDatabase, executeMgmtCommand, clusterUri } = await import('@/lib/azure/kusto-client');
    const gate = kustoConfigGate();
    if (gate) {
      return {
        ...base, status: 'warn',
        detail: `ADX not configured (missing ${gate.missing}) — KQL databases / eventhouses / Real-Time dashboards have no cluster.`,
        remediation: 'Set LOOM_KUSTO_CLUSTER_URI (+ LOOM_KUSTO_DEFAULT_DB). See the "Azure Data Explorer (KQL / Real-Time)" check.',
        redeploy: true,
        ...h.envVarFix(['LOOM_KUSTO_CLUSTER_URI']),
      };
    }
    const r = await withTimeout(executeMgmtCommand(defaultDatabase(), '.show version'), 6000);
    return { ...base, status: 'pass', detail: `ADX reachable + authorized (${clusterUri()}): .show version returned ${r.rowCount} row(s) in ${r.executionMs}ms.` };
  } catch (e: any) {
    const msg = e?.message || String(e);
    const denied = DENIED.test(msg);
    return {
      ...base, status: 'warn',
      detail: `ADX probe failed: ${msg}`,
      remediation: denied
        ? 'Grant the Console UAMI "AllDatabasesViewer" (or Database Admin) on the ADX cluster.'
        : 'Verify LOOM_KUSTO_CLUSTER_URI, that the cluster is RUNNING (not stopped), and network reachability from the Console subnet. A missing default database is runtime-fixable (Heal).',
      redeploy: true,
      // Idempotent runtime fix: createOrUpdate the default KQL database.
      fixId: denied ? undefined : 'ensure-adx-default-db',
      portalSteps: denied ? grantPortalSteps(h, 'the ADX cluster → Permissions', 'AllDatabasesViewer') : undefined,
      fixScript: denied
        ? (() => {
            // Pre-fill the cluster name, RG, and principal id from Loom's own
            // env so the admin runs it verbatim (no <…> placeholders — rule #70).
            const clusterName = env('LOOM_KUSTO_CLUSTER_NAME')
              || (env('LOOM_KUSTO_CLUSTER_URI').match(/https:\/\/([^.]+)\./)?.[1] ?? '')
              || env('LOOM_ADX_CLUSTER')
              || '<adx-cluster>';
            const kustoRg = env('LOOM_KUSTO_RG') || h.ctx.dlzRg || '<rg>';
            const kustoSub = env('LOOM_KUSTO_SUB') || h.ctx.sub;
            return [
              '# Grant the Console UAMI AllDatabasesViewer on the ADX cluster.',
              `az account set --subscription "${kustoSub}"`,
              `$pid = az ad sp show --id "${h.ctx.uamiClientId}" --query id -o tsv`,
              `az kusto cluster-principal-assignment create --cluster-name "${clusterName}" --resource-group "${kustoRg}" --principal-assignment-name "loom-console-viewer" --principal-id $pid --principal-type App --role AllDatabasesViewer`,
            ].join('\n');
          })()
        : undefined,
    };
  }
}

async function probeEventHubs(h: ProbeHelpers): Promise<CheckResult> {
  const base = { id: 'probe-eventhubs', category: 'azure-services' as const, title: 'Event Hubs namespace reachable + authorized (eventstream)', severity: 'optional' as const };
  try {
    const { eventhubsConfigGate, listEventHubs } = await import('@/lib/azure/eventhubs-client');
    const gate = eventhubsConfigGate();
    if (gate) {
      return {
        ...base, status: 'warn',
        detail: `Event Hubs not configured (missing ${gate.missing}) — eventstream items have no Azure-native backend.`,
        remediation: 'Set LOOM_EVENTHUB_NAMESPACE. See the "Event Hubs (eventstream)" check.',
        redeploy: true,
        ...h.envVarFix(['LOOM_EVENTHUB_NAMESPACE']),
      };
    }
    const hubs = await withTimeout(listEventHubs(), 6000);
    return { ...base, status: 'pass', detail: `Event Hubs namespace reachable + authorized (${env('LOOM_EVENTHUB_NAMESPACE')}): ${hubs.length} event hub(s).` };
  } catch (e: any) {
    const msg = e?.message || String(e);
    const denied = DENIED.test(msg);
    return {
      ...base, status: 'warn',
      detail: `Event Hubs probe failed: ${msg}`,
      remediation: denied
        ? 'Grant the Console UAMI "Azure Event Hubs Data Owner" on the namespace (control-plane reads additionally need Reader on the RG).'
        : 'Verify LOOM_EVENTHUB_NAMESPACE (+ LOOM_EVENTHUB_RG/SUB) and network reachability. A missing hub / consumer group is runtime-fixable (Heal).',
      redeploy: true,
      // Idempotent runtime fix: ensure the default hub + a "loom" consumer group.
      fixId: denied ? undefined : 'ensure-eventhub-consumer-group',
      portalSteps: denied ? grantPortalSteps(h, `Event Hubs namespace "${env('LOOM_EVENTHUB_NAMESPACE')}"`, 'Azure Event Hubs Data Owner') : undefined,
      fixScript: denied ? grantScript(h, 'Azure Event Hubs Data Owner', `/subscriptions/${h.ctx.sub}/resourceGroups/${h.ctx.dlzRg}/providers/Microsoft.EventHub/namespaces/${env('LOOM_EVENTHUB_NAMESPACE') || '<namespace>'}`) : undefined,
    };
  }
}

async function probeAdf(h: ProbeHelpers): Promise<CheckResult> {
  const base = { id: 'probe-adf', category: 'azure-services' as const, title: 'Data Factory reachable + authorized (pipelines / mirroring CDC)', severity: 'optional' as const };
  try {
    const { adfConfigGate, getDefaultFactory } = await import('@/lib/azure/adf-client');
    const gate = adfConfigGate();
    if (gate) {
      return {
        ...base, status: 'warn',
        detail: `ADF not configured (missing ${gate.missing}) — ADF-runtime pipelines + mirror CDC have no factory (Synapse pipelines still work).`,
        remediation: 'Set LOOM_ADF_FACTORY (+ LOOM_ADF_RG). See the "Azure Data Factory (mirror CDC)" check.',
        redeploy: true,
        ...h.envVarFix(['LOOM_ADF_FACTORY']),
      };
    }
    const f = await withTimeout(getDefaultFactory(), 6000);
    return { ...base, status: 'pass', detail: `Data Factory reachable + authorized (${f?.name || env('LOOM_ADF_FACTORY') || 'factory'}, ${f?.properties?.provisioningState || 'state n/a'}).` };
  } catch (e: any) {
    const msg = e?.message || String(e);
    const denied = DENIED.test(msg);
    return {
      ...base, status: 'warn',
      detail: `ADF probe failed: ${msg}`,
      remediation: denied
        ? 'Grant the Console UAMI "Data Factory Contributor" on the factory.'
        : 'Verify LOOM_ADF_FACTORY / LOOM_ADF_RG name a factory in this subscription.',
      redeploy: true,
      portalSteps: denied ? grantPortalSteps(h, 'the Data Factory', 'Data Factory Contributor') : undefined,
      fixScript: denied ? grantScript(h, 'Data Factory Contributor', `/subscriptions/${h.ctx.sub}/resourceGroups/<adf-rg>/providers/Microsoft.DataFactory/factories/<factory>`) : undefined,
    };
  }
}

// ── permissions (control plane) ──────────────────────────────────────────────

async function probeArmReader(h: ProbeHelpers): Promise<CheckResult> {
  const base = { id: 'probe-arm-reader', category: 'permissions' as const, title: 'ARM control plane readable (UAMI Reader on the deployment)', severity: 'critical' as const };
  const rg = env('LOOM_ADMIN_RG') || env('LOOM_DLZ_RG');
  if (!has('LOOM_SUBSCRIPTION_ID') || !rg) {
    return {
      ...base, status: 'fail',
      detail: 'LOOM_SUBSCRIPTION_ID / resource group not configured — ARM discovery, monitoring, scaling, and every navigator are blind.',
      remediation: 'Set LOOM_SUBSCRIPTION_ID and LOOM_ADMIN_RG / LOOM_DLZ_RG. See the "Azure subscription + resource groups" check.',
      redeploy: true,
    };
  }
  try {
    const { armGet } = await import('@/lib/azure/arm-client');
    const r = await withTimeout(armGet(`/subscriptions/${env('LOOM_SUBSCRIPTION_ID')}/resourcegroups/${rg}?api-version=2021-04-01`), 6000);
    return { ...base, status: 'pass', detail: `ARM readable as the Console UAMI: resource group "${(r as any)?.name || rg}" resolved (${(r as any)?.location || 'location n/a'}).` };
  } catch (e: any) {
    const msg = e?.message || String(e);
    const denied = DENIED.test(msg);
    return {
      ...base, status: 'fail',
      detail: `ARM read failed: ${msg}`,
      remediation: denied
        ? `Grant the Console UAMI at least "Reader" on resource group "${rg}" (Contributor is wired by the push-button deploy). Monitoring, cost, navigators, and scaling all read ARM as this identity.`
        : 'Verify the Console can reach management.azure.com (or the sovereign ARM endpoint via LOOM_ARM_ENDPOINT) and that the UAMI token is being issued (see the ACA managed-identity notes).',
      redeploy: true,
      portalSteps: denied ? grantPortalSteps(h, `resource group "${rg}"`, 'Reader') : undefined,
      fixScript: denied ? grantScript(h, 'Reader', `/subscriptions/${h.ctx.sub}/resourceGroups/${rg}`) : undefined,
    };
  }
}

async function probeLogAnalytics(h: ProbeHelpers): Promise<CheckResult> {
  const base = { id: 'probe-log-analytics', category: 'azure-services' as const, title: 'Log Analytics query access (monitor / audit / activator)', severity: 'optional' as const };
  try {
    const { logAnalyticsWorkspaceId, queryLogs } = await import('@/lib/azure/monitor-client');
    if (!logAnalyticsWorkspaceId()) {
      return {
        ...base, status: 'warn',
        detail: 'Log Analytics workspace not configured — /monitor logs, audit-log LA source, and continuous Activator evaluation are unavailable (Cosmos-side features still work).',
        remediation: 'Set LOOM_LOG_ANALYTICS_WORKSPACE_ID (auto-derived on a push-button deploy from the monitoring module).',
        redeploy: true,
        ...h.envVarFix(['LOOM_LOG_ANALYTICS_WORKSPACE_ID']),
      };
    }
    const r = await withTimeout(queryLogs('print probe=1', 'PT15M'), 6000);
    return { ...base, status: 'pass', detail: `Log Analytics query executed as the Console UAMI (print returned ${r.rowCount} row(s)).` };
  } catch (e: any) {
    const msg = e?.message || String(e);
    const denied = DENIED.test(msg);
    return {
      ...base, status: 'warn',
      detail: `Log Analytics probe failed: ${msg}`,
      remediation: denied
        ? 'Grant the Console UAMI "Log Analytics Reader" on the workspace.'
        : 'Verify LOOM_LOG_ANALYTICS_WORKSPACE_ID is the workspace customerId GUID and the api.loganalytics endpoint is reachable.',
      redeploy: true,
      portalSteps: denied ? grantPortalSteps(h, 'the Log Analytics workspace', 'Log Analytics Reader') : undefined,
      fixScript: denied ? grantScript(h, 'Log Analytics Reader', env('LOOM_LOG_ANALYTICS_RESOURCE_ID') || '<log-analytics-workspace-resource-id>') : undefined,
    };
  }
}

async function probeGraphDirectory(h: ProbeHelpers): Promise<CheckResult> {
  const base = { id: 'probe-graph-directory', category: 'enrichment' as const, title: 'Microsoft Graph directory read (Users / identity pickers)', severity: 'optional' as const };
  if (env('LOOM_GRAPH_USERS_ENABLED') !== 'true') {
    return {
      ...base, status: 'warn',
      detail: 'Graph user enrichment not enabled — the Users page shows UPN + Cosmos activity only; identity pickers fall back to free-text OIDs.',
      remediation: 'Set LOOM_GRAPH_USERS_ENABLED=true and grant the Console UAMI Directory.Read.All (application) in Microsoft Graph. See the "Microsoft Graph user enrichment" check.',
      redeploy: true,
      ...h.envVarFix(['LOOM_GRAPH_USERS_ENABLED']),
    };
  }
  try {
    const { searchUsers } = await import('@/lib/azure/graph-identity-client');
    const hits = await withTimeout(searchUsers('a', 1), 6000);
    return { ...base, status: 'pass', detail: `Graph directory readable as the Console UAMI (${hits.length} user hit on a 1-row search).` };
  } catch (e: any) {
    const msg = e?.message || String(e);
    return {
      ...base, status: 'warn',
      detail: `Graph directory probe failed: ${msg}`,
      remediation: 'Grant the Console UAMI the Microsoft Graph Directory.Read.All application role + admin consent (see the "Microsoft Graph user enrichment" check for the exact script), then re-run.',
      redeploy: true,
      docs: 'https://learn.microsoft.com/graph/permissions-reference#directoryreadall',
    };
  }
}

async function probePowerPlatform(h: ProbeHelpers): Promise<CheckResult> {
  const base = { id: 'probe-powerplatform', category: 'azure-services' as const, title: 'Power Platform API reachable + authorized (Copilot Studio / Power Apps)', severity: 'optional' as const };
  try {
    const { powerPlatformConfigGate, listEnvironments } = await import('@/lib/azure/powerplatform-client');
    const gate = powerPlatformConfigGate();
    if (gate) {
      return {
        ...base, status: 'warn',
        detail: `Power Platform not configured (missing ${gate.missing}) — the power-* item types + Copilot Studio have no control plane.`,
        remediation: 'Set LOOM_UAMI_CLIENT_ID (the Console UAMI). The SP must also be allowed by the "Service principals can use Power Platform APIs" tenant setting (scripts/csa-loom/grant-powerplatform-sp.ps1 — operator-run).',
        redeploy: true,
      };
    }
    const envs = await withTimeout(listEnvironments(), 6000);
    return { ...base, status: 'pass', detail: `Power Platform BAP API reachable + authorized: ${envs.length} environment(s).` };
  } catch (e: any) {
    const msg = e?.message || String(e);
    const denied = DENIED.test(msg);
    return {
      ...base, status: 'warn',
      detail: denied ? `Power Platform rejected the call (the known SP-not-allowed 403): ${msg}` : `Power Platform probe failed: ${msg}`,
      remediation: 'A Power Platform admin must register the Console UAMI as a Power Platform management app: run scripts/csa-loom/grant-powerplatform-sp.ps1 (New-PowerAppManagementApp), or enable "Service principals can use Power Platform APIs". This is a one-time operator action — the UAMI cannot self-register.',
      redeploy: true,
      docs: 'https://learn.microsoft.com/power-platform/admin/powerplatform-api-create-service-principal',
      portalSteps: [
        'Power Platform admin center → an admin runs the registration (PowerShell): Install-Module Microsoft.PowerApps.Administration.PowerShell.',
        `New-PowerAppManagementApp -ApplicationId ${h.ctx.uamiClientId}`,
        'Return here and click Re-run audit.',
      ],
      fixScript: [
        '# One-time (Power Platform admin): register the Console UAMI as a PP management app.',
        'Install-Module Microsoft.PowerApps.Administration.PowerShell -Scope CurrentUser',
        `Add-PowerAppsAccount   # sign in as a Power Platform admin`,
        `New-PowerAppManagementApp -ApplicationId "${h.ctx.uamiClientId}"`,
      ].join('\n'),
    };
  }
}

async function probeServiceBus(h: ProbeHelpers): Promise<CheckResult> {
  const base = { id: 'probe-servicebus', category: 'azure-services' as const, title: 'Service Bus namespace reachable + authorized (business events)', severity: 'optional' as const };
  try {
    const { servicebusConfigGate, getNamespaceProperties } = await import('@/lib/azure/servicebus-client');
    const gate = servicebusConfigGate();
    if (gate) {
      return {
        ...base, status: 'warn',
        detail: `Service Bus not configured (missing ${gate.missing}) — queue/topic business-event routing is unavailable (Event Grid / Event Hubs paths unaffected).`,
        remediation: 'Set LOOM_SERVICEBUS_NAMESPACE (+ LOOM_SERVICEBUS_RG). See the "Service Bus (queues / topics)" check.',
        redeploy: true,
        ...h.envVarFix(['LOOM_SERVICEBUS_NAMESPACE']),
      };
    }
    const ns = await withTimeout(getNamespaceProperties(), 6000);
    return { ...base, status: 'pass', detail: `Service Bus namespace reachable + authorized (${ns.name || env('LOOM_SERVICEBUS_NAMESPACE')}, sku ${ns.sku || 'n/a'}, status ${ns.status || 'n/a'}).` };
  } catch (e: any) {
    const msg = e?.message || String(e);
    const denied = DENIED.test(msg);
    return {
      ...base, status: 'warn',
      detail: `Service Bus probe failed: ${msg}`,
      remediation: denied
        ? 'Grant the Console UAMI "Azure Service Bus Data Owner" (data plane) + Reader (control plane) on the namespace.'
        : 'Verify LOOM_SERVICEBUS_NAMESPACE and network reachability.',
      redeploy: true,
      portalSteps: denied ? grantPortalSteps(h, `Service Bus namespace "${env('LOOM_SERVICEBUS_NAMESPACE')}"`, 'Azure Service Bus Data Owner') : undefined,
      fixScript: denied ? grantScript(h, 'Azure Service Bus Data Owner', `/subscriptions/${h.ctx.sub}/resourceGroups/${h.ctx.dlzRg}/providers/Microsoft.ServiceBus/namespaces/${env('LOOM_SERVICEBUS_NAMESPACE') || '<namespace>'}`) : undefined,
    };
  }
}

async function probeApim(h: ProbeHelpers): Promise<CheckResult> {
  const base = { id: 'probe-apim', category: 'builders' as const, title: 'API Management reachable (publish-as-API / API marketplace)', severity: 'optional' as const };
  try {
    const { apimConfigGate, getApimService, apimTarget } = await import('@/lib/azure/apim-client');
    const gate = apimConfigGate();
    if (gate) {
      return {
        ...base, status: 'warn',
        detail: `APIM not configured (missing ${gate.missing}) — publish-as-API and the API marketplace deploy target are unavailable.`,
        remediation: 'Set LOOM_SUBSCRIPTION_ID (LOOM_APIM_NAME / LOOM_APIM_RG have deployment defaults). See the "API Management (publish-as-API)" check.',
        redeploy: true,
      };
    }
    const svc = await withTimeout(getApimService(), 6000);
    const t = apimTarget();
    if (!svc) {
      return {
        ...base, status: 'warn',
        detail: `APIM service "${t.name}" not found in resource group "${t.resourceGroup}".`,
        remediation: 'Deploy the APIM module (modules/admin-plane apimEnabled) or point LOOM_APIM_NAME / LOOM_APIM_RG at an existing service.',
        redeploy: true,
      };
    }
    return { ...base, status: 'pass', detail: `APIM reachable + authorized (${(svc as any)?.name || t.name}, sku ${(svc as any)?.sku?.name || 'n/a'}).` };
  } catch (e: any) {
    const msg = e?.message || String(e);
    const denied = DENIED.test(msg);
    return {
      ...base, status: 'warn',
      detail: `APIM probe failed: ${msg}`,
      remediation: denied ? 'Grant the Console UAMI "API Management Service Contributor" on the APIM service.' : 'Verify the APIM target (LOOM_APIM_NAME / LOOM_APIM_RG) and ARM reachability.',
      redeploy: true,
      portalSteps: denied ? grantPortalSteps(h, 'the API Management service', 'API Management Service Contributor') : undefined,
    };
  }
}

async function probeKeyVault(h: ProbeHelpers): Promise<CheckResult> {
  const base = { id: 'probe-keyvault', category: 'security' as const, title: 'Key Vault reachable (connection / shortcut / MCP secrets)', severity: 'optional' as const };
  try {
    const { vaultUrl } = await import('@/lib/azure/kv-secrets-client');
    const url = vaultUrl();
    if (!url) {
      return {
        ...base, status: 'warn',
        detail: 'No Key Vault configured — shortcut credentials, Git PATs, and MCP server secrets have no secret store.',
        remediation: 'Set LOOM_KEY_VAULT_URI (or LOOM_KEY_VAULT_NAME) and grant the Console UAMI "Key Vault Secrets Officer" on the vault.',
        redeploy: true,
        ...h.envVarFix(['LOOM_KEY_VAULT_URI']),
      };
    }
    // Reachability probe: an unauthenticated data-plane GET must answer 401 with
    // a WWW-Authenticate challenge — that proves DNS + network + the vault is up.
    // (Secret round-trips are exercised by the first real secret use; we do not
    // write a probe secret into the operator's vault.)
    const res = await withTimeout(fetch(`${url}/secrets?api-version=7.4&maxresults=1`, { method: 'GET' }), 6000);
    if (res.status === 401 || res.ok) {
      return { ...base, status: 'pass', detail: `Key Vault host reachable (${url} answered HTTP ${res.status}); data-plane auth is exercised on first secret use.` };
    }
    if (res.status === 403) {
      return {
        ...base, status: 'warn',
        detail: `Key Vault answered 403 — the vault firewall is blocking the Console outbound (network ACL, not RBAC).`,
        remediation: 'Add a private endpoint for the Console subnet or allow the Console egress in the vault Networking settings.',
        redeploy: true,
        portalSteps: [
          `Azure portal → Key Vault (${url}) → Networking.`,
          'Add a private endpoint for the Console subnet, or allow trusted services / the Console egress IP.',
          'Return here and click Re-run audit.',
        ],
      };
    }
    return { ...base, status: 'warn', detail: `Key Vault answered HTTP ${res.status}.`, remediation: 'Verify LOOM_KEY_VAULT_URI points at an existing vault.', redeploy: true };
  } catch (e: any) {
    return {
      ...base, status: 'warn',
      detail: `Key Vault unreachable: ${e?.message || String(e)}`,
      remediation: 'Verify LOOM_KEY_VAULT_URI / LOOM_KEY_VAULT_NAME and DNS/network reachability (private endpoint) from the Console subnet.',
      redeploy: true,
    };
  }
}

// ── loom runtime substrates (internal HTTP services) ─────────────────────────

async function probeHttpService(
  id: string, category: CheckResult['category'], title: string, envVar: string,
  featureWhenUp: string, deployHint: string, h: ProbeHelpers,
): Promise<CheckResult> {
  const base = { id, category, title, severity: 'optional' as const };
  const url = env(envVar);
  if (!url) {
    return {
      ...base, status: 'warn',
      detail: `${envVar} not set — ${featureWhenUp} is unavailable (the surrounding editor still renders with its honest gate).`,
      remediation: `Set ${envVar}. ${deployHint}`,
      redeploy: true,
      ...h.envVarFix([envVar]),
    };
  }
  try {
    // Reachability: ANY HTTP answer proves the host is up + routable from the
    // Console (401/404 on the bare base path are normal for these runtimes).
    const res = await withTimeout(fetch(url.replace(/\/+$/, ''), { method: 'GET', redirect: 'manual' as RequestRedirect }), 6000);
    return { ...base, status: 'pass', detail: `${title.split(' — ')[0]} reachable (HTTP ${res.status} from ${url}).` };
  } catch (e: any) {
    return {
      ...base, status: 'warn',
      detail: `${envVar} host unreachable: ${e?.message || String(e)}`,
      remediation: `Verify ${envVar} points at the deployed service and the Console can reach it (internal ingress / VNet). ${deployHint}`,
      redeploy: true,
    };
  }
}

// ── W-B depth wave: 8 live probes for backends that had an env gate but no
//    live call (docs/fiab/health-coverage-audit.md §5 items 1-5, 7). Each is a
//    real read-only call as the Console UAMI, honest-gated when unconfigured. ──

/** Analysis Services (semantic-model fast path). ARM read of the server(s) —
 *  surfaces a PAUSED/STOPPED server (the exact invisible-misconfig class from
 *  06-29), which a mere env gate can't see. AAS is unavailable in Gov clouds —
 *  that is an honest warn (the Synapse-serverless fallback stays functional). */
async function probeAas(h: ProbeHelpers): Promise<CheckResult> {
  const base = { id: 'probe-aas', category: 'azure-services' as const, title: 'Analysis Services reachable + running (semantic-model fast path)', severity: 'optional' as const };
  if (!anyHas('LOOM_AAS_SERVER', 'LOOM_AAS_SERVER_NAME', 'LOOM_AAS_XMLA_ENDPOINT', 'LOOM_POWERBI_XMLA_ENDPOINT')) {
    return { ...base, status: 'warn', detail: 'AAS not configured — semantic models fall back to the Synapse Serverless tabular layer (functional, slower cold queries).', remediation: 'Set LOOM_AAS_SERVER (asazure://… URI) or LOOM_AAS_SERVER_NAME. See the "Analysis Services (semantic-model fast path)" check.', redeploy: true, ...h.envVarFix(['LOOM_AAS_SERVER']) };
  }
  try {
    const { aasAvailabilityGate } = await import('@/lib/azure/aas-client');
    const gov = aasAvailabilityGate();
    if (gov) return { ...base, status: 'warn', detail: gov.detail, remediation: 'No action — the Loom-native tabular layer over Synapse Serverless is the Azure-native default in this cloud (no Power BI / Fabric required).' };
    const sub = env('LOOM_SUBSCRIPTION_ID');
    const rg = env('LOOM_AAS_RG') || h.ctx.adminRg || h.ctx.dlzRg;
    if (!sub || !rg) return { ...base, status: 'warn', detail: 'AAS server configured but LOOM_SUBSCRIPTION_ID / resource group unresolved for the ARM liveness read.', remediation: 'Set LOOM_SUBSCRIPTION_ID and LOOM_AAS_RG (or LOOM_ADMIN_RG).', redeploy: true };
    const { armGet } = await import('@/lib/azure/arm-client');
    const r: any = await withTimeout(armGet(`/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.AnalysisServices/servers?api-version=2017-08-01`), 6000);
    const servers: any[] = Array.isArray(r?.value) ? r.value : [];
    if (servers.length === 0) return { ...base, status: 'warn', detail: `No Analysis Services server found in ${rg}. Serverless fallback is active.`, remediation: 'Deploy the AAS server (modules/admin-plane/aas.bicep, aasEnabled) or clear LOOM_AAS_SERVER to use the serverless fallback silently.', redeploy: true };
    const states = servers.map((s) => `${s?.name}=${s?.properties?.state || 'state n/a'}`).join(', ');
    const paused = servers.find((s) => /paus|suspend|stopp/i.test(String(s?.properties?.state || '')));
    if (paused) return { ...base, status: 'warn', detail: `AAS server is PAUSED (${states}) — semantic-model fast-path queries fail until it is resumed.`, remediation: `Resume the server: az analysis-services server resume --name "${paused.name}" --resource-group "${rg}". Or set an auto-resume policy.`, redeploy: false };
    return { ...base, status: 'pass', detail: `Analysis Services reachable + running (${states}).` };
  } catch (e: any) {
    const msg = e?.message || String(e); const denied = DENIED.test(msg);
    return { ...base, status: denied ? 'fail' : 'warn', detail: `AAS probe failed: ${msg}`, remediation: denied ? 'Grant the Console UAMI "Reader" (+ "Analysis Services Admin" for XMLA) on the AAS server.' : 'Verify LOOM_AAS_SERVER / LOOM_AAS_RG and Console network reachability.', redeploy: true, portalSteps: denied ? grantPortalSteps(h, 'the Analysis Services server', 'Reader') : undefined, fixScript: denied ? grantScript(h, 'Reader', `/subscriptions/${env('LOOM_SUBSCRIPTION_ID')}/resourceGroups/${env('LOOM_AAS_RG') || h.ctx.adminRg}/providers/Microsoft.AnalysisServices/servers/<aas-server>`) : undefined };
  }
}

/** Azure ML workspace (Data Science family: ml-model / AutoML / experiments).
 *  ARM read of the workspace as the Console UAMI. */
async function probeAml(h: ProbeHelpers): Promise<CheckResult> {
  const base = { id: 'probe-aml', category: 'azure-services' as const, title: 'Azure ML workspace reachable + authorized (Data Science family)', severity: 'optional' as const };
  try {
    const { resolveAmlTarget, amlWorkspaceArmPath, AmlNotConfiguredError } = await import('@/lib/azure/resolve-aml-target');
    let target;
    try { target = resolveAmlTarget(); }
    catch (e) {
      if (e instanceof AmlNotConfiguredError) return { ...base, status: 'warn', detail: 'No Azure ML workspace configured — the Data Science item family (ml-model / ml-experiment / AutoML) is gated.', remediation: 'Set LOOM_AML_WORKSPACE (+ LOOM_AML_RESOURCE_GROUP) or the AI Foundry hub (LOOM_FOUNDRY_NAME/LOOM_FOUNDRY_RG). See the "Azure Machine Learning" check.', redeploy: true, ...h.envVarFix(['LOOM_AML_WORKSPACE']) };
      throw e;
    }
    const { armGet } = await import('@/lib/azure/arm-client');
    const r: any = await withTimeout(armGet(`${amlWorkspaceArmPath(target)}?api-version=2024-09-01`), 6000);
    return { ...base, status: 'pass', detail: `Azure ML workspace reachable + authorized (${target.workspace} in ${target.resourceGroup}, ${r?.properties?.provisioningState || 'state n/a'}).` };
  } catch (e: any) {
    const msg = e?.message || String(e); const denied = DENIED.test(msg); const notFound = /404|not found/i.test(msg);
    return { ...base, status: denied ? 'fail' : 'warn', detail: `AML probe failed: ${msg}`, remediation: denied ? 'Grant the Console UAMI "AzureML Data Scientist" + "Reader" on the AML workspace.' : notFound ? 'The configured LOOM_AML_WORKSPACE does not exist in that resource group — deploy it or correct the name.' : 'Verify LOOM_AML_WORKSPACE / LOOM_AML_RESOURCE_GROUP and reachability.', redeploy: true, portalSteps: denied ? grantPortalSteps(h, 'the Azure ML workspace', 'AzureML Data Scientist') : undefined, fixScript: denied ? grantScript(h, 'AzureML Data Scientist', `/subscriptions/${env('LOOM_SUBSCRIPTION_ID')}/resourceGroups/${env('LOOM_AML_RESOURCE_GROUP') || h.ctx.adminRg}/providers/Microsoft.MachineLearningServices/workspaces/${env('LOOM_AML_WORKSPACE') || '<aml-workspace>'}`) : undefined };
  }
}

/** Azure SQL logical servers (SQL database items + mirroring source ops). ARM list. */
async function probeAzureSql(h: ProbeHelpers): Promise<CheckResult> {
  const base = { id: 'probe-azure-sql', category: 'azure-services' as const, title: 'Azure SQL logical servers reachable + authorized', severity: 'optional' as const };
  if (!anyHas('LOOM_AZURE_SQL_DEFAULT_SERVER', 'LOOM_SUBSCRIPTION_ID')) {
    return { ...base, status: 'warn', detail: 'Azure SQL not configured — SQL database items / mirroring source ops have no default server.', remediation: 'Set LOOM_SUBSCRIPTION_ID (Azure SQL items provision via ARM) and optionally LOOM_AZURE_SQL_DEFAULT_SERVER. See the "Azure SQL" check.', redeploy: true, ...h.envVarFix(['LOOM_AZURE_SQL_DEFAULT_SERVER']) };
  }
  try {
    const { listServers } = await import('@/lib/azure/azure-sql-client');
    const servers = await withTimeout(listServers(env('LOOM_SUBSCRIPTION_ID') || undefined), 6000);
    const dflt = env('LOOM_AZURE_SQL_DEFAULT_SERVER');
    return { ...base, status: 'pass', detail: `Azure SQL ARM readable as the Console UAMI: ${servers.length} logical server(s)${dflt ? ` (default: ${dflt})` : ''}${servers.length ? ` — ${servers.slice(0, 5).map((s: any) => s.name).join(', ')}` : ''}.` };
  } catch (e: any) {
    const msg = e?.message || String(e); const denied = DENIED.test(msg);
    return { ...base, status: denied ? 'fail' : 'warn', detail: `Azure SQL probe failed: ${msg}`, remediation: denied ? 'Grant the Console UAMI "Reader" on the subscription/RG for ARM reads (+ an AAD login with db_owner on target servers for mirroring change-feed DDL).' : 'Verify LOOM_SUBSCRIPTION_ID / LOOM_AZURE_SQL_DEFAULT_SERVER and reachability.', redeploy: true, portalSteps: denied ? grantPortalSteps(h, 'the subscription or SQL resource group', 'Reader') : undefined, fixScript: denied ? grantScript(h, 'Reader', `/subscriptions/${env('LOOM_SUBSCRIPTION_ID')}`) : undefined };
  }
}

/** PostgreSQL Flexible (Lakebase / pgvector). Real AAD token + SELECT 1 over the
 *  pg wire protocol — the deepest liveness (proves auth + reachability). */
async function probePostgres(h: ProbeHelpers): Promise<CheckResult> {
  const base = { id: 'probe-postgres', category: 'azure-services' as const, title: 'PostgreSQL Flexible reachable + authorized (Lakebase — AAD SELECT 1)', severity: 'optional' as const };
  const host = env('LOOM_POSTGRES_HOST') || env('LOOM_PGVECTOR_HOST');
  if (!host) {
    return { ...base, status: 'warn', detail: 'Postgres Flexible not configured — lakebase-postgres items and the pgvector store are gated.', remediation: 'Set LOOM_POSTGRES_HOST (+ LOOM_POSTGRES_AAD_USER). See the "PostgreSQL Flexible Server (Lakebase / pgvector)" check.', redeploy: true, ...h.envVarFix(['LOOM_POSTGRES_HOST']) };
  }
  try {
    const { postgresQueryGate, executePostgresQuery } = await import('@/lib/azure/postgres-flex-client');
    const g = postgresQueryGate();
    if (g) return { ...base, status: 'warn', detail: `Postgres server configured but AAD principal not registered: ${g.detail}`, remediation: `Set ${g.missing} and run the one-time pgaadauth_create_principal for the Console UAMI (ARM/provisioning/firewall already work).`, redeploy: true, ...h.envVarFix([g.missing]) };
    const r = await withTimeout(executePostgresQuery(host, 'postgres', 'SELECT 1 AS loom_health'), 8000);
    return { ...base, status: 'pass', detail: `Postgres reachable + AAD-authorized (${host}): SELECT 1 returned ${r.rows?.length ?? 0} row(s).` };
  } catch (e: any) {
    const msg = e?.message || String(e); const denied = DENIED.test(msg) || /password authentication|no pg_hba|role .* does not exist/i.test(msg);
    return { ...base, status: denied ? 'fail' : 'warn', detail: `Postgres SELECT 1 failed: ${msg}`, remediation: denied ? 'Register the Console UAMI as a PG Entra principal: connect as the PG Entra admin and run SELECT * FROM pgaadauth_create_principal(\'<console-uami-name>\', false, false); then GRANT it privileges.' : 'Verify LOOM_POSTGRES_HOST, the server firewall / private endpoint from the Console subnet, and LOOM_POSTGRES_AAD_USER.', redeploy: true };
  }
}

/** Stream Analytics jobs (eventstream processing). ARM list at the RG. */
async function probeStreamAnalytics(h: ProbeHelpers): Promise<CheckResult> {
  const base = { id: 'probe-stream-analytics', category: 'azure-services' as const, title: 'Stream Analytics reachable + authorized (eventstream processing)', severity: 'optional' as const };
  if (!anyHas('LOOM_ASA_RG', 'LOOM_DLZ_RG')) {
    return { ...base, status: 'warn', detail: 'Stream Analytics RG not configured — eventstream processing has no ASA target.', remediation: 'Set LOOM_ASA_RG (falls back to LOOM_DLZ_RG). See the "Stream Analytics" check.', redeploy: true, ...h.envVarFix(['LOOM_ASA_RG']) };
  }
  try {
    const { listJobs } = await import('@/lib/azure/stream-analytics-client');
    const jobs = await withTimeout(listJobs(), 6000);
    return { ...base, status: 'pass', detail: `Stream Analytics ARM readable as the Console UAMI: ${jobs.length} streaming job(s) in ${env('LOOM_ASA_RG') || h.ctx.dlzRg}${jobs.length ? ` — ${jobs.slice(0, 5).map((j: any) => j.name).join(', ')}` : ' (jobs are created on demand by the eventstream provisioner)'}.` };
  } catch (e: any) {
    const msg = e?.message || String(e); const denied = DENIED.test(msg);
    return { ...base, status: denied ? 'fail' : 'warn', detail: `Stream Analytics probe failed: ${msg}`, remediation: denied ? 'Grant the Console UAMI "Contributor" on the Stream Analytics resource group.' : 'Verify LOOM_ASA_RG / LOOM_ASA_SUB and reachability.', redeploy: true, portalSteps: denied ? grantPortalSteps(h, 'the Stream Analytics resource group', 'Contributor') : undefined, fixScript: denied ? grantScript(h, 'Contributor', `/subscriptions/${env('LOOM_ASA_SUB') || env('LOOM_SUBSCRIPTION_ID')}/resourceGroups/${env('LOOM_ASA_RG') || h.ctx.dlzRg}`) : undefined };
  }
}

/** Event Grid topics (business-events / real-time shims). ARM list. */
async function probeEventGrid(h: ProbeHelpers): Promise<CheckResult> {
  const base = { id: 'probe-eventgrid', category: 'azure-services' as const, title: 'Event Grid reachable + authorized (business-events topics)', severity: 'optional' as const };
  try {
    const { eventgridTopicsConfigGate, listEventGridTopics } = await import('@/lib/azure/eventgrid-topics-client');
    const g = eventgridTopicsConfigGate();
    if (g) return { ...base, status: 'warn', detail: 'Event Grid not configured — business-events topics / shims are unavailable (Event Hubs / Service Bus paths still work).', remediation: `Set ${g.missing}. See the "Event Grid" check.`, redeploy: true, ...h.envVarFix([g.missing]) };
    const topics = await withTimeout(listEventGridTopics(), 6000);
    return { ...base, status: 'pass', detail: `Event Grid ARM readable as the Console UAMI: ${topics.length} custom topic(s)${topics.length ? ` — ${topics.slice(0, 5).map((t: any) => t.name).join(', ')}` : ''}.` };
  } catch (e: any) {
    const msg = e?.message || String(e); const denied = DENIED.test(msg);
    return { ...base, status: denied ? 'fail' : 'warn', detail: `Event Grid probe failed: ${msg}`, remediation: denied ? 'Grant the Console UAMI "EventGrid Contributor" on the RG (+ "EventGrid Data Sender" on the topic to publish).' : 'Verify LOOM_EVENTGRID_RG / LOOM_EVENTGRID_BUSINESS_TOPIC and reachability.', redeploy: true, portalSteps: denied ? grantPortalSteps(h, 'the Event Grid resource group', 'EventGrid Contributor') : undefined, fixScript: denied ? grantScript(h, 'EventGrid Contributor', `/subscriptions/${env('LOOM_EVENTGRID_SUB') || env('LOOM_SUBSCRIPTION_ID')}/resourceGroups/${env('LOOM_EVENTGRID_RG') || h.ctx.dlzRg}`) : undefined };
  }
}

/** Azure Batch account (batch-pool compute items). ARM read. */
async function probeBatch(h: ProbeHelpers): Promise<CheckResult> {
  const base = { id: 'probe-batch', category: 'azure-services' as const, title: 'Azure Batch account reachable + authorized (batch-pool items)', severity: 'optional' as const };
  try {
    const { batchConfigGate, getBatchAccount } = await import('@/lib/azure/batch-client');
    const g = batchConfigGate();
    if (g) return { ...base, status: 'warn', detail: 'Azure Batch not configured — batch-pool compute items are gated.', remediation: `Set ${g.missing} (+ LOOM_BATCH_RG). See the "Azure Batch" check.`, redeploy: true, ...h.envVarFix([g.missing]) };
    const acct: any = await withTimeout(getBatchAccount(), 6000);
    return { ...base, status: 'pass', detail: `Azure Batch reachable + authorized (${acct?.name || env('LOOM_BATCH_ACCOUNT')}, ${acct?.properties?.provisioningState || acct?.provisioningState || 'state n/a'}).` };
  } catch (e: any) {
    const msg = e?.message || String(e); const denied = DENIED.test(msg);
    return { ...base, status: denied ? 'fail' : 'warn', detail: `Azure Batch probe failed: ${msg}`, remediation: denied ? 'Grant the Console UAMI "Contributor" on the Batch account.' : 'Verify LOOM_BATCH_ACCOUNT / LOOM_BATCH_RG and reachability.', redeploy: true, portalSteps: denied ? grantPortalSteps(h, 'the Azure Batch account', 'Contributor') : undefined, fixScript: denied ? grantScript(h, 'Contributor', `/subscriptions/${env('LOOM_SUBSCRIPTION_ID')}/resourceGroups/${env('LOOM_BATCH_RG') || h.ctx.dlzRg}/providers/Microsoft.Batch/batchAccounts/${env('LOOM_BATCH_ACCOUNT') || '<batch-account>'}`) : undefined };
  }
}

// ── runner ───────────────────────────────────────────────────────────────────

/** Help Copilot corpus freshness (WS-G / G2). Compares the staged docs against
 *  what the incremental index last built (via the corpus manifest) so a stale
 *  or never-built RAG corpus is detectable at runtime. No env gate — the corpus
 *  is a Loom-internal artifact (Cosmos fallback always available); the only
 *  action is an admin reindex. */
async function probeCopilotCorpus(h: ProbeHelpers): Promise<CheckResult> {
  const base = { id: 'probe-copilot-corpus', category: 'ai-copilot' as const, title: 'Help Copilot corpus freshness (docs RAG index)', severity: 'optional' as const };
  try {
    const { corpusFreshness } = await import('@/lib/azure/loom-docs-index');
    const f = await withTimeout(corpusFreshness(), 8000);
    if (f.state === 'never-indexed') {
      return {
        ...base, status: 'warn',
        detail: `Help Copilot corpus has never been indexed (backend ${f.backend}) — the docs RAG returns nothing until a first build.`,
        remediation: 'POST /api/help-copilot/reindex as an admin to build the corpus (one-time after deploy). The incremental builder then only re-processes changed docs on later runs.',
        redeploy: false,
      };
    }
    if (f.state === 'stale') {
      return {
        ...base, status: 'warn',
        detail: `Help Copilot corpus is STALE — the staged docs changed since the last index build (indexed ${f.indexedAt || 'n/a'}, ${f.indexedChunkCount ?? 0} chunks, backend ${f.backend}).`,
        remediation: 'POST /api/help-copilot/reindex as an admin to re-index. The incremental build only re-processes the changed/new/removed docs.',
        redeploy: false,
      };
    }
    return { ...base, status: 'pass', detail: `Help Copilot corpus fresh (backend ${f.backend}, ${f.indexedChunkCount ?? 0} chunks, indexed ${f.indexedAt || 'n/a'}).` };
  } catch (e: any) {
    return {
      ...base, status: 'warn',
      detail: `Corpus freshness check failed: ${e?.message || String(e)}`,
      remediation: 'Verify Cosmos (or AI Search) reachability — the corpus manifest is read from the help-copilot-corpus container / loom-docs index. Then POST /api/help-copilot/reindex.',
      redeploy: false,
    };
  }
}

/** DR0 + CMK1 — restore/at-rest posture (live ARM). Verifies the estate is
 *  actually restorable AND honestly reports encryption-at-rest, not just
 *  configured: (a) the Loom-store Cosmos account runs Continuous (PITR) backup
 *  — reports the tier (Continuous7Days is the documented-preview tier;
 *  Continuous30Days is the GA default the bicep now ships); (b) CMK-at-rest —
 *  reads properties.keyVaultKeyUri from the same ARM shape. When the deploy
 *  declares the CMK mandate (LOOM_COSMOS_REQUIRE_CMK=true, wired from
 *  drConfig.cosmosRequireCmk), a missing key URI is flagged as a posture GAP;
 *  otherwise the service-managed default is reported honestly (CMK stays an
 *  opt-in, IL5-mandated posture — see loom-console-cosmos.bicep); (c) the DLZ
 *  lake has blob + container soft delete and change feed enabled. Blob
 *  versioning is reported honestly: it is "Not yet supported" on HNS (ADLS
 *  Gen2) accounts per the Learn feature matrix, so on the lake the supported
 *  restore path is soft delete + change feed + Delta time travel — a false
 *  isVersioningEnabled is NOT a defect there. */
async function probeDrRestorePosture(h: ProbeHelpers): Promise<CheckResult> {
  const base = { id: 'probe-dr-restore-posture', category: 'data-plane' as const, title: 'DR restore posture — Cosmos continuous backup + CMK-at-rest + lake recovery (live ARM)', severity: 'optional' as const };
  const good: string[] = [];
  const bad: string[] = [];
  let probed = false;
  // (a) Cosmos — Continuous (PITR) backup on the Loom store.
  // (b) Cosmos — CMK-at-rest (CMK1), from the same account-management read.
  try {
    const { cosmosConfigGate, getAccountManagement } = await import('@/lib/azure/cosmos-account-client');
    if (!cosmosConfigGate()) {
      probed = true;
      const mgmt = await withTimeout(getAccountManagement(), 8000);
      const bp = mgmt?.backupPolicy;
      if (bp?.type === 'Continuous') {
        good.push(`Cosmos "${env('LOOM_COSMOS_ACCOUNT')}": Continuous backup, tier ${bp.tier || 'Continuous30Days'} (PITR window ${bp.tier === 'Continuous7Days' ? '7' : '30'} days)`);
      } else {
        bad.push(`Cosmos "${env('LOOM_COSMOS_ACCOUNT')}" backup mode is "${bp?.type || 'unknown'}" — expected Continuous (PITR). Switch it (hot, in-place): az cosmosdb update --backup-policy-type Continuous --continuous-tier Continuous30Days, or set drConfig.cosmosBackupTier + redeploy.`);
      }
      const cmkRequired = /^(1|true)$/i.test(env('LOOM_COSMOS_REQUIRE_CMK'));
      if (mgmt?.keyVaultKeyUri) {
        good.push(`CMK-at-rest ON (keyVaultKeyUri ${mgmt.keyVaultKeyUri}${mgmt.defaultIdentity ? `, defaultIdentity ${mgmt.defaultIdentity}` : ''})`);
      } else if (cmkRequired) {
        bad.push(`Cosmos "${env('LOOM_COSMOS_ACCOUNT')}" has NO customer-managed key (keyVaultKeyUri unset) but this deploy mandates CMK-at-rest (LOOM_COSMOS_REQUIRE_CMK=true). Enable it (supported hot update, two steps on a continuous-backup account): az cosmosdb update --default-identity UserAssignedIdentity=<uami-resource-id>, then az cosmosdb update --key-uri <versionless-kv-key-uri> — or set drConfig.cosmosRequireCmk/cosmosCmkKeyUri/cosmosCmkIdentityId + redeploy loom-console-cosmos.bicep.`);
      } else {
        good.push('CMK-at-rest: service-managed keys (the default; customer-managed keys are the opt-in IL5 posture via drConfig.cosmosRequireCmk + cosmosCmkKeyUri + cosmosCmkIdentityId)');
      }
    }
  } catch (e: any) {
    probed = true;
    bad.push(`Cosmos backup-policy read failed: ${e?.message || String(e)}${DENIED.test(e?.message || '') ? ' — grant the Console UAMI "DocumentDB Account Contributor" (or Reader) on the account.' : ''}`);
  }
  // (c) Lake — soft delete + change feed on the DLZ ADLS account (blobServices).
  try {
    if (has('LOOM_ADLS_ACCOUNT')) {
      probed = true;
      const { armGet } = await import('@/lib/azure/arm-client');
      const rg = env('LOOM_DLZ_RG') || h.ctx.dlzRg;
      const r: any = await withTimeout(armGet(`/subscriptions/${env('LOOM_SUBSCRIPTION_ID')}/resourceGroups/${rg}/providers/Microsoft.Storage/storageAccounts/${env('LOOM_ADLS_ACCOUNT')}/blobServices/default?api-version=2023-05-01`), 8000);
      const p = r?.properties || {};
      const soft = p.deleteRetentionPolicy?.enabled === true;
      const csoft = p.containerDeleteRetentionPolicy?.enabled === true;
      const cf = p.changeFeed?.enabled === true;
      const versioned = p.isVersioningEnabled === true;
      if (soft && csoft && cf) {
        good.push(`Lake "${env('LOOM_ADLS_ACCOUNT')}": blob soft delete (${p.deleteRetentionPolicy?.days ?? '?'}d) + container soft delete (${p.containerDeleteRetentionPolicy?.days ?? '?'}d) + change feed ON${versioned ? ' + blob versioning ON' : ' (blob versioning n/a on HNS — Delta time travel covers table data)'}`);
      } else {
        bad.push(`Lake "${env('LOOM_ADLS_ACCOUNT')}" restore posture incomplete — blob soft delete: ${soft ? 'on' : 'OFF'}, container soft delete: ${csoft ? 'on' : 'OFF'}, change feed: ${cf ? 'on' : 'OFF'}. Redeploy modules/landing-zone/storage.bicep (recycleRetentionDays wires soft delete; change feed is always-on there).`);
      }
    }
  } catch (e: any) {
    probed = true;
    bad.push(`Lake blob-service read failed: ${e?.message || String(e)}${DENIED.test(e?.message || '') ? ' — grant the Console UAMI "Reader" on the DLZ storage account.' : ''}`);
  }
  if (!probed) {
    return {
      ...base, status: 'warn',
      detail: 'Restore posture unverifiable — neither the Cosmos account coordinates (LOOM_COSMOS_ACCOUNT + LOOM_COSMOS_ACCOUNT_RG) nor the lake account (LOOM_ADLS_ACCOUNT) are configured.',
      remediation: 'Set LOOM_COSMOS_ACCOUNT (+ LOOM_COSMOS_ACCOUNT_RG) and LOOM_ADLS_ACCOUNT so the posture probe can read live ARM. See the "DR restore posture" check.',
      redeploy: true,
      ...h.envVarFix(['LOOM_COSMOS_ACCOUNT', 'LOOM_ADLS_ACCOUNT']),
    };
  }
  if (bad.length) {
    return {
      ...base, status: 'warn',
      detail: `Restore posture gaps: ${bad.join(' ')}${good.length ? ` (healthy: ${good.join('; ')})` : ''}`,
      remediation: 'Bring the estate back to the restorable baseline: Cosmos Continuous (PITR) backup — hot in-place tier switch via the Cosmos account-management surface or drConfig.cosmosBackupTier — CMK-at-rest where the deploy mandates it (drConfig.cosmosRequireCmk + cosmosCmkKeyUri + cosmosCmkIdentityId, or the two-step az cosmosdb update), and lake soft delete + change feed via modules/landing-zone/storage.bicep.',
      redeploy: true,
      docs: 'https://learn.microsoft.com/azure/cosmos-db/continuous-backup-restore-introduction',
    };
  }
  return { ...base, status: 'pass', detail: `Restorable baseline verified via live ARM — ${good.join('; ')}.` };
}

/** Run every extended probe in parallel (each individually time-bounded). */
export async function runExtraProbes(h: ProbeHelpers): Promise<CheckResult[]> {
  return Promise.all([
    probeAdls(h),
    probeSynapse(h),
    probeKusto(h),
    probeEventHubs(h),
    probeAdf(h),
    probeArmReader(h),
    probeLogAnalytics(h),
    probeGraphDirectory(h),
    probePowerPlatform(h),
    probeServiceBus(h),
    probeApim(h),
    probeKeyVault(h),
    // W-B depth wave — 8 live probes for env-gated backends that had no live call.
    probeAas(h),
    probeAml(h),
    probeAzureSql(h),
    probePostgres(h),
    probeStreamAnalytics(h),
    probeEventGrid(h),
    probeBatch(h),
    probeHttpService(
      'probe-grafana', 'azure-services', 'Grafana reachable — usage/governance embeds', 'LOOM_GRAFANA_ENDPOINT',
      'the usage/governance Grafana dashboard embeds (Gov clouds especially)', 'Deployed by the Azure Managed Grafana module; the embeds render an honest gate when unset.', h),
    probeHttpService(
      'probe-dab-runtime', 'builders', 'DAB preview runtime reachable — REST/GraphQL testers', 'LOOM_DAB_PREVIEW_URL',
      'the Data API builder live testers + ontology-sdk "Try it"', 'Deployed by modules/admin-plane/dab-runtime.bicep (dabRuntimeEnabled, default on).', h),
    probeHttpService(
      'probe-udf-runtime', 'builders', 'UDF runtime reachable — user data function Invoke', 'LOOM_UDF_FUNCTION_BASE',
      'user-data-function Invoke', 'Deployed by modules/admin-plane/udf-runtime.bicep (udfRuntimeEnabled, default on).', h),
    probeHttpService(
      'probe-builtin-mcp', 'ai-copilot', 'Built-in Loom MCP server reachable', 'LOOM_BUILTIN_MCP_URL',
      'the built-in MCP server path (catalog list renders regardless)', 'Deployed + wired by the post-deploy bootstrap (built-in MCP Container App).', h),
    probeHttpService(
      'probe-paginated-renderer', 'builders', 'Paginated-report renderer reachable — RDL export', 'LOOM_PAGINATED_RENDER_URL',
      'paginated-report (RDL) export', 'Deployed by the paginated-report-renderer Azure Function (post-deploy bootstrap); authoring persists in Cosmos regardless.', h),
    // WS-G / G2 — Help Copilot docs-RAG corpus freshness (incremental-index manifest).
    probeCopilotCorpus(h),
    // DR0 — restore posture (Cosmos PITR tier + lake soft-delete/change-feed, live ARM).
    probeDrRestorePosture(h),
  ]);
}
