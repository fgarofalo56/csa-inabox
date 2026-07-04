/**
 * Item-level permissions & sharing (F6) — BFF route.
 *
 *   GET    → { ok, permissions[], dlpRestricted, dlpPolicyName?, item } — live
 *            Cosmos rows + DLP reflection (T19). No mock list.
 *   POST   body { principalId, principalType, principalDisplayName?,
 *                 principalUpn?, permissionTypes[] }
 *          → grant + mirror (Cosmos row + ADLS POSIX ACL + ARM Storage RBAC +
 *            opt-in Fabric /share). DLP-restricted items reject Edit/Reshare.
 *   DELETE ?permissionId=... → revoke (Cosmos + ACL + RBAC).
 *
 * Auth: caller must own the item (tenant owns its workspace) OR hold the
 * 'item.share' capability at Contributor. Tenant admins bypass via the gate.
 *
 * Azure-native DEFAULT (per no-fabric-dependency.md): works with
 * LOOM_DEFAULT_FABRIC_WORKSPACE UNSET. The Fabric /share mirror is strictly
 * opt-in (LOOM_FABRIC_PERMISSIONS_ENABLED=true, Commercial/GCC only).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { pdpCheck } from '@/lib/auth/pdp/enforce';
import { checkCapability } from '@/lib/auth/feature-gate';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import {
  listItemPermissions,
  grantItemPermission,
  revokeItemPermission,
  ALL_PERMISSION_TYPES,
  type ItemPermissionType,
} from '@/lib/azure/item-permissions-client';
import { listDlpPolicies, DlpNotConfiguredError } from '@/lib/azure/dlp-graph-client';
import type { WorkspaceItem, Workspace } from '@/lib/types/workspace';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Load the item + verify the caller's tenant owns its workspace. */
async function loadOwnedItem(itemId: string, itemType: string, tenantId: string): Promise<WorkspaceItem | null> {
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<WorkspaceItem>({
      query: 'SELECT * FROM c WHERE c.id = @i AND c.itemType = @t',
      parameters: [{ name: '@i', value: itemId }, { name: '@t', value: itemType }],
    })
    .fetchAll();
  const item = resources[0];
  if (!item) return null;
  const ws = await workspacesContainer();
  try {
    const { resource } = await ws.item(item.workspaceId, tenantId).read<Workspace>();
    return resource && resource.tenantId === tenantId ? item : null;
  } catch {
    return null;
  }
}

/** Caller may manage permissions if they own the item OR hold item.share Contributor. */
async function canManage(session: ReturnType<typeof getSession>, item: WorkspaceItem | null): Promise<boolean> {
  if (!session) return false;
  if (item) return true; // ownership proven by loadOwnedItem
  const r = await checkCapability(session, 'item.share', 'Contributor');
  return r.allow;
}

/** Resolve the item's ADLS container + path from its provisioning receipt. */
function resolveItemStorage(item: WorkspaceItem): { container?: string; path?: string } {
  const state = (item.state || {}) as Record<string, any>;
  const sec = (state.provisioning?.secondaryIds || {}) as Record<string, string>;
  const container = sec.container || state.adlsContainer || undefined;
  const path = sec.rootPath || state.adlsPath || state.rootPath || undefined;
  return { container, path };
}

/** Opt-in Fabric ids — present only when the item was bound to a real Fabric workspace. */
function resolveFabricBinding(item: WorkspaceItem): { fabricWorkspaceId?: string; fabricItemId?: string } {
  const state = (item.state || {}) as Record<string, any>;
  const sec = (state.provisioning?.secondaryIds || {}) as Record<string, string>;
  return {
    fabricWorkspaceId: state.fabricWorkspaceId || sec.fabricWorkspaceId || undefined,
    fabricItemId: state.fabricItemId || sec.fabricItemId || sec.itemId || undefined,
  };
}

/**
 * DLP reflection (T19). An item is DLP-restricted when:
 *   • its provisioning/state stamped `dlpRestricted: true` (set by the T19
 *     DLP scanner), OR
 *   • LOOM_DLP_ENABLED=true, the item carries a sensitivity label, and a live
 *     Purview DLP policy targets that label (best-effort Graph lookup).
 * Never throws — DLP being unconfigured simply yields { restricted: false }.
 */
async function resolveDlp(item: WorkspaceItem): Promise<{ restricted: boolean; policyName?: string }> {
  const state = (item.state || {}) as Record<string, any>;
  if (state.dlpRestricted === true || (item as any).dlpRestricted === true) {
    return { restricted: true, policyName: state.dlpPolicyName || undefined };
  }
  const labelId: string | undefined = state.sensitivityLabelId || (item as any).sensitivityLabelId;
  if (!labelId || process.env.LOOM_DLP_ENABLED !== 'true') return { restricted: false };
  try {
    const policies = await listDlpPolicies();
    for (const p of policies) {
      const hay = JSON.stringify(p.raw ?? p).toLowerCase();
      if (hay.includes(String(labelId).toLowerCase())) {
        return { restricted: true, policyName: p.name || p.displayName || p.id };
      }
    }
  } catch (e) {
    // DlpNotConfiguredError / Graph DLP segment unavailable → not restricted by
    // a policy we can read. The stamped-field path above still applies.
    if (!(e instanceof DlpNotConfiguredError)) {
      // Any other transient Graph error is non-fatal for the share surface.
    }
  }
  return { restricted: false };
}

