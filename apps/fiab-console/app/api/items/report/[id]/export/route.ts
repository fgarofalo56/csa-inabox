/**
 * POST /api/items/report/[id]/export
 *
 * Exports a report to a real downloadable file. THREE paths, dispatched by the
 * request body — Azure-native is the DEFAULT, Power BI is strictly opt-in
 * (no-fabric-dependency.md), and the always-on client print path needs no infra
 * at all:
 *
 *   1. **Azure-native loom-native renderer (DEFAULT)** — `mode:'loom-native'`
 *      (or any request with NO `workspaceId`). Builds/accepts a self-contained
 *      HTML snapshot of the report (pages + visuals, rendered from each visual's
 *      last REAL `/query` rows) and POSTs it to the headless renderer configured
 *      via `LOOM_REPORT_RENDERER`, requesting `format` (PDF / PPTX / PNG) and
 *      `scope` (all | current). The renderer returns the real bytes, streamed
 *      back as an attachment with the correct MIME. NO Fabric / Power BI host is
 *      ever contacted on this branch. When `LOOM_REPORT_RENDERER` is unset the
 *      route returns an honest `412 { ok:false, code:'no-renderer', error }`
 *      naming the env var + the bicep module that would provision it
 *      (no-vaporware.md) — the editor's always-on client "Print / Save as PDF"
 *      and "PNG (current page)" paths still produce a file with zero infra.
 *
 *   2. **Power BI ExportTo (opt-in)** — any request carrying a `workspaceId`
 *      WITHOUT `mode:'loom-native'`. Drives the Power BI async ExportTo job
 *      end-to-end against the REAL Power BI REST API (groupId-scoped, per the
 *      PowerBIEntityNotFound fix):
 *        a. POST /groups/{ws}/reports/{id}/ExportTo
 *        b. poll GET /groups/{ws}/reports/{id}/exports/{exportId} until Succeeded
 *        c. GET  /groups/{ws}/reports/{id}/exports/{exportId}/file (binary)
 *      Standard reports support PDF / PPTX / PNG. Paginated reports (RDL) render
 *      through the SSRS engine and support a wider set (PDF / Word / Excel /
 *      PowerPoint / CSV / XML / MHTML / image) — the request then carries a
 *      `paginatedReportConfiguration` (set via `paginated: true`). This path is
 *      reached ONLY when a Power BI workspace is explicitly bound — never the
 *      default (no-fabric-dependency.md).
 *
 *   3. **Client Print / Save as PDF + PNG (no route, no infra)** — lives in the
 *      editor (`lib/editors/report/export-report.tsx`); listed here for the full
 *      picture. It rasterizes the live canvas / static print HTML in the browser
 *      so the high-fidelity items above are never the only way to get a file.
 *
 * No mocks. Power BI errors (job Failed, 401/403, capacity required) and renderer
 * errors surface verbatim so the editor can show them in a MessageBar.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { fetchWithTimeout, FetchTimeoutError } from '@/lib/azure/fetch-with-timeout';
import {
  startReportExport,
  startPaginatedReportExport,
  getReportExportStatus,
  getReportExportFile,
  PowerBiError,
  type ExportFormat,
  type PaginatedExportFormat,
} from '@/lib/azure/powerbi-client';
import { applySensitivityStamp } from '@/lib/azure/report-export-label';

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

// ── Azure-native loom-native renderer branch ─────────────────────────────────

/** Filename-safe extension for a loom-native format. */
const LOOM_EXT: Record<ExportFormat, string> = { PDF: 'pdf', PPTX: 'pptx', PNG: 'png' };

