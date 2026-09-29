/**
 * GET /api/lakehouse/access?lakehouseId=<id>
 *   → 200 { ok: true, lakehouseId, canWrite }
 *   → 404 when the caller cannot reach the item
 *
 * The caller's access to one lakehouse item, from the same `authorizeLakehouse`
 * decision the lakehouse routes apply. The editor uses it to disable actions
 * that need edit rights and to say why, instead of letting a click end in a 403.
 */
import { NextRequest, NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { apiBadRequest } from '@/lib/api/respond';
import { authorizeLakehouse } from '../_lib/item-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withSession(async (req: NextRequest, { session }) => {
  const lakehouseId = (req.nextUrl.searchParams.get('lakehouseId') || '').trim();
  if (!lakehouseId) return apiBadRequest('lakehouseId is required');
  const access = await authorizeLakehouse(session, lakehouseId);
  if (access instanceof NextResponse) return access;
  return NextResponse.json({ ok: true, lakehouseId, canWrite: access.canWrite });
});
