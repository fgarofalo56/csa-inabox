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
import { apiError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number, code?: string) {
  return apiError(error, status, code === undefined ? undefined : { code });
}

/**
 * Find an item by id (cross-partition) + AUTHORIZE the caller against its parent
 * workspace through the canonical ladder (#3941). Read-scoped for GET, write-
 * scoped for every mutating verb. This REPLACES an owner-only partition point
 * read that admitted only the workspace CREATOR, so the admitted set strictly
 * GROWS: tenant admins and shared-ACL members with the right role now pass.
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
    const { item, denied } = await loadItem(params.id, params.type, session, false);
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
    return err(e?.message || 'Failed to update data-access mode', 500, 'cosmos_error');
  }
}
