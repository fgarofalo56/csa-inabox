import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import { upsertLoomDoc, deleteLoomDoc, docForWorkspace } from '@/lib/azure/loom-search';
import { cleanupWorkspaceMetadata, type CleanupItem } from '@/lib/azure/lineage-gc';
import { teardownWorkspaceBackends, type TeardownItem, type TeardownOutcome } from '@/lib/azure/resource-teardown';
import {
  cascadeDeleteWorkspaceIdentity,
  workspaceIdentityProvisioningEnabled,
  type WorkspaceIdentityCascadeOutcome,
} from '@/lib/azure/workspace-identity-client';
import { resolveWorkspaceAccessByOid, type WorkspaceAccess } from '@/lib/auth/workspace-access';
import type { Workspace } from '@/lib/types/workspace';
import { apiError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number, code?: string) {
  return apiError(error, status, code === undefined ? undefined : { code });
}

/**
 * ACL-aware workspace access (rel-T11/B4): owner fast-path, then the
 * workspace-roles ACL under the tid boundary. Live-caught by the Wave-1
 * two-user receipt — the previous owner-partition point-read 404'd for a
 * Member opening a workspace shared with them, even though the LIST route
 * (listAccessibleWorkspaces) already showed it.
 */
async function loadWorkspaceAccess(id: string): Promise<{ access: WorkspaceAccess | null; session: ReturnType<typeof getSession> }> {
  const session = getSession();
  if (!session) return { access: null, session };
  const claims = session.claims as { oid: string; tid?: string; groups?: string[] };
  // ADMIN-OPEN: a tenant admin can open any workspace in the tenant (the
  // /admin/workspaces inventory lists them all), bypassing the member-only ACL.
  const access = await resolveWorkspaceAccessByOid(claims.oid, id, {
    groups: claims.groups,
    callerTid: claims.tid,
    tenantAdmin: isTenantAdmin(session),
  });
  return { access, session };
}

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { access, session } = await loadWorkspaceAccess(params.id);
  if (!session) return err('Unauthorized', 401, 'unauthorized');
  try {
    // Any role (including Viewer/Contributor) may READ the workspace.
    if (!access) return err('Workspace not found', 404, 'not_found');
    const ws = access.workspace;
    // OneLake path: derived from LOOM_ONELAKE_BASE env + workspace name.
    // Read-only; consumers use this to surface the abfss:// URL in the
    // settings drawer. Workspaces without LOOM_ONELAKE_BASE configured
    // get `oneLake = null`.
    const base = process.env.LOOM_ONELAKE_BASE;
    const oneLake = base
      ? `${base.replace(/\/$/, '')}/${encodeURIComponent(ws.name)}`
      : null;
    return NextResponse.json({ ...ws, oneLake, accessRole: access.role, accessVia: access.via });
  } catch (e: any) {
    return err(e?.message || 'Failed to fetch workspace', 500, 'cosmos_error');
  }
}

export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { access, session } = await loadWorkspaceAccess(params.id);
  if (!session) return err('Unauthorized', 401, 'unauthorized');
  let body: any;
  try { body = await req.json(); } catch { return err('Invalid JSON', 400, 'bad_json'); }
  try {
    if (!access) return err('Workspace not found', 404, 'not_found');
    // Mutations require a write-capable role (Owner/Admin/Member).
    if (!access.canWrite) return err('You have read-only access to this workspace.', 403, 'read_only_role');
    const ws = access.workspace;
    const next: Workspace = {
      ...ws,
      name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : ws.name,
      description: 'description' in body ? (body.description?.trim() || undefined) : ws.description,
      capacity: 'capacity' in body ? (body.capacity?.trim() || undefined) : ws.capacity,
      domain: 'domain' in body ? (body.domain?.trim() || undefined) : ws.domain,
      // Storage-account binding for OneLake lifecycle management. A full ARM
      // resource id (string) — the lifecycle route validates it at use time.
      // Empty string clears the binding (falls back to deployment-default).
      storageAccountId: 'storageAccountId' in body
        ? (typeof body.storageAccountId === 'string' && body.storageAccountId.trim() ? body.storageAccountId.trim() : undefined)
        : ws.storageAccountId,
      updatedAt: new Date().toISOString(),
    };
    const c = await workspacesContainer();
    const { resource } = await c.item(ws.id, ws.tenantId).replace<Workspace>(next);
    if (resource) void upsertLoomDoc(docForWorkspace(resource));
    return NextResponse.json(resource);
  } catch (e: any) {
    return err(e?.message || 'Failed to update workspace', 500, 'cosmos_error');
  }
}

