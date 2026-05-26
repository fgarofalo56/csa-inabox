/**
 * Dataflow Gen2 detail. Cosmos-backed in v3.25.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
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
    if (!resource || resource.itemType !== 'dataflow') return err('dataflow not found', 404);
    return NextResponse.json({
      ok: true,
      dataflow: { id: resource.id, displayName: resource.displayName, description: resource.description },
      definition: (resource.state as any)?.definition || null,
    });
  } catch (e: any) {
    if (e?.code === 404) return err('dataflow not found', 404);
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
    if (!existing || existing.itemType !== 'dataflow') return err('dataflow not found', 404);
    const next: WorkspaceItem = {
      ...existing,
      displayName: body?.displayName?.trim() || existing.displayName,
      description: 'description' in body ? body.description : existing.description,
      state: { ...(existing.state || {}), ...(body?.definition !== undefined ? { definition: body.definition } : {}) },
      updatedAt: new Date().toISOString(),
    };
    const { resource } = await items.item(existing.id, workspaceId).replace(next);
    return NextResponse.json({ ok: true, dataflow: resource });
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
