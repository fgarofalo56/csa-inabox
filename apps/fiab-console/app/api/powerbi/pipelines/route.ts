/**
 * GET  /api/powerbi/pipelines              → list deployment pipelines (+ stages)
 * POST /api/powerbi/pipelines  { pipelineId, sourceStageOrder } → deployAll
 *
 * Power BI deployment pipelines = Dev/Test/Prod stage promotion. Real Power BI
 * REST via the Console UAMI; a 401/403 (SP not a pipeline admin / not authorized
 * for Power BI) is surfaced verbatim with the standard remediation hint. No mocks.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listPipelines, getPipelineStages, deployPipelineAll,
  PowerBiError, POWERBI_SP_HINT,
} from '@/lib/azure/powerbi-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function status(e: any): number { return e instanceof PowerBiError ? e.status : 502; }
function hint(s: number): string | undefined { return (s === 401 || s === 403) ? POWERBI_SP_HINT : undefined; }

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const pipelines = await listPipelines();
    // Attach stages per pipeline (best-effort; a stage read failure leaves []).
    const withStages = await Promise.all(
      pipelines.map(async (p) => ({ ...p, stages: await getPipelineStages(p.id).catch(() => []) })),
    );
    return NextResponse.json({ ok: true, pipelines: withStages });
  } catch (e: any) {
    const s = status(e);
    return NextResponse.json({ ok: false, error: e?.message || String(e), hint: hint(s) }, { status: s });
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({} as any));
  const pipelineId = String(body?.pipelineId || '').trim();
  const sourceStageOrder = Number(body?.sourceStageOrder);
  if (!pipelineId) return NextResponse.json({ ok: false, error: 'pipelineId required' }, { status: 400 });
  if (!Number.isInteger(sourceStageOrder)) return NextResponse.json({ ok: false, error: 'sourceStageOrder required' }, { status: 400 });
  try {
    await deployPipelineAll(pipelineId, sourceStageOrder, { note: 'Promoted via CSA Loom' });
    return NextResponse.json({ ok: true, message: `Deployment from stage ${sourceStageOrder} started.` });
  } catch (e: any) {
    const s = status(e);
    return NextResponse.json({ ok: false, error: e?.message || String(e), hint: hint(s) }, { status: s });
  }
}
