/**
 * GET  /api/marketplace/sharing/shares          → list outbound Delta shares
 * POST /api/marketplace/sharing/shares           → create a share { name, comment? }
 *
 * Real Unity Catalog Delta Sharing REST. Honest 501 gate when no Databricks
 * workspace / metastore is bound (see ./_lib).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listShares, createShare } from '@/lib/azure/unity-catalog-client';
import { resolveShareHost, sharingErrorResponse } from '../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const host = await resolveShareHost(req.nextUrl.searchParams.get('host'));
    const shares = await listShares(host);
    return NextResponse.json({ ok: true, host, shares });
  } catch (e) {
    return sharingErrorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const body = await req.json().catch(() => ({}));
    const name = String(body?.name || '').trim();
    if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
    const host = await resolveShareHost(body?.host);
    const share = await createShare(host, { name, comment: body?.comment });
    return NextResponse.json({ ok: true, host, share });
  } catch (e) {
    return sharingErrorResponse(e);
  }
}
