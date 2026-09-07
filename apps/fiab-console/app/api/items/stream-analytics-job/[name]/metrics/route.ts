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
import { getJob, AsaNotConfiguredError, AsaJobNotFoundError } from '@/lib/azure/stream-analytics-client';
import { fetchMetrics, type MetricResult } from '@/lib/azure/monitor-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Applies to the NOT-CONFIGURED condition only — the one case where the env
 * vars really are the remediation.
 *
 * #3573 / `deploy-integrity.md` R7: this hint used to ride the generic 502 as
 * well, so a 403, a throttle or a DNS failure on a deployment where LOOM_ASA_RG
 * was set correctly told the operator to go set LOOM_ASA_RG — a cause the code
 * had established nothing about. The 502s below now carry the ARM error and
 * nothing else, and a missing job gets its own 404.
 */
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
      // ARM answered with a job carrying no resource id. That is not a
      // provisioning/env condition, so it does not get the provisioning hint.
      return NextResponse.json(
        { ok: false, error: 'ASA job has no ARM resource id' },
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
    if (e instanceof AsaJobNotFoundError) {
      // ASA is configured and ARM answered: the job is simply not there. Say
      // only that — the absence is established, a remediation is not.
      return NextResponse.json(
        { ok: false, error: e.message, code: 'asa-job-not-provisioned' },
        { status: 404 },
      );
    }
    return NextResponse.json(
      { ok: false, error: e?.message || String(e) },
      { status: 502 },
    );
  }
}
