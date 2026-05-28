/**
 * /api/admin/security/dlp/policies
 *
 * GET                  → list Purview DLP policies (Graph /beta).
 * GET ?policyId=<id>   → list rules for a given policy.
 *
 * Requires LOOM_DLP_ENABLED=true + Policy.Read.All AppRole on the
 * Console UAMI.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listDlpPolicies, listDlpRules } from '@/lib/azure/dlp-graph-client';
import { handleSecurityError } from '../../_lib/error-handling';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const policyId = req.nextUrl.searchParams.get('policyId');
  try {
    if (policyId) {
      const rules = await listDlpRules(policyId);
      return NextResponse.json({ ok: true, policyId, rules });
    }
    const policies = await listDlpPolicies();
    return NextResponse.json({ ok: true, policies });
  } catch (e) { return handleSecurityError(e); }
}
