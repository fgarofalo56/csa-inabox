/**
 * POST /api/items/report/copilot
 *
 * Report Copilot — narrative-summary + suggest-visuals, scoped to ONE report
 * item and grounded on its bound CSA Loom tabular semantic model (Synapse
 * Dedicated SQL pool). Streams Server-Sent Events of OrchestratorStep.
 *
 * Body: { prompt: string, reportId?: string, sessionId?: string }
 *   - reportId: the Loom Cosmos item id of the report being edited (optional;
 *     used only to enrich the grounding context — the tools query Synapse
 *     directly so a brand-new report works too).
 *
 * No Power BI / Microsoft Fabric dependency (no-fabric-dependency.md): the
 * narrative comes from AOAI + Synapse only.
 *
 * Returns 503 with { ok:false, error } when no AOAI deployment is wired so the
 * editor can surface a deep-link CTA.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  orchestrate,
  resolveAoaiTarget,
  NoAoaiDeploymentError,
  LoomToolRegistry,
} from '@/lib/azure/copilot-orchestrator';
import { loadTenantCopilotConfig } from '@/lib/azure/copilot-config-store';
import { buildReportTools } from '@/lib/copilot/report-tools';
import { REPORT_COPILOT_PERSONA } from '@/lib/azure/copilot-personas';
import {
  isLoomContentId, cosmosIdFromLoomId, loadContentBackedItem,
} from '../../_lib/pbi-content-fallback';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  let body: { prompt?: string; reportId?: string; sessionId?: string } = {};
  try { body = await req.json(); } catch {}
  const prompt = (body.prompt || '').trim();
  const reportId = (body.reportId || '').trim();
  if (!prompt) return NextResponse.json({ ok: false, error: 'prompt is required' }, { status: 400 });

  const tenantConfig = await loadTenantCopilotConfig(session.claims.oid);

  // Pre-flight: surface AOAI-missing as 503 so the editor can deep-link.
  try {
    await resolveAoaiTarget(tenantConfig);
  } catch (e: any) {
    if (e instanceof NoAoaiDeploymentError) {
      return NextResponse.json({ ok: false, error: e.message }, { status: 503 });
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }

  // Best-effort load of the bound report item for grounding context. Never
  // blocks the run — a brand-new report (no content) still works because the
  // tools query Synapse directly.
  let boundItem = null;
  if (reportId) {
    const cosmosId = isLoomContentId(reportId) ? cosmosIdFromLoomId(reportId) : reportId;
    boundItem = await loadContentBackedItem(cosmosId, 'report', session.claims.oid).catch(() => null);
  }

  // Persona-scoped registry — exactly the two report tools, nothing else.
  const reg = new LoomToolRegistry();
  for (const t of buildReportTools(boundItem)) reg.register(t);

  const sessionId = body.sessionId || `report-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const userOid = session.claims.oid || session.claims.upn || session.claims.email || 'unknown';

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      send('session', { sessionId });
      try {
        for await (const step of orchestrate({
          prompt,
          sessionId,
          userOid,
          tenantConfig,
          systemPrompt: REPORT_COPILOT_PERSONA.systemPrompt,
          registry: reg,
        })) {
          send('step', step);
          if (step.kind === 'final' || step.kind === 'error') break;
        }
      } catch (e: any) {
        send('step', { kind: 'error', error: e?.message || String(e) });
      } finally {
        send('done', { sessionId });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
