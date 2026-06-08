/**
 * Data Marketplace — data-products collection BFF.
 *
 *   GET /api/data-products?name=<n>&excludeId=<id>
 *     → duplicate-name lookup for the edit/create dialog. Returns
 *       `{ ok, duplicate }` where `duplicate` is the existing product that
 *       shares the (case-insensitive) name, or null. This is a NON-BLOCKING
 *       warning source — the dialog still allows Save when a duplicate exists,
 *       matching the Purview portal behaviour.
 *
 * Azure-native by default via the Cosmos `dataproducts` container.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getDataProductStore } from '@/lib/dataproducts/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const name = (req.nextUrl.searchParams.get('name') || '').trim();
  const excludeId = req.nextUrl.searchParams.get('excludeId') || '';
  if (!name) return NextResponse.json({ ok: false, error: 'name query param required' }, { status: 400 });

  try {
    const duplicate = await getDataProductStore().findByName(name, excludeId);
    return NextResponse.json({ ok: true, duplicate });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
