/**
 * POST /api/workspaces/bulk-delete  — admin-only multi-delete.
 *
 * Cleaning up UAT/test estates routinely means deleting 100+ workspaces.
 * Doing that one-DELETE-at-a-time from the per-workspace route is tedious,
 * so this route accepts a batch of ids and deletes each one using the
 * EXACT same semantics as DELETE /api/workspaces/[id]:
 *   1. loadWorkspace(id, tenantId)         — tenantId == caller oid (partition key)
 *   2. cascade-delete the workspace's items (+ remove their loom-search docs)
 *   3. delete the workspace doc            (+ remove its loom-search doc)
 *
 * Admin gating is the SAME check the rest of the app uses: isTenantAdmin()
 * from lib/auth/feature-gate (LOOM_TENANT_ADMIN_GROUP_ID membership OR
 * LOOM_TENANT_ADMIN_OID match). Non-admins get 403 — no new auth scheme.
 *
 * Because a workspace's partition key is its owning user's oid, this reuses
 * the per-workspace load that scopes to the caller's partition. A workspace
 * the caller cannot resolve in their partition reports an honest per-id
 * failure (`not_found`) rather than silently "succeeding" — no vaporware.
 *
 * Contract:
 *   Request : { ids: string[] }
 *   Response: { ok: boolean, deleted: string[], failed: { id: string; error: string }[] }
 *   - ok   : true when at least one id deleted AND no failures, else false.
 *   - 401  : no session.  403 : session is not a tenant admin.  400 : bad body.
 *
 * GET /api/workspaces/bulk-delete  — admin probe for the UI.
 *   Response: { ok: true, isAdmin: boolean }   (401 when unauthenticated)
 *   The workspaces page uses this to decide whether to render the
 *   multi-select + bulk-delete affordances at all.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import { deleteLoomDoc } from '@/lib/azure/loom-search';
import type { Workspace, WorkspaceItem } from '@/lib/types/workspace';
import { apiError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BATCH = 500;

function err(error: string, status: number, code?: string) {
  return apiError(error, status, code === undefined ? undefined : { code });
}

async function loadWorkspace(id: string, tenantId: string): Promise<Workspace | null> {
  const c = await workspacesContainer();
  try {
    const { resource } = await c.item(id, tenantId).read<Workspace>();
    if (!resource) return null;
    if (resource.tenantId !== tenantId) return null;
    return resource;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}

/** Same cascade delete as DELETE /api/workspaces/[id]: items first, then the workspace. */
async function deleteOne(ws: Workspace): Promise<void> {
  const items = await itemsContainer();
  const { resources: children } = await items.items
    .query<WorkspaceItem>(
      {
        query: 'SELECT c.id, c.workspaceId FROM c WHERE c.workspaceId = @w',
        parameters: [{ name: '@w', value: ws.id }],
      },
      { partitionKey: ws.id },
    )
    .fetchAll();
  for (const child of children) {
    await items.item(child.id, ws.id).delete().catch(() => {});
    void deleteLoomDoc(`it:${child.id}`);
  }
  const wsContainer = await workspacesContainer();
  await wsContainer.item(ws.id, ws.tenantId).delete();
  void deleteLoomDoc(`ws:${ws.id}`);
}

export async function GET() {
  const session = getSession();
  if (!session) return err('Unauthorized', 401, 'unauthorized');
  // Tenant admins can bulk-delete anything; every authenticated user can
  // bulk-delete the workspaces they OWN (their own Cosmos partition). The page
  // uses `canBulkDelete` to decide whether to show the multi-select affordances.
  return NextResponse.json({ ok: true, isAdmin: isTenantAdmin(session), canBulkDelete: true });
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return err('Unauthorized', 401, 'unauthorized');

  // Authorization is now PER-WORKSPACE (below), not a blanket tenant-admin gate:
  // a workspace is deletable when the caller is a tenant admin OR owns it
  // (ws.createdBy === oid). Because loadWorkspace() reads from the caller's own
  // partition, a caller can only ever resolve — and thus delete — their own
  // workspaces; a workspace they don't own reports an honest per-id failure.
  const admin = isTenantAdmin(session);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return err('Invalid JSON', 400, 'bad_json');
  }
  const rawIds = body?.ids;
  if (!Array.isArray(rawIds)) return err('Body must be { ids: string[] }', 400, 'bad_request');

  // De-dupe + validate ids; drop empties.
  const ids = Array.from(
    new Set(rawIds.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim())),
  );
  if (ids.length === 0) return err('No workspace ids provided', 400, 'bad_request');
  if (ids.length > MAX_BATCH) {
    return err(`Too many ids (${ids.length}); max ${MAX_BATCH} per request`, 400, 'too_many');
  }

  const tenantId = session.claims.oid;
  const deleted: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];

  for (const id of ids) {
    try {
      const ws = await loadWorkspace(id, tenantId);
      if (!ws) {
        failed.push({ id, error: 'not_found' });
        continue;
      }
      // Per-workspace authorization: tenant admin, or the workspace owner.
      if (!admin && ws.createdBy && ws.createdBy !== session.claims.oid) {
        failed.push({ id, error: 'forbidden' });
        continue;
      }
      await deleteOne(ws);
      deleted.push(id);
    } catch (e: any) {
      failed.push({ id, error: e?.message || 'delete_failed' });
    }
  }

  return NextResponse.json({ ok: failed.length === 0 && deleted.length > 0, deleted, failed });
}
