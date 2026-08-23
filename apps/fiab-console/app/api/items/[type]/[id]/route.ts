import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { auditLogContainer, itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import type { Workspace, WorkspaceItem } from '@/lib/types/workspace';
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
 * Find an item by id (cross-partition) + verify the caller's tenant owns its workspace.
 *
 * DELIBERATELY NOT migrated to `authorizeItemWorkspace` in this PR, and the
 * reason is an authorization one, not laziness. The `workspaces` container is
 * partitioned on `/tenantId`, which stores the workspace CREATOR's oid, so the
 * point read below answers "did this caller CREATE this workspace?".
 * `authorizeItemWorkspace` answers "may this caller ACCESS it?" — owner OR
 * tenant admin OR shared-ACL member. Adopting it here would newly admit admins
 * and ACL members to GET, PATCH and DELETE on EVERY item type that has no
 * dedicated `[id]/route.ts`. That is a real widening, it needs its own review
 * and its own tests, and it does not belong inside a PR whose subject is
 * RESTRICTING what may be written through this same PATCH.
 *
 * The current check fails CLOSED (it refuses people who arguably should be
 * allowed), so deferring it leaks nothing. `check-owner-only-workspace-guard`
 * baselines this one occurrence, and because this PR MODIFIES this file its
 * boy-scout rule fires — so the deferral is recorded as an explicit
 * `TOUCH_EXEMPT` entry in `scripts/ci/check-owner-only-workspace-guard.mjs`,
 * alongside the seven precedents already there (counted, not estimated: the map
 * holds 8 keys including this one; the closest precedent is the sibling
 * `items/[type]/[id]/access-mode/route.ts`, which shares this very `loadItem`
 * shape). The baseline itself is NOT regenerated: the count is unchanged at 66
 * across 57 keys, because this PR does not touch the baselined lines — of its
 * 93 changed lines in this file, zero match either of that guard's detector
 * predicates.
 */
async function loadItem(itemId: string, type: string, tenantId: string): Promise<WorkspaceItem | null> {
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
  if (!item) return null;
  // Verify tenant ownership via parent workspace
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
    const item = await loadItem(params.id, params.type, session.claims.oid);
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
    const item = await loadItem(params.id, params.type, session.claims.oid);
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
    const item = await loadItem(params.id, params.type, session.claims.oid);
    if (!item) return err('Item not found', 404, 'not_found');
    const items = await itemsContainer();
    await items.item(item.id, item.workspaceId).delete();
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return err(e?.message || 'Failed to delete item', 500, 'cosmos_error');
  }
});
