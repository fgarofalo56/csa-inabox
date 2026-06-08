/**
 * GET /api/data-products/[id]/principal-search?q=<text>&kind=user|group
 *   → search Entra principals (users + groups) for the data-product
 *     access-policy dialog's approver / access-provider pickers.
 *
 * Auth: the caller's session tenant must OWN the data product (verified via
 * loadOwnedItem). Unlike /api/admin/permissions/principals this route is NOT
 * gated on the platform-admin `admin.permissions::Contributor` capability —
 * a data-product owner who is not a Loom platform admin still needs to pick
 * approvers. Ownership of the product is the authorization boundary here.
 *
 * Real REST: Microsoft Graph via the shared graph-principals helper (cloud
 * aware — Commercial / GCC-High / IL5). No mock principal list. When Graph
 * permissions aren't granted yet, returns the structured remediation payload.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem } from '../../../items/_lib/item-crud';
import { searchEntraPrincipals, GraphPrincipalsError, type PrincipalKind } from '@/lib/azure/graph-principals';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'data-product';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const { id } = await ctx.params;
  const item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
  if (!item) return NextResponse.json({ ok: false, error: 'data-product not found' }, { status: 404 });

  const q = (req.nextUrl.searchParams.get('q') || '').trim();
  const kind: PrincipalKind = req.nextUrl.searchParams.get('kind') === 'group' ? 'group' : 'user';
  if (!q) return NextResponse.json({ ok: true, results: [] });

  try {
    const results = await searchEntraPrincipals(q, kind);
    return NextResponse.json({ ok: true, results });
  } catch (e: any) {
    if (e instanceof GraphPrincipalsError) {
      return NextResponse.json(
        { ok: false, error: e.message, remediation: e.remediation },
        { status: e.status },
      );
    }
    return NextResponse.json({ ok: false, error: e?.message || 'graph_search_failed' }, { status: 502 });
  }
}
