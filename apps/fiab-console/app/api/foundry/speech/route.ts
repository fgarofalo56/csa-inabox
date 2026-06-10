/**
 * POST /api/foundry/speech — text-to-speech with a TTS deployment.
 *   body: { deployment, input, voice?, responseFormat?, speed?, account?, rg? }
 * AOAI: POST {endpoint}/openai/deployments/{deployment}/audio/speech
 * Returns the binary audio stream (audio/mpeg etc.) on success, or JSON on error.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { synthesizeSpeech, CsError, CsNotConfiguredError } from '@/lib/azure/foundry-cs-client';
import { selectorFromBody } from '../_selector';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const body = await req.json();
    const deployment = String(body?.deployment || '').trim();
    const input = String(body?.input || '').trim();
    if (!deployment) return NextResponse.json({ ok: false, error: 'deployment required' }, { status: 400 });
    if (!input) return NextResponse.json({ ok: false, error: 'input text required' }, { status: 400 });
    const { audio, contentType } = await synthesizeSpeech(deployment, input, {
      voice: typeof body?.voice === 'string' ? body.voice : undefined,
      responseFormat: typeof body?.responseFormat === 'string' ? body.responseFormat : undefined,
      speed: typeof body?.speed === 'number' ? body.speed : undefined,
    }, selectorFromBody(body));
    return new NextResponse(new Uint8Array(audio), { status: 200, headers: { 'content-type': contentType, 'cache-control': 'no-store' } });
  } catch (e: any) {
    if (e instanceof CsNotConfiguredError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
    const status = e instanceof CsError ? e.status : 502;
    const isMissing = status === 404 || /DeploymentNotFound|does not exist/i.test(e?.message || '');
    return NextResponse.json({
      ok: false, error: e?.message || String(e), notDeployed: isMissing,
      hint: isMissing ? 'No TTS model is deployed under that name. Deploy a tts-1 or tts-1-hd model from the Model catalog tab first.' : undefined,
    }, { status });
  }
}
