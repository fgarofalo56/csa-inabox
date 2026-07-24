/**
 * GET /api/assets/lineage — N5 asset-graph (nodes + derived deps) for the canvas.
 *
 * Returns the SAME snapshot /api/assets returns, shaped for the graph: compact
 * node records plus the derived dependency edges. The deps are DERIVED from
 * WS-L's unified lineage (Purview/Atlas + Unity Catalog + Weave, with the
 * `columnMappings` column facet contracted back to table grain) and from N4's
 * emitted model DAG — nothing here re-walks a lineage source.
 *
 * Query:
 *   ?focus=<assetKey>   restrict to that asset's upstream + downstream closure
 *   ?refresh=1          bypass the 30 s assembly cache
 */
import { apiOk, apiServerError } from '@/lib/api/respond';
import { withSession } from '@/lib/api/route-toolkit';
import { findAsset, getAssetRegistry } from '@/lib/assets/asset-registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withSession(async (req, { session }) => {
  try {
    const url = new URL(req.url);
    const focus = (url.searchParams.get('focus') || '').trim();
    const refresh = url.searchParams.get('refresh') === '1';

    // Tenant scope declared explicitly + asserted in the registry (defence in
    // depth); every read is partitioned by this principal's oid.
    const snapshot = await getAssetRegistry(session, {
      bypass: refresh,
      tenantId: session.claims.oid,
    });
    let assets = snapshot.assets;
    let deps = snapshot.deps;
    let focusKey: string | undefined;

    if (focus) {
      const target = findAsset(snapshot, focus);
      if (target) {
        focusKey = target.key;
        // Bounded closure walk in BOTH directions from the focus.
        const keep = new Set<string>([target.key]);
        let guard = deps.length + assets.length + 1;
        let grew = true;
        while (grew && guard-- > 0) {
          grew = false;
          for (const d of deps) {
            if (keep.has(d.from) && !keep.has(d.to)) { keep.add(d.to); grew = true; }
            if (keep.has(d.to) && !keep.has(d.from)) { keep.add(d.from); grew = true; }
          }
        }
        assets = assets.filter((a) => keep.has(a.key));
        deps = deps.filter((d) => keep.has(d.from) && keep.has(d.to));
      }
    }

    return apiOk({
      nodes: assets.map((a) => ({
        key: a.key,
        name: a.name,
        kind: a.kind,
        group: a.group,
        sources: a.sources,
        openHref: a.openHref,
        producedBy: a.producedBy,
        columns: a.columns,
        owners: a.owners,
        tags: a.tags,
        materialization: a.materialization,
        cadenceHint: a.cadenceHint,
        description: a.description,
        policy: a.policy,
        materializer: a.materializer,
        freshness: a.freshness,
        upstream: a.upstream,
        lastMaterializedAt: a.lastMaterializedAt,
        lastRunOutcome: a.lastRunOutcome,
        lastDetail: a.lastDetail,
        configured: a.configured,
      })),
      deps,
      focusKey,
      sources: snapshot.sources,
      roots: snapshot.roots,
      builtAt: snapshot.builtAt,
    });
  } catch (e) {
    return apiServerError(e, 'asset lineage failed', 'asset_lineage_failed');
  }
});
