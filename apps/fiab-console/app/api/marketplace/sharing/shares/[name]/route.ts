/**
 * GET    /api/marketplace/sharing/shares/[name]   → share + objects + recipient grants
 * PATCH  /api/marketplace/sharing/shares/[name]   → add/remove objects, grant/revoke recipients
 * DELETE /api/marketplace/sharing/shares/[name]   → delete the share
 *
 * PATCH body (any subset):
 *   { addObjects?: UCDataObject[], removeObjects?: [{name}], grant?: string[], revoke?: string[] }
 *   - addObjects/removeObjects → UC PATCH /shares/{name} updates
 *   - grant/revoke (recipient names) → UC PATCH /shares/{name}/permissions
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  getShare, updateShareObjects, deleteShare, getSharePermissions, updateSharePermissions,
} from '@/lib/azure/unity-catalog-client';
import { resolveShareHost, sharingErrorResponse } from '../../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ name: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const name = decodeURIComponent((await ctx.params).name);
    const host = await resolveShareHost(req.nextUrl.searchParams.get('host'));
    const [share, permissions] = await Promise.all([
      getShare(host, name, true),
      getSharePermissions(host, name).catch(() => ({ privilege_assignments: [] })),
    ]);
    return NextResponse.json({ ok: true, host, share, permissions });
  } catch (e) {
    return sharingErrorResponse(e);
  }
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ name: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const name = decodeURIComponent((await ctx.params).name);
    const body = await req.json().catch(() => ({}));
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
    return NextResponse.json({ ok: true, host, share, permissions });
  } catch (e) {
    return sharingErrorResponse(e);
  }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ name: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const name = decodeURIComponent((await ctx.params).name);
    const host = await resolveShareHost(req.nextUrl.searchParams.get('host'));
    await deleteShare(host, name);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return sharingErrorResponse(e);
  }
}
