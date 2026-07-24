/**
 * GET /api/assets/status — N5 estate freshness ROLLUP + the incident lists.
 *
 * The KPI band on the Assets canvas and the reconciler's own "what did the last
 * pass leave behind" view read this: how many assets are fresh / stale /
 * overdue / never-materialized / unmanaged, which ones are currently late (worst
 * first), which have a failing materializer, and which lineage sources are gated.
 *
 * Every number is computed from the SAME derived snapshot the canvas draws — a
 * KPI can never disagree with the node it counts.
 */
import { apiOk, apiServerError } from '@/lib/api/respond';
import { withSession } from '@/lib/api/route-toolkit';
import { getAssetRegistry } from '@/lib/assets/asset-registry';
import { FRESHNESS_RANK, rollupFreshness } from '@/lib/assets/freshness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** How many rows each incident list returns (bounded payload). */
const LIST_CAP = 50;

export const GET = withSession(async (req, { session }) => {
  try {
    const refresh = new URL(req.url).searchParams.get('refresh') === '1';
    // Tenant scope declared explicitly + asserted in the registry (defence in
    // depth); every read is partitioned by this principal's oid.
    const snapshot = await getAssetRegistry(session, {
      bypass: refresh,
      tenantId: session.claims.oid,
    });

    const late = snapshot.assets
      .filter((a) => a.freshness.status === 'overdue' || a.freshness.status === 'stale')
      .sort((a, b) => {
        const r = FRESHNESS_RANK[a.freshness.status] - FRESHNESS_RANK[b.freshness.status];
        return r !== 0 ? r : b.freshness.overdueByMinutes - a.freshness.overdueByMinutes;
      })
      .slice(0, LIST_CAP)
      .map((a) => ({
        key: a.key,
        name: a.name,
        group: a.group,
        status: a.freshness.status,
        ageMinutes: a.freshness.ageMinutes,
        overdueByMinutes: a.freshness.overdueByMinutes,
        dueAt: a.freshness.dueAt,
        materializer: a.materializer.kind,
        mode: a.policy.mode,
      }));

    const failing = snapshot.assets
      .filter((a) => a.lastRunOutcome === 'failed')
      .sort((a, b) => (b.consecutiveFailures ?? 0) - (a.consecutiveFailures ?? 0))
      .slice(0, LIST_CAP)
      .map((a) => ({
        key: a.key,
        name: a.name,
        consecutiveFailures: a.consecutiveFailures ?? 1,
        lastTriggerAt: a.lastTriggerAt,
        detail: a.lastDetail,
      }));

    const unbound = snapshot.assets
      .filter((a) => a.policy.mode === 'auto' && a.materializer.kind === 'none')
      .slice(0, LIST_CAP)
      .map((a) => ({ key: a.key, name: a.name, group: a.group }));

    return apiOk({
      rollup: rollupFreshness(snapshot.assets.map((a) => a.freshness.status)),
      autoManaged: snapshot.assets.filter((a) => a.policy.mode === 'auto').length,
      configured: snapshot.assets.filter((a) => a.configured).length,
      late,
      failing,
      unbound,
      sources: snapshot.sources,
      roots: snapshot.roots,
      builtAt: snapshot.builtAt,
    });
  } catch (e) {
    return apiServerError(e, 'asset status failed', 'asset_status_failed');
  }
});
