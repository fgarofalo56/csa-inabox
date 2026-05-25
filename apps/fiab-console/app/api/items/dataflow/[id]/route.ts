/**
 * Dataflow Gen2 (Fabric) detail.
 * GET    /api/items/dataflow/[id]?workspaceId=...   — metadata + definition
 * PUT    /api/items/dataflow/[id]?workspaceId=...   — update displayName/description and/or definition
 * DELETE /api/items/dataflow/[id]?workspaceId=...
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  getDataflow, getDataflowDefinition, upsertDataflow, deleteDataflow, FabricError,
} from '@/lib/azure/fabric-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(e: any) {
  const status = e instanceof FabricError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), endpoint: e?.endpoint, hint: e?.hint }, { status });
}

export async function GET(req: NextRequest, ctx: { params: { id: string } }) {
  if (!getSession()) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  try {
    const [item, definition] = await Promise.all([
      getDataflow(workspaceId, ctx.params.id),
      getDataflowDefinition(workspaceId, ctx.params.id).catch(() => null),
    ]);
    return NextResponse.json({ ok: true, dataflow: item, definition });
  } catch (e) { return err(e); }
}

export async function PUT(req: NextRequest, ctx: { params: { id: string } }) {
  if (!getSession()) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  const body = await req.json().catch(() => ({}));
  try {
    const res = await upsertDataflow(workspaceId, { id: ctx.params.id, displayName: body.displayName, description: body.description, definition: body.definition });
    return NextResponse.json({ ok: true, dataflow: res });
  } catch (e) { return err(e); }
}

export async function DELETE(req: NextRequest, ctx: { params: { id: string } }) {
  if (!getSession()) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  try {
    await deleteDataflow(workspaceId, ctx.params.id);
    return NextResponse.json({ ok: true });
  } catch (e) { return err(e); }
}
