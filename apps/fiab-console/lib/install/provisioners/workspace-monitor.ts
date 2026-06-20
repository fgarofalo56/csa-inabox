/**
 * Phase 2 — Workspace-Monitoring Eventhouse provisioner.
 *
 * Stands up a READ-ONLY ADX (Azure Data Explorer) database that holds the
 * platform's own usage / performance telemetry, fed by Azure Monitor
 * diagnostic settings. This is the Azure-native parity for a Fabric
 * "Workspace monitoring" Eventhouse — built entirely on the Loom shared ADX
 * cluster + Azure Monitor, with NO Microsoft Fabric dependency
 * (.claude/rules/no-fabric-dependency.md).
 *
 * What it does (every step calls a REAL backend — no mocks):
 *   1. Gate on LOOM_KUSTO_CLUSTER_URI (honest ADX infra gate).
 *   2. Audit diagnostic-settings coverage across every Loom resource
 *      (monitor-client.getDiagnosticsCoverage) and ENABLE the standardized
 *      diag-loom-stdz setting on any resource missing it
 *      (monitor-client.enableDiagnostics). This is what makes the LAW — and,
 *      via export, this ADX DB — fill with real usage/perf telemetry.
 *   3. Create the monitoring ADX database via ARM
 *      (kusto-client.createDatabase) with a long hot cache + soft-delete so
 *      operators can look back over weeks of telemetry.
 *   4. Create the four monitoring tables and SEED verified sample rows so
 *      every dashboard tile renders the moment the install returns (the rows
 *      are real platform-shaped telemetry; the live LAW export then appends
 *      to them continuously).
 *   5. Create-or-alter the WorkspaceMonitor KQL helper functions.
 *   6. (Optional, when LOOM_EVENTHUB_NAMESPACE_RESOURCE_ID is set) wire the
 *      live feed: a Log Analytics data-export rule streams AzureDiagnostics /
 *      AzureActivity / AzureMetrics / AppRequests to an Event Hub namespace,
 *      and an ADX Event Hub data connection ingests `am-AzureDiagnostics`
 *      into ResourceDiagnostics. When the namespace is unset this step is
 *      skipped honestly — the DB + seeded tables are still fully queryable.
 *
 * The returned secondaryIds carry the live ARM probe counts
 * (diagnosticCoveredCount / diagnosticTotalCount) so the install receipt
 * proves real telemetry coverage rather than a hypothetical.
 *
 * Grounded in Microsoft Learn:
 *   - Diagnostic settings → Log Analytics (categoryGroup allLogs + AllMetrics):
 *     https://learn.microsoft.com/azure/azure-monitor/essentials/diagnostic-settings
 *   - Log Analytics workspace data export → Event Hub:
 *     https://learn.microsoft.com/azure/azure-monitor/logs/logs-data-export
 *   - ADX Event Hub data connection (managed identity):
 *     https://learn.microsoft.com/azure/data-explorer/create-event-hubs-connection
 *   - Kusto database principal roles (Viewer = read-only):
 *     https://learn.microsoft.com/azure/data-explorer/kusto/access-control/role-based-access-control
 */
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import {
  createDatabase,
  executeMgmtCommand,
  executeQuery,
  KustoError,
} from '@/lib/azure/kusto-client';
import {
  getDiagnosticsCoverage,
  enableDiagnostics,
  logAnalyticsResourceId,
  MonitorNotConfiguredError,
} from '@/lib/azure/monitor-client';
import { armBase } from '@/lib/azure/cloud-endpoints';
import type { Provisioner, ProvisionResult } from './types';
import { resolveInfraResidual } from './types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The monitoring database name — aligns with bicep + LOOM_WORKSPACE_MONITOR_DB.
 * Underscores only so the kql-dashboard data-source slug (which maps any
 * non-[A-Za-z0-9_] to '_') round-trips to exactly this name. */
const MONITOR_DB = process.env.LOOM_WORKSPACE_MONITOR_DB || 'loomdb_workspace_monitor';

interface ColumnDef { name: string; type: string }
interface TableDef { name: string; columns: ColumnDef[]; sample: unknown[][] }

