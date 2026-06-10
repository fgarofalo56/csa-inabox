/**
 * POST /api/foundry/images — generate images from a prompt against a deployed
 * image model (gpt-image-1 series).
 *   body: { deployment, prompt, n?, size?, quality?, style?, account?, rg? }
 *
 * Backend: POST {endpoint}/openai/deployments/{deployment}/images/generations.
 * Honest gate: DeploymentNotFound (404) → "deploy an image model first".
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { generateImage, CsError, CsNotConfiguredError } from '@/lib/azure/foundry-cs-client';
import { selectorFromBody } from '../_selector';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const body = await req.json();
    const deployment = String(body?.deployment || '').trim();
    const prompt = String(body?.prompt || '').trim();
    if (!deployment) return NextResponse.json({ ok: false, error: 'deployment required' }, { status: 400 });
    if (!prompt) return NextResponse.json({ ok: false, error: 'prompt required' }, { status: 400 });
    const result = await generateImage(deployment, prompt, {
      n: typeof body.n === 'number' ? body.n : undefined,
      size: typeof body.size === 'string' ? body.size : undefined,
      quality: typeof body.quality === 'string' ? body.quality : undefined,
      style: typeof body.style === 'string' ? body.style : undefined,
    }, selectorFromBody(body));
    return NextResponse.json({ ok: true, images: result.images });
  } catch (e: any) {
    if (e instanceof CsNotConfiguredError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
    if (e instanceof CsError) {
      const isMissing = e.status === 404 || /DeploymentNotFound|does not exist|not found/i.test(e.message);
      return NextResponse.json({
        ok: false,
        error: e.message,
        notDeployed: isMissing,
        hint: isMissing
          ? 'No image model is deployed under that name. Open the Model catalog tab, pick an image-generation model (e.g. gpt-image-1) and Deploy it, then return here.'
          : undefined,
      }, { status: e.status || 502 });
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
