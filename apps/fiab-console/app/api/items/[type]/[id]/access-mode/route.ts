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
 * existing item PATCH state pattern — no schema migration). Only valid for the
 * SQL endpoint item types; only workspace admins/contributors may change it.
 *
 * Real backend: Cosmos read (cross-partition) + tenant-ownership check + role
 * resolution + Cosmos replace. No mocks.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import { resolveWorkspaceRole, canEditWorkspaceConfig } from '@/lib/auth/workspace-role';
import { isSqlAccessModeItemType, normalizeAccessMode } from '@/lib/azure/sql-access-mode';
import type { Workspace, WorkspaceItem } from '@/lib/types/workspace';
import { apiError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number, code?: string) {
  return apiError(error, status, code === undefined ? undefined : { code });
}

/** Find an item by id (cross-partition) + verify the caller's tenant owns its workspace. */
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

export async function PATCH(req: NextRequest, props: { params: Promise<{ type: string; id: string }> }) {
  const params = await props.params;
  const session = getSession();
  if (!session) return err('Unauthorized', 401, 'unauthorized');

  if (!isSqlAccessModeItemType(params.type)) {
    return err(
      'Data-access mode is only supported on SQL analytics endpoints (synapse-dedicated-sql-pool, synapse-serverless-sql-pool).',
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
    const item = await loadItem(params.id, params.type, session.claims.oid);
    if (!item) return err('Item not found', 404, 'not_found');

    // Only workspace owners/contributors may change the data-access mode.
    const { role } = await resolveWorkspaceRole(item.workspaceId, session.claims.oid, session.claims.upn);
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