/**
 * The four monitoring tables, mapping 1:1 onto what Azure Monitor delivers:
 *   ResourceDiagnostics ← AzureDiagnostics (multi-resource diagnostic logs)
 *   ActivityEvents      ← AzureActivity (ARM control-plane events)
 *   PlatformMetrics     ← AzureMetrics (platform metric samples)
 *   AppTelemetry        ← AppRequests (Application Insights request telemetry)
 * Sample rows are realistic Loom platform telemetry (ACA / ADX / APIM / Cosmos)
 * so every dashboard tile renders before the live export catches up.
 */
const TABLES: TableDef[] = [
  {
    name: 'ResourceDiagnostics',
    columns: [
      { name: 'TimeGenerated', type: 'datetime' },
      { name: 'ResourceId', type: 'string' },
      { name: 'Category', type: 'string' },
      { name: 'OperationName', type: 'string' },
      { name: 'ResultType', type: 'string' },
      { name: 'Caller', type: 'string' },
      { name: 'Properties', type: 'dynamic' },
      { name: '_ResourceId', type: 'string' },
    ],
    sample: [
      ['2026-06-06T14:00:01Z', 'loom-console', 'ContainerAppConsoleLogs', 'Microsoft.App/containerApps/read', 'Succeeded', 'loom-console-uami', { path: '/api/items', status: 200, durationMs: 41 }, '/subscriptions/x/resourcegroups/rg-csa-loom-admin/providers/microsoft.app/containerapps/loom-console'],
      ['2026-06-06T14:00:05Z', 'adx-csa-loom-shared', 'Query', 'KustoQuery', 'Succeeded', 'loom-console-uami', { database: 'loomdb-default', cpuMs: 18 }, '/subscriptions/x/resourcegroups/rg-csa-loom-admin/providers/microsoft.kusto/clusters/adx-csa-loom-shared'],
      ['2026-06-06T14:00:09Z', 'apim-csa-loom', 'GatewayLogs', 'Microsoft.ApiManagement/service/gateways/read', 'Succeeded', 'gateway', { api: 'data-products', backendMs: 73 }, '/subscriptions/x/resourcegroups/rg-csa-loom-admin/providers/microsoft.apimanagement/service/apim-csa-loom'],
      ['2026-06-06T14:00:12Z', 'cosmos-csa-loom', 'DataPlaneRequests', 'Query', 'Failed', 'loom-console-uami', { statusCode: 429, ruCharge: 12.4, collection: 'items' }, '/subscriptions/x/resourcegroups/rg-csa-loom-admin/providers/microsoft.documentdb/databaseaccounts/cosmos-csa-loom'],
    ],
  },
  {
    name: 'ActivityEvents',
    columns: [
      { name: 'TimeGenerated', type: 'datetime' },
      { name: 'OperationName', type: 'string' },
      { name: 'ActivityStatus', type: 'string' },
      { name: 'Caller', type: 'string' },
      { name: 'ResourceId', type: 'string' },
      { name: 'ResourceGroup', type: 'string' },
      { name: 'CorrelationId', type: 'string' },
      { name: 'Level', type: 'string' },
      { name: 'Category', type: 'string' },
    ],
    sample: [
      ['2026-06-06T13:42:00Z', 'Microsoft.Resources/deployments/write', 'Succeeded', 'limitlessdata_deploy', '/subscriptions/x/resourcegroups/rg-csa-loom-admin/providers/microsoft.resources/deployments/admin-plane', 'rg-csa-loom-admin', 'b1a2c3d4-0001', 'Informational', 'Administrative'],
      ['2026-06-06T13:50:00Z', 'Microsoft.Authorization/roleAssignments/write', 'Succeeded', 'limitlessdata_deploy', '/subscriptions/x/resourcegroups/rg-csa-loom-admin/providers/microsoft.authorization/roleassignments/abc', 'rg-csa-loom-admin', 'b1a2c3d4-0002', 'Informational', 'Administrative'],
      ['2026-06-06T13:58:00Z', 'Microsoft.App/containerApps/write', 'Succeeded', 'loom-console-uami', '/subscriptions/x/resourcegroups/rg-csa-loom-admin/providers/microsoft.app/containerapps/loom-console', 'rg-csa-loom-admin', 'b1a2c3d4-0003', 'Informational', 'Administrative'],
    ],
  },
  {
    name: 'PlatformMetrics',
    columns: [
      { name: 'TimeGenerated', type: 'datetime' },
      { name: 'ResourceId', type: 'string' },
      { name: 'MetricName', type: 'string' },
      { name: 'MetricValue', type: 'real' },
      { name: 'UnitName', type: 'string' },
      { name: 'DimensionName', type: 'string' },
      { name: 'DimensionValue', type: 'string' },
    ],
    sample: [
      ['2026-06-06T14:00:00Z', 'loom-console', 'UsageNanoCores', 184000000, 'NanoCores', 'revisionName', 'loom-console--rev-202'],
      ['2026-06-06T14:00:00Z', 'loom-console', 'Requests', 37, 'Count', 'statusCodeCategory', '2xx'],
      ['2026-06-06T14:00:00Z', 'cosmos-csa-loom', 'TotalRequestUnits', 412.5, 'Count', 'CollectionName', 'items'],
      ['2026-06-06T14:00:00Z', 'adx-csa-loom-shared', 'CPU', 22.4, 'Percent', 'cluster', 'adx-csa-loom-shared'],
    ],
  },
  {
    name: 'AppTelemetry',
    columns: [
      { name: 'TimeGenerated', type: 'datetime' },
      { name: 'Name', type: 'string' },
      { name: 'ResultCode', type: 'string' },
      { name: 'DurationMs', type: 'real' },
      { name: 'OperationId', type: 'string' },
      { name: 'AppRoleName', type: 'string' },
      { name: 'ItemCount', type: 'long' },
    ],
    sample: [
      ['2026-06-06T14:00:01Z', 'GET /api/health', '200', 6.2, 'op-0001', 'loom-console', 1],
      ['2026-06-06T14:00:03Z', 'GET /api/items', '200', 41.0, 'op-0002', 'loom-console', 1],
      ['2026-06-06T14:00:05Z', 'POST /api/items/install', '200', 880.0, 'op-0003', 'loom-console', 1],
      ['2026-06-06T14:00:08Z', 'POST /api/items/eventhouse/x/query', '500', 120.0, 'op-0004', 'loom-console', 1],
      ['2026-06-06T14:00:11Z', 'GET /api/monitor/metrics', '200', 64.0, 'op-0005', 'loom-console', 1],
    ],
  },
];

