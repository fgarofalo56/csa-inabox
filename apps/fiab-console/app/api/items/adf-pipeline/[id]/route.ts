/**
 * GET    /api/items/adf-pipeline/[id]  — fetch pipeline spec
 * PUT    /api/items/adf-pipeline/[id]  — upsert pipeline spec
 * DELETE /api/items/adf-pipeline/[id]  — delete pipeline
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getPipeline, upsertPipeline, deletePipeline, type AdfPipeline } from '@/lib/azure/adf-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: { params: { id: string } }) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  try {
    const pipeline = await getPipeline(ctx.params.id);
    return NextResponse.json({ ok: true, pipeline });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function PUT(req: NextRequest, ctx: { params: { id: string } }) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const body = (await req.json().catch(() => null)) as AdfPipeline | null;
  if (!body || !body.properties) {
    return NextResponse.json({ error: 'body must be { name?, properties: {...} }' }, { status: 400 });
  }
  try {
    const pipeline = await upsertPipeline(ctx.params.id, { ...body, name: ctx.params.id });
    return NextResponse.json({ ok: true, pipeline });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: { id: string } }) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  try {
    await deletePipeline(ctx.params.id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
