/**
 * POST /api/items/paginated-report/[id]/render
 *
 * Renders a Loom-native paginated report (RDL) — the Azure-native DEFAULT
 * backend (no Microsoft Fabric / Power BI workspace required).
 *
 * Body:
 *   {
 *     rdl?: string,                     // live import preview (overrides stored)
 *     params?: Record<string,string[]>, // { State: ['WA'] }
 *     page?: number,                    // 1-based page, default 1
 *     run?: boolean,                    // false → return param schema only
 *     workspaceId?: string,             // opt-in Power BI backend only
 *     reportId?: string, datasetId?: string,
 *   }
 *
 * RDL source precedence: body.rdl → item.state.rdlXml (Cosmos) → opt-in Power BI
 * (LOOM_PAGINATED_REPORT_BACKEND=powerbi|fabric + workspace/report). Datasets
 * execute against Synapse Serverless SQL by default, Azure Analysis Services for
 * `asazure://` sources, or Power BI executeQueries on the opt-in path.
 *
 * Returns RdlRenderResult JSON, or a structured honest gate ({ ok:false, error,
 * hint }) when no definition exists or the Azure backend isn't provisioned.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadKustoItem, KustoError } from '@/lib/azure/kusto-client';
import { renderPaginatedReport, RdlRenderError } from '@/lib/azure/paginated-report-renderer';
import { PowerBiError } from '@/lib/azure/powerbi-client';
import { AasError } from '@/lib/azure/aas-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const bodyRdl = typeof body?.rdl === 'string' ? body.rdl : '';
  const userParams = (body?.params && typeof body.params === 'object') ? (body.params as Record<string, string[]>) : {};
  const page = parseInt(String(body?.page ?? '1'), 10) || 1;
  const run = body?.run !== false;
  const workspaceId = typeof body?.workspaceId === 'string' ? body.workspaceId.trim() : '';
  const reportId = typeof body?.reportId === 'string' ? body.reportId.trim() : '';
  const datasetId = typeof body?.datasetId === 'string' ? body.datasetId.trim() : '';

  try {
    // Default Azure-native source: the Loom item's stored RDL definition.
    let storedRdl = '';
    let reportName = '';
    const item = await loadKustoItem(id, 'paginated-report', session.claims.oid);
    if (item) {
      storedRdl = typeof item.state?.rdlXml === 'string' ? item.state.rdlXml : '';
      reportName = item.displayName || '';
    }

    const result = await renderPaginatedReport({
      rdlXml: bodyRdl || storedRdl || undefined,
      source: bodyRdl ? 'import' : 'item',
      reportName,
      userParams,
      page,
      run,
      pbiWorkspaceId: workspaceId || undefined,
      pbiReportId: reportId || undefined,
      pbiDatasetId: datasetId || undefined,
    });
    return NextResponse.json(result);
  } catch (e: any) {
    if (e instanceof RdlRenderError) {
      return NextResponse.json({ ok: false, error: e.message, hint: e.hint }, { status: e.status });
    }
    if (e instanceof PowerBiError) {
      return NextResponse.json({ ok: false, error: e.message }, { status: e.status });
    }
    if (e instanceof AasError) {
      return NextResponse.json({ ok: false, error: e.message }, { status: e.status ?? 502 });
    }
    // Honest Azure infra gate (e.g. "Missing env var: LOOM_SYNAPSE_WORKSPACE").
    const msg = e?.message || String(e);
    if (/Missing env var/i.test(msg)) {
      return NextResponse.json({
        ok: false,
        error: msg,
        hint: 'The Azure-native renderer executes RDL datasets against Synapse Serverless SQL. '
          + 'Set LOOM_SYNAPSE_WORKSPACE (and deploy the Synapse workspace) to enable rendering.',
      }, { status: 409 });
    }
    const status = e instanceof KustoError ? e.status : 500;
    return NextResponse.json({ ok: false, error: msg }, { status });
  }
}
