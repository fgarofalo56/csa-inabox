/**
 * POST /api/copilot/orchestrate
 *
 * Body: { prompt: string, sessionId?: string, contextSlug?: string,
 *         contextPayload?: { activeQuery?, schema?, workspaceId?, itemId?, … } }
 * Streams Server-Sent Events of OrchestratorStep until completion.
 *
 * `contextSlug` selects the per-pane persona (warehouse / notebook / lakehouse
 * / …) server-side via the persona registry; `contextPayload` carries the raw
 * editor state (active query, schema, workspace id) the persona's system prompt
 * is composed from. An unknown slug silently degrades to the cross-item
 * 'default' persona — never a 400.
 *
 * Returns 503 with { ok:false, error } if no AOAI deployment is wired
 * to the Foundry hub so the UI can surface a deep-link CTA.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  orchestrate,
  resolveAoaiTarget,
  NoAoaiDeploymentError,
} from '@/lib/azure/copilot-orchestrator';
import { VALID_CONTEXT_SLUGS, type PersonaContextPayload } from '@/lib/azure/copilot-personas';
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
    contextSlug?: string;
    contextPayload?: Record<string, unknown>;
  } = {};
  try { body = await req.json(); } catch {}
  const prompt = (body.prompt || '').trim();
  if (!prompt) {
    return NextResponse.json({ ok: false, error: 'prompt is required' }, { status: 400 });
  }
  const sessionId = body.sessionId || `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Resolve the pane persona slug. Validate against the registry; an unknown
  // slug degrades to 'default' (never 400 — safe degradation per the registry
  // contract). The contextPayload is passed through verbatim; the persona
  // template interpolates only its named fields server-side.
  const contextSlug =
    body.contextSlug && VALID_CONTEXT_SLUGS.has(body.contextSlug) ? body.contextSlug : 'default';
  const contextPayload: PersonaContextPayload =
    body.contextPayload && typeof body.contextPayload === 'object' ? body.contextPayload : {};

  // Tenant admin-selected Copilot config (account + chat deployment). Falls
  // back to env / Foundry-hub discovery inside resolveAoaiTarget.
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

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      send('session', { sessionId });
      try {
        for await (const step of orchestrate({ prompt, sessionId, userOid, tenantConfig, contextSlug, contextPayload })) {
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