/** HTML-escape a value for safe interpolation into the fallback snapshot. */
function escHtml(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The self-contained HTML the renderer rasterizes. Prefer the client-built
 * snapshot (`body.html` from the designer's `buildReportPrintHtml`, themed +
 * fed by each visual's last real `/query` rows). When the caller didn't ship
 * one, synthesize a minimal-but-valid document from any structured
 * `pages`/`rowsByVisual` it did send (real rows → small tables), so the renderer
 * always receives a real, self-contained page — never an empty body. NO Fabric /
 * Power BI data is fetched here; the rows are the Synapse/AAS results the client
 * already holds (no-fabric-dependency.md, no-vaporware.md).
 */
function resolveSnapshotHtml(body: any, reportId: string, scope: 'all' | 'current'): string {
  if (typeof body?.html === 'string' && body.html.trim()) return body.html;

  const reportName = String(body?.reportName || `Report ${reportId}`);
  const rowsByVisual: Record<string, Array<Record<string, unknown>>> =
    body?.rowsByVisual && typeof body.rowsByVisual === 'object' ? body.rowsByVisual : {};
  const allPages: Array<{ id?: string; name?: string; visuals?: Array<{ id?: string; type?: string; title?: string; hidden?: boolean }> }> =
    Array.isArray(body?.pages) ? body.pages : [];
  const currentPageId = body?.currentPageId ? String(body.currentPageId) : undefined;
  const pages = scope === 'current' && currentPageId
    ? (allPages.filter((p) => p?.id === currentPageId).length ? allPages.filter((p) => p?.id === currentPageId) : allPages)
    : allPages;

  const tableHtml = (rows: Array<Record<string, unknown>>): string => {
    if (!Array.isArray(rows) || rows.length === 0) return '<div class="e">No rows.</div>';
    const cols = Object.keys(rows[0]);
    const head = cols.map((c) => `<th>${escHtml(c)}</th>`).join('');
    const bodyRows = rows.slice(0, 30).map((r) =>
      `<tr>${cols.map((c) => `<td>${escHtml(r[c])}</td>`).join('')}</tr>`).join('');
    return `<table><thead><tr>${head}</tr></thead><tbody>${bodyRows}</tbody></table>`;
  };

  const pagesHtml = (pages.length ? pages : [{ name: reportName, visuals: [] }]).map((p) => {
    const visuals = (p.visuals || []).filter((v) => v && !v.hidden);
    const cards = visuals.length
      ? visuals.map((v) =>
          `<section class="v"><h3>${escHtml(v.title || v.type || 'Visual')}</h3>${tableHtml(rowsByVisual[String(v.id)] || [])}</section>`).join('')
      : '<div class="e">This page has no visible visuals.</div>';
    return `<div class="pg"><p class="rh">${escHtml(reportName)}</p><h2>${escHtml(p.name || 'Page')}</h2>${cards}</div>`;
  }).join('');

  const css =
    '.doc{font-family:Segoe UI,system-ui,-apple-system,sans-serif;color:#242424;background:#fff}' +
    '.pg{padding:24px;page-break-after:always}.pg:last-child{page-break-after:auto}' +
    '.rh{font-size:12px;opacity:.6;margin:0 0 4px}h2{font-size:20px;margin:0 0 16px}' +
    '.v{border:1px solid rgba(128,128,128,.25);border-radius:8px;padding:12px;margin:0 0 12px}' +
    '.v h3{font-size:13px;margin:0 0 8px}table{width:100%;border-collapse:collapse;font-size:11px}' +
    'th,td{border:1px solid rgba(128,128,128,.2);padding:4px 6px;text-align:left}.e{font-size:12px;opacity:.6}' +
    '@page{margin:12mm}';
  return `<style>${css}</style><div class="doc">${pagesHtml}</div>`;
}

/**
 * Render the report to real bytes through the configured headless renderer
 * (`LOOM_REPORT_RENDERER`), mirroring the paginated-report-renderer delegation:
 * POST the HTML snapshot to `${base}/api/render` with the optional Function host
 * key (`LOOM_REPORT_RENDER_KEY`) appended as `?code=…`. Returns an honest 412
 * gate when the renderer isn't deployed; surfaces renderer errors verbatim.
 */
async function exportLoomNative(
  req: NextRequest,
  reportId: string,
  body: any,
  session: NonNullable<ReturnType<typeof getSession>>,
): Promise<NextResponse> {
  const requested = String(body?.format || 'PDF').toUpperCase() as ExportFormat;
  const mime = MIME[requested];
  if (!mime) {
    return NextResponse.json(
      { ok: false, error: `unsupported export format "${requested}" — allowed: ${Object.keys(MIME).join(', ')}` },
      { status: 400 },
    );
  }
  const scope: 'all' | 'current' = body?.scope === 'current' ? 'current' : 'all';

  // Honest infra-gate (no-vaporware.md): the high-fidelity renderer is optional.
  // Authoring + the client Print / PNG paths still work without it.
  const base = (process.env.LOOM_REPORT_RENDERER || '').trim();
  if (!base) {
    return NextResponse.json(
      {
        ok: false,
        code: 'no-renderer',
        error:
          'High-fidelity report export renderer is not deployed in this environment. ' +
          'Use the editor’s Print / Save as PDF (or PNG of the current page) for a ' +
          'no-setup file, OR deploy the headless report renderer and set ' +
          'LOOM_REPORT_RENDERER to its base URL. The renderer is the ' +
          'azure-functions/paginated-report-renderer Function (deploy/main.bicep) ' +
          'wired through platform/fiab/bicep/modules/admin-plane/main.bicep ' +
          '(param loomPaginatedRenderUrl → env LOOM_REPORT_RENDERER).',
      },
      { status: 412 },
    );
  }

  const html = resolveSnapshotHtml(body, reportId, scope);
  const key = (process.env.LOOM_REPORT_RENDER_KEY || '').trim();
  const url = new URL('/api/render', base.replace(/\/$/, ''));
  if (key) url.searchParams.set('code', key);

  try {
    // Rendering is slower than a metadata call but must stay under maxDuration.
    const res = await fetchWithTimeout(
      url.toString(),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ html, format: requested, scope, reportId }),
      },
      55_000,
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return NextResponse.json(
        { ok: false, error: `report renderer returned HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}` },
        { status: 502 },
      );
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    const stamped = await applySensitivityStamp(session, reportId, bytes, LOOM_EXT[requested]);
    if (stamped.blocked) return NextResponse.json({ ok: false, error: stamped.blocked }, { status: 403 });
    return new NextResponse(stamped.bytes, {
      status: 200,
      headers: {
        'content-type': mime,
        'content-disposition': `attachment; filename="report-${reportId}.${LOOM_EXT[requested]}"`,
        'cache-control': 'no-store',
      },
    });
  } catch (e: any) {
    if (e instanceof FetchTimeoutError) {
      return NextResponse.json(
        { ok: false, error: 'report renderer timed out — retry, or use Print / Save as PDF for a no-setup file' },
        { status: 504 },
      );
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const { id: reportId } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const workspaceId = (body?.workspaceId || '').toString().trim();
  const mode = String(body?.mode || '').toLowerCase();

  // Dispatch: Azure-native renderer is the DEFAULT (explicit mode, or no bound
  // Power BI workspace). The Power BI ExportTo path is reached ONLY when a
  // workspace is explicitly bound (no-fabric-dependency.md).
  if (mode === 'loom-native' || !workspaceId) {
    return exportLoomNative(req, reportId, body, session);
  }

  // ── Power BI ExportTo (opt-in) ──────────────────────────────────────────────
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
    const stamped = await applySensitivityStamp(session, reportId, Buffer.from(bytes), ext);
    if (stamped.blocked) return NextResponse.json({ ok: false, error: stamped.blocked }, { status: 403 });
    return new NextResponse(stamped.bytes, {
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
