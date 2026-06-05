/**
 * GET /api/governance/insights — tenant governance KPIs:
 *   - sensitive-data coverage (% labeled)
 *   - classification coverage (% items with ≥1 classification)
 *   - active policies count
 *   - audit events 30d
 *   - top-5 most-classified items
 *   - per-type label coverage table
 *
 * Real, derived from Cosmos. No mocks.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { workspacesContainer, itemsContainer, auditLogContainer, tenantSettingsContainer } from '@/lib/azure/cosmos-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = s.claims.oid;
  try {
    const wsC = await workspacesContainer();
    const itC = await itemsContainer();
    const audC = await auditLogContainer();
    const tsC = await tenantSettingsContainer();

    const { resources: workspaces } = await wsC.items.query({
      query: 'SELECT c.id FROM c WHERE c.tenantId = @t',
      parameters: [{ name: '@t', value: tenantId }],
    }, { partitionKey: tenantId }).fetchAll();
    const wsIds = workspaces.map((w: any) => w.id);

    let items: any[] = [];
    if (wsIds.length) {
      const { resources } = await itC.items.query({
        query: 'SELECT c.id, c.workspaceId, c.itemType, c.displayName, c.state FROM c WHERE ARRAY_CONTAINS(@w, c.workspaceId)',
        parameters: [{ name: '@w', value: wsIds }],
      }).fetchAll();
      items = resources;
    }

    // Real per-item governance signals (no invented fields):
    //   labeled    = state.sensitivityLabel set
    //   classified = ≥1 state.classifications entry
    //   owned      = an explicit data owner (state.owner / ownerUpn / contact / steward)
    //   endorsed   = Fabric-style endorsement: state.endorsement Certified/Promoted, or state.certified
    const isOwned = (st: any) => !!(st?.owner || st?.ownerUpn || st?.contact || st?.steward);
    const isEndorsed = (st: any) =>
      st?.endorsement === 'Certified' || st?.endorsement === 'Promoted' || st?.certified === true;

    const total = items.length;
    const labeled = items.filter((i) => i.state?.sensitivityLabel).length;
    const classified = items.filter((i) => Array.isArray(i.state?.classifications) && i.state.classifications.length).length;
    const owned = items.filter((i) => isOwned(i.state)).length;
    const endorsed = items.filter((i) => isEndorsed(i.state)).length;

    // Per-type coverage
    const byType = new Map<string, { type: string; total: number; labeled: number; classified: number; owned: number; endorsed: number }>();
    for (const i of items) {
      const cur = byType.get(i.itemType) || { type: i.itemType, total: 0, labeled: 0, classified: 0, owned: 0, endorsed: 0 };
      cur.total++;
      if (i.state?.sensitivityLabel) cur.labeled++;
      if (Array.isArray(i.state?.classifications) && i.state.classifications.length) cur.classified++;
      if (isOwned(i.state)) cur.owned++;
      if (isEndorsed(i.state)) cur.endorsed++;
      byType.set(i.itemType, cur);
    }
    const coverage = Array.from(byType.values()).sort((a, b) => b.total - a.total);

    // Top classified items
    const topClassified = [...items]
      .filter((i) => Array.isArray(i.state?.classifications))
      .map((i) => ({
        id: i.id, displayName: i.displayName, itemType: i.itemType,
        count: i.state.classifications.length,
        classifications: i.state.classifications.slice(0, 6),
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    // Active policies (count + list for the policy-effectiveness table)
    let policyCount = 0;
    let policies: Array<{ name: string; type?: string; scope?: string; enabled: boolean; updatedAt?: string }> = [];
    try {
      const { resource: pd } = await tsC.item(`policies:${tenantId}`, tenantId).read<any>();
      if (Array.isArray(pd?.items)) {
        policyCount = pd.items.filter((p: any) => p.enabled).length;
        policies = pd.items.map((p: any) => ({
          name: String(p.name || p.id || 'policy'),
          type: p.type ? String(p.type) : undefined,
          scope: p.scope ? String(p.scope) : (p.itemType ? String(p.itemType) : undefined),
          enabled: !!p.enabled,
          updatedAt: p.updatedAt || p.modifiedAt || undefined,
        }));
      }
    } catch { /* no policy doc yet */ }

    // Audit events 30d
    let auditEvents30d = 0;
    try {
      const since = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
      const { resources } = await audC.items.query({
        query: 'SELECT VALUE COUNT(1) FROM c WHERE c.tenantId = @t AND c.at >= @since',
        parameters: [{ name: '@t', value: tenantId }, { name: '@since', value: since }],
      }).fetchAll();
      auditEvents30d = resources[0] || 0;
    } catch { /* container may be empty */ }

    const pct = (n: number) => (total ? Math.round(100 * n / total) : 0);
    // Composite compliance score = mean of the four coverage dimensions.
    const complianceScorePct = total
      ? Math.round((pct(labeled) + pct(classified) + pct(owned) + pct(endorsed)) / 4)
      : 0;

    return NextResponse.json({
      ok: true,
      kpis: {
        totalItems: total,
        sensitiveCoveragePct: pct(labeled),
        classificationCoveragePct: pct(classified),
        ownershipCoveragePct: pct(owned),
        endorsementCoveragePct: pct(endorsed),
        complianceScorePct,
        activePolicies: policyCount,
        auditEvents30d,
      },
      coverage,
      topClassified,
      policies,
      source: 'cosmos',
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
