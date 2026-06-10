/**
 * POST /api/foundry/audio — transcribe an audio file against a deployed Whisper
 * (audio-transcription) model.
 *
 * Accepts multipart/form-data: `file` (audio blob), `deployment`, optional
 * `account` / `rg`. Backend:
 *   POST {endpoint}/openai/deployments/{deployment}/audio/transcriptions.
 * Honest gate: DeploymentNotFound (404) → "deploy a Whisper model first".
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
    const deployment = String(form.get('deployment') || '').trim();
    const file = form.get('file');
    if (!deployment) return NextResponse.json({ ok: false, error: 'deployment required' }, { status: 400 });
    if (!(file instanceof Blob)) return NextResponse.json({ ok: false, error: 'a multipart `file` (audio) field is required' }, { status: 400 });
    const fileName = (file as File).name || 'audio.wav';

    const account = form.get('account');
    const rg = form.get('rg');
    const selector: AccountSelector | undefined = typeof account === 'string' && account.trim()
      ? { name: account.trim(), rg: typeof rg === 'string' && rg.trim() ? rg.trim() : undefined }
      : undefined;

    const result = await transcribeAudio(deployment, file, fileName, selector);
    return NextResponse.json({ ok: true, text: result.text });
  } catch (e: any) {
    if (e instanceof CsNotConfiguredError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
    if (e instanceof CsError) {
      const isMissing = e.status === 404 || /DeploymentNotFound|does not exist|not found/i.test(e.message);
      return NextResponse.json({
        ok: false,
        error: e.message,
        notDeployed: isMissing,
        hint: isMissing
          ? 'No audio model is deployed under that name. Open the Model catalog tab, pick a Whisper model and Deploy it, then return here.'
          : undefined,
      }, { status: e.status || 502 });
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
