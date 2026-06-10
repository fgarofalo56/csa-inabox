/**
 * POST /api/foundry/reasoning — reasoning (o-series) chat completion.
 *   body: { deployment, messages, reasoningEffort?, maxCompletionTokens?, account?, rg? }
 * AOAI: POST {endpoint}/openai/deployments/{deployment}/chat/completions
 *   o-series models use reasoning_effort + max_completion_tokens (reject temperature).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { reasoningCompletion, type ChatMessage, CsError, CsNotConfiguredError } from '@/lib/azure/foundry-cs-client';
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
    const effort = ['low', 'medium', 'high'].includes(body?.reasoningEffort) ? body.reasoningEffort : undefined;
    const result = await reasoningCompletion(deployment, messages, {
      reasoningEffort: effort,
      maxCompletionTokens: typeof body?.maxCompletionTokens === 'number' ? body.maxCompletionTokens : undefined,
    }, selectorFromBody(body));
    return NextResponse.json({ ok: true, result });
  } catch (e: any) {
    if (e instanceof CsNotConfiguredError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
    const status = e instanceof CsError ? e.status : 502;
    const isMissing = status === 404 || /DeploymentNotFound|does not exist/i.test(e?.message || '');
    return NextResponse.json({
      ok: false, error: e?.message || String(e), notDeployed: isMissing,
      hint: isMissing ? 'No reasoning (o-series) model is deployed under that name. Deploy o1, o3, o4-mini or o1-mini from the Model catalog tab first.' : undefined,
    }, { status });
  }
}
