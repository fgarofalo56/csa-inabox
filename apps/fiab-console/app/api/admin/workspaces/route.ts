/**
 * GET /api/admin/workspaces — tenant-wide workspace inventory with
 * item counts, last activity, and capacity assignment. Cosmos-backed.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { workspacesContainer, itemsContainer } from '@/lib/azure/cosmos-client';

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
      query: 'SELECT * FROM c WHERE c.tenantId = @t',
      parameters: [{ name: '@t', value: tenantId }],
    }, { partitionKey: tenantId }).fetchAll();

    // For each workspace, count items + find latest activity.
    const result = [];
    for (const w of workspaces) {
      const { resources: stats } = await itC.items.query({
        query: 'SELECT COUNT(1) AS itemCount, MAX(c.updatedAt) AS lastActivity FROM c WHERE c.workspaceId = @w',
        parameters: [{ name: '@w', value: w.id }],
      }, { partitionKey: w.id }).fetchAll();
      const s0 = stats[0] || {};
      result.push({
        id: w.id,
        name: w.name,
        description: w.description,
        createdBy: w.createdBy,
        createdAt: w.createdAt,
        updatedAt: w.updatedAt,
        capacity: w.capacity,
        domain: w.domain,
        itemCount: s0.itemCount || 0,
        lastActivity: s0.lastActivity || w.updatedAt,
        state: w.state || 'Active',
      });
    }

    return NextResponse.json({ ok: true, total: result.length, workspaces: result });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
