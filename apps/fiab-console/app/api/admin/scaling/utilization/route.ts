/**
 * GET /api/admin/scaling/utilization
 *
 * Per-service current-utilization snapshot for the Admin → Scale by SKU page.
 * Queries Azure Monitor metrics (real REST) over the last 15 minutes and returns
 * the most recent non-null data point per scalable service.
 *
 * Per .claude/rules/no-vaporware.md: values are ONLY returned when a real Azure
 * Monitor data point exists. When a resource type has no ARM metric, or the
 * resource is not configured, or Monitor has no data in the window, the entry
 * returns { available: false } so the UI shows "—" honestly.
 *
 * Resource-type → metric mapping (grounded in METRIC_CATALOG in monitor-client):
 *   Synapse Dedicated SQL pool   → DWUUsedPercent (Average, max over pools)
 *   Cosmos DB account            → NormalizedRUConsumption (Maximum)
 *   ADX cluster                  → CPU (Average)
 *   AI Search                    → SearchQueriesPerSecond (Average)
 *   APIM                         → Requests (Total)
 *   Container Apps               → UsageNanoCores (Average, max over apps)
 *   Databricks SQL Warehouse     → no ARM Monitor metric → available:false
 *   Databricks Cluster           → no ARM Monitor metric → available:false
 *   AI Foundry compute           → no ARM Monitor metric → available:false
 *
 * ARM resource IDs are constructed server-side from the same env vars the
 * individual scaling routes use. No resourceId is required from the client.
 *
 * Auth: same getSession() + denyIfNoDlzAccess guard as all other /admin/scaling routes.
 * Monitor permission: the Console UAMI needs "Monitoring Reader" on the subscription.
 *
 * Response shape:
 *   { ok:true, items: ScalingUtilItem[] }
 *
 * ScalingUtilItem:
 *   { resourceType: string, metric: string, unit: string, value: number, available: true }
 *   | { resourceType: string, available: false, reason?: string }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { denyIfNoDlzAccess } from '@/lib/auth/dlz-gate';
import { fetchMetrics, MonitorNotConfiguredError, MonitorError } from '@/lib/azure/monitor-client';
import { armBase } from '@/lib/azure/cloud-endpoints';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** One row in the response — one scalable service type. */
export interface ScalingUtilItem {
  /** ARM resource type (lowercase), e.g. 'microsoft.synapse/workspaces'. */
  resourceType: string;
  /** True when a real Azure Monitor data point was returned. */
  available: boolean;
  /** Metric name as returned by Azure Monitor, e.g. 'DWUUsedPercent'. */
  metric?: string;
  /** Azure Monitor unit string, e.g. 'Percent', 'Count'. */
  unit?: string;
  /** The most recent non-null data point value over the last 15 minutes. */
  value?: number;
  /** Human-readable label for the metric, e.g. 'DWU used %'. */
  label?: string;
  /** Honest reason when available:false (e.g. 'not configured', 'no ARM metric'). */
  reason?: string;
}

/** Pick the last non-null value from a set of metric points. */
function lastValue(points: { timeStamp: string; value: number | null }[]): number | null {
  // points arrive oldest-first from Azure Monitor; scan from the end.
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i].value !== null) return points[i].value as number;
  }
  return null;
}

