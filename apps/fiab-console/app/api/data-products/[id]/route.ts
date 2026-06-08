/**
 * GET    /api/data-products/[id]  — fetch one data product (active backend).
 * PATCH  /api/data-products/[id]  — update a data product (lifecycle surface).
 * DELETE /api/data-products/[id]  — delete a data product.
 *
 * The active backend is resolved by the DataProductStore factory. On the
 * Purview Unified Catalog path, GET hits the real
 *   GET {endpoint}/datagovernance/catalog/dataProducts/{id}?api-version=2026-03-20-preview
 * (the live acceptance probe). On the Cosmos default, it reads the
 * data-product item from Cosmos. Same route, both backends (ui-parity.md).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { createDataProductStore } from '@/lib/dataproducts/store';
import { PurviewNotConfiguredError, PurviewError } from '@/lib/azure/purview-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  if (e instanceof PurviewNotConfiguredError) {
    return NextResponse.json({ ok: false, error: e.message, hint: e.hint }, { status: 501 });
  }
  if (e instanceof PurviewError) {
    const status = e.status >= 400 && e.status < 600 ? e.status : 502;
    return NextResponse.json({ ok: false, error: e.message }, { status });
  }
  const err = e as Error & { status?: number };
  return NextResponse.json({ ok: false, error: err?.message || String(e) }, { status: err?.status || 500 });
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const store = createDataProductStore();
  try {
    const item = await store.get(session, (await ctx.params).id);
    if (!item) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    return NextResponse.json({ ok: true, backend: store.backendName, item });
  } catch (e) {
    return fail(e);
  }
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const store = createDataProductStore();
  try {
    const item = await store.update(session, (await ctx.params).id, body);
    if (!item) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    return NextResponse.json({ ok: true, backend: store.backendName, item });
  } catch (e) {
    return fail(e);
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const store = createDataProductStore();
  try {
    const removed = await store.remove(session, (await ctx.params).id);
    if (!removed) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    return NextResponse.json({ ok: true, backend: store.backendName });
  } catch (e) {
    return fail(e);
  }
}
