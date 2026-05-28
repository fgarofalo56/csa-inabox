/**
 * GET /api/items?type=<itemType>
 *
 * Legacy single-type list endpoint. Returns every item of the requested
 * type owned by the caller's tenant (via parent workspace ownership).
 *
 * Callers:
 *  - lib/editors/phase3-editors.tsx:1085 — KQL Queryset "Pin to dashboard"
 *    dialog loads kql-dashboard items.
 *  - lib/editors/phase3-editors.tsx:1125 — KQL Queryset "Set alert" dialog
 *    loads activator items.
 *
 * Both callers do `j?.items || j?.value` so we return `{ ok, items }`.
 *
 * Previously returned 404 HTML, which the editors silently parsed as an
 * empty array — meaning "Pin to dashboard" and "Set alert" dropdowns
 * were ALWAYS empty regardless of whether real items existed in Cosmos.
 *
 * For multi-type queries the established endpoint is
 * /api/items/by-type?type=A&type=B (or ?types=A,B). This route is a thin
 * shim for the single-type form.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listOwnedItems } from './_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  }
  const type = req.nextUrl.searchParams.get('type');
  if (!type) {
    return NextResponse.json(
      {
        ok: false,
        error: 'type query parameter is required',
        hint: 'For multi-type queries use /api/items/by-type?type=A&type=B',
      },
      { status: 400 },
    );
  }
  try {
    const items = await listOwnedItems(type, session.claims.oid);
    return NextResponse.json({ ok: true, items });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || 'cosmos_error', code: 'cosmos_error' },
      { status: 500 },
    );
  }
}