export async function GET(_req: NextRequest, props: { params: Promise<{ type: string; id: string }> }) {
  const { type, id } = await props.params;
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  // PDP gate (default-off / shadow-ready). Item-level read.
  const blocked = await pdpCheck(s, { level: 'item', id, itemType: type }, 'read');
  if (blocked) return blocked;
  const item = await loadOwnedItem(id, type, s.claims.oid);
  if (!(await canManage(s, item))) {
    return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }
  if (!item) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });

  const [permissions, dlp] = await Promise.all([listItemPermissions(id), resolveDlp(item)]);
  const storage = resolveItemStorage(item);
  return NextResponse.json({
    ok: true,
    permissions,
    dlpRestricted: dlp.restricted,
    dlpPolicyName: dlp.policyName,
    hasStoragePath: !!(storage.container && storage.path),
    item: { id: item.id, itemType: item.itemType, displayName: item.displayName },
    availablePermissionTypes: ALL_PERMISSION_TYPES,
  });
}

export async function POST(req: NextRequest, props: { params: Promise<{ type: string; id: string }> }) {
  const { type, id } = await props.params;
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  // PDP gate (default-off / shadow-ready). Granting a permission is a share.
  const blocked = await pdpCheck(s, { level: 'item', id, itemType: type }, 'share');
  if (blocked) return blocked;
  const item = await loadOwnedItem(id, type, s.claims.oid);
  if (!(await canManage(s, item))) {
    return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }
  if (!item) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const principalId = (body?.principalId || '').toString().trim();
  const principalType = body?.principalType === 'group' ? 'group' : 'user';
  if (!principalId) {
    return NextResponse.json({ ok: false, error: 'principalId required' }, { status: 400 });
  }
  const requested: ItemPermissionType[] = Array.isArray(body?.permissionTypes)
    ? body.permissionTypes.filter((t: string): t is ItemPermissionType => ALL_PERMISSION_TYPES.includes(t as ItemPermissionType))
    : [];

  // DLP restriction (T19): a restricted item cannot grant Edit or Reshare.
  const dlp = await resolveDlp(item);
  let permissionTypes = requested;
  if (dlp.restricted) {
    const blocked = requested.filter((t) => t === 'Edit' || t === 'Reshare');
    if (blocked.length) {
      return NextResponse.json(
        {
          ok: false,
          error: 'dlp_restricted',
          message: `Sharing is restricted by DLP policy${dlp.policyName ? ` "${dlp.policyName}"` : ''}. Edit and Reshare cannot be granted on this item.`,
          dlpPolicyName: dlp.policyName,
        },
        { status: 422 },
      );
    }
  }

  const storage = resolveItemStorage(item);
  const fabric = resolveFabricBinding(item);
  try {
    const grant = await grantItemPermission({
      itemId: id,
      itemType: type,
      workspaceId: item.workspaceId,
      tenantId: s.claims.oid,
      principalId,
      principalType,
      principalDisplayName: body?.principalDisplayName || undefined,
      principalUpn: body?.principalUpn || undefined,
      permissionTypes,
      grantedBy: s.claims.upn || s.claims.oid,
      adlsContainer: storage.container,
      adlsPath: storage.path,
      fabricWorkspaceId: fabric.fabricWorkspaceId,
      fabricItemId: fabric.fabricItemId,
    });
    return NextResponse.json({ ok: true, permission: grant }, { status: 201 });
  } catch (e: any) {
    return apiServerError(e, 'grant failed');
  }
}

export async function DELETE(req: NextRequest, props: { params: Promise<{ type: string; id: string }> }) {
  const { type, id } = await props.params;
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  // PDP gate (default-off / shadow-ready). Revoking a permission is admin.
  const blocked = await pdpCheck(s, { level: 'item', id, itemType: type }, 'admin');
  if (blocked) return blocked;
  const item = await loadOwnedItem(id, type, s.claims.oid);
  if (!(await canManage(s, item))) {
    return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }
  if (!item) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });

  const permissionId = new URL(req.url).searchParams.get('permissionId');
  if (!permissionId) {
    return NextResponse.json({ ok: false, error: 'permissionId required' }, { status: 400 });
  }
  try {
    const { notes } = await revokeItemPermission(id, permissionId);
    return NextResponse.json({ ok: true, notes });
  } catch (e: any) {
    return apiServerError(e, 'revoke failed');
  }
}
