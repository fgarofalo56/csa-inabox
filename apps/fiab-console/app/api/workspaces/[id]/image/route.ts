/**
 * Workspace image — Power BI-style custom workspace avatar.
 *
 *   POST   /api/workspaces/[id]/image  — upload/replace. Accepts either a JSON
 *          body ({ dataUri } or { contentType, base64 }) OR multipart/form-data
 *          with an `image` file. Write-capable role required (Owner/Admin/Member,
 *          same as PATCH /api/workspaces/[id]). Caps at 1 MiB, raster only.
 *   GET    /api/workspaces/[id]/image  — serve the raw bytes (any role that can
 *          read the workspace). 404 when no image is set.
 *   DELETE /api/workspaces/[id]/image  — remove it. Write-capable role required.
 *
 * The bytes live in a sidecar Cosmos doc (lib/azure/workspace-image-store); the
 * workspace doc carries only the `image` metadata pointer. Azure-native (Cosmos)
 * — no new infra, no Fabric dependency.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { workspacesContainer } from '@/lib/azure/cosmos-client';
import { resolveWorkspaceAccessByOid, type WorkspaceAccess } from '@/lib/auth/workspace-access';
import {
  putWorkspaceImage,
  getWorkspaceImage,
  deleteWorkspaceImage,
  parseDataUri,
  WorkspaceImageError,
  WORKSPACE_IMAGE_MAX_BYTES,
} from '@/lib/azure/workspace-image-store';
import type { Workspace } from '@/lib/types/workspace';
import { apiError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function loadAccess(id: string): Promise<{ access: WorkspaceAccess | null; session: ReturnType<typeof getSession> }> {
  const session = getSession();
  if (!session) return { access: null, session };
  const claims = session.claims as { oid: string; tid?: string; groups?: string[] };
  const access = await resolveWorkspaceAccessByOid(claims.oid, id, { groups: claims.groups, callerTid: claims.tid });
  return { access, session };
}

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const { access, session } = await loadAccess(id);
  if (!session) return apiError('Unauthorized', 401, { code: 'unauthorized' });
  if (!access) return apiError('Workspace not found', 404, { code: 'not_found' });
  try {
    const img = await getWorkspaceImage(access.workspace.tenantId, id);
    if (!img) return apiError('No workspace image set', 404, { code: 'no_image' });
    return new NextResponse(new Uint8Array(img.bytes), {
      status: 200,
      headers: {
        'Content-Type': img.contentType,
        'Content-Length': String(img.bytes.length),
        // Auth-gated content — keep it private; a short TTL + the `?ts=` cache
        // buster the UI appends make replacements show up promptly.
        'Cache-Control': 'private, max-age=300',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (e: any) {
    return apiError(e?.message || 'Failed to load workspace image', 500, { code: 'cosmos_error' });
  }
}

/** Extract { contentType, bytes } from a JSON or multipart request. */
async function readUpload(req: NextRequest): Promise<{ contentType: string; bytes: Buffer }> {
  const ct = req.headers.get('content-type') || '';
  if (ct.includes('multipart/form-data')) {
    const form = await req.formData();
    const file = form.get('image');
    if (!file || typeof file === 'string') {
      throw new WorkspaceImageError('multipart body must include an `image` file field.', 400);
    }
    const buf = Buffer.from(await file.arrayBuffer());
    const type = (file as File).type || '';
    return { contentType: type.toLowerCase(), bytes: buf };
  }
  // JSON body: { dataUri } or { contentType, base64 }.
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    throw new WorkspaceImageError('Expected a JSON body ({ dataUri } or { contentType, base64 }) or multipart form-data.', 400);
  }
  if (typeof body.dataUri === 'string' && body.dataUri) {
    return parseDataUri(body.dataUri);
  }
  if (typeof body.base64 === 'string' && typeof body.contentType === 'string') {
    return { contentType: body.contentType.toLowerCase(), bytes: Buffer.from(body.base64, 'base64') };
  }
  throw new WorkspaceImageError('Provide `dataUri`, or both `contentType` and `base64`.', 400);
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const { access, session } = await loadAccess(id);
  if (!session) return apiError('Unauthorized', 401, { code: 'unauthorized' });
  if (!access) return apiError('Workspace not found', 404, { code: 'not_found' });
  if (!access.canWrite) return apiError('You have read-only access to this workspace.', 403, { code: 'read_only_role' });

  // Guard against oversized request bodies before decoding (base64 inflates
  // ~33%, so bound the raw stream generously above the 1 MiB decoded cap).
  const declared = Number(req.headers.get('content-length') || 0);
  if (declared && declared > WORKSPACE_IMAGE_MAX_BYTES * 2) {
    return apiError(`Image too large (max ${WORKSPACE_IMAGE_MAX_BYTES / 1024} KiB).`, 413, { code: 'too_large' });
  }

  try {
    const { contentType, bytes } = await readUpload(req);
    const ws = access.workspace;
    const meta = await putWorkspaceImage(ws.tenantId, id, contentType, bytes, session.claims.upn || session.claims.oid);
    // Stamp the pointer on the workspace doc so the header/cards/switcher know an
    // image exists (and can cache-bust on `updatedAt`).
    const c = await workspacesContainer();
    const next: Workspace = { ...ws, image: meta, updatedAt: new Date().toISOString() };
    const { resource } = await c.item(ws.id, ws.tenantId).replace<Workspace>(next);
    return NextResponse.json({ ok: true, image: meta, workspace: resource });
  } catch (e: any) {
    if (e instanceof WorkspaceImageError) return apiError(e.message, e.status, { code: 'image_invalid' });
    return apiError(e?.message || 'Failed to save workspace image', 500, { code: 'cosmos_error' });
  }
}

export async function DELETE(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const { access, session } = await loadAccess(id);
  if (!session) return apiError('Unauthorized', 401, { code: 'unauthorized' });
  if (!access) return apiError('Workspace not found', 404, { code: 'not_found' });
  if (!access.canWrite) return apiError('You have read-only access to this workspace.', 403, { code: 'read_only_role' });
  try {
    const ws = access.workspace;
    await deleteWorkspaceImage(ws.tenantId, id);
    const c = await workspacesContainer();
    const { image: _drop, ...rest } = ws;
    const next: Workspace = { ...(rest as Workspace), updatedAt: new Date().toISOString() };
    const { resource } = await c.item(ws.id, ws.tenantId).replace<Workspace>(next);
    return NextResponse.json({ ok: true, workspace: resource });
  } catch (e: any) {
    return apiError(e?.message || 'Failed to remove workspace image', 500, { code: 'cosmos_error' });
  }
}
