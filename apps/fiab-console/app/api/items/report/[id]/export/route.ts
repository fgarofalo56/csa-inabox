/**
 * POST /api/items/report/[id]/export
 *
 * Body: { workspaceId: string, format?: string, paginated?: boolean,
 *         parameterValues?: { name, value }[] }
 * Returns: the exported file as a binary download (Content-Disposition: attachment),
 *          OR { ok: false, error } JSON on failure.
 *
 * Drives the Power BI async ExportTo job end-to-end against the REAL Power BI
 * REST API (groupId-scoped, per the PowerBIEntityNotFound fix):
 *   1. POST /groups/{ws}/reports/{id}/ExportTo
 *   2. poll GET /groups/{ws}/reports/{id}/exports/{exportId} until Succeeded
 *   3. GET  /groups/{ws}/reports/{id}/exports/{exportId}/file (binary)
 *
 * Standard Power BI reports support PDF / PPTX / PNG. Paginated reports (RDL)
 * render through the SSRS rendering engine and support a wider set (PDF / Word /
 * Excel / PowerPoint / CSV / XML / MHTML / image) — the request body must then
 * carry a `paginatedReportConfiguration` object (set via `paginated: true`).
 *
 * No mocks. Power BI errors (job Failed, 401/403, capacity required) surface
 * verbatim so the editor can show them in a MessageBar.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  startReportExport,
  startPaginatedReportExport,
  getReportExportStatus,
  getReportExportFile,
  PowerBiError,
  type ExportFormat,
  type PaginatedExportFormat,
} from '@/lib/azure/powerbi-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60; // export jobs are slow; allow up to a minute

const MIME: Record<ExportFormat, string> = {
  PDF: 'application/pdf',
  PPTX: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  PNG: 'image/png',
};

// Paginated reports (RDL) render through the SSRS rendering extensions and
// support a wider format set than standard Power BI reports.
const PAGINATED_MIME: Record<PaginatedExportFormat, string> = {
  PDF: 'application/pdf',
  DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  PPTX: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  CSV: 'text/csv',
  XML: 'application/xml',
  MHTML: 'multipart/related',
  IMAGE: 'image/tiff',
};

const PAGINATED_EXT: Record<PaginatedExportFormat, string> = {
  PDF: 'pdf', DOCX: 'docx', XLSX: 'xlsx', PPTX: 'pptx',
  CSV: 'csv', XML: 'xml', MHTML: 'mhtml', IMAGE: 'tiff',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const { id: reportId } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const workspaceId = (body?.workspaceId || '').toString().trim();
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });

  const paginated = body?.paginated === true;
  const parameterValues = Array.isArray(body?.parameterValues)
    ? body.parameterValues
        .filter((p: any) => p && typeof p.name === 'string')
        .map((p: any) => ({ name: String(p.name), value: String(p.value ?? '') }))
    : [];

  // Resolve the requested format against the per-kind allow-list + MIME map.
  const requested = String(body?.format || 'PDF').toUpperCase();
  const mime = paginated
    ? PAGINATED_MIME[requested as PaginatedExportFormat]
    : MIME[requested as ExportFormat];
  if (!mime) {
    const allowed = paginated ? Object.keys(PAGINATED_MIME) : Object.keys(MIME);
    return NextResponse.json(
      { ok: false, error: `unsupported export format "${requested}" — allowed: ${allowed.join(', ')}` },
      { status: 400 },
    );
  }
  const ext = paginated
    ? PAGINATED_EXT[requested as PaginatedExportFormat]
    : requested.toLowerCase();

  try {
    const job = paginated
      ? await startPaginatedReportExport(workspaceId, reportId, requested as PaginatedExportFormat, parameterValues)
      : await startReportExport(workspaceId, reportId, requested as ExportFormat);
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
    return new NextResponse(bytes, {
      status: 200,
      headers: {
        'content-type': mime,
        'content-disposition': `attachment; filename="report-${reportId}.${ext}"`,
        'cache-control': 'no-store',
      },
    });
  } catch (e: any) {
    const status = e instanceof PowerBiError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
