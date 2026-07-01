/**
 * GET /api/admin/security/mip/applicable-items
 *
 * Lists the Loom workspace items in the caller's tenant that a sensitivity
 * label can be applied to, for the admin "Apply label" wizard's item picker.
 * Returns id, itemType, displayName, workspaceName and the currently-applied
 * label (if any). Real Cosmos query — no mock data.
 *
 * The actual apply is performed by PUT /api/items/[type]/[id]/sensitivity-label
 * (validated against the live Graph taxonomy + label policy), so this route is
 * read-only and never gates on MIP being configured.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const gate = requireTenantAdmin(s);
  if (gate) return gate;
  const tenantId = s.claims.oid;
  try {
    const wsC = await workspacesContainer();
    const itC = await itemsContainer();
    const { resources: workspaces } = await wsC.items.query({
      query: 'SELECT c.id, c.name FROM c WHERE c.tenantId = @t',
      parameters: [{ name: '@t', value: tenantId }],
    }, { partitionKey: tenantId }).fetchAll();
    const wsIds = workspaces.map((w: any) => w.id);
    const wsName = new Map<string, string>(workspaces.map((w: any) => [w.id, w.name]));
    if (!wsIds.length) return NextResponse.json({ ok: true, items: [], total: 0 });

    const { resources: items } = await itC.items.query({
      query: 'SELECT c.id, c.workspaceId, c.itemType, c.displayName, c.state FROM c WHERE ARRAY_CONTAINS(@w, c.workspaceId)',
      parameters: [{ name: '@w', value: wsIds }],
    }).fetchAll();

    const mapped = items.map((i: any) => ({
      id: i.id,
      itemType: i.itemType,
      displayName: i.displayName || i.id,
      workspaceName: wsName.get(i.workspaceId) || i.workspaceId,
      currentLabelId: (i.state?.sensitivityLabelId as string | undefined) ?? null,
      currentLabelName: (i.state?.sensitivityLabel as string | undefined) ?? null,
    })).sort((a, b) => (a.displayName || '').localeCompare(b.displayName || ''));

    return NextResponse.json({ ok: true, items: mapped, total: mapped.length });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'Failed to list items', code: 'cosmos_error' }, { status: 500 });
  }
}
