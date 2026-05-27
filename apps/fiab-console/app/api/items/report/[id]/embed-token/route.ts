/**
 * POST /api/items/report/[id]/embed-token
 *
 * Body: { workspaceId: string, accessLevel?: 'View' | 'Edit' }
 * Returns: { ok, token, tokenId, expiration, embedUrl }
 *
 * Proxies the Power BI REST GenerateToken call using the Console UAMI.
 * The 401/403 from Power BI surfaces verbatim — no fake token, no mock.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { generateReportEmbedToken, getReport, PowerBiError } from '@/lib/azure/powerbi-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: { id: string } }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const workspaceId = (body?.workspaceId || '').toString().trim();
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  const accessLevel = body?.accessLevel === 'Edit' ? 'Edit' : 'View';
  try {
    const [tokenResp, report] = await Promise.all([
      generateReportEmbedToken(workspaceId, ctx.params.id, accessLevel),
      getReport(workspaceId, ctx.params.id),
    ]);
    return NextResponse.json({
      ok: true,
      ...tokenResp,
      embedUrl: report.embedUrl,
      reportId: report.id,
    });
  } catch (e: any) {
    const status = e instanceof PowerBiError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
