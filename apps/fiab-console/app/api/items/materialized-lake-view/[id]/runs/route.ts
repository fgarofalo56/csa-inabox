/**
 * GET /api/items/materialized-lake-view/[id]/runs?size=25
 *
 * Lists the recent Synapse Spark batch jobs that refreshed THIS materialized
 * lake view, filtered by the `loomItemId` tag the refresh engine stamps. Real
 * Livy batch history — no mock data. Honest gate when Synapse is unconfigured.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadMlvItem } from '../../_lib/load';
import { listSparkBatchJobs, type SparkBatchJob } from '@/lib/azure/synapse-dev-client';
import { defaultSparkPool } from '@/lib/azure/synapse-livy-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const item = await loadMlvItem(id, session.claims.oid).catch(() => null);
  if (!item) return NextResponse.json({ ok: false, error: 'MLV not found' }, { status: 404 });

  if (!process.env.LOOM_SYNAPSE_WORKSPACE) {
    return NextResponse.json(
      {
        ok: false,
        gate: 'synapse_not_configured',
        error: 'Spark run history needs a Synapse workspace.',
        remediation:
          'Set LOOM_SYNAPSE_WORKSPACE (+ LOOM_SYNAPSE_SPARK_POOL) and grant the Console UAMI ' +
          'the Synapse Administrator role. No Microsoft Fabric required.',
      },
      { status: 503 },
    );
  }

  const size = Math.min(100, Math.max(1, parseInt(req.nextUrl.searchParams.get('size') || '25', 10) || 25));
  const pool = defaultSparkPool();
  try {
    const list = await listSparkBatchJobs(pool, 0, 100);
    const mine = (list.sessions || []).filter((b: SparkBatchJob) => b.tags?.loomItemId === id);
    return NextResponse.json({
      ok: true,
      sparkPool: pool,
      sessions: mine.slice(0, size).map((b) => ({
        id: b.id,
        name: b.name,
        state: b.state || b.livyInfo?.currentState,
        result: b.result,
        appId: b.appId,
        submittedAt: b.submittedAt,
        trigger: b.tags?.loomTrigger,
      })),
    });
  } catch (e: any) {
    const msg = (e?.message || String(e)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return NextResponse.json({ ok: false, error: msg.slice(0, 300) }, { status: 502 });
  }
}
