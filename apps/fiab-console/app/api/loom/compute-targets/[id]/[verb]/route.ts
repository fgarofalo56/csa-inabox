/**
 * POST /api/loom/compute-targets/[id]/[verb]
 * verb = start | stop | restart
 *
 * Routes the lifecycle action to the right Azure REST per kind, parsed
 * from the compute target id prefix:
 *   spark:<name>           → Synapse Spark pool (auto-pause is the only knob;
 *                            returns 501 with explanation)
 *   databricks:<clusterId> → Databricks /api/2.0/clusters/{start,delete,restart}
 *   dedicated-sql:<name>   → Synapse Dedicated SQL pool ARM resume/pause
 *   serverless:<name>      → 501 (no lifecycle — Serverless is always-on)
 *
 * Used by the shared <ComputePicker> component when the user clicks
 * Resume / Pause / Restart on a selected compute. Failures surface
 * verbatim — no mock responses.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  _req: NextRequest,
  props: { params: Promise<{ id: string; verb: string }> }
) {
  const params = await props.params;
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const { id, verb } = params;
  if (!['start', 'stop', 'restart'].includes(verb)) {
    return NextResponse.json({ ok: false, error: 'invalid verb' }, { status: 400 });
  }

  const [prefix, ...rest] = id.split(':');
  const name = rest.join(':');

  try {
    if (prefix === 'databricks') {
      const { startCluster, terminateCluster, restartCluster } = await import('@/lib/azure/databricks-client');
      if (verb === 'start') await startCluster(name);
      else if (verb === 'stop') await terminateCluster(name);
      else await restartCluster(name);
      return NextResponse.json({ ok: true, kind: 'databricks-cluster', verb, id });
    }
    if (prefix === 'dedicated-sql') {
      const { resumeDedicatedPool, pauseDedicatedPool } = await import('@/lib/azure/synapse-dev-client');
      if (verb === 'start') await resumeDedicatedPool(name);
      else if (verb === 'stop') await pauseDedicatedPool(name);
      else return NextResponse.json({ ok: false, error: 'restart not supported for dedicated SQL pool — pause then start' }, { status: 400 });
      return NextResponse.json({ ok: true, kind: 'synapse-dedicated-sql', verb, id });
    }
    if (prefix === 'spark') {
      return NextResponse.json({ ok: false, error: 'Synapse Spark pools auto-start on job submission; no explicit lifecycle. Configure auto-pause minutes in the Synapse portal.' }, { status: 501 });
    }
    if (prefix === 'serverless') {
      return NextResponse.json({ ok: false, error: 'Serverless SQL is always-on; no lifecycle action.' }, { status: 501 });
    }
    return NextResponse.json({ ok: false, error: `unknown compute target prefix: ${prefix}` }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
