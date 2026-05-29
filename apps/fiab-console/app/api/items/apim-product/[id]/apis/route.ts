/**
 * GET    /api/items/apim-product/[id]/apis            — APIs in this product + all APIs (for the picker)
 * POST   /api/items/apim-product/[id]/apis            — add an API. body: { apiId }
 * DELETE /api/items/apim-product/[id]/apis?apiId=foo  — remove an API from the product
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listProductApis, addApiToProduct, removeApiFromProduct, listApis, ApimError,
} from '@/lib/azure/apim-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function handleErr(e: any) {
  const status = e instanceof ApimError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body, status }, { status });
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const id = (await ctx.params).id;
  try {
    const [productApis, allApis] = await Promise.all([listProductApis(id), listApis()]);
    return NextResponse.json({ ok: true, productApis, allApis });
  } catch (e: any) { return handleErr(e); }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const id = (await ctx.params).id;
  const body = await req.json().catch(() => ({}));
  const apiId = String(body?.apiId || '').trim();
  if (!apiId) return NextResponse.json({ ok: false, error: 'apiId is required' }, { status: 400 });
  try {
    await addApiToProduct(id, apiId);
    const productApis = await listProductApis(id);
    return NextResponse.json({ ok: true, productApis });
  } catch (e: any) { return handleErr(e); }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const id = (await ctx.params).id;
  const apiId = req.nextUrl.searchParams.get('apiId');
  if (!apiId) return NextResponse.json({ ok: false, error: 'apiId query param is required' }, { status: 400 });
  try {
    await removeApiFromProduct(id, apiId);
    const productApis = await listProductApis(id);
    return NextResponse.json({ ok: true, productApis });
  } catch (e: any) { return handleErr(e); }
}
