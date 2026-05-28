/**
 * GET    /api/items/apim-api/[id]  — fetch one API
 * PUT    /api/items/apim-api/[id]  — upsert API
 * DELETE /api/items/apim-api/[id]  — delete API
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getApi, upsertApi, deleteApi, ApimError } from '@/lib/azure/apim-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function handleErr(e: any) {
  const status = e instanceof ApimError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body, status }, { status });
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const api = await getApi((await ctx.params).id);
    if (!api) return NextResponse.json({ ok: false, error: 'not found', status: 404 }, { status: 404 });
    return NextResponse.json({ ok: true, api });
  } catch (e: any) { return handleErr(e); }
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  if (!body?.displayName) return NextResponse.json({ ok: false, error: 'displayName is required' }, { status: 400 });
  if (!body?.path) return NextResponse.json({ ok: false, error: 'path is required' }, { status: 400 });
  try {
    const api = await upsertApi((await ctx.params).id, {
      displayName: String(body.displayName),
      path: String(body.path),
      protocols: Array.isArray(body.protocols) ? body.protocols : undefined,
      subscriptionRequired: body.subscriptionRequired,
      serviceUrl: body.serviceUrl,
      description: body.description,
      format: body.format,
      value: body.value,
    });
    return NextResponse.json({ ok: true, api });
  } catch (e: any) { return handleErr(e); }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    await deleteApi((await ctx.params).id);
    return NextResponse.json({ ok: true });
  } catch (e: any) { return handleErr(e); }
}
