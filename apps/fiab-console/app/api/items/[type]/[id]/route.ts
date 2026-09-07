import { NextRequest, NextResponse } from 'next/server';
import { authorizeItemWorkspace } from '@/lib/auth/workspace-guard';
import type { SessionPayload } from '@/lib/auth/session';
import crypto from 'node:crypto';
import { auditLogContainer, itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { apiError } from '@/lib/api/respond';
import { recordItemOpen } from '@/lib/items/record-open';
import { assertNoServerOwnedStateChange, ServerOwnedStateError } from '@/app/api/items/_lib/item-crud';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number, code?: string) {
  return apiError(error, status, code === undefined ? undefined : { code });
}

/**
 * Find an item by id (cross-partition) + AUTHORIZE the caller against its
 * parent workspace.
 *
 * #3941 — MIGRATED to `authorizeItemWorkspace`, which is the widening the four
 * deferrals recorded here previously said needed its own PR. This is that PR.
 *
 * WHAT CHANGES, stated plainly because it is an access change: this route backs
 * GET, PATCH and DELETE for EVERY item type that has no dedicated
 * `[id]/route.ts`. Before, all three verbs were limited to the workspace
 * CREATOR — `workspaces` is partitioned on `/tenantId`, which stores the
 * creator's oid, so `ws.item(workspaceId, callerOid)` could only answer "did
 * you CREATE this workspace?". Now GET admits any workspace role
 * (`allowReadRoles: true`) and PATCH/DELETE admit WRITE-capable roles
 * (Owner/Admin/Member) plus a tenant admin, exactly as `authorizeWorkspace`
 * defines them. The owner fast path inside the resolver is the same point read
 * this function used to do, so no caller who could reach an item before loses
 * access — the set strictly GROWS, and DELETE grows with it.
 *
 * The refusal wording is deliberately split; see the comment on the `denied`
 * branch below.
 */
async function loadItem(
  itemId: string,
  type: string,
  session: SessionPayload,
  allowReadRoles: boolean,
): Promise<{ item: WorkspaceItem | null; denied: NextResponse | null }> {
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<WorkspaceItem>({
      query: 'SELECT * FROM c WHERE c.id = @id AND c.itemType = @t',
      parameters: [
        { name: '@id', value: itemId },
        { name: '@t', value: type },
      ],
    })
    .fetchAll();
  const item = resources[0];
  if (!item) return { item: null, denied: null };
  // Verify tenant ownership via parent workspace
  // #3941 - the canonical ladder, replacing the owner-only partition point read
  // this helper used to do. `workspaces` is partitioned on `/tenantId`, which
  // holds the workspace CREATOR's oid, so `ws.item(workspaceId, callerOid)`
  // could only answer "did YOU create this workspace?" - it refused tenant
  // admins and shared-ACL members on every item type with no dedicated route
  // (the #2941/#2942 defect). `authorizeItemWorkspace` answers "may you ACCESS
  // it?", scoped: read roles for GET, write-capable only for the mutations.
  const denied = await authorizeItemWorkspace(session, {
    workspaceId: item.workspaceId,
    itemId,
    itemType: type,
    allowReadRoles,
    notFound: 'Item not found',
  });
  // An ORDINARY refusal (404) collapses to `null` so the route keeps its own
  // not-found wording, which is what its clients already render. The 409
  // `tenant_unconfirmed` refusal does NOT: flattening it into "item not found"
  // would state that the item does not exist, which the code did not establish
  // - the workspace document WAS read and the admin rights ARE real
  // (deploy-integrity.md R7). It is handed back for the route to return.
  if (denied) return { item: null, denied: denied.status === 404 ? null : denied };
  return { item, denied: null };
}

/**
 * Route-toolkit: `withSession` (R1/R3), migrated by hand — the codemod refuses
 * this file ("getSession() without the exact 401 guard") because the 401 body
 * was `err('Unauthorized', 401, 'unauthorized')`.
 *
 * ONE DISCLOSED DELTA, stated rather than implied: the toolkit's 401 is
 * `apiUnauthorized()` → `{ ok:false, error:'unauthenticated' }`, so the body
 * text changes and the `code:'unauthorized'` field is dropped. Grepped before
 * making the change: no client, hook, or test in this app branches on that
 * code, and no test asserts this route's 401 body. AUTHORIZATION is unchanged —
 * same `getSession()`, same refusal. Session resolution also now precedes param
 * resolution (auth-first), which is the stricter ordering.
 *
 * `loadItem`'s workspace ownership check below is DELIBERATELY untouched: see
 * the note on it.
 */
export const GET = withSession<{ type: string; id: string }>(async (
  _req: NextRequest,
  { session, params },
) => {
  try {
    const { item, denied } = await loadItem(params.id, params.type, session, true);
    if (denied) return denied;
    if (!item) return err('Item not found', 404, 'not_found');
    // Feed "Recent": record the open (throttled, best-effort — never blocks).
    await recordItemOpen(
      { oid: session.claims.oid, upn: session.claims.upn },
      { id: item.id, itemType: params.type, workspaceId: item.workspaceId },
    );
    return NextResponse.json(item);
  } catch (e: any) {
    return err(e?.message || 'Failed to fetch item', 500, 'cosmos_error');
  }
});

export const PATCH = withSession<{ type: string; id: string }>(async (
  req: NextRequest,
  { session, params },
) => {
  let body: any;
  try { body = await req.json(); } catch { return err('Invalid JSON', 400, 'bad_json'); }
  try {
    const { item, denied } = await loadItem(params.id, params.type, session, false);
    if (denied) return denied;
    if (!item) return err('Item not found', 404, 'not_found');
    const nextState = 'state' in body && body.state && typeof body.state === 'object' ? body.state : item.state;
    // #3611 — this route serves EVERY item type that has no dedicated
    // `[id]/route.ts`, including `lakehouse-shortcut` (whose own route.ts has
    // no `[id]` segment, so `/api/items/lakehouse-shortcut/<id>` can only match
    // this pattern — the two patterns differ in segment count, so no
    // static-vs-dynamic precedence question arises). `state` is written
    // wholesale, so without this check any authenticated user could point a
    // shortcut they own at a platform Key Vault secret and then delete it, or
    // point `engineObject` at arbitrary SQL. Reject-on-change: a body that
    // round-trips these keys unchanged, or omits them, is unaffected.
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
    return NextResponse.json(resource);
  } catch (e: any) {
    return err(e?.message || 'Failed to update item', 500, 'cosmos_error');
  }
});

export const DELETE = withSession<{ type: string; id: string }>(async (
  _req: NextRequest,
  { session, params },
) => {
  try {
    const { item, denied } = await loadItem(params.id, params.type, session, false);
    if (denied) return denied;
    if (!item) return err('Item not found', 404, 'not_found');
    const items = await itemsContainer();
    await items.item(item.id, item.workspaceId).delete();
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return err(e?.message || 'Failed to delete item', 500, 'cosmos_error');
  }
});
