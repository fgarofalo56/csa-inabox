/**
 * Admin workspace settings BFF — backs the workspace Settings flyout.
 *
 * GET   /api/admin/workspaces/{id} — load one workspace (+ derived OneLake path
 *       + the default ADLS storage account id used for OneLake-storage usage).
 * PATCH /api/admin/workspaces/{id} — General / License / OneLake-storage tabs:
 *       persist name/description/licenseMode/contacts/capacity/domain/
 *       storageAccountId/m365GroupId/m365SiteUrl. When `capacity` changes and a
 *       Fabric/Power BI group is bound, re-assign the capacity best-effort.
 *
 * DELETE /api/admin/workspaces/{id} — tenant-admin cascade delete of ANY
 *       workspace (items → loom-search docs → the workspace doc), for cleaning
 *       up cross-tenant / UAT debris the admin does not personally own.
 *
 * Real Cosmos read/write. Access is resolved OWNER-FIRST then, for a tenant
 * admin only, CROSS-PARTITION: a workspace lives in its creator's partition
 * (tenantId == creator oid), so an owner reads their own workspace directly
 * while a tenant admin can additionally resolve any workspace in the tenant to
 * run the Settings flyout / govern it. A non-admin can still only ever read or
 * patch a workspace they own (resolveAdminWorkspace enforces the admin gate
 * before any cross-partition read). Azure-native by default — no Fabric
 * workspace required.
 */
import { NextRequest, NextResponse } from 'next/server';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { resolveAdminWorkspace } from '@/lib/auth/workspace-guard';
import { workspacesContainer, itemsContainer } from '@/lib/azure/cosmos-client';
import { upsertLoomDoc, deleteLoomDoc, docForWorkspace } from '@/lib/azure/loom-search';
import { assignWorkspaceToCapacity, FabricError } from '@/lib/azure/fabric-client';
import type { Workspace, WorkspaceItem, WorkspaceLicenseMode } from '@/lib/types/workspace';
import { apiError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number, code?: string) {
  return apiError(error, status, code === undefined ? undefined : { code });
}

const VALID_LICENSE_MODES: WorkspaceLicenseMode[] = [
  'Org', 'Trial', 'Pro', 'Premium', 'PremiumPerUser', 'Embedded', 'Delegated',
];

/** Default ADLS Gen2 storage-account ARM id used for OneLake usage (deployment default). */
export function defaultStorageAccountId(): string | null {
  const sub = process.env.LOOM_SUBSCRIPTION_ID;
  const rg = process.env.LOOM_DLZ_RG;
  const acct = process.env.LOOM_ADLS_ACCOUNT;
  if (!sub || !rg || !acct) return null;
  return `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Storage/storageAccounts/${acct}`;
}

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const resolved = await resolveAdminWorkspace(params.id);
  if (resolved.resp) return resolved.resp;
  const { ws } = resolved;
  try {
    const base = process.env.LOOM_ONELAKE_BASE;
    const oneLake = base ? `${base.replace(/\/$/, '')}/${encodeURIComponent(ws.name)}` : null;
    return NextResponse.json({
      ok: true,
      workspace: ws,
      oneLake,
      storageAccountId: ws.storageAccountId || defaultStorageAccountId(),
      storageAccountIsDefault: !ws.storageAccountId,
    });
  } catch (e: any) {
    return err(e?.message || 'Failed to fetch workspace', 500, 'cosmos_error');
  }
}

