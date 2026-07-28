/**
 * GET    /api/marketplace/sharing/shares/[name]   → share + objects + recipient grants
 * PATCH  /api/marketplace/sharing/shares/[name]   → add/remove objects, grant/revoke recipients
 * DELETE /api/marketplace/sharing/shares/[name]   → delete the share
 *
 * PATCH body (any subset):
 *   { addObjects?, removeObjects?: [{name}|{schema,name}], grant?: string[], revoke?: string[] }
 *
 * Backend-dependent object shape (LU-9):
 *   loom       addObjects: [{ schema, name, location: 'abfss://…', historyShared? }]
 *              — the Loom backend serves Delta tables from the estate's own
 *                ADLS lake, so a bare Unity Catalog three-part name has no
 *                meaning without a Databricks metastore.
 *   databricks addObjects: UCDataObject[] → UC PATCH /shares/{name}
 *
 * Grants: on the Loom backend a grant lives on the RECIPIENT, because the OSS
 * sharing server has no per-recipient authorization at all — see
 * lib/sharing/model.ts. On Databricks it is a UC share permission.
 */
import { NextResponse } from 'next/server';
import { withSession, withTenantAdmin } from '@/lib/api/route-toolkit';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import {
  getShare, updateShareObjects, deleteShare, getSharePermissions, updateSharePermissions,
} from '@/lib/azure/unity-catalog-client';
import { resolveShareHost, sharingErrorResponse } from '../../_lib';
import {
  isLoomSharingBackend, loomGetShare, loomPatchShare, loomDeleteShare, loomSharingErrorResponse,
} from '../../_loom-backend';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withSession<{ name: string }>(async (req, { params, session }) => {
  try {
    const name = decodeURIComponent(params.name);
    if (isLoomSharingBackend()) return await loomGetShare(name, { full: isTenantAdmin(session) });
    const host = await resolveShareHost(req.nextUrl.searchParams.get('host'));
    const [share, permissions] = await Promise.all([
      getShare(host, name, true),
      getSharePermissions(host, name).catch(() => ({ privilege_assignments: [] })),
    ]);
    return NextResponse.json({ ok: true, backend: 'databricks', host, share, permissions });
  } catch (e) {
    return loomSharingErrorResponse(e) || sharingErrorResponse(e);
  }
});

// Adding a table to a share, or granting a recipient, changes who OUTSIDE the
// boundary can read estate data — tenant admin on the Loom backend.
export const PATCH = withTenantAdmin<{ name: string }>(async (req, { params }) => {
  try {
    const name = decodeURIComponent(params.name);
    const body = await req.json().catch(() => ({}));
    if (isLoomSharingBackend()) return await loomPatchShare(name, body);
    const host = await resolveShareHost(body?.host);
    if (Array.isArray(body?.addObjects) || Array.isArray(body?.removeObjects)) {
      await updateShareObjects(host, name, { add: body.addObjects, remove: body.removeObjects });
    }
    if (Array.isArray(body?.grant) || Array.isArray(body?.revoke)) {
      await updateSharePermissions(host, name, { add: body.grant, remove: body.revoke });
    }
    const [share, permissions] = await Promise.all([
      getShare(host, name, true),
      getSharePermissions(host, name).catch(() => ({ privilege_assignments: [] })),
    ]);
    return NextResponse.json({ ok: true, backend: 'databricks', host, share, permissions });
  } catch (e) {
    return loomSharingErrorResponse(e) || sharingErrorResponse(e);
  }
});

export const DELETE = withTenantAdmin<{ name: string }>(async (req, { params }) => {
  try {
    const name = decodeURIComponent(params.name);
    if (isLoomSharingBackend()) return await loomDeleteShare(name);
    const host = await resolveShareHost(req.nextUrl.searchParams.get('host'));
    await deleteShare(host, name);
    return NextResponse.json({ ok: true, backend: 'databricks' });
  } catch (e) {
    return loomSharingErrorResponse(e) || sharingErrorResponse(e);
  }
});
