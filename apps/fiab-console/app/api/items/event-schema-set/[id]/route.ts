/**
 * Event Schema Set detail / update / delete.
 *
 * Subjects array shape:
 *   { name: string, format: 'AVRO' | 'JSON' | 'PROTOBUF', versions: [{ id, schema, createdAt }] }
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
    if (!resource || resource.itemType !== 'event-schema-set') return err('event schema set not found', 404);
    const state = (resource.state || {}) as Record<string, unknown>;
    return NextResponse.json({
      ok: true,
      schemaSet: {
        id: resource.id,
        displayName: resource.displayName,
        description: resource.description,
        subjects: (state.subjects as unknown[]) || [],
        compatibility: state.compatibility || 'BACKWARD',
        format: state.format || 'AVRO',
        externalRegistry: state.externalRegistry || null,
      },
    });
  } catch (e: any) {
    if (e?.code === 404) return err('event schema set not found', 404);
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
    if (!existing || existing.itemType !== 'event-schema-set') return err('event schema set not found', 404);
    const next: WorkspaceItem = {
      ...existing,
      displayName: body?.displayName ?? existing.displayName,
      description: body?.description ?? existing.description,
      state: {
        ...(existing.state || {}),
        ...(body?.subjects !== undefined && { subjects: body.subjects }),
        ...(body?.compatibility !== undefined && { compatibility: body.compatibility }),
        ...(body?.format !== undefined && { format: body.format }),
        ...(body?.externalRegistry !== undefined && { externalRegistry: body.externalRegistry }),
      },
      updatedAt: new Date().toISOString(),
    };
    const { resource } = await items.item(existing.id, workspaceId).replace(next);
    return NextResponse.json({ ok: true, schemaSet: resource });
  } catch (e: any) { return err(e?.message || String(e), 500); }
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
