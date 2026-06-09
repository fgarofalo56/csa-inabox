/**
 * GET /api/items/azure-sql-database/[id]/principal-search?q=<text>&kind=user|group
 *   → search Entra principals (users / groups) for the per-database Share
 *     dialog's principal picker.
 *
 * Auth: any authenticated Loom session. The real authorization boundary for the
 * Share action is enforced at ARM: granting a role still requires the Console
 * UAMI to hold the constrained RBAC-Admin role (see share/route.ts), which ARM
 * checks on the PUT. Principal search itself is read-only Graph lookup.
 *
 * Real REST: Microsoft Graph via the shared graph-principals helper (cloud
 * aware — Commercial / GCC-High / IL5). No mock principal list. When Graph
 * permissions aren't granted yet, returns the structured remediation payload.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { searchEntraPrincipals, GraphPrincipalsError, type PrincipalKind } from '@/lib/azure/graph-principals';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

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
