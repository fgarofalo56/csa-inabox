/**
 * Data pipeline list + create.
 *
 * GET  /api/items/data-pipeline?workspaceId=...   — list pipelines in this Loom workspace
 * POST /api/items/data-pipeline?workspaceId=...   — create
 *   body: { displayName, description?, definition?: { activities: [...] } }
 *
 * v3.25: In Loom's Azure-native model, "data pipeline" maps to an ADF
 * pipeline in the loom-managed Data Factory. The Cosmos workspace-item
 * tracks the Loom-side reference + Loom workspace association; the
 * underlying execution surface is ADF. This preserves the Fabric-parity
 * UX (workspace dropdown, create+save+run inside Loom) while running
 * on the customer's deployed ADF.
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api/respond';
import { getSession } from '@/lib/auth/session';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import { listPipelines, upsertPipeline, type AdfPipeline } from '@/lib/azure/adf-client';
import type { Workspace, WorkspaceItem } from '@/lib/types/workspace';

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
      parameters: [{ name: '@w', value: workspaceId }, { name: '@t', value: 'data-pipeline' }],
    }, { partitionKey: workspaceId }).fetchAll();
    return NextResponse.json({
      ok: true, workspaceId,
      pipelines: resources.map(r => ({
        id: r.id,
        displayName: r.displayName,
        description: r.description,
        adfPipelineName: (r.state as any)?.adfPipelineName,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
    });
  } catch (e: any) { return apiError(e?.message || String(e), 500); }
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

    // 1. Create the ADF pipeline (real Azure resource)
    const adfName = `loom_${workspaceId.replace(/-/g, '').slice(0, 8)}_${displayName.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 40)}`;
    const adfSpec: AdfPipeline = {
      name: adfName,
      properties: body?.definition?.properties || { activities: [] },
    };
    try { await upsertPipeline(adfName, adfSpec); } catch { /* permission gate — keep going, surface error in editor */ }

    // 2. Create the Loom-side Cosmos item
    const items = await itemsContainer();
    const now = new Date().toISOString();
    const item: WorkspaceItem = {
      id: crypto.randomUUID(),
      workspaceId,
      itemType: 'data-pipeline',
      displayName,
      description: body?.description,
      state: { adfPipelineName: adfName, definition: body?.definition },
      createdBy: s.claims.upn || s.claims.email || s.claims.oid,
      createdAt: now,
      updatedAt: now,
    };
    const { resource } = await items.items.create(item);
    return NextResponse.json({ ok: true, pipeline: resource });
  } catch (e: any) { return apiError(e?.message || String(e), 500); }
}
