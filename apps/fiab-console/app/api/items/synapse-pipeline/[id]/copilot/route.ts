/**
 * POST /api/items/synapse-pipeline/[id]/copilot — Pipeline Copilot (Synapse).
 *
 * Synapse Integrate sibling of the ADF pipeline Copilot route. Identical
 * orchestration; the persona registry targets the Synapse dev endpoint
 * (synapse-dev-client) instead of ADF ARM. See the ADF route for the full
 * contract (SSE `step` stream + `canvas_apply` event, bind-required gate,
 * honest 503 when no Azure OpenAI deployment is wired).
 *
 * Azure-native by default — no Microsoft Fabric / Power BI dependency.
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

const ITEM_TYPE = 'synapse-pipeline';
const BACKEND = 'synapse' as const;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const { id } = await ctx.params;

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
