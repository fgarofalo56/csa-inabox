/**
 * Mirrored Databricks detail / delete.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number) { return NextResponse.json({ ok: false, error }, { status }); }

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  try {
    const items = await itemsContainer();
    const { resource } = await items.item((await ctx.params).id, workspaceId).read<WorkspaceItem>();
    if (!resource || resource.itemType !== 'mirrored-databricks') return err('mirrored databricks catalog not found', 404);
    return NextResponse.json({
      ok: true,
      mirror: {
        id: resource.id,
        displayName: resource.displayName,
        description: resource.description,
        catalogName: (resource.state as any)?.catalogName,
        hostname: (resource.state as any)?.hostname,
        mirrorMode: (resource.state as any)?.mirrorMode || 'AllTables',
      },
    });
  } catch (e: any) {
    if (e?.code === 404) return err('mirrored databricks catalog not found', 404);
    return err(e?.message || String(e), 500);
  }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  try {
    const items = await itemsContainer();
    await items.item((await ctx.params).id, workspaceId).delete();
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    if (e?.code === 404) return NextResponse.json({ ok: true });
    return err(e?.message || String(e), 500);
  }
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  const body = await req.json().catch(() => ({}));
  try {
    const items = await itemsContainer();
    const { resource: existing } = await items.item((await ctx.params).id, workspaceId).read<WorkspaceItem>();
    if (!existing || existing.itemType !== 'mirrored-databricks') return err('mirrored databricks catalog not found', 404);
    const next: WorkspaceItem = {
      ...existing,
      displayName: body?.displayName ?? existing.displayName,
      description: body?.description ?? existing.description,
      state: {
        ...(existing.state || {}),
        ...(body?.catalogName !== undefined && { catalogName: body.catalogName }),
        ...(body?.hostname !== undefined && { hostname: body.hostname }),
        ...(body?.mirrorMode !== undefined && { mirrorMode: body.mirrorMode }),
      },
      updatedAt: new Date().toISOString(),
    };
    const { resource } = await items.item(existing.id, workspaceId).replace(next);
    return NextResponse.json({ ok: true, mirror: resource });
  } catch (e: any) { return err(e?.message || String(e), 500); }
}
