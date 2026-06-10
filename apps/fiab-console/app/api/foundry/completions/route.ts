/**
 * POST /api/foundry/completions — legacy text completion (non-chat).
 *   body: { deployment, prompt, maxTokens?, temperature?, topP?, stop?, account?, rg? }
 * AOAI: POST {endpoint}/openai/deployments/{deployment}/completions
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { textCompletion, CsError, CsNotConfiguredError } from '@/lib/azure/foundry-cs-client';
import { selectorFromBody } from '../_selector';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const body = await req.json();
    const deployment = String(body?.deployment || '').trim();
    const prompt = String(body?.prompt || '');
    if (!deployment) return NextResponse.json({ ok: false, error: 'deployment required' }, { status: 400 });
    if (!prompt.trim()) return NextResponse.json({ ok: false, error: 'prompt required' }, { status: 400 });
    const result = await textCompletion(deployment, prompt, {
      maxTokens: typeof body?.maxTokens === 'number' ? body.maxTokens : undefined,
      temperature: typeof body?.temperature === 'number' ? body.temperature : undefined,
      topP: typeof body?.topP === 'number' ? body.topP : undefined,
      stop: Array.isArray(body?.stop) ? body.stop.map(String).filter(Boolean) : undefined,
    }, selectorFromBody(body));
    return NextResponse.json({ ok: true, result });
  } catch (e: any) {
    if (e instanceof CsNotConfiguredError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
    const status = e instanceof CsError ? e.status : 502;
    const isMissing = status === 404 || /DeploymentNotFound|does not exist|OperationNotSupported/i.test(e?.message || '');
    return NextResponse.json({
      ok: false, error: e?.message || String(e), notDeployed: isMissing,
      hint: isMissing ? 'This deployment does not support the legacy completions endpoint. Deploy a completions-capable model (e.g. gpt-35-turbo-instruct) from the Model catalog tab.' : undefined,
    }, { status });
  }
}
