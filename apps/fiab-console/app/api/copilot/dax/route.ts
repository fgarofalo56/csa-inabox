/**
 * POST /api/copilot/dax
 *
 * DAX-persona Copilot endpoint. Same SSE streaming shape as
 * /api/copilot/orchestrate, but scoped to the DAX persona: the DAX system
 * prompt + the `dax_*` / `loom_*` tool subset. Evaluation runs against the
 * Loom-native Synapse SQL backend — ZERO Power BI / Fabric REST calls on this
 * path (grep gate per no-fabric-dependency.md).
 *
 * Body: { prompt: string, sessionId?: string, itemId?: string, itemType?: string }
 * Stream: SSE OrchestratorStep events (kind: thought | tool_call | tool_result | final | error).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { enforceRateLimit } from '@/lib/azure/rate-limiter';
import {
  orchestrate,
  resolveAoaiTarget,
  NoAoaiDeploymentError,
} from '@/lib/azure/copilot-orchestrator';
import { loadTenantCopilotConfig } from '@/lib/azure/copilot-config-store';
import { DAX_PERSONA } from '@/lib/azure/copilot-personas-dax';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  }
  const limited = await enforceRateLimit(session, 'aoai');
  if (limited) return limited;

  let body: { prompt?: string; sessionId?: string; itemId?: string; itemType?: string } = {};
  try { body = await req.json(); } catch { /* empty body → validated below */ }
  const prompt = (body.prompt || '').trim();
  if (!prompt) {
    return NextResponse.json({ ok: false, error: 'prompt is required' }, { status: 400 });
  }
  const sessionId = body.sessionId || `dax-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Tenant admin-selected Copilot config (account + chat deployment); falls back
  // to env / Foundry-hub discovery inside resolveAoaiTarget.
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

  const userOid = session.claims.oid || session.claims.upn || session.claims.email || 'unknown';

  // Inject the active item context so the model can call dax_model_context /
  // dax_nl2measure with the right itemId/itemType without asking.
  const itemId = (body.itemId || '').trim();
  const itemType = (body.itemType || 'semantic-model').trim();
  const enrichedPrompt = itemId
    ? `[Active Loom model: itemId="${itemId}", itemType="${itemType}". Use these for any dax_* tool call.]\n\n${prompt}`
    : prompt;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      send('session', { sessionId });
      try {
        for await (const step of orchestrate({
          prompt: enrichedPrompt,
          sessionId,
          userOid,
          tenantConfig,
          personaSystemPrompt: DAX_PERSONA.systemPrompt,
          toolPrefixes: DAX_PERSONA.toolPrefixes,
          maxIterations: DAX_PERSONA.maxIterations,
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
