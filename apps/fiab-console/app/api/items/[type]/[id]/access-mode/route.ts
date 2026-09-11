/**
 * PATCH /api/items/[type]/[id]/access-mode
 *
 * Sets the SQL endpoint data-access mode (F10) for a SQL analytics endpoint.
 *   body: { accessMode: 'service' | 'user' }
 *
 * - 'service' (default): queries run as the Loom console service identity.
 * - 'user': queries run under the signed-in user's own Azure identity (the
 *   query route uses the caller's cached delegated SQL token).
 *
 * The chosen mode is persisted to Cosmos at `item.state.accessMode` (reusing the
 * existing item PATCH state pattern — no schema migration). Valid for the SQL
 * endpoint item types plus report + kql-database (EH-P1-OBO, #1800); only
 * workspace admins/contributors may change it.
 *
 * Real backend: Cosmos read (cross-partition) + tenant-ownership check + role
 * resolution + Cosmos replace. No mocks.
 */
import { NextRequest, NextResponse } from 'next/server';
import { authorizeItemWorkspace } from '@/lib/auth/workspace-guard';
import { getSession, type SessionPayload } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { resolveWorkspaceRole, canEditWorkspaceConfig } from '@/lib/auth/workspace-role';
import {
  isUserAccessModeItemType,
  USER_ACCESS_MODE_ITEM_TYPES,
  normalizeAccessMode,
} from '@/lib/azure/sql-access-mode';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { apiError, apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * #3941 review - A ROUTE CEILING ABOVE THE GROUP WALK.
 *
 * This route's authorization moved from an owner-only point read to
 * `authorizeItemWorkspace`. The owner fast path short-circuits, so a caller who
 * created the workspace pays nothing new - but the population this migration
 * newly ADMITS (non-owner ACL members and tenant admins) is exactly the one
 * that falls through to `resolveEffectiveRole`, which walks group assignments
 * SEQUENTIALLY with no walk-wide ceiling (#3834). 71 other console routes
 * declare a bound; not one of these ten did, so the widening landed on the
 * routes with no ceiling at all.
 *
 * WHAT THIS DOES AND DOES NOT ESTABLISH (deploy-integrity.md R7): it DECLARES a
 * bound - it does not, on this deployment, enforce one, and the earlier wording
 * here ("it bounds the REQUEST") asserted an effect that was not established
 * (#4357 review item 3). `maxDuration` is a build-time segment config: measured
 * in next@15.5.21, every reference under `node_modules/next/dist` sits in
 * `build/` (segment-config collection, the build manifest, the types plugin) or
 * in typegen - nothing under `next/dist/server` reads it on the request path, so
 * the standalone server this console ships as does not cut the request off at
 * 60s. Enforcement belongs to the hosting platform, and that the console's
 * Container Apps runtime performs it was NOT established. What the line does buy
 * is the declared bound the house convention expects - 71 other console routes
 * carry one and not one of these ten did - so any platform that does read it
 * bounds these routes like the rest. It does not bound the group walk either
 * way: #3834 is still open.
 */
export const maxDuration = 60;

function err(error: string, status: number, code?: string) {
  return apiError(error, status, code === undefined ? undefined : { code });
}

/**
 * Find an item by id (cross-partition) + AUTHORIZE the caller against its parent
 * workspace through the canonical ladder (#3941). Read-scoped for GET, write-
 * scoped for every mutating verb. This REPLACES an owner-only partition point
 * read that admitted only the workspace CREATOR, so for any item row carrying a
 * workspaceId the admitted set GROWS: tenant admins and shared-ACL members with
 * the right role now pass.
 *
 * THE ONE NON-MONOTONE DIRECTION IS CLOSED IN THIS FILE (#4357 review item 4;
 * disclosed as an accepted widening in review item 2, now fixed rather than
 * disclosed). When an item row's `workspaceId` is FALSY,
 * `authorizeItemWorkspace` resolves no workspace and returns null — an ALLOW the
 * role resolver never sees (workspace-guard.ts, the `if (!workspaceId) return
 * null` prologue), and one intended for an id that names NO item anywhere. The
 * owner-only point read this replaced did
 * `ws.item(item.workspaceId, tenantId).read()`, which on a falsy id 404s or
 * throws, so the helper REFUSED. That row shape would therefore have moved from
 * refuse to proceed, so `loadItem` below refuses it EXPLICITLY before the ladder
 * runs and this route's access change is a widening in one direction only.
 * `items` is partitioned on `/workspaceId` (cosmos-client.ts) so such a row is
 * close to unreachable — but that is a durability argument, not an
 * authorization one, which is why it is fixed here rather than argued away.
 * The shared helper's ALLOW is UNCHANGED and still applies to its other
 * importers; only these ten routes are covered. Pinned by
 * `app/api/items/[type]/[id]/__tests__/workspace-authz.test.ts`, which reds if
 * the line is removed.
 */
async function loadItem(
  itemId: string,
  type: string,
  session: SessionPayload,
  // #3941 review - NAMED, not a bare positional boolean. This argument
  // selects the AUTHORIZATION scope: `true` admits read-only workspace
  // roles, `false` restricts to the write-capable ones. As a positional
  // `boolean` a transposed argument would silently widen a mutation with no
  // compiler complaint, and every call site read `..., session, { allowReadRoles: false })` with
  // nothing on screen saying which way `false` pointed.
  { allowReadRoles }: { allowReadRoles: boolean },
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
  // #4357 review 4 — the item EXISTS but names no workspace, so there is nothing
  // to authorize against. Refuse here: handing it to `authorizeItemWorkspace`
  // would hit that helper's `if (!workspaceId) return null` prologue, and `null`
  // is the ALLOW. Collapsing to the route's own not-found keeps the wording its
  // clients already render, and matches what the replaced owner-only point read
  // did on a falsy partition key. See the docblock above.
  if (!item.workspaceId) return { item: null, denied: null };
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

export async function PATCH(req: NextRequest, props: { params: Promise<{ type: string; id: string }> }) {
  const params = await props.params;
  const session = getSession();
  if (!session) return err('Unauthorized', 401, 'unauthorized');

  // EH-P1-OBO (#1800): the SQL endpoints (F10) plus report + kql-database —
  // the item types whose read routes honor the per-user data-access mode.
  if (!isUserAccessModeItemType(params.type)) {
    return err(
      `Data-access mode is only supported on: ${USER_ACCESS_MODE_ITEM_TYPES.join(', ')}.`,
      400,
      'unsupported_item_type',
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return err('Invalid JSON', 400, 'bad_json');
  }
  if (body?.accessMode !== 'service' && body?.accessMode !== 'user') {
    return err("accessMode must be 'service' or 'user'", 400, 'bad_access_mode');
  }
  const accessMode = normalizeAccessMode(body.accessMode);

  try {
    const { item, denied } = await loadItem(params.id, params.type, session, { allowReadRoles: false });
    if (denied) return denied;
    if (!item) return err('Item not found', 404, 'not_found');

    // Only workspace owners/contributors may change the data-access mode.
    const { role } = await resolveWorkspaceRole(item.workspaceId, session);
    if (!canEditWorkspaceConfig(role)) {
      return err('You need workspace admin or contributor access to change the data-access mode.', 403, 'forbidden');
    }

    const next: WorkspaceItem = {
      ...item,
      state: { ...(item.state ?? {}), accessMode },
      updatedAt: new Date().toISOString(),
    };
    const items = await itemsContainer();
    const { resource } = await items.item(item.id, item.workspaceId).replace<WorkspaceItem>(next);
    return NextResponse.json({ ok: true, accessMode: (resource?.state as any)?.accessMode ?? accessMode });
  } catch (e: any) {
    // #4357 review 5 — do NOT echo `e.message` to the client. A Cosmos SDK
    // error message carries the request URI, which embeds the account host,
    // database, container and partition-key value; an API response body is a
    // publication surface on a public repo. `apiServerError` logs the raw
    // detail server-side (log-injection-safe) and returns a fixed public string
    // with the same `cosmos_error` code this handler already used, so no client
    // branching on the code changes.
    return apiServerError(e, 'Failed to update data-access mode', 'cosmos_error');
  }
}
