/**
 * GET  /api/items/databricks-notebook/[id]?path=/Workspace/foo
 *      → { ok, path, language, content }            (live Databricks workspace/export)
 * GET  /api/items/databricks-notebook/[id]?workspaceId=...   (no path)
 *      → { ok, path, language, content, source:'cosmos' }
 *        Cosmos fallback: serialize the bundle-stamped NotebookContent cells
 *        (state.cells / state.content.cells) into a Databricks SOURCE notebook
 *        so a bundle-installed notebook opens FULLY POPULATED with every
 *        markdown + code cell — even before/without the live workspace import.
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
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { buildDatabricksSource } from '@/lib/install/provisioners/_seed-databricks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const path = req.nextUrl.searchParams.get('path');

  // No path → serve the installed item's bundle-stamped cells from Cosmos so
  // the notebook opens populated (mirrors app/api/items/notebook/[id]/route.ts,
  // adapted to the databricks-notebook editor's { content } SOURCE shape).
  if (!path) {
    const workspaceId = req.nextUrl.searchParams.get('workspaceId');
    if (!workspaceId) return NextResponse.json({ ok: false, error: 'path or workspaceId is required' }, { status: 400 });
    try {
      const items = await itemsContainer();
      const { resource } = await items.item((await ctx.params).id, workspaceId).read<any>();
      if (!resource || resource.itemType !== 'databricks-notebook') {
        return NextResponse.json({ ok: false, error: 'notebook not found' }, { status: 404 });
      }
      const state = (resource.state as any) || {};
      // Fallback: cells may be stamped directly (state.cells) or stranded in the
      // NotebookContent shape (state.content.cells) — surface either.
      const cells = (Array.isArray(state.cells) && state.cells.length > 0)
        ? state.cells
        : (state.content?.kind === 'notebook' && Array.isArray(state.content.cells) ? state.content.cells : []);
      const defaultLang = state.defaultLang || state.content?.defaultLang || 'pyspark';
      const content = buildDatabricksSource({ cells, defaultLang });
      return NextResponse.json({ ok: true, path: null, language: 'PYTHON', content, source: 'cosmos' });
    } catch (e: any) {
      if (e?.code === 404) return NextResponse.json({ ok: false, error: 'notebook not found' }, { status: 404 });
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
    }
  }

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
