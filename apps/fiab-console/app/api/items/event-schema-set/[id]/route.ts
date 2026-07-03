/**
 * Event Schema Set detail / update / delete.
 *
 * Subjects array shape:
 *   { name: string, format: 'AVRO' | 'JSON' | 'PROTOBUF', versions: [{ id, schema, createdAt }] }
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api/respond';
import { getSession } from '@/lib/auth/session';
import { assertOwner } from '@/lib/auth/workspace-guard';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { schemaRegistryConfigGate } from '@/lib/azure/eventhubs-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';



export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return apiError('workspaceId required', 400);
  if (!(await assertOwner(workspaceId, s.claims.oid))) return apiError('event schema set not found', 404);
  try {
    const items = await itemsContainer();
    const { resource } = await items.item((await ctx.params).id, workspaceId).read<WorkspaceItem>();
    if (!resource || resource.itemType !== 'event-schema-set') return apiError('event schema set not found', 404);
    const state = (resource.state || {}) as Record<string, unknown>;
    // Whether server-side compatibility is enforced by the Azure Event Hubs
    // Schema Registry data plane (opt-in via LOOM_EH_SCHEMA_GROUP). When unset,
    // the in-process Avro validator enforces compatibility (the default).
    const srWired = schemaRegistryConfigGate() === null;
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
        compatBackend: srWired ? 'eventhubs-sr' : 'cosmos-inprocess',
        eventHubsSchemaGroup: srWired ? (process.env.LOOM_EH_SCHEMA_GROUP || null) : null,
      },
    });
  } catch (e: any) {
    if (e?.code === 404) return apiError('event schema set not found', 404);
    return apiError(e?.message || String(e), 500);
  }
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return apiError('workspaceId required', 400);
  if (!(await assertOwner(workspaceId, s.claims.oid))) return apiError('event schema set not found', 404);
  const body = await req.json().catch(() => ({}));
  try {
    const items = await itemsContainer();
    const { resource: existing } = await items.item((await ctx.params).id, workspaceId).read<WorkspaceItem>();
    if (!existing || existing.itemType !== 'event-schema-set') return apiError('event schema set not found', 404);
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
  } catch (e: any) { return apiError(e?.message || String(e), 500); }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return apiError('workspaceId required', 400);
  if (!(await assertOwner(workspaceId, s.claims.oid))) return apiError('event schema set not found', 404);
  try {
    const items = await itemsContainer();
    await items.item((await ctx.params).id, workspaceId).delete();
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    if (e?.code === 404) return NextResponse.json({ ok: true });
    return apiError(e?.message || String(e), 500);
  }
}
