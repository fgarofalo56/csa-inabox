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
import { getSession } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { loadAuthorizedItem } from '../_lib/load-item';
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
    const { item, denied } = await loadAuthorizedItem(session, {
      itemId: params.id, itemType: params.type, write: true, notFound: 'Item not found',
    });
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
