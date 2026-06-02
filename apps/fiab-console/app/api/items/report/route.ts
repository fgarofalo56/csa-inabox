/**
 * GET /api/items/report?workspaceId=...
 * Lists Power BI reports (excludes paginated).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listReports, PowerBiError } from '@/lib/azure/powerbi-client';
import { listContentBackedItems, reportListEntry } from '../_lib/pbi-content-fallback';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  // Bundle-installed reports carry their pages/visuals in state.content but
  // have no live Power BI report yet. Surface them so the editor's Pages panel
  // renders the bundle definition rather than opening empty. `loom:` id →
  // detail + pages routes serve from state.content.
  const loomEntries = (await listContentBackedItems('report', 'report', session.claims.oid))
    .map(reportListEntry);
  try {
    const all = await listReports(workspaceId);
    const reports = all.filter((r) => r.reportType !== 'PaginatedReport');
    return NextResponse.json({ ok: true, workspaceId, reports: [...loomEntries, ...reports] });
  } catch (e: any) {
    if (loomEntries.length > 0) {
      return NextResponse.json({ ok: true, workspaceId, reports: loomEntries });
    }
    const status = e instanceof PowerBiError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
