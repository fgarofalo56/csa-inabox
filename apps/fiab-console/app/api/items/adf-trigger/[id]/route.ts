/**
 * GET    /api/items/adf-trigger/[id]  — fetch trigger
 * PUT    /api/items/adf-trigger/[id]  — upsert trigger
 * DELETE /api/items/adf-trigger/[id]  — delete trigger
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getTrigger, upsertTrigger, deleteTrigger, type AdfTrigger } from '@/lib/azure/adf-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  try {
    const trigger = await getTrigger((await ctx.params).id);
    return NextResponse.json({ ok: true, trigger });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const body = (await req.json().catch(() => null)) as AdfTrigger | null;
  if (!body || !body.properties) {
    return NextResponse.json({ error: 'body must be { name?, properties: {...} }' }, { status: 400 });
  }
  try {
    const trigger = await upsertTrigger((await ctx.params).id, { ...body, name: (await ctx.params).id });
    return NextResponse.json({ ok: true, trigger });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  try {
    await deleteTrigger((await ctx.params).id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
