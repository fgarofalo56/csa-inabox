/**
 * /api/admin/security/dlp/alerts
 *
 * GET ?top=25&since=<iso> → recent DLP-source alerts via Graph
 *                            /v1.0/security/alerts_v2 filtered on
 *                            detectionSource = 'microsoftDataLossPrevention'.
 *
 * Requires SecurityAlert.Read.All AppRole.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listDlpAlerts } from '@/lib/azure/dlp-graph-client';
import { handleSecurityError } from '../../_lib/error-handling';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const top = Number(req.nextUrl.searchParams.get('top') || 25);
  const since = req.nextUrl.searchParams.get('since') || undefined;
  try {
    const alerts = await listDlpAlerts({ top, sinceIso: since });
    return NextResponse.json({ ok: true, alerts });
  } catch (e) { return handleSecurityError(e); }
}
