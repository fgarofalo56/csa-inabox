/**
 * GET /api/assets — N5 SOFTWARE-DEFINED ASSET list.
 *
 * The estate as a graph of assets: every lakehouse table, materialized view,
 * SQLMesh/dbt model (N4) and pipeline output that Loom's lineage already knows
 * about, each with its DERIVED deps, its freshness policy, its materializer
 * binding, and its live freshness status.
 *
 * The graph is DERIVED from WS-L's `lib/azure/unified-lineage.ts` (+ the N4
 * model DAG) on every read — never hand-authored and never a second lineage
 * store. The `loom-assets` Cosmos sidecar supplies only the policy + watermarks.
 *
 * Query:
 *   ?status=overdue|stale|fresh|never|unmanaged   filter by freshness
 *   ?group=<group>                                filter by catalog group
 *   ?q=<text>                                     substring match on key/name
 *   ?refresh=1                                    bypass the 30 s assembly cache
 *
 * Honest: an estate with no lineage returns zero assets and the per-source gate
 * status — never sample rows.
 */
import { apiOk, apiServerError } from '@/lib/api/respond';
import { withSession } from '@/lib/api/route-toolkit';
import { getAssetRegistry } from '@/lib/assets/asset-registry';
import { rollupFreshness, type FreshnessStatus } from '@/lib/assets/freshness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STATUSES: FreshnessStatus[] = ['fresh', 'stale', 'overdue', 'never', 'unmanaged'];

export const GET = withSession(async (req, { session }) => {
  try {
    const url = new URL(req.url);
    const status = url.searchParams.get('status') || '';
    const group = (url.searchParams.get('group') || '').trim().toLowerCase();
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    const refresh = url.searchParams.get('refresh') === '1';

    // Tenant scope is declared explicitly and asserted inside the registry —
    // every Cosmos + lineage read below is partitioned by this principal's oid.
    const snapshot = await getAssetRegistry(session, {
      bypass: refresh,
      tenantId: session.claims.oid,
    });

    let assets = snapshot.assets;
    if (STATUSES.includes(status as FreshnessStatus)) {
      assets = assets.filter((a) => a.freshness.status === status);
    }
    if (group) assets = assets.filter((a) => a.group.toLowerCase() === group);
    if (q) {
      assets = assets.filter(
        (a) => a.key.toLowerCase().includes(q) || a.name.toLowerCase().includes(q),
      );
    }

    return apiOk({
      assets,
      total: snapshot.assets.length,
      rollup: rollupFreshness(snapshot.assets.map((a) => a.freshness.status)),
      groups: [...new Set(snapshot.assets.map((a) => a.group))].sort(),
      sources: snapshot.sources,
      roots: snapshot.roots,
      builtAt: snapshot.builtAt,
    });
  } catch (e) {
    return apiServerError(e, 'asset list failed', 'asset_list_failed');
  }
});