export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const resolved = await resolveAdminWorkspace(params.id);
  if (resolved.resp) return resolved.resp;
  const { ws } = resolved;
  let body: any;
  try { body = await req.json(); } catch { return err('Invalid JSON', 400, 'bad_json'); }
  try {
    const capacityChanged = 'capacity' in body && (body.capacity?.trim() || undefined) !== ws.capacity;

    const next: Workspace = {
      ...ws,
      name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : ws.name,
      description: 'description' in body ? (body.description?.trim() || undefined) : ws.description,
      capacity: 'capacity' in body ? (body.capacity?.trim() || undefined) : ws.capacity,
      domain: 'domain' in body ? (body.domain?.trim() || undefined) : ws.domain,
      licenseMode: 'licenseMode' in body && VALID_LICENSE_MODES.includes(body.licenseMode)
        ? body.licenseMode : ws.licenseMode,
      contacts: 'contacts' in body
        ? (Array.isArray(body.contacts)
            ? (body.contacts as unknown[]).map((c) => String(c).trim()).filter(Boolean).slice(0, 100)
            : ws.contacts)
        : ws.contacts,
      storageAccountId: 'storageAccountId' in body
        ? (typeof body.storageAccountId === 'string' && body.storageAccountId.trim() ? body.storageAccountId.trim() : undefined)
        : ws.storageAccountId,
      m365GroupId: 'm365GroupId' in body
        ? (typeof body.m365GroupId === 'string' && body.m365GroupId.trim() ? body.m365GroupId.trim() : undefined)
        : ws.m365GroupId,
      m365SiteUrl: 'm365SiteUrl' in body
        ? (typeof body.m365SiteUrl === 'string' && body.m365SiteUrl.trim() ? body.m365SiteUrl.trim() : undefined)
        : ws.m365SiteUrl,
      m365GroupName: 'm365GroupName' in body
        ? (typeof body.m365GroupName === 'string' && body.m365GroupName.trim() ? body.m365GroupName.trim() : undefined)
        : ws.m365GroupName,
      updatedAt: new Date().toISOString(),
    };

    // Capacity re-assignment is opt-in: only attempt it when a Fabric/Power BI
    // group is already bound (lazy-bound on the first PBI artifact). On the
    // Azure-native default there is no group, so we record the queued state and
    // NEVER fail the PATCH (no-fabric-dependency.md).
    if (capacityChanged && next.capacity) {
      if (next.fabricGroupId) {
        try {
          await assignWorkspaceToCapacity(next.fabricGroupId, next.capacity);
          next.capacityAssignment = { status: 'assigned', capacityId: next.capacity, at: new Date().toISOString() };
        } catch (e: any) {
          next.capacityAssignment = {
            status: 'failed',
            capacityId: next.capacity,
            error: e instanceof FabricError ? `Fabric ${e.status}: ${e.message}` : (e?.message || String(e)),
            at: new Date().toISOString(),
          };
        }
      } else {
        next.capacityAssignment = {
          status: 'queued',
          capacityId: next.capacity,
          queuedReason: 'No bound Fabric/Power BI group on this workspace yet. The first PBI-backed artifact will create the group and assign the chosen capacity.',
          at: new Date().toISOString(),
        };
      }
    } else if (capacityChanged && !next.capacity) {
      next.capacityAssignment = undefined;
    }

    const c = await workspacesContainer();
    const { resource } = await c.item(ws.id, ws.tenantId).replace<Workspace>(next);
    if (resource) void upsertLoomDoc(docForWorkspace(resource));
    return NextResponse.json({ ok: true, workspace: resource });
  } catch (e: any) {
    return err(e?.message || 'Failed to update workspace', 500, 'cosmos_error');
  }
}

/**
 * DELETE /api/admin/workspaces/{id} — tenant-admin cascade delete.
 *
 * Restricted to tenant admins (this is the org-wide govern surface; an owner
 * deletes their OWN workspace via DELETE /api/workspaces/[id]). Cascade matches
 * that owner route EXACTLY: items first (partition-keyed by `workspaceId`) with
 * their loom-search docs, then the workspace doc + its loom-search doc. Because
 * the workspace is resolved cross-partition, `ws.tenantId` is the creator's
 * partition — the delete is keyed by the LOADED doc's ids, not the caller's oid,
 * so it deletes UAT/foreign debris the admin does not personally own.
 */
export async function DELETE(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const resolved = await resolveAdminWorkspace(params.id);
  if (resolved.resp) return resolved.resp;
  const { session, ws } = resolved;
  // Destructive tenant-wide delete is admin-only; a non-admin owner uses the
  // self-service DELETE /api/workspaces/[id] route instead.
  if (!isTenantAdmin(session)) {
    return err('Only a tenant admin can delete a workspace from the admin console.', 403, 'admin_only');
  }
  try {
    const items = await itemsContainer();
    const { resources: children } = await items.items
      .query<WorkspaceItem>({
        query: 'SELECT c.id, c.workspaceId FROM c WHERE c.workspaceId = @w',
        parameters: [{ name: '@w', value: ws.id }],
      }, { partitionKey: ws.id })
      .fetchAll();
    for (const child of children) {
      await items.item(child.id, ws.id).delete().catch(() => {});
      void deleteLoomDoc(`it:${child.id}`);
    }
    const c = await workspacesContainer();
    await c.item(ws.id, ws.tenantId).delete();
    void deleteLoomDoc(`ws:${ws.id}`);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return err(e?.message || 'Failed to delete workspace', 500, 'cosmos_error');
  }
}
