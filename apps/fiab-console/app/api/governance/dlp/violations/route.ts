/**
 * GET /api/governance/dlp/violations
 *
 * Real per-item DLP violations via Microsoft Graph
 * (/v1.0/security/alerts_v2 shaped per item). Works in every cloud
 * (Commercial / GCC / GCC-High / IL5) — alerts_v2 is GA on all Graph roots.
 *
 * Query: ?top=50&since=<iso>&policyId=<id>
 *
 * On success the route stamps `lastScannedAt` into the per-tenant dlp-meta
 * doc so the UI can show when violations were last refreshed. If DLP isn't
 * enabled (LOOM_DLP_ENABLED), returns a structured 503 with remediation.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listDlpViolations } from '@/lib/azure/dlp-graph-client';
import { graphDlpPolicyApiAvailable, cloudBoundaryLabel } from '@/lib/azure/cloud-endpoints';
import { handleSecurityError } from '../../../admin/security/_lib/error-handling';
import { stampLastScanned } from '../_lib/meta';

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
    let lastScannedAt: string | undefined;
    try { lastScannedAt = await stampLastScanned(s.claims.oid); } catch { /* meta best-effort */ }
    return NextResponse.json({
      ok: true,
      violations,
      count: violations.length,
      lastScannedAt,
      boundary: cloudBoundaryLabel(),
      dlpPolicyApiAvailable: graphDlpPolicyApiAvailable(),
    });
  } catch (e) { return handleSecurityError(e); }
}
