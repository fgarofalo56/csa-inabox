/**
 * POST /api/items/paginated-report/[id]/export
 *   body: {
 *     definition?: RdlReportDefinition,        // the in-memory authored report (preferred)
 *     workspaceId?: string,                    // fallback: load the saved definition
 *     format: 'pdf' | 'xlsx' | 'docx',
 *     parameterValues?: Array<{ name: string; value: string }>,
 *   }
 *
 * Renders a Loom-native paginated report (RDL) to a REAL binary document
 * (PDF / Excel / Word) by delegating to the `paginated-report-renderer` Azure
 * Function (`LOOM_PAGINATED_RENDER_URL`) and streams the bytes back with the
 * correct Content-Type + Content-Disposition.
 *
 * This is the export path. It is deliberately separate from `/render`, which
 * returns the on-screen JSON page-model (`RdlRenderResult`) and depends on
 * Synapse Serverless. Exporting through `/render` produced a JSON blob renamed
 * `.pdf`/`.xlsx`/`.docx` — the C1 audit bug. The binary exporter is
 * `renderReport()` in paginated-report-client.ts.
 *
 * Honest-gate (no-vaporware.md): export depends on the renderer Function, so the
 * gate guards `LOOM_PAGINATED_RENDER_URL` — its REAL dependency. When unset, the
 * route returns a structured 503 with a `hint` the designer renders as a precise
 * MessageBar (env var + bicep module) instead of downloading a broken file.
 *
 * Azure-native; no Microsoft Fabric / Power BI workspace required.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { enforceRateLimit } from '@/lib/azure/rate-limiter';
import {
  paginatedRenderGate,
  renderReport,
  getRdlDefinition,
  type RdlExportFormat,
  type RdlReportDefinition,
} from '@/lib/azure/paginated-report-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const FORMATS: RdlExportFormat[] = ['pdf', 'xlsx', 'docx'];

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const limited = await enforceRateLimit(session, 'export');
  if (limited) return limited;

  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({} as Record<string, unknown>));

  const format = String((body as any)?.format || '') as RdlExportFormat;
  if (!FORMATS.includes(format)) {
    return NextResponse.json({ ok: false, error: `format must be one of: ${FORMATS.join(', ')}` }, { status: 400 });
  }

  // Honest infra-gate: export needs the renderer Function. Authoring works
  // without it; export does not. Return a structured 503 the designer renders
  // as a precise MessageBar — NEVER a silently-broken download.
  const gate = paginatedRenderGate();
  if (gate) {
    return NextResponse.json(
      {
        ok: false,
        error: gate.detail,
        hint: {
          missingEnvVar: gate.missingEnvVar,
          bicepModule: 'azure-functions/paginated-report-renderer/deploy/main.bicep',
          bicepStatus: 'deploy the renderer Function, then set LOOM_PAGINATED_RENDER_URL on the Console',
          followUp: 'Authoring works without the renderer; only PDF / Excel / Word export is gated.',
        },
      },
      { status: 503 },
    );
  }

  // The authoritative report is the one the designer holds in memory (including
  // unsaved edits the user just authored); fall back to the saved definition by
  // workspace + id when the body doesn't carry it.
  let def = (body as any)?.definition as RdlReportDefinition | undefined;
  if (!def || typeof def !== 'object') {
    const workspaceId = typeof (body as any)?.workspaceId === 'string' ? (body as any).workspaceId.trim() : '';
    if (!workspaceId) {
      return NextResponse.json({ ok: false, error: 'definition or workspaceId is required' }, { status: 400 });
    }
    def = (await getRdlDefinition(workspaceId, id)) ?? undefined;
    if (!def) return NextResponse.json({ ok: false, error: 'report definition not found' }, { status: 404 });
  }

  const parameterValues = Array.isArray((body as any)?.parameterValues)
    ? ((body as any).parameterValues as Array<{ name: string; value: string }>)
    : [];

  try {
    const { bytes, mimeType, fileName } = await renderReport(def, format, parameterValues);
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'Content-Type': mimeType,
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Content-Length': String(bytes.length),
        'Cache-Control': 'no-store',
      },
    });
  } catch (e: any) {
    const status = typeof e?.status === 'number' ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
