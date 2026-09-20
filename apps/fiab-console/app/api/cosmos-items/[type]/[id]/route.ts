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
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { apiError } from '@/lib/api/respond';
import { recordItemVersion } from '@/lib/versions/item-version-store';
import {
  assertNoServerOwnedStateChange, ServerOwnedStateError,
} from '@/app/api/items/_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number, code?: string) {
  return apiError(error, status, code === undefined ? undefined : { code });
}

export async function GET(
  _req: NextRequest,
  props: { params: Promise<{ type: string; id: string }> }
) {
  const params = await props.params;
  const session = getSession();
  if (!session) return err('Unauthorized', 401, 'unauthorized');
  try {
    // READ resolves via owner → workspace ACL → item-level grant (rel-T87), so
    // a user the item was shared with can open it (any role admits read).
    const access = await resolveItemAccessByOid(session, params.id, params.type);
    if (!access) return err('Item not found', 404, 'not_found');
    return NextResponse.json(access.item);
  } catch (e: any) {
    return err(e?.message || 'Failed to fetch item', 500, 'cosmos_error');
  }
}

export async function PATCH(req: NextRequest, props: { params: Promise<{ type: string; id: string }> }) {
  const params = await props.params;
  const session = getSession();
  if (!session) return err('Unauthorized', 401, 'unauthorized');
  let body: any;
  try { body = await req.json(); } catch { return err('Invalid JSON', 400, 'bad_json'); }
  try {
    // WRITE requires a write-capable role: workspace Owner/Admin/Member, or an
    // item-level grant that includes `Edit`. A read-only share cannot mutate.
    const access = await resolveItemAccessByOid(session, params.id, params.type);
    if (!access) return err('Item not found', 404, 'not_found');
    if (!access.canWrite) return err('Read-only access', 403, 'forbidden');
    const item = access.item;
    const nextState = 'state' in body && body.state && typeof body.state === 'object' ? body.state : item.state;
    // #4619 — `state` is replaced WHOLESALE below with no schema validation, and
    // this is the route `lib/api/workspaces.ts:272` (`updateItem`) puts every
    // generic editor save through. A handful of its TOP-LEVEL keys are not user
    // data: they record what the provisioning engine created for this item, and
    // other code derives a security-relevant scope from them. Reject-on-change,
    // so a body that round-trips them unchanged, or omits them, is unaffected.
    //
    // `assertNoServerOwnedStateChange`, NOT the narrower scope assert. It calls
    // the scope assert and then adds the depth-blind server-owned key check
    // (#3611: `secretRef` names a Key Vault secret a later delete acts on,
    // `engineObject` names a query-engine object a later query acts on) plus the
    // `__proto__` refusal. This route's sibling at `items/[type]/[id]` has
    // always called the fuller one; calling only the scope assert here left that
    // class open on a PATCH route, which review measured.
    try {
      assertNoServerOwnedStateChange(nextState, item.state);
    } catch (e: any) {
      if (e instanceof ServerOwnedStateError) return err(e.message, 400, 'server_owned_state');
      throw e;
    }
    const next: WorkspaceItem = {
      ...item,
      displayName: typeof body.displayName === 'string' && body.displayName.trim() ? body.displayName.trim() : item.displayName,
      description: 'description' in body ? (body.description?.trim() || undefined) : item.description,
      state: nextState,
      updatedAt: new Date().toISOString(),
    };
    const items = await itemsContainer();
    const { resource } = await items.item(item.id, item.workspaceId).replace<WorkspaceItem>(next);
    // Version-history snapshot (Wave-2 W6) — record this save as a version at the
    // SHARED save chokepoint so all editors that persist via this generic route
    // get history for free. Best-effort inside the helper; never fails the save.
    await recordItemVersion(item, resource ?? next, {
      oid: session.claims.oid,
      name: session.claims.name || session.claims.upn || session.claims.email,
    });
    return NextResponse.json(resource);
  } catch (e: any) {
    return err(e?.message || 'Failed to update item', 500, 'cosmos_error');
  }
}

export async function DELETE(
  _req: NextRequest,
  props: { params: Promise<{ type: string; id: string }> }
) {
  const params = await props.params;
  const session = getSession();
  if (!session) return err('Unauthorized', 401, 'unauthorized');
  try {
    // DELETE is destructive: require WORKSPACE-level write (owner or a
    // workspace Admin/Member). An item-level `Edit` grant confers edit, not
    // delete (matches Fabric — sharing an item never lets the grantee delete it).
    const access = await resolveItemAccessByOid(session, params.id, params.type);
    if (!access) return err('Item not found', 404, 'not_found');
    if (!access.canWrite || access.via === 'item-grant') {
      return err('Delete requires workspace write access', 403, 'forbidden');
    }
    const item = access.item;
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
