/**
 * Generic Cosmos-backed item creation — used by the shared NewItemGate
 * (`lib/editors/new-item-gate.tsx`) so any focused editor's `/new` route can
 * create a real Cosmos item without each editor needing a bespoke create BFF.
 *
 * Lives under /api/cosmos-items/ (NOT /api/items/) so it doesn't collide with
 * per-type Fabric/Azure proxy routes.
 *
 * POST /api/cosmos-items/[type]   { workspaceId, displayName, description?, state? }
 *   → { ok: true, item } with a freshly minted Cosmos record. The caller then
 *     navigates to /items/[type]/[item.id] where the full editor (with its real
 *     Save / Run / Deploy / Publish actions) takes over.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import { upsertLoomDoc, docForItem } from '@/lib/azure/loom-search';
import type { Workspace, WorkspaceItem } from '@/lib/types/workspace';
import { apiError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number, code?: string) {
  return apiError(error, status, code === undefined ? undefined : { code });
}

export async function POST(req: NextRequest, props: { params: Promise<{ type: string }> }) {
  const { type } = await props.params;
  const session = getSession();
  if (!session) return err('Unauthorized', 401, 'unauthorized');

  let body: any;
  try { body = await req.json(); } catch { return err('Invalid JSON', 400, 'bad_json'); }

  const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId.trim() : '';
  const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
  if (!workspaceId) return err('workspaceId is required', 400, 'missing_workspaceId');
  if (!displayName) return err('displayName is required', 400, 'missing_displayName');

  try {
    // Verify the caller's tenant owns the target workspace.
    const ws = await workspacesContainer();
    let workspace: Workspace | undefined;
    try {
      const { resource } = await ws.item(workspaceId, session.claims.oid).read<Workspace>();
      workspace = resource;
    } catch (e: any) {
      if (e?.code !== 404) throw e;
    }
    if (!workspace || workspace.tenantId !== session.claims.oid) {
      return err('Workspace not found', 404, 'not_found');
    }

    const now = new Date().toISOString();
    const item: WorkspaceItem = {
      id: crypto.randomUUID(),
      workspaceId,
      itemType: type,
      displayName,
      description: typeof body.description === 'string' && body.description.trim() ? body.description.trim() : undefined,
      folderId: null,
      state: body.state && typeof body.state === 'object' ? body.state : {},
      createdBy: session.claims.upn || session.claims.email || session.claims.oid,
      createdAt: now,
      updatedAt: now,
    };
    const items = await itemsContainer();
    const { resource } = await items.items.create<WorkspaceItem>(item);
    if (resource) void upsertLoomDoc(docForItem(resource, session.claims.oid));
    return NextResponse.json({ ok: true, item: resource });
  } catch (e: any) {
    return err(e?.message || 'Failed to create item', 500, 'cosmos_error');
  }
}
