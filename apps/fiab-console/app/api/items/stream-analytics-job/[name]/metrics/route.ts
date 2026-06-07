/**
 * GET /api/items/stream-analytics-job/[name]/metrics
 *   Live Azure Monitor platform metrics for one ASA streaming job:
 *   SU % utilization, watermark delay, backlogged input events, and input/
 *   output event counts. Resolves the job's ARM resource id via getJob, then
 *   reads the Azure Monitor metrics REST surface (no Fabric dependency).
 *
 *   ASA emits these metrics only while the job is in the Running state — when
 *   the job is Stopped the series will be empty; the editor explains this.
 *
 *   Honest gate: 501 + hint when ASA env (LOOM_ASA_RG / sub) is unset.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getJob, AsaNotConfiguredError } from '@/lib/azure/stream-analytics-client';
import { fetchMetrics, type MetricResult } from '@/lib/azure/monitor-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HINT =
  'Provision an ASA job (bicep: platform/fiab/bicep/modules/landing-zone/stream-analytics.bicep, ' +
  'flag enableStreamAnalytics=true) and set LOOM_ASA_RG (and LOOM_ASA_SUB if different). ' +
  'The Console UAMI needs Monitoring Reader (or Stream Analytics Contributor) on the job to read metrics.';

// Average-aggregated gauges vs total-aggregated counters. The Azure Monitor
// metrics REST surface takes a single aggregation per request, so we issue two
// requests and merge — matching each metric to its canonical aggregation.
const AVG_METRICS = ['ResourceUtilization', 'OutputWatermarkDelaySeconds', 'InputEventsSourcesBacklogged'];
const TOTAL_METRICS = ['InputEvents', 'OutputEvents'];

export async function GET(_req: Request, ctx: { params: { name: string } }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const name = ctx.params?.name;
  if (!name) return NextResponse.json({ ok: false, error: 'name required' }, { status: 400 });
  try {
    const job = await getJob(name);
    if (!job.id) {
      return NextResponse.json(
        { ok: false, error: 'ASA job has no ARM resource id', hint: HINT },
        { status: 502 },
      );
    }
    const [avg, total] = await Promise.all([
      fetchMetrics({
        resourceId: job.id,
        metricNames: AVG_METRICS,
        timespan: 'PT1H',
        interval: 'PT5M',
        aggregation: 'Average',
      }),
      fetchMetrics({
        resourceId: job.id,
        metricNames: TOTAL_METRICS,
        timespan: 'PT1H',
        interval: 'PT5M',
        aggregation: 'Total',
      }),
    ]);
    const metrics: MetricResult[] = [...avg, ...total];
    return NextResponse.json({
      ok: true,
      metrics,
      resourceId: job.id,
      jobState: job.jobState || job.state || null,
    });
  } catch (e: any) {
    if (e instanceof AsaNotConfiguredError) {
      return NextResponse.json({ ok: false, error: e.message, hint: HINT }, { status: 501 });
    }
    return NextResponse.json(
      { ok: false, error: e?.message || String(e), hint: HINT },
      { status: 502 },
    );
  }
}
