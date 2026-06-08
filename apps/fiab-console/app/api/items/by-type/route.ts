/**
 * Cross-type item lister for top-level surfaces like /activator,
 * /realtime-hub, /semantic-model, /onelake, etc.
 *
 * GET /api/items/by-type?type=lakehouse&type=eventstream → flat list
 *   of every item of those types owned by caller's tenant.
 *
 * Tenant scoping: an item is "owned" when its parent workspace's
 * tenantId matches session.claims.oid.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const sp = new URL(req.url).searchParams;
  // Accept either repeated `?type=A&type=B` (legacy callers) OR a single
  // comma-separated `?types=A,B`. The comma-separated form is preferred
  // because Azure Front Door Premium WAF (DRS 2.1 rule 921180, HTTP
  // Parameter Pollution) blocks the repeated form when there are 4+
  // identical keys, returning 403 at the edge.
  const fromRepeated = sp.getAll('type');
  const fromCsv = (sp.get('types') || '').split(',');
  const types = [...fromRepeated, ...fromCsv].map(t => t.trim()).filter(Boolean);
  if (types.length === 0) {
    return NextResponse.json({ ok: false, error: 'at least one ?type= or ?types= required' }, { status: 400 });
  }
  const items = await itemsContainer();
  // Cross-partition query; types is small, expanded to OR.
  const orClauses = types.map((_, i) => `c.itemType = @t${i}`).join(' OR ');
  const params = types.map((t, i) => ({ name: `@t${i}`, value: t }));
  // Project the full c.state blob (ItemDetails still reads it) plus the two
  // governance leaves the catalog cards render directly — Cosmos returns
  // c.state.endorsement / c.state.sensitivityLabel as top-level fields.
  const { resources: candidates } = await items.items
    .query({
      query: `SELECT c.id, c.itemType, c.workspaceId, c.displayName, c.description, c.state, c.createdBy, c.createdAt, c.updatedAt, c.state.endorsement, c.state.sensitivityLabel FROM c WHERE ${orClauses}`,
      parameters: params,
    })
    .fetchAll();

  if (candidates.length === 0) return NextResponse.json({ ok: true, items: [] });

  // Tenant-filter by workspace ownership (cached). Capture each owning
  // workspace's domain id so the card can show a domain badge (resolved to a
  // display name client-side via /api/governance/domains).
  const ws = await workspacesContainer();
  const cache = new Map<string, boolean>();
  const wsDomainId = new Map<string, string | undefined>();
  const owned: any[] = [];
  for (const it of candidates as any[]) {
    let isOwned = cache.get(it.workspaceId);
    if (isOwned === undefined) {
      try {
        const { resource } = await ws.item(it.workspaceId, s.claims.oid).read<any>();
        isOwned = !!resource && resource.tenantId === s.claims.oid;
        wsDomainId.set(it.workspaceId, resource?.domain ?? undefined);
      } catch { isOwned = false; }
      cache.set(it.workspaceId, isOwned);
    }
    if (isOwned) owned.push({ ...it, workspaceDomain: wsDomainId.get(it.workspaceId) });
  }
  owned.sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt));
  return NextResponse.json({ ok: true, items: owned });
}
