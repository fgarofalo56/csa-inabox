/**
 * GET /api/governance/govern/owner — data-owner Govern view (F3).
 *
 * Parity: Fabric OneLake Catalog → Govern → "My items" (data-owner scope).
 * Source: https://learn.microsoft.com/fabric/governance/onelake-catalog-govern
 *
 * Returns governance posture for ONLY the signed-in user's items:
 *   - inventory count
 *   - sensitivity-label coverage %
 *   - description (curation) coverage %
 *   - endorsement coverage %
 *   - owner-scoped recommended-action lists (unlabeled / undescribed items)
 *
 * Owner scope is ALWAYS derived from the validated session cookie
 * (s.claims.oid / s.claims.upn). There is NO `?owner=` query parameter, so a
 * caller cannot request another user's posture. The cached read is a single-
 * partition point-read keyed on ownerId — cross-owner leakage is structurally
 * impossible. The live-compute fallback filters items server-side on
 * state.ownerUpn / state.contact / state.steward / createdBy = the caller's UPN.
 *
 * Fast path: read the posture-aggregates doc the posture-refresh Function wrote
 * on tab-open. Cold path (no cache yet, or Function not provisioned): compute
 * live from the Loom Cosmos catalog. Either way the UI renders real data —
 * never a mock, never an empty placeholder.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  workspacesContainer,
  itemsContainer,
  postureAggregatesContainer,
  recommendedActionsContainer,
} from '@/lib/azure/cosmos-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface OwnerItem {
  id: string;
  itemType: string;
  displayName: string;
  workspaceId?: string;
  updatedAt?: string;
  createdBy?: string;
  state?: {
    sensitivityLabel?: string;
    description?: string;
    endorsement?: string;
    certified?: boolean;
    ownerUpn?: string;
    contact?: string;
    steward?: string;
  };
}

const isEndorsed = (st: OwnerItem['state']) =>
  st?.endorsement === 'Certified' || st?.endorsement === 'Promoted' || st?.certified === true;

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const ownerId = s.claims.oid;     // partition key — NEVER a URL param
  const ownerUpn = s.claims.upn;    // item-level owner predicate
  const tenantId = s.claims.oid;    // Loom convention: workspace.tenantId === owner OID's tenant root

  try {
    // ── Fast path: cached aggregates written by the posture-refresh Function ──
    const paC = await postureAggregatesContainer();
    let cached: any = null;
    try {
      const { resource } = await paC.item(ownerId, ownerId).read<any>();
      if (resource && resource.computedAt) cached = resource;
    } catch {
      /* not yet cached — fall through to live compute */
    }

    // ── Cached recommended actions (owner-scoped) ──
    const raC = await recommendedActionsContainer();
    let cachedActions: any = null;
    try {
      const { resource } = await raC.item(ownerId, ownerId).read<any>();
      if (resource) cachedActions = resource;
    } catch {
      /* none yet */
    }

    if (cached) {
      return NextResponse.json({
        ok: true,
        source: 'cache',
        kpis: {
          totalItems: cached.totalItems ?? 0,
          labelCoveragePct: cached.labelCoveragePct ?? 0,
          descriptionCoveragePct: cached.descriptionCoveragePct ?? 0,
          endorsementCoveragePct: cached.endorsementCoveragePct ?? 0,
          computedAt: cached.computedAt,
        },
        unlabeled: cachedActions?.unlabeled ?? [],
        undescribed: cachedActions?.undescribed ?? [],
        unendorsed: cachedActions?.unendorsed ?? [],
        owner: { upn: ownerUpn, name: s.claims.name },
      });
    }

    // ── Cold path: compute live from the Loom Cosmos catalog ──
    const wsC = await workspacesContainer();
    const itC = await itemsContainer();

    const { resources: workspaces } = await wsC.items.query({
      query: 'SELECT c.id FROM c WHERE c.tenantId = @t',
      parameters: [{ name: '@t', value: tenantId }],
    }, { partitionKey: tenantId }).fetchAll();
    const wsIds = workspaces.map((w: any) => w.id);

    let ownerItems: OwnerItem[] = [];
    if (wsIds.length) {
      const { resources } = await itC.items.query({
        query: `SELECT c.id, c.itemType, c.displayName, c.workspaceId, c.updatedAt, c.createdBy, c.state
                FROM c
                WHERE ARRAY_CONTAINS(@w, c.workspaceId)
                  AND (c.state.ownerUpn = @upn OR c.state.contact = @upn
                    OR c.state.steward = @upn OR c.createdBy = @upn)`,
        parameters: [
          { name: '@w', value: wsIds },
          { name: '@upn', value: ownerUpn },
        ],
      }).fetchAll();
      ownerItems = resources as OwnerItem[];
    }

    const total = ownerItems.length;
    const labeled = ownerItems.filter((i) => i.state?.sensitivityLabel).length;
    const described = ownerItems.filter((i) => i.state?.description && String(i.state.description).length > 0).length;
    const endorsed = ownerItems.filter((i) => isEndorsed(i.state)).length;
    const pct = (n: number) => (total > 0 ? Math.round((100 * n) / total) : 0);

    const kpis = {
      totalItems: total,
      labelCoveragePct: pct(labeled),
      descriptionCoveragePct: pct(described),
      endorsementCoveragePct: pct(endorsed),
      computedAt: new Date().toISOString(),
    };

    const toAction = (i: OwnerItem, issue: string) => ({
      id: i.id,
      displayName: i.displayName,
      itemType: i.itemType,
      issue,
    });
    const unlabeled = ownerItems.filter((i) => !i.state?.sensitivityLabel).slice(0, 8).map((i) => toAction(i, 'no_label'));
    const undescribed = ownerItems.filter((i) => !(i.state?.description && String(i.state.description).length > 0)).slice(0, 8).map((i) => toAction(i, 'no_description'));
    const unendorsed = ownerItems.filter((i) => !isEndorsed(i.state)).slice(0, 8).map((i) => toAction(i, 'no_endorsement'));

    // Best-effort warm the cache so the next tab-open serves the fast path.
    // Never block the response on these writes.
    void paC.items.upsert({ id: ownerId, ownerId, ...kpis }).catch(() => {});
    void raC.items.upsert({ id: ownerId, ownerId, unlabeled, undescribed, unendorsed, computedAt: kpis.computedAt }).catch(() => {});

    return NextResponse.json({
      ok: true,
      source: 'live',
      kpis,
      unlabeled,
      undescribed,
      unendorsed,
      owner: { upn: ownerUpn, name: s.claims.name },
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
