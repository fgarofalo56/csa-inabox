/**
 * POST /api/foundry/chat — run a chat completion against a REAL deployed model.
 *
 * body: {
 *   deployment: string,                  // deployment name on the AOAI account
 *   messages: [{ role, content }, ...],   // OpenAI-style message thread
 *   temperature?, maxTokens?, topP?, stop?: string[]
 * }
 *
 * Calls the data-plane chat/completions endpoint of the resolved Cognitive
 * Services account. No streaming on the wire (the route returns the full
 * answer); the client renders it. If the deployment doesn't exist the upstream
 * returns DeploymentNotFound and we surface it as an honest gate.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  chatCompletion,
  type ChatMessage,
  CsError,
  CsNotConfiguredError,
} from '@/lib/azure/foundry-cs-client';
import { selectorFromBody } from '../_selector';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const body = await req.json();
    const deployment = String(body?.deployment || '').trim();
    if (!deployment) return NextResponse.json({ ok: false, error: 'deployment required' }, { status: 400 });
    const rawMessages = Array.isArray(body?.messages) ? body.messages : [];
    const messages: ChatMessage[] = rawMessages
      .filter((m: any) => m && typeof m.content === 'string' && ['system', 'user', 'assistant'].includes(m.role))
      .map((m: any) => ({ role: m.role, content: m.content }));
    if (!messages.some((m) => m.role === 'user')) {
      return NextResponse.json({ ok: false, error: 'at least one user message required' }, { status: 400 });
    }
    const result = await chatCompletion(deployment, messages, {
      temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
      maxTokens: typeof body.maxTokens === 'number' ? body.maxTokens : undefined,
      topP: typeof body.topP === 'number' ? body.topP : undefined,
      stop: Array.isArray(body.stop) ? body.stop.map(String).filter(Boolean) : undefined,
    }, selectorFromBody(body));
    return NextResponse.json({ ok: true, result });
  } catch (e: any) {
    if (e instanceof CsNotConfiguredError) {
      return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
    }
    if (e instanceof CsError) {
      // DeploymentNotFound (404) → honest gate: deploy a chat model first.
      const isMissing = e.status === 404 || /DeploymentNotFound|does not exist|not found/i.test(e.message);
      return NextResponse.json(
        {
          ok: false,
          error: e.message,
          notDeployed: isMissing,
          hint: isMissing
            ? 'No chat model is deployed under that name. Open the Model catalog tab, pick a chat-completion model (e.g. gpt-4o-mini) and Deploy it, then return here.'
            : undefined,
        },
        { status: e.status || 502 },
      );
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
