/**
 * Write authorization for Synapse notebooks on the deployment-default
 * workspace (#4619). Shared by `/api/synapse/notebooks` (POST, DELETE) and
 * `/api/synapse/notebooks/[name]` (PUT, DELETE).
 *
 *   - No `itemId` → the write is not for any Loom item, so it is an org-wide
 *     change to the shared Synapse workspace: `requireTenantAdmin` decides it
 *     (a tenant admin proceeds; anyone else gets the canonical `admin_only`
 *     403 with a reason that describes this surface).
 *   - With an `itemId` → EVERY caller, tenant admin included, must reach that
 *     `synapse-notebook` item through `resolveItemAccessByOid` (owner,
 *     workspace role, or item grant — with its tenant boundary) with a WRITE
 *     role. An id that does not resolve is a 404 for everyone.
 *   - The name must then be the one bound to that item (`isNameBoundToItem`).
 *     A name outside the binding (a legacy free-named notebook opened from the
 *     item) is again an org-wide write, decided by `requireTenantAdmin`; a
 *     non-admin gets 403 `notebook_not_bound`.
 *
 * There is no tenant-admin shortcut ahead of the item lookup: an admin who
 * names an item gets the tenant-bounded resolution like anyone else.
 *
 * The item is resolved by its server-minted id and the binding is derived from
 * the RESOLVED item's id, not from the value the caller sent.
 *
 * Returns null when the write may proceed, otherwise the response to return.
 * Call it after the name is validated and before any request body is read.
 */
import { NextResponse } from 'next/server';
import type { SessionPayload } from '@/lib/auth/session';
import { requireTenantAdmin, type TenantAdminRefusal } from '@/lib/auth/feature-gate';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';
import { boundNotebookName, isNameBoundToItem } from '@/lib/notebook/synapse-notebook-binding';

export const SYNAPSE_NOTEBOOK_ITEM_TYPE = 'synapse-notebook';

export const UNSCOPED_NOTEBOOK_REFUSAL: TenantAdminRefusal = {
  reason:
    'This request does not name the notebook item it is for, so it can only change notebooks in the '
    + 'shared Synapse workspace as a tenant admin.',
  remediation:
    'Open the notebook item and create, save or delete from its editor, or ask a tenant admin to make '
    + 'this change.',
};

export async function authorizeNotebookWrite(
  session: SessionPayload,
  name: string,
  itemId: unknown,
): Promise<NextResponse | null> {
  const id = typeof itemId === 'string' ? itemId.trim() : '';
  if (!id) return requireTenantAdmin(session, UNSCOPED_NOTEBOOK_REFUSAL);

  // 404, not 403: never confirm an id the caller may not see.
  const access = await resolveItemAccessByOid(session, id, SYNAPSE_NOTEBOOK_ITEM_TYPE);
  if (!access) return NextResponse.json({ ok: false, error: 'notebook item not found' }, { status: 404 });
  if (!access.canWrite) {
    return NextResponse.json({
      ok: false,
      code: 'read_only',
      error: 'Your role on this notebook item is read-only, so Loom did not change the notebook. A '
        + 'workspace Member/Admin, or an item grant that includes Edit, can make this change.',
    }, { status: 403 });
  }
  if (isNameBoundToItem(name, access.item.id)) return null;

  // A name outside this item's binding is an org-wide write in the shared
  // workspace, so the org-wide gate decides it.
  const orgWide = requireTenantAdmin(session);
  if (!orgWide) return null;
  const bound = boundNotebookName(access.item.displayName, access.item.id);
  return NextResponse.json({
    ok: false,
    code: 'notebook_not_bound',
    error: bound
      ? `"${name}" is not a notebook of this item. This item publishes as "${bound}"; other notebooks `
        + 'in the shared workspace can only be changed by a tenant admin.'
      : 'This item has no notebook name it can publish under; only a tenant admin can change '
        + 'notebooks for it.',
    ...(bound ? { boundName: bound } : {}),
  }, { status: 403 });
}
