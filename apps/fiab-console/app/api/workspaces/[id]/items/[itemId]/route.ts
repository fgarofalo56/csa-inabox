/**
 * PATCH  /api/workspaces/[id]/items/[itemId]   → move-to-folder / rename
 *        Body: { folderId?: string | null, displayName?: string, description?: string }
 *
 * DELETE /api/workspaces/[id]/items/[itemId]   → delete item (cascades to
 *        any sibling items that point to this item via state.sqlEndpointFor)
 *
 * Tenant ownership is verified via the parent workspace's tenantId == session.oid.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer, workspacesContainer, foldersContainer } from '@/lib/azure/cosmos-client';
import { deleteLoomDoc, docForItem, upsertLoomDoc } from '@/lib/azure/loom-search';
import { reconcileThreadEdgesOnDelete } from '@/lib/thread/thread-edges';
import type { Workspace, WorkspaceItem } from '@/lib/types/workspace';
import { apiError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number, code?: string) {
  return apiError(error, status, code ? { code } : undefined);
}

async function loadOwned(
  workspaceId: string,
  itemId: string,
  tenantId: string,
): Promise<{ ws: Workspace; item: WorkspaceItem } | null> {
  const wsC = await workspacesContainer();
  let ws: Workspace | undefined;
  try {
    const { resource } = await wsC.item(workspaceId, tenantId).read<Workspace>();
    ws = resource ?? undefined;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
  if (!ws || ws.tenantId !== tenantId) return null;
  const items = await itemsContainer();
  try {
    const { resource } = await items.item(itemId, workspaceId).read<WorkspaceItem>();
    if (!resource) return null;
    return { ws, item: resource };
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}

export async function PATCH(
  req: NextRequest,
  props: { params: Promise<{ id: string; itemId: string }> }
) {
  const params = await props.params;
  const s = getSession();
  if (!s) return err('Unauthorized', 401, 'unauthorized');
  let body: any;
  try { body = await req.json(); } catch { return err('Invalid JSON', 400, 'bad_json'); }
  try {
    const found = await loadOwned(params.id, params.itemId, s.claims.oid);
    if (!found) return err('Item not found', 404, 'not_found');

    // If folderId is being changed, validate it exists in this workspace
    // (null/empty resets back to root).
    let nextFolderId: string | null | undefined = undefined;
    if ('folderId' in body) {
      if (body.folderId === null || body.folderId === '' || body.folderId === undefined) {
        nextFolderId = null;
      } else if (typeof body.folderId === 'string') {
        const fC = await foldersContainer();
        try {
          const { resource } = await fC.item(body.folderId, params.id).read<any>();
          if (!resource) return err('Target folder not found', 400, 'folder_not_found');
          nextFolderId = body.folderId;
        } catch (e: any) {
          if (e?.code === 404) return err('Target folder not found', 400, 'folder_not_found');
          throw e;
        }
      } else {
        return err('folderId must be a string or null', 400, 'bad_folderId');
      }
    }

    const next: WorkspaceItem = {
      ...found.item,
      displayName: typeof body.displayName === 'string' && body.displayName.trim()
        ? body.displayName.trim() : found.item.displayName,
      description: 'description' in body
        ? (body.description?.trim() || undefined) : found.item.description,
      folderId: nextFolderId === undefined ? (found.item.folderId ?? null) : nextFolderId,
      updatedAt: new Date().toISOString(),
    };
    const items = await itemsContainer();
    const { resource } = await items.item(found.item.id, found.item.workspaceId).replace<WorkspaceItem>(next);
    if (resource) void upsertLoomDoc(docForItem(resource, s.claims.oid));
    return NextResponse.json({ ok: true, item: resource });
  } catch (e: any) {
    return err(e?.message || 'Failed to update item', 500, 'cosmos_error');
  }
}

export async function DELETE(
  _req: NextRequest,
  props: { params: Promise<{ id: string; itemId: string }> }
) {
  const params = await props.params;
  const s = getSession();
  if (!s) return err('Unauthorized', 401, 'unauthorized');
  try {
    const found = await loadOwned(params.id, params.itemId, s.claims.oid);
    if (!found) return err('Item not found', 404, 'not_found');
    const items = await itemsContainer();

    // Cascade: delete any item whose state.sqlEndpointFor === this item's id.
    try {
      const { resources: paired } = await items.items
        .query<WorkspaceItem>({
          query: 'SELECT * FROM c WHERE c.workspaceId = @w AND c.state.sqlEndpointFor = @id',
          parameters: [
            { name: '@w', value: params.id },
            { name: '@id', value: found.item.id },
          ],
        }, { partitionKey: params.id })
        .fetchAll();
      for (const p of paired) {
        try {
          await items.item(p.id, p.workspaceId).delete();
          void deleteLoomDoc(`it:${p.id}`);
          // Reconcile lineage for cascade-deleted paired items too (audit B9).
          void reconcileThreadEdgesOnDelete(s.claims.oid, p.id, { mode: 'remove' });
        } catch { /* ignore individual paired-delete failures */ }
      }
    } catch { /* ignore cascade query failures */ }

    await items.item(found.item.id, found.item.workspaceId).delete();
    void deleteLoomDoc(`it:${found.item.id}`);
    // Auto-reconcile Thread/Weave lineage — this is a HARD delete, so hard-remove
    // every edge touching this item (audit B9: this route previously skipped
    // reconcile, which only ran from item-crud.ts, leaving orphan lineage edges).
    void reconcileThreadEdgesOnDelete(s.claims.oid, found.item.id, { mode: 'remove' });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return err(e?.message || 'Failed to delete item', 500, 'cosmos_error');
  }
}
