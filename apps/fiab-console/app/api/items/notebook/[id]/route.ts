/**
 * Notebook (Loom-native) detail.
 * GET    /api/items/notebook/[id]?workspaceId=...   — metadata + code body
 * PUT    /api/items/notebook/[id]?workspaceId=...   — update code body
 *   body: { definition: { code: string, lang?: 'python'|'sql'|'scala'|'r' } }
 *        | { displayName?, description? }
 * DELETE /api/items/notebook/[id]?workspaceId=...
 *
 * v3.22: All notebook persistence is now in Cosmos workspace-items (not
 * Fabric REST). Execution is dispatched via the editor's chosen compute
 * (Synapse Spark Livy / Databricks Jobs) — see [id]/run/route.ts.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import type { Workspace, WorkspaceItem } from '@/lib/types/workspace';
import { migrateLegacyState, type NotebookCell, type NotebookCellLang } from '@/lib/types/notebook-cell';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number) { return NextResponse.json({ ok: false, error }, { status }); }

async function loadWs(id: string, tenantId: string): Promise<Workspace | null> {
  const c = await workspacesContainer();
  try {
    const { resource } = await c.item(id, tenantId).read<Workspace>();
    return resource?.tenantId === tenantId ? resource : null;
  } catch (e: any) { if (e?.code === 404) return null; throw e; }
}

export async function GET(req: NextRequest, ctx: { params: { id: string } }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  try {
    const ws = await loadWs(workspaceId, s.claims.oid);
    if (!ws) return err('workspace not found', 404);
    const items = await itemsContainer();
    const { resource } = await items.item(ctx.params.id, workspaceId).read<WorkspaceItem>();
    if (!resource || resource.itemType !== 'notebook') return err('notebook not found', 404);
    const state = (resource.state as any) || {};
    const migrated = migrateLegacyState(state);
    return NextResponse.json({
      ok: true,
      notebook: { id: resource.id, displayName: resource.displayName, description: resource.description },
      definition: {
        // Legacy flat fields kept for backward compat.
        code: state.code || '',
        lang: state.lang || 'python',
        // New cell-based shape.
        cells: migrated.cells,
        defaultLang: migrated.defaultLang,
        attachedSources: migrated.attachedSources || [],
      },
    });
  } catch (e: any) {
    if (e?.code === 404) return err('notebook not found', 404);
    return err(e?.message || String(e), 500);
  }
}

export async function PUT(req: NextRequest, ctx: { params: { id: string } }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  const body = await req.json().catch(() => ({}));
  try {
    const ws = await loadWs(workspaceId, s.claims.oid);
    if (!ws) return err('workspace not found', 404);
    const items = await itemsContainer();
    const { resource: existing } = await items.item(ctx.params.id, workspaceId).read<WorkspaceItem>();
    if (!existing || existing.itemType !== 'notebook') return err('notebook not found', 404);
    const def = body?.definition;
    const stateNext: Record<string, unknown> = { ...(existing.state || {}) };

    if (def?.cells !== undefined && Array.isArray(def.cells)) {
      const cells = def.cells as NotebookCell[];
      stateNext.cells = cells;
      if (def?.defaultLang) stateNext.defaultLang = def.defaultLang as NotebookCellLang;
      if (def?.attachedSources !== undefined) stateNext.attachedSources = def.attachedSources;
      // Keep `code` mirror in sync for old consumers (concatenated cells).
      const codeMirror = cells
        .filter(c => c.type === 'code')
        .map(c => c.source)
        .join('\n\n# --- next cell ---\n');
      stateNext.code = codeMirror;
      if (def?.defaultLang) stateNext.lang = def.defaultLang;
    } else {
      // Legacy single-blob update path.
      if (def?.code !== undefined) stateNext.code = String(def.code);
      if (def?.lang) stateNext.lang = def.lang;
    }

    const next: WorkspaceItem = {
      ...existing,
      displayName: body?.displayName?.trim() || existing.displayName,
      description: 'description' in body ? body.description : existing.description,
      state: stateNext,
      updatedAt: new Date().toISOString(),
    };
    const { resource } = await items.item(existing.id, workspaceId).replace(next);
    const respState = (resource?.state as any) || {};
    return NextResponse.json({
      ok: true,
      notebook: { id: resource?.id, displayName: resource?.displayName },
      definition: {
        code: respState.code,
        lang: respState.lang,
        cells: respState.cells || [],
        defaultLang: respState.defaultLang || 'pyspark',
        attachedSources: respState.attachedSources || [],
      },
    });
  } catch (e: any) { return err(e?.message || String(e), 500); }
}

export async function DELETE(req: NextRequest, ctx: { params: { id: string } }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  try {
    const items = await itemsContainer();
    await items.item(ctx.params.id, workspaceId).delete();
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    if (e?.code === 404) return NextResponse.json({ ok: true });
    return err(e?.message || String(e), 500);
  }
}
