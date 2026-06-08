/**
 * /api/admin/security/dlp/violations
 *
 * GET ?top=50&since=<iso> → real per-item DLP violations via Graph
 *                            /v1.0/security/alerts_v2 (shaped per item).
 *
 * Parallel to the governance violations route; shares listDlpViolations().
 * Works in every cloud (alerts_v2 is GA on all Graph roots). Requires
 * LOOM_DLP_ENABLED=true + SecurityAlert.Read.All AppRole.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listDlpViolations } from '@/lib/azure/dlp-graph-client';
import { handleSecurityError } from '../../_lib/error-handling';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const top = Number(req.nextUrl.searchParams.get('top') || 50);
  const since = req.nextUrl.searchParams.get('since') || undefined;
  const policyId = req.nextUrl.searchParams.get('policyId') || undefined;
  try {
    const violations = await listDlpViolations({ top, sinceIso: since, policyId });
    return NextResponse.json({ ok: true, violations, count: violations.length });
  } catch (e) { return handleSecurityError(e); }
}