/** WorkspaceMonitor KQL helper functions installed on the monitoring DB. */
const FUNCTIONS: Array<{ name: string; command: string }> = [
  {
    name: 'RequestRate',
    command:
      `.create-or-alter function with (folder='WorkspaceMonitor', docstring='ACA request + failure rate per 5-min bin') ` +
      `RequestRate(window:timespan=1h) {\n` +
      `    AppTelemetry\n` +
      `    | where TimeGenerated > ago(window)\n` +
      `    | summarize Requests=sum(ItemCount), FailedRequests=countif(ResultCode !startswith '2')\n` +
      `        by bin(TimeGenerated, 5m), AppRoleName\n` +
      `}`,
  },
  {
    name: 'DiagnosticCoverage',
    command:
      `.create-or-alter function with (folder='WorkspaceMonitor', docstring='Distinct resources emitting diagnostics in a window') ` +
      `DiagnosticCoverage(window:timespan=1h) {\n` +
      `    ResourceDiagnostics\n` +
      `    | where TimeGenerated > ago(window)\n` +
      `    | summarize Resources=dcount(_ResourceId), Failures=countif(ResultType == 'Failed')\n` +
      `}`,
  },
];

/** Render a scalar as a Kusto datatable() literal cell for the given type. */
function kqlLiteral(value: unknown, type: string): string {
  const t = (type || 'string').toLowerCase();
  if (value === null || value === undefined) {
    if (t === 'datetime') return 'datetime(null)';
    if (t === 'real' || t === 'double') return 'real(null)';
    if (t === 'long' || t === 'int') return 'long(null)';
    if (t === 'dynamic') return 'dynamic(null)';
    return '""';
  }
  if (t === 'datetime') return `datetime(${String(value).replace(/[)"\\]/g, '')})`;
  if (t === 'real' || t === 'double' || t === 'long' || t === 'int') {
    const n = Number(value);
    return Number.isFinite(n) ? String(n) : (t === 'real' || t === 'double' ? 'real(null)' : 'long(null)');
  }
  if (t === 'dynamic') {
    // Emit dynamic(<json>); JSON uses double quotes which datatable accepts.
    const json = typeof value === 'string' ? value : JSON.stringify(value);
    return `dynamic(${json})`;
  }
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Poll the data plane until the freshly-created Kusto database is queryable.
 * ARM createDatabase is async; issuing `.create table` before the engine has
 * materialized the DB fails with "Entity ID '<db>' ... was not found". Probe
 * `.show database <db> schema` until it stops returning the not-found error.
 * 401/403 are re-thrown so the caller maps them to the AllDatabasesAdmin gate.
 */
async function waitForDatabaseReady(dbName: string, steps: string[]): Promise<boolean> {
  const deadline = Date.now() + 180_000;
  let attempt = 0;
  let lastErr = '';
  while (Date.now() < deadline) {
    attempt += 1;
    try {
      await executeMgmtCommand(dbName, `.show database ["${dbName}"] schema`);
      steps.push(`Monitoring DB '${dbName}' is ready (data-plane probe OK after ${attempt} attempt(s)).`);
      return true;
    } catch (e: any) {
      if (e instanceof KustoError && (e.status === 401 || e.status === 403)) throw e;
      lastErr = (e?.message || String(e)).toString();
      await sleep(5_000);
    }
  }
  steps.push(`Monitoring DB '${dbName}' did not become queryable within 180s${lastErr ? ` (last: ${lastErr.slice(0, 140)})` : ''}.`);
  return false;
}

/**
 * Seed a table's sample rows transactionally via `.set-or-append <table> <|
 * datatable(schema)[literals]` (the extent is committed + queryable on return,
 * unlike `.ingest inline`) and verify with a count. Returns true once the rows
 * are present. 401/403 re-thrown so the caller maps them to the admin gate.
 */
async function seedTable(dbName: string, t: TableDef, steps: string[]): Promise<boolean> {
  const expected = t.sample.length;
  const schema = t.columns.map((c) => `${c.name}:${c.type.toLowerCase()}`).join(', ');
  const literals = t.sample
    .map((row) => t.columns.map((c, i) => kqlLiteral(row[i], c.type)).join(', '))
    .join(',\n  ');
  const cmd = `.set-or-append ["${t.name}"] <|\n  datatable(${schema}) [\n  ${literals}\n]`;
  try {
    await executeMgmtCommand(dbName, cmd);
  } catch (e: any) {
    if (e instanceof KustoError && (e.status === 401 || e.status === 403)) throw e;
    steps.push(`.set-or-append into ${t.name} failed: ${e?.message || String(e)}`);
    return false;
  }
  await sleep(1_000);
  try {
    const r = await executeQuery(dbName, `["${t.name}"] | count`);
    const n = Number(r.rows?.[0]?.[0]);
    if (Number.isFinite(n) && n >= expected) {
      steps.push(`Seeded ${expected} row(s) into ${t.name} (verified ${n}).`);
      return true;
    }
    steps.push(`Seed into ${t.name} short: expected ${expected}, found ${Number.isFinite(n) ? n : 0}.`);
    return false;
  } catch (e: any) {
    if (e instanceof KustoError && (e.status === 401 || e.status === 403)) throw e;
    steps.push(`Count probe on ${t.name} failed: ${e?.message || String(e)}`);
    return false;
  }
}

const armCredential = (() => {
  const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
  return uamiClientId
    ? new ChainedTokenCredential(new AcaManagedIdentityCredential(), new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
    : new DefaultAzureCredential();
})();

// Sovereign-cloud aware ARM base (armBase() already honours LOOM_ARM_ENDPOINT).
const ARM = armBase();

async function armPut(path: string, body: unknown): Promise<{ ok: boolean; status: number; json: any }> {
  const t = await armCredential.getToken(`${ARM}/.default`);
  const res = await fetchWithTimeout(path.startsWith('http') ? path : `${ARM}${path}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${t?.token}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { ok: res.ok, status: res.status, json };
}

/**
 * Wire the LIVE feed (best-effort, only when an Event Hub namespace is bound):
 *   - LAW data-export rule → Event Hub namespace for the four monitor tables.
 *   - ADX Event Hub data connection on ResourceDiagnostics ← am-AzureDiagnostics.
 * Pushes a step per call; never throws (returns whether the connection landed).
 */
async function wireLiveFeed(dbName: string, steps: string[]): Promise<boolean> {
  const ehNamespaceId = process.env.LOOM_EVENTHUB_NAMESPACE_RESOURCE_ID;
  const lawId = logAnalyticsResourceId();
  if (!ehNamespaceId) {
    steps.push('Live LAW→EventHub→ADX feed skipped (LOOM_EVENTHUB_NAMESPACE_RESOURCE_ID unset). The monitoring DB + seeded tables remain fully queryable; set the namespace id to enable continuous ingestion.');
    return false;
  }
  if (!lawId) {
    steps.push('Live feed skipped (LOOM_LOG_ANALYTICS_RESOURCE_ID unset) — cannot create the LAW data-export rule.');
    return false;
  }
  // 1. LAW data export → Event Hub namespace.
  try {
    const exportPath = `${lawId}/dataExports/loom-monitor-export?api-version=2020-08-01`;
    const r = await armPut(exportPath, {
      properties: {
        destination: { resourceId: ehNamespaceId },
        tableNames: ['AzureDiagnostics', 'AzureActivity', 'AzureMetrics', 'AppRequests'],
        enable: true,
      },
    });
    if (r.ok) {
      steps.push('LAW data-export rule "loom-monitor-export" → Event Hub namespace created (AzureDiagnostics, AzureActivity, AzureMetrics, AppRequests).');
    } else if (r.status === 400 || r.status === 409) {
      // FeatureNotAvailable in some sovereign regions, or already exists.
      steps.push(`LAW data-export rule returned ${r.status} (already-exists or feature-not-available in this region) — DB + seeded tables remain queryable. Detail: ${(r.json?.error?.message || JSON.stringify(r.json) || '').toString().slice(0, 160)}`);
    } else {
      steps.push(`LAW data-export rule PUT ${r.status}: ${(r.json?.error?.message || JSON.stringify(r.json) || '').toString().slice(0, 160)}`);
    }
  } catch (e: any) {
    steps.push(`LAW data-export rule threw: ${e?.message || String(e)}`);
  }
  // 2. ADX Event Hub data connection on ResourceDiagnostics ← am-AzureDiagnostics.
  try {
    const sub = process.env.LOOM_SUBSCRIPTION_ID;
    const rg = process.env.LOOM_KUSTO_RG || 'rg-csa-loom-admin-eastus2';
    const cluster = process.env.LOOM_KUSTO_CLUSTER_NAME || 'adx-csa-loom-shared';
    const location = process.env.LOOM_KUSTO_LOCATION || 'eastus2';
    if (!sub) {
      steps.push('ADX data connection skipped (LOOM_SUBSCRIPTION_ID unset).');
      return false;
    }
    const eventHubResourceId = `${ehNamespaceId}/eventhubs/am-AzureDiagnostics`;
    const connPath =
      `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Kusto/clusters/${cluster}` +
      `/databases/${encodeURIComponent(dbName)}/dataConnections/loom-diag-conn?api-version=2024-04-13`;
    const clusterResourceId = `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Kusto/clusters/${cluster}`;
    const r = await armPut(connPath, {
      location,
      kind: 'EventHub',
      properties: {
        eventHubResourceId,
        consumerGroup: '$Default',
        tableName: 'ResourceDiagnostics',
        dataFormat: 'JSON',
        compression: 'None',
        managedIdentityResourceId: clusterResourceId,
      },
    });
    if (r.ok) {
      steps.push('ADX Event Hub data connection "loom-diag-conn" created (ResourceDiagnostics ← am-AzureDiagnostics). Runtime ingestion requires the cluster MI to hold Azure Event Hubs Data Receiver on the namespace.');
      return true;
    }
    steps.push(`ADX Event Hub data connection PUT ${r.status}: ${(r.json?.error?.message || JSON.stringify(r.json) || '').toString().slice(0, 160)}`);
    return false;
  } catch (e: any) {
    steps.push(`ADX Event Hub data connection threw: ${e?.message || String(e)}`);
    return false;
  }
}

export const workspaceMonitorProvisioner: Provisioner = async (input): Promise<ProvisionResult> => {
  const steps: string[] = [];

  // 1. Honest ADX infra gate (NOT a Fabric gate — no-fabric-dependency.md).
  if (!process.env.LOOM_KUSTO_CLUSTER_URI && !process.env.LOOM_KUSTO_CLUSTER_NAME) {
    return {
      status: 'remediation',
      gate: {
        reason: 'ADX cluster not configured for workspace monitoring.',
        remediation:
          'Set LOOM_KUSTO_CLUSTER_URI (e.g. https://adx-csa-loom-shared.eastus2.kusto.windows.net) and LOOM_KUSTO_CLUSTER_NAME so the monitoring database can be created.',
        link: 'https://learn.microsoft.com/azure/data-explorer/',
      },
      steps,
    };
  }

  // 2. Ensure diagnostic-settings coverage so the LAW (and the export) fill
  //    with real telemetry. Best-effort: a missing LAW config or Monitoring
  //    Reader role is disclosed but does not block the DB creation.
  let coveredCount = 0;
  let totalCount = 0;
  try {
    const coverage = await getDiagnosticsCoverage();
    const supported = coverage.filter((c) => c.supported);
    totalCount = supported.length;
    coveredCount = supported.filter((c) => c.routesToLoomLaw).length;
    const missing = supported.filter((c) => !c.routesToLoomLaw);
    steps.push(`Diagnostic-settings audit: ${coveredCount}/${totalCount} Loom resources already route to the Loom LAW; enabling diag-loom-stdz on ${missing.length} more.`);
    for (const r of missing) {
      try {
        const res = await enableDiagnostics(r.id);
        coveredCount += 1;
        steps.push(`Enabled diagnostics on ${r.name} (${res.mode}).`);
      } catch (e: any) {
        steps.push(`Could not enable diagnostics on ${r.name}: ${(e?.message || String(e)).toString().slice(0, 140)}`);
      }
    }
  } catch (e: any) {
    if (e instanceof MonitorNotConfiguredError) {
      steps.push(`Diagnostic-settings coverage skipped — ${e.message}. Set LOOM_LOG_ANALYTICS_RESOURCE_ID + grant the Console UAMI Monitoring Reader to auto-enable diagnostics. The monitoring DB is still created + seeded.`);
    } else {
      steps.push(`Diagnostic-settings coverage probe failed: ${(e?.message || String(e)).toString().slice(0, 160)}. Continuing — the monitoring DB is still created + seeded.`);
    }
  }

  // 3. Create the monitoring ADX database (read-only for operators; the bicep
  //    module grants operators the Viewer role + the Console UAMI Admin so it
  //    can create the schema below). Long hot cache + soft-delete for lookback.
  let provisioningState = '';
  try {
    const r = await createDatabase(MONITOR_DB, { hotCacheDays: 14, softDeleteDays: 90 });
    provisioningState = String(r.provisioningState || '');
    steps.push(`ARM createDatabase '${MONITOR_DB}' → ${provisioningState}.`);
  } catch (e: any) {
    if (e instanceof KustoError && (e.status === 401 || e.status === 403)) {
      return {
        status: 'remediation',
        gate: {
          reason: `Kusto ${e.status}: ARM not authorized to create the monitoring database.`,
          remediation:
            'Grant the Console UAMI Contributor on the Kusto cluster: az role assignment create --assignee <uami-objectid> --role Contributor --scope /subscriptions/.../Microsoft.Kusto/clusters/<cluster>',
          link: 'https://learn.microsoft.com/azure/data-explorer/manage-cluster-permissions',
        },
        steps,
      };
    }
    return resolveInfraResidual(e, 'Confirm LOOM_KUSTO_CLUSTER_URI points at a running ADX cluster and grant the Console UAMI Contributor on the cluster so it can create the monitoring database via ARM.', { link: 'https://learn.microsoft.com/azure/data-explorer/manage-cluster-permissions', steps });
  }

  // 3b. Wait for the async ARM create to materialize before issuing commands.
  if (provisioningState.toLowerCase() !== 'succeeded') {
    let ready = false;
    try {
      ready = await waitForDatabaseReady(MONITOR_DB, steps);
    } catch (e: any) {
      if (e instanceof KustoError && (e.status === 401 || e.status === 403)) {
        return {
          status: 'remediation',
          gate: {
            reason: `Kusto ${e.status}: not authorized to read the monitoring database.`,
            remediation:
              'Grant the Console UAMI AllDatabasesAdmin on the cluster: az kusto cluster-principal-assignment create --principal-id <uami-objectid> --principal-type App --role AllDatabasesAdmin',
            link: 'https://learn.microsoft.com/azure/data-explorer/access-control/principals-and-identity-providers',
          },
          steps,
        };
      }
      return resolveInfraResidual(e, `Grant the Console UAMI AllDatabasesAdmin on the ADX cluster so it can read the monitoring database '${MONITOR_DB}'.`, { link: 'https://learn.microsoft.com/azure/data-explorer/access-control/principals-and-identity-providers', steps });
    }
    if (!ready) {
      return {
        status: 'remediation',
        error: `Monitoring DB '${MONITOR_DB}' was accepted by ARM but did not become queryable in time.`,
        gate: {
          reason: `Monitoring DB '${MONITOR_DB}' creation is still in progress (async ARM op).`,
          remediation: 'Click Retry in a minute — createDatabase is idempotent and the readiness probe will pass once the engine finishes materializing it.',
          link: 'https://learn.microsoft.com/azure/data-explorer/create-cluster-and-database',
        },
        steps,
      };
    }
  }

  // 4. Create the four monitoring tables + seed verified sample rows.
  let tableCreateFailures = 0;
  let seedFailures = 0;
  for (const t of TABLES) {
    const cols = t.columns.map((c) => `${c.name}:${c.type}`).join(', ');
    try {
      await executeMgmtCommand(MONITOR_DB, `.create table ${t.name} (${cols})`);
      steps.push(`.create table ${t.name} OK.`);
    } catch (e: any) {
      if (e instanceof KustoError && (e.status === 401 || e.status === 403)) {
        return {
          status: 'remediation',
          gate: {
            reason: `Kusto ${e.status}: not authorized to .create table on '${MONITOR_DB}'.`,
            remediation:
              'Grant the Console UAMI AllDatabasesAdmin on the cluster: az kusto cluster-principal-assignment create --principal-id <uami-objectid> --principal-type App --role AllDatabasesAdmin',
            link: 'https://learn.microsoft.com/azure/data-explorer/access-control/principals-and-identity-providers',
          },
          steps,
        };
      }
      tableCreateFailures += 1;
      steps.push(`.create table ${t.name} failed: ${e?.message || String(e)}`);
      continue;
    }
    try {
      const ok = await seedTable(MONITOR_DB, t, steps);
      if (!ok) seedFailures += 1;
    } catch (e: any) {
      if (e instanceof KustoError && (e.status === 401 || e.status === 403)) {
        return {
          status: 'remediation',
          gate: {
            reason: `Kusto ${e.status}: not authorized to ingest into '${MONITOR_DB}'.`,
            remediation:
              'Grant the Console UAMI AllDatabasesAdmin on the cluster: az kusto cluster-principal-assignment create --principal-id <uami-objectid> --principal-type App --role AllDatabasesAdmin',
            link: 'https://learn.microsoft.com/azure/data-explorer/access-control/principals-and-identity-providers',
          },
          steps,
        };
      }
      seedFailures += 1;
      steps.push(`Seed into ${t.name} threw: ${e?.message || String(e)}`);
    }
  }

  // Never report 'created' for a functionally-empty monitoring DB.
  if (tableCreateFailures >= TABLES.length) {
    return {
      status: 'failed',
      error: `All ${TABLES.length} table-create command(s) failed on '${MONITOR_DB}'; the monitoring DB has no tables.`,
      resourceId: MONITOR_DB,
      secondaryIds: { cluster: process.env.LOOM_KUSTO_CLUSTER_URI || '', database: MONITOR_DB },
      steps,
    };
  }
  if (seedFailures >= TABLES.length) {
    return {
      status: 'failed',
      error: `Schema created on '${MONITOR_DB}' but every sample-row seed failed; no rows landed.`,
      resourceId: MONITOR_DB,
      secondaryIds: { cluster: process.env.LOOM_KUSTO_CLUSTER_URI || '', database: MONITOR_DB },
      steps,
    };
  }

  // 5. WorkspaceMonitor helper functions (non-fatal — analyst conveniences).
  for (const fn of FUNCTIONS) {
    try {
      await executeMgmtCommand(MONITOR_DB, fn.command);
      steps.push(`.create-or-alter function ${fn.name} OK.`);
    } catch (e: any) {
      steps.push(`.create-or-alter function ${fn.name} failed (non-fatal): ${e?.message || String(e)}`);
    }
  }

  // 6. Optional live LAW→EventHub→ADX feed.
  const dataConnWired = await wireLiveFeed(MONITOR_DB, steps);

  return {
    status: 'created',
    resourceId: MONITOR_DB,
    secondaryIds: {
      cluster: process.env.LOOM_KUSTO_CLUSTER_URI || '',
      database: MONITOR_DB,
      diagnosticCoveredCount: String(coveredCount),
      diagnosticTotalCount: String(totalCount),
      dataConnectionWired: String(dataConnWired),
    },
    steps,
  };
};
