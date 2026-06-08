/**
 * GET  /api/data-products       — list data products (active backend).
 * POST /api/data-products       — create a data product (active backend).
 *
 * Both operate against whichever DataProductStore the factory selects:
 *   - cosmos (default)          — data-product items in Cosmos.
 *   - purview-unified (opt-in)  — Purview Unified Catalog REST (Commercial only).
 * The UI calls the SAME routes for both backends (ui-parity.md). When the
 * Unified Catalog adapter is active but not yet authorized/configured, the
 * PurviewError/PurviewNotConfiguredError propagates as an honest 4xx/5xx with a
 * structured hint (no-vaporware.md).
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

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const store = createDataProductStore();
  const domain = req.nextUrl.searchParams.get('domain') || undefined;
  try {
    const items = await store.list(session, { domain });
    return NextResponse.json({ ok: true, backend: store.backendName, items });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  if (!body?.name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
  const store = createDataProductStore();
  try {
    const item = await store.create(session, body);
    return NextResponse.json({ ok: true, backend: store.backendName, item }, { status: 201 });
  } catch (e) {
    return fail(e);
  }
}
