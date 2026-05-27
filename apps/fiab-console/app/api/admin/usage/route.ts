/**
 * GET /api/admin/usage — tenant usage metrics aggregated from Cosmos.
 *   - items per type
 *   - items per workspace
 *   - activity per day (last 30 days, from audit-log + item updatedAt)
 *   - top-10 most-active items by audit count
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { workspacesContainer, itemsContainer, auditLogContainer } from '@/lib/azure/cosmos-client';

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

    const { resources: workspaces } = await wsC.items.query({
      query: 'SELECT c.id, c.name FROM c WHERE c.tenantId = @t',
      parameters: [{ name: '@t', value: tenantId }],
    }, { partitionKey: tenantId }).fetchAll();
    const wsIds = workspaces.map((w: any) => w.id);
    const wsName = new Map(workspaces.map((w: any) => [w.id, w.name]));

    let items: any[] = [];
    if (wsIds.length) {
      const { resources } = await itC.items.query({
        query: 'SELECT c.id, c.workspaceId, c.itemType, c.displayName, c.updatedAt FROM c WHERE ARRAY_CONTAINS(@w, c.workspaceId)',
        parameters: [{ name: '@w', value: wsIds }],
      }).fetchAll();
      items = resources;
    }

    // Items per type
    const byType = new Map<string, number>();
    for (const i of items) byType.set(i.itemType, (byType.get(i.itemType) || 0) + 1);
    const itemsByType = Array.from(byType.entries()).map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count);

    // Items per workspace
    const byWs = new Map<string, number>();
    for (const i of items) byWs.set(i.workspaceId, (byWs.get(i.workspaceId) || 0) + 1);
    const itemsByWorkspace = Array.from(byWs.entries()).map(([wsId, count]) => ({
      workspaceId: wsId, workspaceName: wsName.get(wsId) || wsId, count,
    })).sort((a, b) => b.count - a.count).slice(0, 20);

    // Activity per day (last 30 days) from audit-log
    const since = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
    let auditCount = 0;
    const byDay = new Map<string, number>();
    const byItem = new Map<string, { itemId: string; count: number }>();
    try {
      const { resources: audits } = await audC.items.query({
        query: 'SELECT c.itemId, c.at FROM c WHERE c.tenantId = @t AND c.at >= @since',
        parameters: [
          { name: '@t', value: tenantId },
          { name: '@since', value: since },
        ],
      }).fetchAll();
      auditCount = audits.length;
      for (const a of audits) {
        const day = (a.at as string).slice(0, 10);
        byDay.set(day, (byDay.get(day) || 0) + 1);
        const cur = byItem.get(a.itemId) || { itemId: a.itemId, count: 0 };
        cur.count++;
        byItem.set(a.itemId, cur);
      }
    } catch { /* audit container may be empty */ }

    const activity = Array.from(byDay.entries())
      .map(([day, count]) => ({ day, count }))
      .sort((a, b) => a.day.localeCompare(b.day));

    const topItems = Array.from(byItem.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)
      .map((t) => {
        const it = items.find((i) => i.id === t.itemId);
        return {
          itemId: t.itemId,
          auditCount: t.count,
          displayName: it?.displayName,
          itemType: it?.itemType,
          workspaceName: it ? (wsName.get(it.workspaceId) || it.workspaceId) : undefined,
        };
      });

    return NextResponse.json({
      ok: true,
      totals: {
        workspaces: workspaces.length,
        items: items.length,
        itemTypes: itemsByType.length,
        auditEvents30d: auditCount,
      },
      itemsByType,
      itemsByWorkspace,
      activity,
      topItems,
      since,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
