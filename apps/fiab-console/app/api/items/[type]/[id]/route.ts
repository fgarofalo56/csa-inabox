import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { auditLogContainer, itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { apiError } from '@/lib/api/respond';
import { recordItemOpen } from '@/lib/items/record-open';
import { assertNoServerOwnedStateChange, ServerOwnedStateError } from '@/app/api/items/_lib/item-crud';
import { loadAuthorizedItem } from './_lib/load-item';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number, code?: string) {
  return apiError(error, status, code === undefined ? undefined : { code });
}

/**
 * #3941 — `loadItem` MIGRATED to the canonical authorization ladder.
 *
 * What used to live here was a private copy of an owner-only workspace point
 * read: `ws.item(item.workspaceId, session.claims.oid).read()` plus
 * `resource.tenantId !== oid`. The `workspaces` container is partitioned on
 * `/tenantId`, which stores the workspace CREATOR's oid, so that pair answered
 * "did this caller CREATE this workspace?" and refused a tenant admin or a
 * shared-ACL member on their own tenant's item. It was baselined by
 * `check-owner-only-workspace-guard` and TOUCH_EXEMPT'd twice (#3611, #3753)
 * because clearing it WIDENS who may GET, PATCH and DELETE every item type that
 * has no dedicated `[id]/route.ts`.
 *
 * That widening is now made, deliberately and with its own tests: the shared
 * `loadAuthorizedItem` runs owner → tenant admin → shared-ACL member,
 * READ-scoped for GET and WRITE-scoped for PATCH and DELETE. See its header for
 * the full rationale and the read/write contract.
 */
export const GET = withSession<{ type: string; id: string }>(async (
  _req: NextRequest,
  { session, params },
) => {
  try {
    const { item, denied } = await loadAuthorizedItem(session, {
      itemId: params.id, itemType: params.type, write: false, notFound: 'Item not found',
    });
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
    const { item, denied } = await loadAuthorizedItem(session, {
      itemId: params.id, itemType: params.type, write: true, notFound: 'Item not found',
    });
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
    const { item, denied } = await loadAuthorizedItem(session, {
      itemId: params.id, itemType: params.type, write: true, notFound: 'Item not found',
    });
    if (denied) return denied;
    if (!item) return err('Item not found', 404, 'not_found');
    const items = await itemsContainer();
    await items.item(item.id, item.workspaceId).delete();
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return err(e?.message || 'Failed to delete item', 500, 'cosmos_error');
  }
});
