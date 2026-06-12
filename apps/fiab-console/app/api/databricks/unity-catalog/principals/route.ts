/**
 * Unity Catalog grant — principal directory picker (Catalog Explorer
 * Permissions tab autocompletes the principal field over the workspace's
 * users / groups / service principals).
 *
 *   GET /api/databricks/unity-catalog/principals?q=data   → { ok, principals }
 *
 * Real Databricks SCIM 2.0 REST:
 *   GET /api/2.0/preview/scim/v2/{Users,Groups,ServicePrincipals}?filter=…
 * Learn: https://learn.microsoft.com/azure/databricks/admin/users-groups/scim/
 *
 * The console UAMI needs workspace SCIM read access (member of the workspace,
 * or workspace/account admin). A SCIM 403 surfaces verbatim — no `return []`.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { databricksConfigGate, listUcPrincipals } from '@/lib/azure/databricks-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function gate() {
  const g = databricksConfigGate();
  if (g) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', error: `Databricks workspace not configured: set ${g.missing}.`, missing: g.missing },
      { status: 503 },
    );
  }
  return null;
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const q = req.nextUrl.searchParams.get('q')?.trim() || '';
  try {
    const principals = await listUcPrincipals(q);
    return NextResponse.json({ ok: true, principals });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
}
