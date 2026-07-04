/**
 * Notebook (Loom-native) list + create.
 * GET  /api/items/notebook?workspaceId=...   — list notebooks in a Loom workspace
 * POST /api/items/notebook?workspaceId=...   — create
 *   body: { displayName, description?, definition?: { code: string, lang?: 'python'|'sql'|'scala'|'r' } }
 *
 * v3.22: Loom no longer proxies to Fabric Notebook v1. Notebook metadata +
 * body live in Cosmos workspace-items; execution is dispatched to a real
 * Azure-native compute target (Synapse Spark via Livy OR Databricks Jobs)
 * the user picks in the editor. See /api/items/notebook/[id]/run.
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiError, apiServerError } from '@/lib/api/respond';
import { getSession } from '@/lib/auth/session';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import type { Workspace, WorkspaceItem } from '@/lib/types/workspace';
import { upsertLoomDoc, docForItem } from '@/lib/azure/loom-search';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';



async function loadWs(id: string, tenantId: string): Promise<Workspace | null> {
  const c = await workspacesContainer();
  try {
    const { resource } = await c.item(id, tenantId).read<Workspace>();
    return resource?.tenantId === tenantId ? resource : null;
  } catch (e: any) { if (e?.code === 404) return null; throw e; }
}

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return apiError('workspaceId required', 400);
  try {
    const ws = await loadWs(workspaceId, s.claims.oid);
    if (!ws) return apiError('workspace not found', 404);
    const items = await itemsContainer();
    const { resources } = await items.items.query<WorkspaceItem>({
      query: 'SELECT * FROM c WHERE c.workspaceId = @w AND c.itemType = @t ORDER BY c.updatedAt DESC',
      parameters: [{ name: '@w', value: workspaceId }, { name: '@t', value: 'notebook' }],
    }, { partitionKey: workspaceId }).fetchAll();
    return NextResponse.json({
      ok: true, workspaceId,
      notebooks: resources.map(r => ({
        id: r.id,
        displayName: r.displayName,
        description: r.description,
        // Folder this notebook lives in (null = workspace root). Carried on the
        // Cosmos doc; surfaced so the editor's Notebooks pane can render the
        // folder/subfolder tree (reuses the workspace folders engine).
        folderId: r.folderId ?? null,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        lang: (r.state as any)?.lang || 'python',
      })),
    });
  } catch (e: any) { return apiServerError(e); }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return apiError('workspaceId required', 400);
  const body = await req.json().catch(() => ({}));
  const displayName = String(body?.displayName || '').trim();
  if (!displayName) return apiError('displayName required', 400);
  try {
    const ws = await loadWs(workspaceId, s.claims.oid);
    if (!ws) return apiError('workspace not found', 404);
    const items = await itemsContainer();
    const now = new Date().toISOString();
    const item: WorkspaceItem = {
      id: crypto.randomUUID(),
      workspaceId,
      itemType: 'notebook',
      displayName,
      description: body?.description,
      state: {
        code: body?.definition?.code || '# Loom notebook\ndf = spark.range(10)\ndf.show()\n',
        lang: body?.definition?.lang || 'python',
      },
      createdBy: s.claims.upn || s.claims.email || s.claims.oid,
      createdAt: now,
      updatedAt: now,
    };
    const { resource } = await items.items.create(item);
    if (resource) upsertLoomDoc(docForItem(resource, ws.tenantId)).catch(() => {});
    return NextResponse.json({ ok: true, notebook: resource });
  } catch (e: any) { return apiServerError(e); }
}
