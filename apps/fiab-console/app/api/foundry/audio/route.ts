/**
 * POST /api/foundry/audio — transcribe audio with a Whisper deployment.
 *   multipart/form-data: file=<audio>, deployment, language?, responseFormat?, account?, rg?
 * AOAI: POST {endpoint}/openai/deployments/{deployment}/audio/transcriptions
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { transcribeAudio, CsError, CsNotConfiguredError, type AccountSelector } from '@/lib/azure/foundry-cs-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const form = await req.formData();
    const file = form.get('file');
    const deployment = String(form.get('deployment') || '').trim();
    if (!(file instanceof File)) return NextResponse.json({ ok: false, error: 'file (audio) required' }, { status: 400 });
    if (!deployment) return NextResponse.json({ ok: false, error: 'deployment required' }, { status: 400 });
    const account = form.get('account');
    const rg = form.get('rg');
    const selector: AccountSelector | undefined = typeof account === 'string' && account.trim()
      ? { name: account.trim(), rg: typeof rg === 'string' && rg.trim() ? rg.trim() : undefined }
      : undefined;
    const buf = Buffer.from(await file.arrayBuffer());
    const { text } = await transcribeAudio(deployment, buf, file.name || 'audio.wav', {
      language: typeof form.get('language') === 'string' ? String(form.get('language')) || undefined : undefined,
      responseFormat: typeof form.get('responseFormat') === 'string' ? String(form.get('responseFormat')) || undefined : undefined,
    }, selector);
    return NextResponse.json({ ok: true, text });
  } catch (e: any) {
    if (e instanceof CsNotConfiguredError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
    const status = e instanceof CsError ? e.status : 502;
    const isMissing = status === 404 || /DeploymentNotFound|does not exist/i.test(e?.message || '');
    return NextResponse.json({
      ok: false, error: e?.message || String(e), notDeployed: isMissing,
      hint: isMissing ? 'No Whisper / audio model is deployed under that name. Deploy a whisper model from the Model catalog tab first.' : undefined,
    }, { status });
  }
}
