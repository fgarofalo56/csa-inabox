/**
 * POST /api/foundry/assistants — create an assistant + a thread.
 *   body: { deployment, name?, instructions?, tools?: string[], account?, rg? }
 * AOAI Assistants (v2): POST /openai/assistants + POST /openai/threads
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { createAssistantAndThread, CsError, CsNotConfiguredError } from '@/lib/azure/foundry-cs-client';
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
    const tools = Array.isArray(body?.tools) ? body.tools.map(String).filter((t: string) => ['code_interpreter', 'file_search'].includes(t)) : [];
    const { assistantId, threadId } = await createAssistantAndThread({
      deployment,
      name: typeof body?.name === 'string' ? body.name : undefined,
      instructions: typeof body?.instructions === 'string' ? body.instructions : undefined,
      tools,
    }, selectorFromBody(body));
    return NextResponse.json({ ok: true, assistantId, threadId });
  } catch (e: any) {
    if (e instanceof CsNotConfiguredError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
    const status = e instanceof CsError ? e.status : 502;
    const isMissing = status === 404 || /DeploymentNotFound|does not exist|not found/i.test(e?.message || '');
    return NextResponse.json({
      ok: false, error: e?.message || String(e), notDeployed: isMissing,
      hint: isMissing ? 'No assistant-capable chat model is deployed. Deploy a gpt-4o / gpt-4o-mini model from the Model catalog tab.' : undefined,
    }, { status });
  }
}
