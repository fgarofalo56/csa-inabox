/**
 * GET /api/items/materialized-lake-view/[id]/runs?size=25
 *
 * Lists the recent Synapse Spark batch jobs that refreshed THIS materialized
 * lake view, filtered by the `loomItemId` tag the refresh engine stamps. Real
 * Livy batch history — no mock data. Honest gate when Synapse is unconfigured.
 */
import { NextRequest, NextResponse } from 'next/server';
import { loadMlvItem } from '../../_lib/load';
import { listRecentSparkBatchJobs, type SparkBatchJob } from '@/lib/azure/synapse-dev-client';
import { defaultSparkPool } from '@/lib/azure/synapse-livy-client';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withSession<{ id: string }>(async (req: NextRequest, { session, params }) => {
  const { id } = params;

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
    // MOST RECENT first. `listSparkBatchJobs(pool, 0, N)` would return the
    // pool's OLDEST N batches — `from` is an index into Livy's ASCENDING
    // batch-id list — and this grid is labelled "Runs". While the old size=100
    // was over Livy's 20-row cap that at least failed loudly with a 400;
    // clamping the size without fixing the window would have turned it into a
    // silent wrong-rows surface. We scan a window WIDER than `size` because the
    // tag filter below is applied client-side: only some of the pool's recent
    // batches belong to this MLV.
    const scanLimit = Math.min(200, Math.max(size, size * 4));
    const list = await listRecentSparkBatchJobs(pool, scanLimit);
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
      // Truncation is DISCLOSED, never dropped: the tag filter runs over a
      // bounded window of the pool's run history, so an MLV whose refreshes are
      // older than that window legitimately shows nothing. Without these fields
      // the surface cannot tell "no runs" from "no runs in the part I looked at".
      truncatedBy: list.truncatedBy ?? null,
      scanned: list.scanned,
      poolTotal: list.total,
      windowComplete: !list.truncatedBy && list.scanned >= list.total,
    });
  } catch (e: any) {
    const msg = (e?.message || String(e)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return NextResponse.json({ ok: false, error: msg.slice(0, 300) }, { status: 502 });
  }
});
