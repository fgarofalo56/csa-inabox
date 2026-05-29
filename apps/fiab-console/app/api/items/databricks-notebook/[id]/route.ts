/**
 * GET  /api/items/databricks-notebook/[id]?path=/Workspace/foo
 *      → { ok, path, language, content }
 * PUT  /api/items/databricks-notebook/[id]
 *      body { path, language, content } → upsert (workspace/import overwrite=true)
 * DELETE /api/items/databricks-notebook/[id]?path=/Workspace/foo[&recursive=true]
 *      → delete a notebook/dir (workspace/delete)
 *
 * [id] is the Loom item id — the actual notebook is identified by the
 * `path` query/body parameter against the Databricks workspace.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  getNotebook,
  importNotebook,
  deleteWorkspaceObject,
} from '@/lib/azure/databricks-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const path = req.nextUrl.searchParams.get('path');
  if (!path) return NextResponse.json({ ok: false, error: 'path is required' }, { status: 400 });
  try {
    const nb = await getNotebook(path);
    return NextResponse.json({ ok: true, ...nb });
  } catch (e: any) {
    const status = e?.status === 404 ? 404 : e?.status === 403 ? 403 : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

export async function PUT(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const path = (body?.path || '').toString().trim();
  const language = (body?.language || 'PYTHON').toString().toUpperCase();
  const content = (body?.content ?? '').toString();
  if (!path) return NextResponse.json({ ok: false, error: 'path is required' }, { status: 400 });
  if (!['PYTHON', 'SQL', 'SCALA', 'R'].includes(language)) {
    return NextResponse.json({ ok: false, error: 'invalid language' }, { status: 400 });
  }
  try {
    await importNotebook(path, language as any, content, true);
    return NextResponse.json({ ok: true, path, language });
  } catch (e: any) {
    const status = e?.status === 403 ? 403 : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const path = req.nextUrl.searchParams.get('path');
  const recursive = req.nextUrl.searchParams.get('recursive') === 'true';
  if (!path) return NextResponse.json({ ok: false, error: 'path is required' }, { status: 400 });
  try {
    await deleteWorkspaceObject(path, recursive);
    return NextResponse.json({ ok: true, path });
  } catch (e: any) {
    const status = e?.status === 404 ? 404 : e?.status === 403 ? 403 : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
