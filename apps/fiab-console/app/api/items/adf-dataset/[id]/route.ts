/**
 * GET    /api/items/adf-dataset/[id]  — fetch dataset
 * PUT    /api/items/adf-dataset/[id]  — upsert dataset
 * DELETE /api/items/adf-dataset/[id]  — delete dataset
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getDataset, upsertDataset, deleteDataset, type AdfDataset } from '@/lib/azure/adf-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  try {
    const dataset = await getDataset((await ctx.params).id);
    return NextResponse.json({ ok: true, dataset });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const body = (await req.json().catch(() => null)) as AdfDataset | null;
  if (!body || !body.properties) {
    return NextResponse.json({ error: 'body must be { name?, properties: {...} }' }, { status: 400 });
  }
  try {
    const dataset = await upsertDataset((await ctx.params).id, { ...body, name: (await ctx.params).id });
    return NextResponse.json({ ok: true, dataset });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  try {
    await deleteDataset((await ctx.params).id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
