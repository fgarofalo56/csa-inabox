/**
 * Data pipeline detail.
 * GET    /api/items/data-pipeline/[id]?workspaceId=...   — metadata + ADF spec
 * PUT    /api/items/data-pipeline/[id]?workspaceId=...   — update displayName/description and/or definition (writes to ADF)
 * DELETE /api/items/data-pipeline/[id]?workspaceId=...   — delete (removes ADF pipeline + Cosmos item)
 *
 * v3.25: backed by ADF, not Fabric REST.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { getPipeline, upsertPipeline, deletePipeline, type AdfPipeline } from '@/lib/azure/adf-client';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number) { return NextResponse.json({ ok: false, error }, { status }); }

export async function GET(req: NextRequest, ctx: { params: { id: string } }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  try {
    const items = await itemsContainer();
    const { resource } = await items.item(ctx.params.id, workspaceId).read<WorkspaceItem>();
    if (!resource || resource.itemType !== 'data-pipeline') return err('pipeline not found', 404);
    const adfName = (resource.state as any)?.adfPipelineName;
    let definition: AdfPipeline | null = null;
    if (adfName) {
      try { definition = await getPipeline(adfName); } catch { /* ADF may not have it yet */ }
    }
    return NextResponse.json({
      ok: true,
      pipeline: { id: resource.id, displayName: resource.displayName, description: resource.description, adfPipelineName: adfName },
      definition,
    });
  } catch (e: any) {
    if (e?.code === 404) return err('pipeline not found', 404);
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
    const items = await itemsContainer();
    const { resource: existing } = await items.item(ctx.params.id, workspaceId).read<WorkspaceItem>();
    if (!existing || existing.itemType !== 'data-pipeline') return err('pipeline not found', 404);
    const adfName = (existing.state as any)?.adfPipelineName;
    if (body?.definition && adfName) {
      try {
        await upsertPipeline(adfName, {
          name: adfName,
          properties: body.definition.properties || body.definition,
        });
      } catch (e: any) { return err(`ADF write failed: ${e?.message || e}`, 502); }
    }
    const next: WorkspaceItem = {
      ...existing,
      displayName: body?.displayName?.trim() || existing.displayName,
      description: 'description' in body ? body.description : existing.description,
      state: { ...(existing.state || {}), ...(body?.definition ? { definition: body.definition } : {}) },
      updatedAt: new Date().toISOString(),
    };
    const { resource } = await items.item(existing.id, workspaceId).replace(next);
    return NextResponse.json({ ok: true, pipeline: resource });
  } catch (e: any) { return err(e?.message || String(e), 500); }
}

export async function DELETE(req: NextRequest, ctx: { params: { id: string } }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  try {
    const items = await itemsContainer();
    const { resource: existing } = await items.item(ctx.params.id, workspaceId).read<WorkspaceItem>();
    const adfName = (existing?.state as any)?.adfPipelineName;
    if (adfName) { try { await deletePipeline(adfName); } catch { /* tolerate ADF 404 */ } }
    await items.item(ctx.params.id, workspaceId).delete();
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    if (e?.code === 404) return NextResponse.json({ ok: true });
    return err(e?.message || String(e), 500);
  }
}
