/**
 * Admin folders route — tenant admins manage folders in ANY workspace.
 *
 * GET    /api/admin/workspaces/[id]/folders          → { ok, folders }
 * POST   /api/admin/workspaces/[id]/folders          → { ok, folder }   (201)
 * PATCH  /api/admin/workspaces/[id]/folders          → { ok, folder }   (rename {id,name})
 * DELETE /api/admin/workspaces/[id]/folders?id=...    → { ok }           (cascade reparent)
 *
 * No per-workspace ownership check — the guard is tenant-admin (isTenantAdmin).
 * Delegates to the shared folders-client service so behavior is identical to
 * the owner route. Loom-native Cosmos store (PK /workspaceId), no Fabric.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import {
  dbListFolders, dbCreateFolder, dbRenameFolder, dbDeleteFolder,
} from '@/lib/clients/folders-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function guard() {
  const s = getSession();
  if (!s) return { resp: NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 }) };
  if (!isTenantAdmin(s)) return { resp: NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 }) };
  return { s };
}

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const g = guard();
  if (g.resp) return g.resp;
  try {
    const folders = await dbListFolders(params.id);
    return NextResponse.json({ ok: true, folders });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const g = guard();
  if (g.resp) return g.resp;
  const body = await req.json().catch(() => ({}));
  if (!body?.name || typeof body.name !== 'string' || !body.name.trim())
    return NextResponse.json({ ok: false, error: 'name required' }, { status: 400 });
  try {
    const folder = await dbCreateFolder(
      params.id, body.name, body.parent || null, g.s!.claims.upn || g.s!.claims.oid,
    );
    return NextResponse.json({ ok: true, folder }, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const g = guard();
  if (g.resp) return g.resp;
  const body = await req.json().catch(() => ({}));
  if (!body?.id || typeof body.id !== 'string')
    return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 });
  if (!body?.name || typeof body.name !== 'string' || !body.name.trim())
    return NextResponse.json({ ok: false, error: 'name required' }, { status: 400 });
  try {
    const folder = await dbRenameFolder(params.id, body.id, body.name);
    return NextResponse.json({ ok: true, folder });
  } catch (e: any) {
    const notFound = /not found/i.test(e?.message || '');
    return NextResponse.json(
      { ok: false, error: e?.message || String(e) },
      { status: notFound ? 404 : 500 },
    );
  }
}

export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const g = guard();
  if (g.resp) return g.resp;
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 });
  try {
    await dbDeleteFolder(params.id, id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
