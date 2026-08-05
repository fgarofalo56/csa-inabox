/**
 * GET  /api/items/databricks-notebook/[id]?path=/Shared/loom-installs/<app>/foo
 *      → { ok, path, language, content, root }   (live Databricks workspace/export)
 * GET  /api/items/databricks-notebook/[id]        (no path)
 *      → { ok, path, language, content, root, source:'cosmos' }
 *        Cosmos fallback: serialize the bundle-stamped NotebookContent cells
 *        (state.cells / state.content.cells) into a Databricks SOURCE notebook
 *        so a bundle-installed notebook opens FULLY POPULATED with every
 *        markdown + code cell — even before/without the live workspace import.
 * PUT  /api/items/databricks-notebook/[id]
 *      body { path, language, content } → upsert (workspace/import overwrite=true)
 * DELETE /api/items/databricks-notebook/[id]?path=…[&recursive=true]
 *      → delete a notebook/dir (workspace/delete)
 *
 * [id] is the Loom item id. Every handler AUTHORIZES the caller against that
 * item's workspace (`authorizeItemWorkspace`, the canonical owner →
 * tenant-admin → shared-ACL ladder) and then BINDS `path` to that item's own
 * folder — see `_lib/notebook-path-scope.ts` for why both layers are required
 * and what shipped without them (#2977).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { authorizeItemWorkspace } from '@/lib/auth/workspace-guard';
import {
  getNotebook,
  importNotebook,
  deleteWorkspaceObject,
  mkdirsWorkspace,
} from '@/lib/azure/databricks-client';
import { buildDatabricksSource } from '@/lib/install/provisioners/_seed-databricks';
import { apiServerError } from '@/lib/api/respond';
import {
  DBX_NOTEBOOK_ITEM_TYPE,
  loadNotebookItemRaw,
  notebookScopeRoot,
  scopeDbxNotebookPath,
} from '../_lib/notebook-path-scope';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NOT_FOUND = 'notebook not found';

/**
 * Session → workspace authorization → the resolved item, in that order.
 *
 * `authorizeItemWorkspace` resolves the workspace FROM THE ITEM when the caller
 * omits `?workspaceId=`, so authorization is NOT skippable by dropping the
 * param. Its one permissive case — an `[id]` that names no item of this type
 * anywhere in the estate — is closed here rather than inherited: with no item
 * there is no scope root, so we return the route's 404 instead of proceeding to
 * Databricks with an unbound path. Fail-closed, not fall-through.
 *
 * `read` selects the scope: read-only GET admits any workspace role; PUT/DELETE
 * stay write-scoped (Owner/Admin/Member) so a Viewer can never overwrite or
 * delete a notebook through a route that only "made the read work".
 */
async function authorize(
  req: NextRequest,
  id: string,
  opts: { read: boolean },
): Promise<{ item: WorkspaceItem; denied?: undefined } | { item?: undefined; denied: NextResponse }> {
  const session = getSession();
  if (!session) {
    return { denied: NextResponse.json({ error: 'unauthenticated' }, { status: 401 }) };
  }
  const denied = await authorizeItemWorkspace(session, {
    workspaceId: req.nextUrl.searchParams.get('workspaceId'),
    itemId: id,
    itemType: DBX_NOTEBOOK_ITEM_TYPE,
    ...(opts.read ? { allowReadRoles: true } : {}),
    notFound: NOT_FOUND,
  });
  if (denied) return { denied };
  const item = await loadNotebookItemRaw(id);
  if (!item) {
    return { denied: NextResponse.json({ ok: false, error: NOT_FOUND }, { status: 404 }) };
  }
  return { item };
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { item, denied } = await authorize(req, id, { read: true });
  if (denied) return denied;
  const { root } = notebookScopeRoot(item, id);
  const rawPath = req.nextUrl.searchParams.get('path');

  // No path → serve the installed item's bundle-stamped cells from Cosmos so
  // the notebook opens populated (mirrors app/api/items/notebook/[id]/route.ts,
  // adapted to the databricks-notebook editor's { content } SOURCE shape).
  // `root` rides along so the editor can anchor its tree + "new notebook"
  // suggestion inside the scope this route will actually authorize.
  if (!rawPath) {
    try {
      const state = (item.state as Record<string, any>) || {};
      // Fallback: cells may be stamped directly (state.cells) or stranded in the
      // NotebookContent shape (state.content.cells) — surface either.
      const cells = (Array.isArray(state.cells) && state.cells.length > 0)
        ? state.cells
        : (state.content?.kind === 'notebook' && Array.isArray(state.content.cells) ? state.content.cells : []);
      const defaultLang = state.defaultLang || state.content?.defaultLang || 'pyspark';
      const content = buildDatabricksSource({ cells, defaultLang });
      return NextResponse.json({ ok: true, path: null, root, language: 'PYTHON', content, source: 'cosmos' });
    } catch (e: any) {
      return apiServerError(e);
    }
  }

  const scoped = scopeDbxNotebookPath(item, id, rawPath);
  if (!scoped.ok) {
    return NextResponse.json({ ok: false, error: scoped.error, root }, { status: scoped.status });
  }
  try {
    const nb = await getNotebook(scoped.path);
    return NextResponse.json({ ok: true, ...nb, root });
  } catch (e: any) {
    const status = e?.status === 404 ? 404 : e?.status === 403 ? 403 : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { item, denied } = await authorize(req, id, { read: false });
  if (denied) return denied;
  const body = await req.json().catch(() => ({}));
  const language = (body?.language || 'PYTHON').toString().toUpperCase();
  const content = (body?.content ?? '').toString();
  if (!['PYTHON', 'SQL', 'SCALA', 'R'].includes(language)) {
    return NextResponse.json({ ok: false, error: 'invalid language' }, { status: 400 });
  }
  const scoped = scopeDbxNotebookPath(item, id, body?.path);
  if (!scoped.ok) {
    return NextResponse.json({ ok: false, error: scoped.error }, { status: scoped.status });
  }
  try {
    // The item's own folder may not exist yet (an item that declares no path is
    // scoped to a deterministic per-item root). workspace/import does NOT create
    // parents, so mkdirs first — idempotent server-side — otherwise "new
    // notebook" would 400 inside the very scope we just authorized.
    const slash = scoped.path.lastIndexOf('/');
    if (slash > 0) await mkdirsWorkspace(scoped.path.slice(0, slash));
    await importNotebook(scoped.path, language as any, content, true);
    return NextResponse.json({ ok: true, path: scoped.path, language });
  } catch (e: any) {
    const status = e?.status === 403 ? 403 : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { item, denied } = await authorize(req, id, { read: false });
  if (denied) return denied;
  const recursive = req.nextUrl.searchParams.get('recursive') === 'true';
  const scoped = scopeDbxNotebookPath(item, id, req.nextUrl.searchParams.get('path'));
  if (!scoped.ok) {
    return NextResponse.json({ ok: false, error: scoped.error }, { status: scoped.status });
  }
  try {
    await deleteWorkspaceObject(scoped.path, recursive);
    return NextResponse.json({ ok: true, path: scoped.path });
  } catch (e: any) {
    const status = e?.status === 404 ? 404 : e?.status === 403 ? 403 : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
