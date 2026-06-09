/**
 * POST /api/items/adf-pipeline/[id]/copilot — Pipeline Copilot (ADF).
 *
 * The streaming backend for the data-pipeline editor's Copilot pane. Drives the
 * pipeline persona (PIPELINE_COPILOT_SYSTEM_PROMPT + buildPipelineRegistry) over
 * the shared orchestrate() loop with a tight, ADF-scoped tool set:
 *   NL→pipeline (pipeline_generate), apply-to-canvas (pipeline_apply_canvas),
 *   run (pipeline_run), status (pipeline_get_run_status), summarize, and the
 *   error assistant (pipeline_explain_error). `/` source/dest completion is fed
 *   by the sibling GET .../connections route.
 *
 * SSE events: the standard orchestrator `step` stream PLUS a dedicated
 *   event: canvas_apply
 *   data: { spec, pipelineName, activityCount }
 * emitted when the model calls pipeline_apply_canvas — so the editor refreshes
 * the React-Flow canvas without a separate GET.
 *
 * Azure-native by default (no Microsoft Fabric / Power BI dependency): the
 * backend is the env-pinned ADF factory. Requires the item to be BOUND to a
 * real pipeline (resolveBinding) — 412 otherwise, the same gate the editor's
 * other actions use. Honest 503 when no Azure OpenAI deployment is wired.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  resolveAoaiTarget,
  orchestrate,
  NoAoaiDeploymentError,
} from '@/lib/azure/copilot-orchestrator';
import {
  buildPipelineRegistry,
  PIPELINE_COPILOT_SYSTEM_PROMPT,
} from '@/lib/azure/copilot-personas-pipeline';
import { resolveBinding, bindingErrorResponse } from '@/lib/azure/pipeline-binding';
import { loadTenantCopilotConfig } from '@/lib/azure/copilot-config-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'adf-pipeline';
const BACKEND = 'adf' as const;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const { id } = await ctx.params;

  // The copilot needs the real Azure pipeline name — bind required.
  let pipelineName: string;
  try {
    ({ pipelineName } = await resolveBinding(id, ITEM_TYPE, session.claims.oid));
  } catch (e) {
    const { status, body } = bindingErrorResponse(e);
    return NextResponse.json(body, { status });
  }

  let body: { prompt?: string; sessionId?: string } = {};
  try { body = (await req.json()) as typeof body; } catch { /* validated below */ }
  const prompt = String(body.prompt || '').trim();
  if (!prompt) return NextResponse.json({ ok: false, error: 'prompt required' }, { status: 400 });
  const sessionId = body.sessionId || `pip-${BACKEND}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Resolve Azure OpenAI — honest 503 gate when nothing is wired.
  const tenantConfig = await loadTenantCopilotConfig(session.claims.oid).catch(() => null);
  let aoaiTarget;
  try {
    aoaiTarget = await resolveAoaiTarget(tenantConfig);
  } catch (e: any) {
    if (e instanceof NoAoaiDeploymentError) {
      return NextResponse.json({ ok: false, code: 'no_aoai', error: e.message }, { status: 503 });
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }

  const registry = buildPipelineRegistry(BACKEND, pipelineName, aoaiTarget);
  const userOid = session.claims.oid;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      send('session', { sessionId, pipelineName });
      try {
        for await (const step of orchestrate({
          prompt,
          sessionId,
          userOid,
          tenantConfig,
          maxIterations: 8,
          registryOverride: registry,
          systemPromptOverride: PIPELINE_COPILOT_SYSTEM_PROMPT,
        })) {
          // Emit a dedicated canvas_apply event when the model pushes a spec.
          if (
            step.kind === 'tool_result' &&
            step.name === 'pipeline_apply_canvas' &&
            (step.result as any)?._action === 'apply_canvas'
          ) {
            const r = step.result as any;
            send('canvas_apply', { spec: r.spec, pipelineName: r.pipelineName, activityCount: r.activityCount });
          }
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
