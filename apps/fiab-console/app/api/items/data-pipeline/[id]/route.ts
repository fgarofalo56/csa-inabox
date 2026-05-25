/**
 * Data pipeline (Fabric) detail.
 * GET    /api/items/data-pipeline/[id]?workspaceId=...   — metadata + definition
 * PUT    /api/items/data-pipeline/[id]?workspaceId=...   — update displayName/description and/or definition
 *   body: { displayName?, description?, definition? }
 * DELETE /api/items/data-pipeline/[id]?workspaceId=...
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  getDataPipeline, getDataPipelineDefinition, upsertDataPipeline, deleteDataPipeline, FabricError,
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
      getDataPipeline(workspaceId, ctx.params.id),
      getDataPipelineDefinition(workspaceId, ctx.params.id).catch(() => null),
    ]);
    return NextResponse.json({ ok: true, pipeline: item, definition });
  } catch (e) { return err(e); }
}

export async function PUT(req: NextRequest, ctx: { params: { id: string } }) {
  if (!getSession()) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  const body = await req.json().catch(() => ({}));
  try {
    const res = await upsertDataPipeline(workspaceId, { id: ctx.params.id, displayName: body.displayName, description: body.description, definition: body.definition });
    return NextResponse.json({ ok: true, pipeline: res });
  } catch (e) { return err(e); }
}

export async function DELETE(req: NextRequest, ctx: { params: { id: string } }) {
  if (!getSession()) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  try {
    await deleteDataPipeline(workspaceId, ctx.params.id);
    return NextResponse.json({ ok: true });
  } catch (e) { return err(e); }
}
