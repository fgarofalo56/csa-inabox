/**
 * POST /api/items/report/[id]/refresh
 *
 * Body: { workspaceId: string }
 * Returns: { ok, datasetId } | { ok: false, error }
 *
 * A Power BI report has no data of its own — it renders a semantic model
 * (dataset). "Refresh" therefore resolves the report's datasetId and queues
 * a refresh of that dataset against the REAL Power BI REST API:
 *   GET  /groups/{ws}/reports/{id}            -> datasetId
 *   POST /groups/{ws}/datasets/{dsId}/refreshes
 *
 * groupId-scoped (per the PowerBIEntityNotFound fix). No mocks; Power BI
 * errors (no dataset, push dataset, capacity required) surface verbatim.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getReport, refreshDataset, PowerBiError } from '@/lib/azure/powerbi-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const { id: reportId } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const workspaceId = (body?.workspaceId || '').toString().trim();
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });

  try {
    const report = await getReport(workspaceId, reportId);
    if (!report.datasetId) {
      return NextResponse.json(
        { ok: false, error: 'report has no underlying dataset to refresh (e.g. a live-connection or RDL report)' },
        { status: 409 },
      );
    }
    await refreshDataset(workspaceId, report.datasetId);
    return NextResponse.json({ ok: true, datasetId: report.datasetId });
  } catch (e: any) {
    const status = e instanceof PowerBiError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
