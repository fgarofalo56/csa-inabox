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

    const total = items.length;
    const labeled = items.filter((i) => i.state?.sensitivityLabel).length;
    const classified = items.filter((i) => Array.isArray(i.state?.classifications) && i.state.classifications.length).length;

    // Per-type coverage
    const byType = new Map<string, { type: string; total: number; labeled: number; classified: number }>();
    for (const i of items) {
      const cur = byType.get(i.itemType) || { type: i.itemType, total: 0, labeled: 0, classified: 0 };
      cur.total++;
      if (i.state?.sensitivityLabel) cur.labeled++;
      if (Array.isArray(i.state?.classifications) && i.state.classifications.length) cur.classified++;
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

    // Active policy count
    let policyCount = 0;
    try {
      const { resource: pd } = await tsC.item(`policies:${tenantId}`, tenantId).read<any>();
      if (pd?.items) policyCount = pd.items.filter((p: any) => p.enabled).length;
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

    return NextResponse.json({
      ok: true,
      kpis: {
        totalItems: total,
        sensitiveCoveragePct: total ? Math.round(100 * labeled / total) : 0,
        classificationCoveragePct: total ? Math.round(100 * classified / total) : 0,
        activePolicies: policyCount,
        auditEvents30d,
      },
      coverage,
      topClassified,
      source: 'cosmos',
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
