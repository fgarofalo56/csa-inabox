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
import { apiError } from '@/lib/api/respond';
import { getSession } from '@/lib/auth/session';
import { assertOwner } from '@/lib/auth/workspace-guard';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import type { Workspace, WorkspaceItem } from '@/lib/types/workspace';
import { migrateLegacyState, type NotebookCell, type NotebookCellLang } from '@/lib/types/notebook-cell';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';



async function loadWs(id: string, tenantId: string): Promise<Workspace | null> {
  const c = await workspacesContainer();
  try {
    const { resource } = await c.item(id, tenantId).read<Workspace>();
    return resource?.tenantId === tenantId ? resource : null;
  } catch (e: any) { if (e?.code === 404) return null; throw e; }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return apiError('workspaceId required', 400);
  try {
    const ws = await loadWs(workspaceId, s.claims.oid);
    if (!ws) return apiError('workspace not found', 404);
    const items = await itemsContainer();
    const { resource } = await items.item((await ctx.params).id, workspaceId).read<WorkspaceItem>();
    if (!resource || resource.itemType !== 'notebook') return apiError('notebook not found', 404);
    const state = (resource.state as any) || {};
    // Fallback for bundle-installed notebooks whose cells were stamped only
    // into state.content (NotebookContent shape) and never into state.cells —
    // surface them so the notebook opens populated rather than empty.
    if ((!Array.isArray(state.cells) || state.cells.length === 0) && state.content?.kind === 'notebook' && Array.isArray(state.content.cells)) {
      state.cells = state.content.cells;
      if (!state.defaultLang && state.content.defaultLang) state.defaultLang = state.content.defaultLang;
    }
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
        attachedAmlEnv: state.attachedAmlEnv || null,
        customLibraries: Array.isArray(state.customLibraries) ? state.customLibraries : [],
        // Session sizing chosen via the editor's "Configure session" dialog
        // (UI shape: { numExecutors, executorMemoryGb, timeoutMinutes }).
        sessionConfig: (state.sessionConfig && typeof state.sessionConfig === 'object') ? state.sessionConfig : null,
      },
    });
  } catch (e: any) {
    if (e?.code === 404) return apiError('notebook not found', 404);
    return apiError(e?.message || String(e), 500);
  }
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return apiError('workspaceId required', 400);
  const body = await req.json().catch(() => ({}));
  try {
    const ws = await loadWs(workspaceId, s.claims.oid);
    if (!ws) return apiError('workspace not found', 404);
    const items = await itemsContainer();
    const { resource: existing } = await items.item((await ctx.params).id, workspaceId).read<WorkspaceItem>();
    if (!existing || existing.itemType !== 'notebook') return apiError('notebook not found', 404);
    const def = body?.definition;
    const stateNext: Record<string, unknown> = { ...(existing.state || {}) };

    // Session sizing (UI shape) — clamp server-side so a tampered client can't
    // request an absurd executor count. Persisted independently of cells so a
    // Configure-session save doesn't require touching the notebook body.
    if (def?.sessionConfig && typeof def.sessionConfig === 'object') {
      const sc = def.sessionConfig as Record<string, unknown>;
      const clamp = (v: unknown, lo: number, hi: number, dflt: number) => {
        const n = Math.round(Number(v));
        return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
      };
      stateNext.sessionConfig = {
        numExecutors: clamp(sc.numExecutors, 1, 100, 2),
        executorMemoryGb: clamp(sc.executorMemoryGb, 1, 8, 4),
        timeoutMinutes: clamp(sc.timeoutMinutes, 1, 1440, 60),
      };
    }

    if (def?.cells !== undefined && Array.isArray(def.cells)) {
      const cells = def.cells as NotebookCell[];
      stateNext.cells = cells;
      if (def?.defaultLang) stateNext.defaultLang = def.defaultLang as NotebookCellLang;
      if (def?.attachedSources !== undefined) stateNext.attachedSources = def.attachedSources;
      if (def?.attachedAmlEnv !== undefined) stateNext.attachedAmlEnv = def.attachedAmlEnv;
      if (def?.customLibraries !== undefined) stateNext.customLibraries = def.customLibraries;
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
        attachedAmlEnv: respState.attachedAmlEnv || null,
        customLibraries: Array.isArray(respState.customLibraries) ? respState.customLibraries : [],
        sessionConfig: respState.sessionConfig || null,
      },
    });
  } catch (e: any) { return apiError(e?.message || String(e), 500); }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return apiError('workspaceId required', 400);
  if (!(await assertOwner(workspaceId, s.claims.oid))) return apiError('notebook not found', 404);
  try {
    const items = await itemsContainer();
    await items.item((await ctx.params).id, workspaceId).delete();
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    if (e?.code === 404) return NextResponse.json({ ok: true });
    return apiError(e?.message || String(e), 500);
  }
}
