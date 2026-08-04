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
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { resolveWorkspaceAccessByOid, ambientAccessOptsFor } from '@/lib/auth/workspace-access';
import { withSession } from '@/lib/api/route-toolkit';
import { upsertLoomDoc, docForItem } from '@/lib/azure/loom-search';
import { autoBindOnCreate } from '@/lib/azure/auto-bind';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { apiError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number, code?: string) {
  return apiError(error, status, code === undefined ? undefined : { code });
}

export const POST = withSession<{ type: string }>(async (req: NextRequest, { session, params }) => {
  const { type } = params;

  let body: any;
  try { body = await req.json(); } catch { return err('Invalid JSON', 400, 'bad_json'); }

  const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId.trim() : '';
  const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
  if (!workspaceId) return err('workspaceId is required', 400, 'missing_workspaceId');
  if (!displayName) return err('displayName is required', 400, 'missing_displayName');

  try {
    // Authorize the caller against the target workspace.
    //
    // This USED to be the owner-only point read `ws.item(workspaceId,
    // session.claims.oid).read()` plus `workspace.tenantId !== oid` — the same
    // inlined `assertOwner` that #2946 removed from `pipeline-binding.ts` and
    // the semantic-model route (#2941, #2942). `workspaces` is partitioned by
    // `/tenantId` and `Workspace.tenantId` holds the workspace CREATOR's oid, so
    // it answered "did this caller create the workspace", not "may this caller
    // write to it": a tenant admin or an ACL Member got "Workspace not found"
    // and could not create an item at all — which also meant auto-bind never
    // ran for them. It now uses the canonical ladder (owner → tenant admin →
    // shared ACL), the same one `/api/workspaces/[id]/items` POST already used
    // for the identical operation.
    //
    // WRITE-SCOPED: `canWrite` is required, so a shared read-only Viewer still
    // cannot create items — strictly not weaker than the owner-only behaviour.
    const access = await resolveWorkspaceAccessByOid(
      session.claims.oid,
      workspaceId,
      await ambientAccessOptsFor(session.claims.oid),
    );
    // 404 rather than 403, so an id cannot be probed for existence across
    // tenants — the same behaviour the previous owner-only read had.
    if (!access || !access.canWrite) return err('Workspace not found', 404, 'not_found');

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
    // AUTO-BIND (auto-bind-by-default §1). This is the INTERACTIVE create path
    // — the "New item" tile in the console — so it is the first place a user
    // can produce an item whose backing Azure object does not exist yet.
    // Create-or-attach it now, named after the item, so the editor that opens
    // next already has a canvas. Deadline-bounded and never-throwing.
    if (resource) await autoBindOnCreate(resource);
    return NextResponse.json({ ok: true, item: resource });
  } catch (e: any) {
    return err(e?.message || 'Failed to create item', 500, 'cosmos_error');
  }
});
