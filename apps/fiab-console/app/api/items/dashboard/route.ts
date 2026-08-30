/**
 * GET /api/items/dashboard?workspaceId=...
 * Lists Power BI dashboards in a workspace (the OPT-IN Power BI leg of the
 * dashboard editor; the Azure-native canvas does not depend on it).
 *
 * #3566 — WHY THE ERROR IS RESHAPED HERE. The editor renders whatever `error`
 * this route returns, verbatim, next to its "Power BI view" data source. It used
 * to receive the client's bare fallback — "powerbi GET /groups/<guid>/dashboards
 * failed" — with no status, no reason and no remediation, which is exactly the
 * shape `deploy-integrity.md` R7 exists to stop: it reads like a verdict while
 * establishing nothing. `powerbi-client.ts`'s `bareFailureMessage` now supplies
 * the reasoning for an EMPTY body; this route additionally guarantees the HTTP
 * STATUS reaches the surface even when Power BI DID return a body, because a
 * terse upstream message ("Unauthorized") is no more actionable than the old one
 * without it.
 */

import { NextRequest, NextResponse } from 'next/server';
import { listDashboards, PowerBiError } from '@/lib/azure/powerbi-client';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withSession(async (req: NextRequest) => {
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  try {
    const dashboards = await listDashboards(workspaceId);
    return NextResponse.json({ ok: true, workspaceId, dashboards });
  } catch (e: any) {
    const isPbi = e instanceof PowerBiError;
    const status = isPbi ? e.status : 502;
    const raw = (e?.message || String(e)).toString();
    // The status is prepended only when the message does not already carry it,
    // so the reasoned `bareFailureMessage` text is not double-stamped.
    const error = isPbi && !raw.includes(`HTTP ${status}`)
      ? `Power BI returned HTTP ${status} listing the dashboards in workspace ${workspaceId}: ${raw}`
      : raw;
    return NextResponse.json(
      {
        ok: false,
        error,
        // Structured alongside the prose so a surface can branch without
        // parsing English. `pbiStatus` is absent for a non-Power BI throw —
        // never defaulted to a number Loom did not observe (R7).
        ...(isPbi ? { pbiStatus: status } : {}),
      },
      { status },
    );
  }
});
