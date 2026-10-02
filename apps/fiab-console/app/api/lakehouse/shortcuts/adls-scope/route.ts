/**
 * GET /api/lakehouse/shortcuts/adls-scope?itemId=<lakehouse item id>
 *
 * The ADLS locations the shortcut wizard may offer for this lakehouse.
 * ADLS shortcuts and browse share one container scope
 * (app/api/lakehouse/_lib/adls-scope.ts): this deployment's lake containers and
 * the containers readable lakehouses in the item's workspace record. A tenant
 * admin may use any account (`unrestricted: true`), and the same list is then
 * offered as suggestions.
 *
 * Returns { ok: true, data: { unrestricted, locations: [{ account, container,
 * dfsHost, source, lakehouseName? }] } }. 400 `item_required` without
 * `itemId`; 404 when the caller cannot read the item; 503
 * `adls_scope_unverified` when the workspace lookup fails for a non-admin.
 *
 * Auth: session-required. Runtime: nodejs, force-dynamic.
 */
import { NextRequest, NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { resolveAdlsScope } from '../../_lib/adls-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withSession(async (req: NextRequest, { session }) => {
  const itemId = (req.nextUrl.searchParams.get('itemId') || '').trim();
  if (!itemId) {
    return NextResponse.json(
      { ok: false, code: 'item_required', error: 'itemId (the lakehouse item) is required.' },
      { status: 400 },
    );
  }
  const scope = await resolveAdlsScope(session, itemId);
  if (scope instanceof NextResponse) return scope;
  return NextResponse.json({ ok: true, data: { unrestricted: scope.unrestricted, locations: scope.locations } });
});
