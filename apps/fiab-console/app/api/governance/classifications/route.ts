/**
 * GET /api/governance/classifications — derive classifications from the
 * tenant's item.state.classifications across the data catalog. Returns
 * each distinct classification with its hit count + sample items.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = s.claims.oid;
  try {
    const wsC = await workspacesContainer();
    const itC = await itemsContainer();
    const { resources: workspaces } = await wsC.items.query({
      query: 'SELECT c.id FROM c WHERE c.tenantId = @t',
      parameters: [{ name: '@t', value: tenantId }],
    }, { partitionKey: tenantId }).fetchAll();
    const wsIds = workspaces.map((w: any) => w.id);
    if (!wsIds.length) return NextResponse.json({ ok: true, classifications: [], total: 0 });

    const { resources: items } = await itC.items.query({
      query: 'SELECT c.id, c.workspaceId, c.itemType, c.displayName, c.state FROM c WHERE ARRAY_CONTAINS(@w, c.workspaceId)',
      parameters: [{ name: '@w', value: wsIds }],
    }).fetchAll();

    const byClass = new Map<string, { name: string; count: number; samples: any[] }>();
    for (const i of items) {
      const cls: string[] = i.state?.classifications || [];
      for (const c of cls) {
        const cur = byClass.get(c) || { name: c, count: 0, samples: [] };
        cur.count++;
        if (cur.samples.length < 5) cur.samples.push({ id: i.id, displayName: i.displayName, itemType: i.itemType, workspaceId: i.workspaceId });
        byClass.set(c, cur);
      }
    }

    const classifications = Array.from(byClass.values()).sort((a, b) => b.count - a.count);
    return NextResponse.json({ ok: true, classifications, total: classifications.length, source: 'cosmos' });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
