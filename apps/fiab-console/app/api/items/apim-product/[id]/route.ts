/** GET / PUT / DELETE for a single APIM product. */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getProduct, upsertProduct, deleteProduct, ApimError } from '@/lib/azure/apim-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function handleErr(e: any) {
  const status = e instanceof ApimError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body, status }, { status });
}

export async function GET(_req: NextRequest, ctx: { params: { id: string } }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const product = await getProduct(ctx.params.id);
    if (!product) return NextResponse.json({ ok: false, error: 'not found', status: 404 }, { status: 404 });
    return NextResponse.json({ ok: true, product });
  } catch (e: any) { return handleErr(e); }
}

export async function PUT(req: NextRequest, ctx: { params: { id: string } }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  if (!body?.displayName) return NextResponse.json({ ok: false, error: 'displayName is required' }, { status: 400 });
  try {
    const product = await upsertProduct(ctx.params.id, {
      displayName: String(body.displayName),
      description: body.description,
      subscriptionRequired: body.subscriptionRequired,
      approvalRequired: body.approvalRequired,
      state: body.state,
      terms: body.terms,
    });
    return NextResponse.json({ ok: true, product });
  } catch (e: any) { return handleErr(e); }
}

export async function DELETE(_req: NextRequest, ctx: { params: { id: string } }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    await deleteProduct(ctx.params.id);
    return NextResponse.json({ ok: true });
  } catch (e: any) { return handleErr(e); }
}
