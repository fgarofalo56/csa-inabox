/**
 * POST /api/help-copilot/chat
 *
 * Body: { prompt: string, sessionId?: string }
 * Streams Server-Sent Events of HelpStep until completion.
 *
 * Returns 503 with { ok:false, error } if no AOAI deployment is wired
 * so the widget can surface a deep-link CTA (same UX as /api/copilot/orchestrate).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  resolveAoaiTarget,
  NoAoaiDeploymentError,
} from '@/lib/azure/copilot-orchestrator';
import { orchestrateHelp, newSessionId } from '@/lib/azure/help-copilot-orchestrator';
import { loadTenantCopilotConfig } from '@/lib/azure/copilot-config-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  }

  let body: {
    prompt?: string;
    sessionId?: string;
    context?: {
      path?: string;
      label?: string;
      itemType?: string;
      itemId?: string;
      tutorial?: { id: string; stepIndex: number; stepTitle?: string; stepBody?: string; totalSteps?: number };
      receiptScope?: { itemId?: string; itemType?: string; workspaceId?: string };
    };
  } = {};
  try { body = await req.json(); } catch {}
  const prompt = (body.prompt || '').trim();
  if (!prompt) {
    return NextResponse.json({ ok: false, error: 'prompt is required' }, { status: 400 });
  }
  const sessionId = body.sessionId || newSessionId();

  // Tenant admin-selected Copilot config (account + model deployments). The
  // help agent prefers helpAgentDeployment; resolveAoaiTarget falls back to env.
  const tenantConfig = await loadTenantCopilotConfig(session.claims.oid);
  const helpCfg = tenantConfig
    ? { ...tenantConfig, copilotChatDeployment: tenantConfig.helpAgentDeployment || tenantConfig.copilotChatDeployment }
    : null;

  // Pre-flight: surface AOAI-missing as 503 so the widget can deep-link.
  try {
    await resolveAoaiTarget(helpCfg);
  } catch (e: any) {
    if (e instanceof NoAoaiDeploymentError) {
      return NextResponse.json({ ok: false, error: e.message, gate: 'aoai' }, { status: 503 });
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }

  const userId = session.claims.oid || session.claims.upn || session.claims.email || 'unknown';

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      send('session', { sessionId });
      try {
        for await (const step of orchestrateHelp({ prompt, sessionId, userId, tenantConfig, pageContext: body.context })) {
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