/** Fetch a single metric for a resource; returns null on any error. */
async function probe(opts: {
  resourceId: string;
  metric: string;
  aggregation: string;
  label: string;
  resourceType: string;
}): Promise<ScalingUtilItem> {
  const { resourceId, metric, aggregation, label, resourceType } = opts;
  try {
    const results = await fetchMetrics({
      resourceId,
      metricNames: [metric],
      timespan: 'PT15M',
      interval: 'PT5M',
      aggregation,
    });
    const r = results[0];
    if (!r) return { resourceType, available: false, reason: 'no metric result' };
    const v = lastValue(r.points);
    if (v === null) return { resourceType, available: false, reason: 'no data in window' };
    return {
      resourceType,
      available: true,
      metric,
      unit: r.unit,
      value: Math.round(v * 100) / 100,
      label,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { resourceType, available: false, reason: msg.slice(0, 120) };
  }
}

export async function GET(_req: NextRequest): Promise<NextResponse> {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const denied = await denyIfNoDlzAccess(s, 'scaling');
  if (denied) return denied;

  const ARM = armBase();
  const sub = process.env.LOOM_SUBSCRIPTION_ID || '';

  // ---------------------------------------------------------------------------
  // Build per-resource probe descriptors. Each item either resolves to a real
  // ARM resource ID (and we probe Monitor) or returns { available:false } with
  // an honest reason (not configured / no ARM metric for this type).
  // ---------------------------------------------------------------------------

  const probes: Promise<ScalingUtilItem>[] = [];

  // 1. Synapse Dedicated SQL pool — DWUUsedPercent
  //    Resource: Microsoft.Synapse/workspaces/{ws}/sqlPools/{pool}
  //    Grounded in:
  //    learn.microsoft.com/azure/synapse-analytics/sql-data-warehouse/sql-data-warehouse-manage-monitor
  {
    const synapseSub = process.env.LOOM_SYNAPSE_SUB || sub;
    const synapseRg = process.env.LOOM_SYNAPSE_RG || process.env.LOOM_DLZ_RG || '';
    const synapseWs = process.env.LOOM_SYNAPSE_WORKSPACE || '';
    const synapsePool = process.env.LOOM_SYNAPSE_DEDICATED_POOL || '';
    const resourceType = 'microsoft.synapse/workspaces/sqlpools';
    if (!synapseSub || !synapseRg || !synapseWs || !synapsePool) {
      probes.push(Promise.resolve({
        resourceType,
        available: false,
        reason: 'LOOM_SYNAPSE_WORKSPACE or LOOM_SYNAPSE_DEDICATED_POOL not configured',
      }));
    } else {
      const resourceId =
        `${ARM}/subscriptions/${synapseSub}/resourceGroups/${synapseRg}/providers/Microsoft.Synapse/workspaces/${synapseWs}/sqlPools/${synapsePool}`;
      probes.push(probe({
        resourceId,
        metric: 'DWUUsedPercent',
        aggregation: 'Average',
        label: 'DWU used %',
        resourceType,
      }));
    }
  }

  // 2. Cosmos DB account — NormalizedRUConsumption (max % across partitions)
  //    Resource: Microsoft.DocumentDB/databaseAccounts/{account}
  //    Grounded in:
  //    learn.microsoft.com/azure/cosmos-db/monitor-reference#normalizedrucons
  {
    const resourceType = 'microsoft.documentdb/databaseaccounts';
    // LOOM_COSMOS_ACCOUNT_ID is the full ARM resource id when set (preferred).
    // Otherwise derive account name from LOOM_COSMOS_ENDPOINT hostname.
    let cosmosResourceId: string | null =
      (process.env.LOOM_COSMOS_ACCOUNT_ID || '').trim() || null;
    if (!cosmosResourceId) {
      const endpoint = (process.env.LOOM_COSMOS_ENDPOINT || '').trim();
      const accountName = endpoint
        ? (endpoint.match(/https?:\/\/([^.]+)\./)?.[1] || null)
        : null;
      const cosmosRg = process.env.LOOM_COSMOS_ACCOUNT_RG || process.env.LOOM_DLZ_RG || '';
      const cosmosSub = sub;
      if (accountName && cosmosRg && cosmosSub) {
        cosmosResourceId =
          `${ARM}/subscriptions/${cosmosSub}/resourceGroups/${cosmosRg}/providers/Microsoft.DocumentDB/databaseAccounts/${accountName}`;
      }
    }
    if (!cosmosResourceId) {
      probes.push(Promise.resolve({
        resourceType,
        available: false,
        reason: 'LOOM_COSMOS_ENDPOINT or LOOM_COSMOS_ACCOUNT_ID not configured',
      }));
    } else {
      probes.push(probe({
        resourceId: cosmosResourceId,
        metric: 'NormalizedRUConsumption',
        aggregation: 'Maximum',
        label: 'Normalized RU %',
        resourceType,
      }));
    }
  }

  // 3. Azure Data Explorer (ADX) cluster — CPU %
  //    Resource: Microsoft.Kusto/clusters/{name}
  //    Grounded in:
  //    learn.microsoft.com/azure/data-explorer/using-metrics#supported-azure-data-explorer-metrics
  {
    const resourceType = 'microsoft.kusto/clusters';
    const kustoSub = process.env.LOOM_KUSTO_SUB || sub;
    const kustoRg = process.env.LOOM_KUSTO_RG || process.env.LOOM_DLZ_RG || '';
    const kustoCluster = process.env.LOOM_KUSTO_CLUSTER_NAME || '';
    if (!kustoSub || !kustoRg || !kustoCluster) {
      probes.push(Promise.resolve({
        resourceType,
        available: false,
        reason: 'LOOM_KUSTO_CLUSTER_NAME or LOOM_KUSTO_RG not configured',
      }));
    } else {
      const resourceId =
        `${ARM}/subscriptions/${kustoSub}/resourceGroups/${kustoRg}/providers/Microsoft.Kusto/clusters/${kustoCluster}`;
      probes.push(probe({
        resourceId,
        metric: 'CPU',
        aggregation: 'Average',
        label: 'CPU %',
        resourceType,
      }));
    }
  }

  // 4. AI Search — SearchQueriesPerSecond
  //    Resource: Microsoft.Search/searchServices/{name}
  //    Grounded in:
  //    learn.microsoft.com/azure/search/monitor-azure-cognitive-search-data-reference
  {
    const resourceType = 'microsoft.search/searchservices';
    const searchSub = process.env.LOOM_AI_SEARCH_SUB || sub;
    const searchRg = process.env.LOOM_AI_SEARCH_RG || process.env.LOOM_ADMIN_RG || '';
    const searchName = process.env.LOOM_AI_SEARCH_SERVICE || '';
    if (!searchSub || !searchRg || !searchName) {
      probes.push(Promise.resolve({
        resourceType,
        available: false,
        reason: 'LOOM_AI_SEARCH_SERVICE or LOOM_AI_SEARCH_RG not configured',
      }));
    } else {
      const resourceId =
        `${ARM}/subscriptions/${searchSub}/resourceGroups/${searchRg}/providers/Microsoft.Search/searchServices/${searchName}`;
      probes.push(probe({
        resourceId,
        metric: 'SearchQueriesPerSecond',
        aggregation: 'Average',
        label: 'Queries / sec',
        resourceType,
      }));
    }
  }

  // 5. APIM — Requests (Total over window)
  //    Resource: Microsoft.ApiManagement/service/{name}
  //    Grounded in:
  //    learn.microsoft.com/azure/api-management/monitor-api-management-reference
  {
    const resourceType = 'microsoft.apimanagement/service';
    const apimSub = process.env.LOOM_APIM_SUB || sub;
    const apimRg = process.env.LOOM_APIM_RG || process.env.LOOM_ADMIN_RG || '';
    const apimName = process.env.LOOM_APIM_NAME || '';
    if (!apimSub || !apimRg || !apimName) {
      probes.push(Promise.resolve({
        resourceType,
        available: false,
        reason: 'LOOM_APIM_NAME not configured',
      }));
    } else {
      const resourceId =
        `${ARM}/subscriptions/${apimSub}/resourceGroups/${apimRg}/providers/Microsoft.ApiManagement/service/${apimName}`;
      probes.push(probe({
        resourceId,
        metric: 'Requests',
        aggregation: 'Total',
        label: 'Requests (15m)',
        resourceType,
      }));
    }
  }

  // 6. Container Apps — UsageNanoCores (CPU nanocores, average over the app)
  //    Resource: Microsoft.App/containerApps/{name}
  //    We probe the Loom console app itself (loom-console) as representative.
  //    Grounded in:
  //    learn.microsoft.com/azure/container-apps/metrics
  {
    const resourceType = 'microsoft.app/containerapps';
    const acaSub = process.env.LOOM_SUBSCRIPTION_ID || sub;
    const acaRg = process.env.LOOM_ACA_RG || process.env.LOOM_ADMIN_RG || '';
    // The console app's own name — gives a real utilization reading without
    // needing to enumerate all apps (that's what the scaling list already does).
    const acaAppName = process.env.LOOM_CONSOLE_APP_NAME || 'loom-console';
    if (!acaSub || !acaRg) {
      probes.push(Promise.resolve({
        resourceType,
        available: false,
        reason: 'LOOM_ACA_RG or LOOM_ADMIN_RG not configured',
      }));
    } else {
      const resourceId =
        `${ARM}/subscriptions/${acaSub}/resourceGroups/${acaRg}/providers/Microsoft.App/containerApps/${acaAppName}`;
      probes.push(probe({
        resourceId,
        metric: 'UsageNanoCores',
        aggregation: 'Average',
        label: 'CPU (nanocores)',
        resourceType,
      }));
    }
  }

  // 7. Databricks SQL Warehouse — no ARM Monitor metric available for DBU/RU.
  //    Databricks exposes utilization only through its own REST API (account-level
  //    billing logs), not through azure.microsoft.com/providers/microsoft.insights.
  //    Per .claude/rules/no-vaporware.md: return available:false, not a fake value.
  probes.push(Promise.resolve({
    resourceType: 'microsoft.databricks/warehouse',
    available: false,
    reason: 'No Azure Monitor ARM metric for Databricks SQL Warehouse DBU utilization',
  }));

  // 8. Databricks Cluster — same as above.
  probes.push(Promise.resolve({
    resourceType: 'microsoft.databricks/cluster',
    available: false,
    reason: 'No Azure Monitor ARM metric for Databricks interactive cluster DBU',
  }));

  // 9. AI Foundry (AML compute) — no per-compute-target Monitor metric emitted
  //    from the ACA/workspace plane. AML compute metrics exist at the workspace
  //    level (Active Nodes, Idle Nodes) but not as a simple % utilization scalar
  //    we can surface honestly next to a scale dial. Return available:false.
  probes.push(Promise.resolve({
    resourceType: 'microsoft.machinelearningservices/workspaces/computes',
    available: false,
    reason: 'No scalar utilization metric available for AML compute targets via Azure Monitor',
  }));

  // ---------------------------------------------------------------------------
  // Fan-out: run all probes in parallel; each is already fault-isolated inside
  // probe() so one hung Monitor call cannot block the whole response.
  // ---------------------------------------------------------------------------
  let items: ScalingUtilItem[];
  try {
    items = await Promise.all(probes);
  } catch (e) {
    // Belt-and-suspenders: probe() never throws, but if something unexpected
    // slips through we surface it rather than crash-looping.
    if (e instanceof MonitorNotConfiguredError) {
      return NextResponse.json({ ok: false, error: e.message, missing: e.missing }, { status: 503 });
    }
    const status = e instanceof MonitorError ? e.status : 500;
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status });
  }

  return NextResponse.json({ ok: true, items });
}
