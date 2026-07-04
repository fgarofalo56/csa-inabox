/**
 * GET /api/items/cosmos-db/[id]/metrics
 *
 * Live Azure Monitor platform metrics for the configured Cosmos DB navigator
 * account (LOOM_COSMOS_ACCOUNT). Powers the cosmos-account-editor Metrics tab:
 *   - RU consumed (TotalRequestUnits, Total)            ← saturation vs provisioned
 *   - Provisioned throughput (ProvisionedThroughput, Maximum)
 *   - Data storage (DataUsage, Total)
 *   - Throttled requests (TotalRequests filtered StatusCode '429', Count)
 *
 * The Cosmos account is resolved from env (no Fabric dependency). When a db /
 * container is supplied we add an OData $filter so the series is scoped to that
 * database/container exactly like the Azure portal "Metrics (classic)" /
 * "Insights" blades. The 429 series uses the StatusCode dimension.
 *
 * Query params:
 *   db        — database name (optional; omit for account-level aggregate)
 *   container — container name (optional; requires db)
 *   timespan  — ISO duration: PT1H | PT6H | P1D | P7D (default PT1H)
 *
 * Returns: { ok, metrics: MetricResult[], throttled: MetricResult[], resourceId,
 *            timespan, db, container }
 *
 * Honest gate (per no-vaporware.md): 503 { ok:false, code:'not_configured' }
 *   when LOOM_COSMOS_ACCOUNT / LOOM_COSMOS_ACCOUNT_RG / LOOM_SUBSCRIPTION_ID are
 *   unset. The Console UAMI needs "Monitoring Reader" at subscription scope
 *   (platform/fiab/bicep/modules/admin-plane/monitoring-reader-rbac.bicep
 *   already grants this) — no new role grant required.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { cosmosConfigGate, cosmosAccountResourceId } from '@/lib/azure/cosmos-account-client';
import { fetchMetrics, type MetricResult } from '@/lib/azure/monitor-client';
import { escapeSqlLiteral } from '@/lib/sql/quoting';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HINT =
  'Set LOOM_COSMOS_ACCOUNT, LOOM_COSMOS_ACCOUNT_RG, and LOOM_SUBSCRIPTION_ID on the ' +
  'Console Container App. The Console UAMI needs "Monitoring Reader" at subscription scope ' +
  '(platform/fiab/bicep/modules/admin-plane/monitoring-reader-rbac.bicep already grants this) ' +
  'to read Azure Monitor metrics for the Cosmos DB account.';

/** Whitelisted windows → grain so the request stays inside Monitor data-point caps. */
function grainFor(timespan: string): { timespan: string; ru: string; coarse: string } {
  switch (timespan) {
    case 'P7D': return { timespan, ru: 'PT1H', coarse: 'PT1H' };
    case 'P1D': return { timespan, ru: 'PT15M', coarse: 'PT30M' };
    case 'PT6H': return { timespan, ru: 'PT5M', coarse: 'PT15M' };
    case 'PT1H':
    default: return { timespan: 'PT1H', ru: 'PT5M', coarse: 'PT5M' };
  }
}

// Escape single quotes in dimension values for the OData $filter literal.
const odata = (v: string) => escapeSqlLiteral(v);

export async function GET(req: Request, _ctx: { params: { id: string } }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const gate = cosmosConfigGate();
  if (gate) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', missing: gate.missing, hint: gate.hint },
      { status: 503 },
    );
  }

  const url = new URL(req.url);
  const db = (url.searchParams.get('db') || '').trim();
  const container = (url.searchParams.get('container') || '').trim();
  const rawSpan = (url.searchParams.get('timespan') || 'PT1H').trim();
  const { timespan, ru, coarse } = grainFor(rawSpan);

  let resourceId: string;
  try {
    resourceId = cosmosAccountResourceId();
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e), hint: HINT }, { status: 503 });
  }

  // Build OData filters for dimension scoping. Without a db we read the
  // account-level aggregate (Monitor sums across dimensions automatically).
  const scopeFilter =
    db && container ? `DatabaseName eq '${odata(db)}' and CollectionName eq '${odata(container)}'`
      : db ? `DatabaseName eq '${odata(db)}'`
        : undefined;
  const throttleFilter = scopeFilter
    ? `${scopeFilter} and StatusCode eq '429'`
    : `StatusCode eq '429'`;

  try {
    const [ruResult, provisionedResult, storageResult, throttledResult] = await Promise.all([
      fetchMetrics({
        resourceId,
        metricNames: ['TotalRequestUnits'],
        aggregation: 'Total',
        timespan, interval: ru, filter: scopeFilter,
      }),
      fetchMetrics({
        resourceId,
        metricNames: ['ProvisionedThroughput'],
        aggregation: 'Maximum',
        timespan, interval: coarse, filter: scopeFilter,
      }),
      fetchMetrics({
        resourceId,
        metricNames: ['DataUsage'],
        aggregation: 'Total',
        timespan, interval: coarse, filter: scopeFilter,
      }),
      fetchMetrics({
        resourceId,
        metricNames: ['TotalRequests'],
        aggregation: 'Count',
        timespan, interval: ru, filter: throttleFilter,
      }),
    ]);

    const metrics: MetricResult[] = [...ruResult, ...provisionedResult, ...storageResult];
    const throttled: MetricResult[] = throttledResult;

    return NextResponse.json({
      ok: true,
      metrics,
      throttled,
      resourceId,
      timespan,
      db: db || null,
      container: container || null,
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e), hint: HINT },
      { status: 502 },
    );
  }
}
