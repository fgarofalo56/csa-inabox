/**
 * GET /api/admin/tenant-settings/groups?ids=<comma-separated-objectIds>
 *
 * Bulk-resolves the Entra security-group object IDs stored in a toggle's
 * "Apply to" scope back into display names, so the tenant-settings page can
 * render the saved scope as group chips (not raw OIDs) on load.
 *
 * Real REST: Microsoft Graph POST /v1.0/directoryObjects/getByIds (types=group)
 * via the Console UAMI app-only token. When the identity picker is not wired,
 * returns 503 with the same honest-gate hint the picker renders.
 *
 * Responses:
 *   { ok: true, groups: IdentityHit[] }                 200
 *   { ok: false, error: 'not_configured', hint }        503
 *   { ok: false, error: 'graph_403', remediation, hint} 503
 *   { ok: false, error: 'graph_<N>', body }             502
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  getGroupsByIds,
  GraphIdentityNotConfiguredError,
  GraphIdentityError,
} from '@/lib/azure/graph-identity-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const raw = (req.nextUrl.searchParams.get('ids') || '').trim();
  const ids = raw ? raw.split(',').map((x) => x.trim()).filter(Boolean) : [];
  if (ids.length === 0) return NextResponse.json({ ok: true, groups: [] });

  try {
    const groups = await getGroupsByIds(ids);
    return NextResponse.json({ ok: true, groups });
  } catch (e: any) {
    if (e instanceof GraphIdentityNotConfiguredError) {
      return NextResponse.json(
        { ok: false, error: 'not_configured', message: e.message, hint: e.hint },
        { status: 503 },
      );
    }
    if (e instanceof GraphIdentityError) {
      if (e.status === 401 || e.status === 403) {
        return NextResponse.json(
          {
            ok: false,
            error: `graph_${e.status}`,
            remediation:
              'Console UAMI lacks Group.Read.All admin consent. Run ' +
              'scripts/csa-loom/grant-identity-graph-approles.sh, then a Tenant Admin grants admin consent.',
          },
          { status: 503 },
        );
      }
      return NextResponse.json(
        { ok: false, error: `graph_${e.status}`, body: typeof e.body === 'string' ? e.body.slice(0, 500) : e.message },
        { status: 502 },
      );
    }
    return NextResponse.json(
      { ok: false, error: 'unexpected', message: e?.message || String(e) },
      { status: 500 },
    );
  }
}
