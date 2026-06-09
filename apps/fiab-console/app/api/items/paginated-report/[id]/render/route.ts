/**
 * POST /api/items/paginated-report/[id]/render
 *   body: { workspaceId: string, format: 'pdf' | 'xlsx' | 'docx',
 *           parameterValues?: Array<{ name, value }> }
 *
 * Renders the Loom-native RDL definition (loaded from Cosmos) to a binary file
 * by delegating to the `paginated-report-renderer` Azure Function (ReportLab /
 * openpyxl / python-docx). Azure-native — NO Microsoft Fabric / Power BI
 * dependency.
 *
 * Honest-gate (no-vaporware.md): when LOOM_PAGINATED_RENDER_URL is unset the
 * route returns 503 + a NotConfiguredHint naming the env var + bicep module so
 * the editor can surface the exact remediation. Authoring is unaffected.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  getRdlDefinition,
  renderReport,
  paginatedRenderGate,
  type RdlExportFormat,
} from '@/lib/azure/paginated-report-client';
import type { NotConfiguredHint } from '@/lib/components/admin-security/not-configured-bar';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 55;

const FORMATS: RdlExportFormat[] = ['pdf', 'xlsx', 'docx'];

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;

  let body: { workspaceId?: string; format?: string; parameterValues?: Array<{ name: string; value: string }> };
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid json body' }, { status: 400 }); }

  const workspaceId = body.workspaceId;
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  const format = (body.format || 'pdf').toLowerCase() as RdlExportFormat;
  if (!FORMATS.includes(format)) {
    return NextResponse.json({ ok: false, error: `unsupported format '${format}' (pdf|xlsx|docx)` }, { status: 400 });
  }

  // Honest infra gate — renderer Function not deployed in this environment.
  const gate = paginatedRenderGate();
  if (gate) {
    const hint: NotConfiguredHint = {
      missingEnvVar: gate.missingEnvVar,
      bicepModule: 'azure-functions/paginated-report-renderer/deploy/main.bicep',
      bicepStatus:
        'optional module; deploy separately, then set LOOM_PAGINATED_RENDER_URL on the Console ' +
        '(admin-plane param loomPaginatedRenderUrl) to the output functionUrl',
      followUp:
        'az deployment group create -g <fn-rg> -f azure-functions/paginated-report-renderer/deploy/main.bicep ' +
        '-p loomCosmosEndpoint=... loomCosmosAccountName=...',
    };
    return NextResponse.json({ ok: false, error: gate.detail, hint }, { status: 503 });
  }

  let definition;
  try {
    definition = await getRdlDefinition(workspaceId, id);
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
  if (!definition) {
    return NextResponse.json({ ok: false, error: 'report not saved yet — Save the report before exporting' }, { status: 404 });
  }
  if (!definition.tablixes.length) {
    return NextResponse.json({ ok: false, error: 'report has no tablix to render — add a tablix first' }, { status: 400 });
  }

  try {
    const out = await renderReport(definition, format, body.parameterValues || []);
    return new NextResponse(out.bytes as any, {
      status: 200,
      headers: {
        'content-type': out.mimeType,
        'content-disposition': `attachment; filename="${out.fileName}"`,
        'cache-control': 'no-store',
      },
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
}
