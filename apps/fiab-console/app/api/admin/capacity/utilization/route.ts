/**
 * POST /api/admin/capacity/utilization
 *
 * Azure Monitor platform-metric utilization for ONE inventory resource — the
 * per-row sparkline + the detail-pane charts on /admin/capacity.
 *
 * Body: {
 *   resourceId: string,
 *   resourceType: string,          // ARM type, e.g. Microsoft.Kusto/clusters
 *   timespan?: string,             // ISO duration, default P1D
 *   interval?: string,             // ISO grain, default PT15M
 *   allMetrics?: boolean,          // detail pane: fetch every catalog metric
 * }
 *
 * Backend: GET {resourceId}/providers/microsoft.insights/metrics (real REST via
 * monitor-client.fetchMetrics). The metric set comes from monitor-client's
 * curated METRIC_CATALOG via metricsForType() — for the sparkline we take the
 * first (headline) metric; allMetrics returns all of them for the detail charts.
 *
 * A resource type with no catalog entry is NOT an error — the route returns
 * { ok:true, data:{ gate:'no_metrics_for_type' } } so the cell renders "—"
 * rather than spinning. This includes Microsoft.Fabric/capacities in Azure
 * Government, where no Fabric capacity exists (the cu_percentage metric is
 * Commercial/GCC only) — Gov falls through to the honest "—", never blank.
 *
 * Shape: { ok:true, data } | { ok:false, gate } | { ok:false, error }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  fetchMetrics, metricsForType, MonitorNotConfiguredError, MonitorError,
} from '@/lib/azure/monitor-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  let body: any;
  try { body = await req.json(); } catch { body = {}; }
  const resourceId = typeof body?.resourceId === 'string' ? body.resourceId.trim() : '';
  const resourceType = typeof body?.resourceType === 'string' ? body.resourceType.trim() : '';
  const timespan = typeof body?.timespan === 'string' ? body.timespan : 'P1D';
  const interval = typeof body?.interval === 'string' ? body.interval : 'PT15M';
  const allMetrics = body?.allMetrics === true;
  if (!resourceId) return NextResponse.json({ ok: false, error: 'resourceId required' }, { status: 400 });
  if (!resourceType) return NextResponse.json({ ok: false, error: 'resourceType required' }, { status: 400 });

  const catalog = metricsForType(resourceType);
  if (catalog.length === 0) {
    // No platform metric defined for this resource type — honest "—" cell.
    return NextResponse.json({ ok: true, data: { gate: 'no_metrics_for_type', resourceType } });
  }

  // Sparkline → first (headline) metric only; detail pane → all catalog metrics.
  const wanted = allMetrics ? catalog : [catalog[0]];

  try {
    // Group requested metrics by aggregation (Azure Monitor takes one aggregation
    // per call), so a mixed catalog still returns each metric on its native agg.
    const byAgg = new Map<string, { metric: string; aggregation: string; label: string }[]>();
    for (const m of wanted) {
      const agg = m.aggregation || 'Average';
      if (!byAgg.has(agg)) byAgg.set(agg, []);
      byAgg.get(agg)!.push(m);
    }
    const labelFor = new Map(wanted.map((m) => [m.metric.toLowerCase(), m.label]));

    const series: { metricName: string; label: string; unit: string; aggregation: string; points: any[] }[] = [];
    for (const [agg, group] of byAgg.entries()) {
      const results = await fetchMetrics({
        resourceId,
        metricNames: group.map((m) => m.metric),
        timespan,
        interval,
        aggregation: agg,
      });
      for (const r of results) {
        series.push({
          metricName: r.name,
          label: labelFor.get(r.name.toLowerCase()) || r.name,
          unit: r.unit,
          aggregation: r.aggregation,
          points: r.points,
        });
      }
    }

    if (allMetrics) {
      return NextResponse.json({ ok: true, data: { resourceType, metrics: series } });
    }
    // Sparkline: return the single headline series (or an empty one if Monitor
    // emitted no data in the window — the UI renders "—" in that case).
    const head = series[0] || { metricName: catalog[0].metric, label: catalog[0].label, unit: '', aggregation: catalog[0].aggregation, points: [] };
    return NextResponse.json({ ok: true, data: { resourceType, metric: head } });
  } catch (e) {
    if (e instanceof MonitorNotConfiguredError) {
      return NextResponse.json({ ok: false, gate: { missing: e.missing, message: e.message } });
    }
    if (e instanceof MonitorError && (e.status === 401 || e.status === 403)) {
      return NextResponse.json({
        ok: false,
        gate: {
          missing: ['Monitoring Reader'],
          message:
            'The Console UAMI cannot read Azure Monitor metrics. Grant it "Monitoring Reader" on the subscription so utilization sparklines + charts render. Bicep: platform/fiab/bicep/modules/admin-plane/monitoring-reader-rbac.bicep.',
        },
      });
    }
    const status = e instanceof MonitorError ? e.status : 500;
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status });
  }
}