export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { access, session } = await loadWorkspaceAccess(params.id);
  if (!session) return err('Unauthorized', 401, 'unauthorized');
  // Cascade = also DELETE the underlying Azure data/services each item
  // provisioned (the user explicitly chose "Delete everything"). Default (no
  // flag) is catalog-only — Azure resources are retained.
  const cascade = req.nextUrl.searchParams.get('cascade') === 'true';
  try {
    if (!access) return err('Workspace not found', 404, 'not_found');
    // Deleting a whole workspace stays OWNER/Admin-scoped — a Member can
    // write items but must not be able to destroy the shared workspace.
    if (access.via !== 'owner' && access.role !== 'Admin') {
      return err('Only the workspace owner or an Admin can delete a workspace.', 403, 'owner_or_admin_required');
    }
    const ws = access.workspace;
    // Cascade delete items first. Select the fields lineage GC + backend teardown
    // need (itemType + displayName + full state) alongside id/workspaceId so both
    // the metadata plane can be reconciled AND, on cascade, each item's real
    // Azure backend can be resolved from state.provisioning before the docs go.
    const items = await itemsContainer();
    const { resources: children } = await items.items
      .query<CleanupItem & { displayName?: string }>({
        query: 'SELECT c.id, c.workspaceId, c.itemType, c.displayName, c.state FROM c WHERE c.workspaceId = @w',
        parameters: [{ name: '@w', value: ws.id }],
      }, { partitionKey: ws.id })
      .fetchAll();

    // On cascade, tear down each item's Azure backend BEFORE the Cosmos item
    // docs are deleted (teardown reads state.provisioning for the backend refs).
    // Best-effort + serial — never throws, so it can't block the delete.
    let teardown: TeardownOutcome[] | undefined;
    if (cascade) {
      teardown = await teardownWorkspaceBackends(children as TeardownItem[], ws.tenantId);
    }

    for (const child of children) {
      await items.item(child.id, ws.id).delete().catch(() => {});
      void deleteLoomDoc(`it:${child.id}`);
    }
    // GC the metadata plane for every cascade-deleted item (LIN-GC-1): soft-delete
    // each Purview Atlas entity + hard-remove its Weave/Thread lineage edges, so
    // the Analyze → Lineage surfaces don't keep serving deleted assets. Best-effort
    // and fire-and-forget — never blocks the workspace delete. tenantId is the
    // workspace owner's partition (the value items were onboarded with).
    void cleanupWorkspaceMetadata(children, ws.tenantId);
    // I1 delete cascade: remove the per-workspace UAMI + its role assignments
    // (they orphan otherwise — a security liability). Best-effort BEFORE the
    // doc goes (we need workspaceIdentity.principalId); a failed identity
    // delete NEVER blocks the workspace delete, but the outcome is recorded
    // in the response body (and server log).
    let identityCascade: WorkspaceIdentityCascadeOutcome | undefined;
    if (ws.workspaceIdentity?.status === 'provisioned' || workspaceIdentityProvisioningEnabled()) {
      identityCascade = await cascadeDeleteWorkspaceIdentity(ws.id, ws.workspaceIdentity?.principalId);
      if (identityCascade.status === 'failed') {
        console.warn(`[workspace-delete] identity cascade failed for ${ws.id}: ${identityCascade.error}`);
      }
    }
    const wsContainer = await workspacesContainer();
    await wsContainer.item(ws.id, ws.tenantId).delete();
    void deleteLoomDoc(`ws:${ws.id}`);
    return NextResponse.json({ ok: true, ...(teardown ? { teardown } : {}), ...(identityCascade ? { identityCascade } : {}) });
  } catch (e: any) {
    return err(e?.message || 'Failed to delete workspace', 500, 'cosmos_error');
  }
}
