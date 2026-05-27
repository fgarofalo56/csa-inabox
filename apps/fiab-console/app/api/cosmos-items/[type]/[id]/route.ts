/**
 * Generic Cosmos-backed item CRUD — used by the editor page chrome to
 * hydrate the React Query cache regardless of item type.
 *
 * Lives under /api/cosmos-items/ (NOT /api/items/) so it doesn't collide
 * with per-type Fabric/Azure proxy routes like /api/items/notebook/[id]
 * which require ?workspaceId=… and would 400 when called without one.
 *
 * GET    /api/cosmos-items/[type]/[id]   → item record from Cosmos
 * PATCH  /api/cosmos-items/[type]/[id]   → update displayName/description/state
 * DELETE /api/cosmos-items/[type]/[id]   → soft delete from Cosmos
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import type { Workspace, WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number, code?: string) {
  return NextResponse.json({ ok: false, error, code }, { status });
}

async function loadItem(itemId: string, type: string, tenantId: string): Promise<WorkspaceItem | null> {
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<WorkspaceItem>({
      query: 'SELECT * FROM c WHERE c.id = @id AND c.itemType = @t',
      parameters: [{ name: '@id', value: itemId }, { name: '@t', value: type }],
    })
    .fetchAll();
  const item = resources[0];
  if (!item) return null;
  const ws = await workspacesContainer();
  try {
    const { resource } = await ws.item(item.workspaceId, tenantId).read<Workspace>();
    if (!resource || resource.tenantId !== tenantId) return null;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
  return item;
}

export async function GET(_req: NextRequest, { params }: { params: { type: string; id: string } }) {
  const session = getSession();
  if (!session) return err('Unauthorized', 401, 'unauthorized');
  try {
    const item = await loadItem(params.id, params.type, session.claims.oid);
    if (!item) return err('Item not found', 404, 'not_found');
    return NextResponse.json(item);
  } catch (e: any) {
    return err(e?.message || 'Failed to fetch item', 500, 'cosmos_error');
  }
}

export async function PATCH(req: NextRequest, { params }: { params: { type: string; id: string } }) {
  const session = getSession();
  if (!session) return err('Unauthorized', 401, 'unauthorized');
  let body: any;
  try { body = await req.json(); } catch { return err('Invalid JSON', 400, 'bad_json'); }
  try {
    const item = await loadItem(params.id, params.type, session.claims.oid);
    if (!item) return err('Item not found', 404, 'not_found');
    const next: WorkspaceItem = {
      ...item,
      displayName: typeof body.displayName === 'string' && body.displayName.trim() ? body.displayName.trim() : item.displayName,
      description: 'description' in body ? (body.description?.trim() || undefined) : item.description,
      state: 'state' in body && body.state && typeof body.state === 'object' ? body.state : item.state,
      updatedAt: new Date().toISOString(),
    };
    const items = await itemsContainer();
    const { resource } = await items.item(item.id, item.workspaceId).replace<WorkspaceItem>(next);
    return NextResponse.json(resource);
  } catch (e: any) {
    return err(e?.message || 'Failed to update item', 500, 'cosmos_error');
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: { type: string; id: string } }) {
  const session = getSession();
  if (!session) return err('Unauthorized', 401, 'unauthorized');
  try {
    const item = await loadItem(params.id, params.type, session.claims.oid);
    if (!item) return err('Item not found', 404, 'not_found');
    const items = await itemsContainer();

    // Cascade: when a lakehouse is deleted, also drop its auto-paired SQL
    // analytics endpoint (warehouse item w/ state.sqlEndpointFor === lakehouse.id).
    if (params.type === 'lakehouse') {
      try {
        const { resources: paired } = await items.items
          .query<WorkspaceItem>({
            query: 'SELECT * FROM c WHERE c.workspaceId = @w AND c.state.sqlEndpointFor = @id',
            parameters: [
              { name: '@w', value: item.workspaceId },
              { name: '@id', value: item.id },
            ],
          }, { partitionKey: item.workspaceId })
          .fetchAll();
        for (const p of paired) {
          try { await items.item(p.id, p.workspaceId).delete(); } catch { /* ignore */ }
        }
      } catch { /* best-effort */ }
    }

    await items.item(item.id, item.workspaceId).delete();
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return err(e?.message || 'Failed to delete item', 500, 'cosmos_error');
  }
}
