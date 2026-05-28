/**
 * POST /api/items/report/[id]/export
 *
 * Body: { workspaceId: string, format?: 'PDF' | 'PPTX' | 'PNG' }
 * Returns: the exported file as a binary download (Content-Disposition: attachment),
 *          OR { ok: false, error } JSON on failure.
 *
 * Drives the Power BI async ExportTo job end-to-end against the REAL Power BI
 * REST API (groupId-scoped, per the PowerBIEntityNotFound fix):
 *   1. POST /groups/{ws}/reports/{id}/ExportTo
 *   2. poll GET /groups/{ws}/reports/{id}/exports/{exportId} until Succeeded
 *   3. GET  /groups/{ws}/reports/{id}/exports/{exportId}/file (binary)
 *
 * No mocks. Power BI errors (job Failed, 401/403, capacity required) surface
 * verbatim so the editor can show them in a MessageBar.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  startReportExport,
  getReportExportStatus,
  getReportExportFile,
  PowerBiError,
  type ExportFormat,
} from '@/lib/azure/powerbi-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60; // export jobs are slow; allow up to a minute

const MIME: Record<ExportFormat, string> = {
  PDF: 'application/pdf',
  PPTX: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  PNG: 'image/png',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const { id: reportId } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const workspaceId = (body?.workspaceId || '').toString().trim();
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  const format: ExportFormat = (['PDF', 'PPTX', 'PNG'].includes(body?.format) ? body.format : 'PDF') as ExportFormat;

  try {
    const job = await startReportExport(workspaceId, reportId, format);
    let status = job.status;
    let exportId = job.id;

    // Poll until the job finishes (bounded by maxDuration). Power BI returns
    // 'Running' until the file is ready.
    const deadline = Date.now() + 55_000;
    while ((status === 'Running' || status === 'NotStarted') && Date.now() < deadline) {
      await sleep(2000);
      const s = await getReportExportStatus(workspaceId, reportId, exportId);
      status = s.status;
      exportId = s.id || exportId;
      if (status === 'Failed') {
        return NextResponse.json(
          { ok: false, error: s.error?.message || 'Power BI export job failed' },
          { status: 502 },
        );
      }
    }

    if (status !== 'Succeeded') {
      return NextResponse.json(
        { ok: false, error: `export still ${status} after timeout — retry, or export from Power BI Web for very large reports` },
        { status: 504 },
      );
    }

    const { bytes } = await getReportExportFile(workspaceId, reportId, exportId);
    const ext = format.toLowerCase();
    return new NextResponse(bytes, {
      status: 200,
      headers: {
        'content-type': MIME[format],
        'content-disposition': `attachment; filename="report-${reportId}.${ext}"`,
        'cache-control': 'no-store',
      },
    });
  } catch (e: any) {
    const status = e instanceof PowerBiError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
