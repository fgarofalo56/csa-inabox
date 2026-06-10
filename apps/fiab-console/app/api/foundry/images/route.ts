/**
 * POST /api/foundry/images — generate images from a prompt (DALL-E / gpt-image).
 *   body: { deployment, prompt, n?, size?, quality?, style?, account?, rg? }
 * AOAI: POST {endpoint}/openai/deployments/{deployment}/images/generations
 *
 * Gov gate: image generation is not hosted in Azure US Government — short-circuit
 * with an honest message before any HTTP call.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { generateImage, govModalityGate, CsError, CsNotConfiguredError } from '@/lib/azure/foundry-cs-client';
import { selectorFromBody } from '../_selector';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const gate = govModalityGate('image');
  if (gate) return NextResponse.json({ ok: false, error: gate, notDeployed: true }, { status: 503 });
  try {
    const body = await req.json();
    const deployment = String(body?.deployment || '').trim();
    const prompt = String(body?.prompt || '').trim();
    if (!deployment) return NextResponse.json({ ok: false, error: 'deployment required' }, { status: 400 });
    if (!prompt) return NextResponse.json({ ok: false, error: 'prompt required' }, { status: 400 });
    const { images } = await generateImage(deployment, prompt, {
      n: typeof body?.n === 'number' ? body.n : undefined,
      size: typeof body?.size === 'string' ? body.size : undefined,
      quality: typeof body?.quality === 'string' ? body.quality : undefined,
      style: typeof body?.style === 'string' ? body.style : undefined,
    }, selectorFromBody(body));
    return NextResponse.json({ ok: true, images });
  } catch (e: any) {
    if (e instanceof CsNotConfiguredError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
    const status = e instanceof CsError ? e.status : 502;
    const isMissing = status === 404 || /DeploymentNotFound|does not exist/i.test(e?.message || '');
    return NextResponse.json({
      ok: false, error: e?.message || String(e), notDeployed: isMissing,
      hint: isMissing ? 'No image model is deployed under that name. Deploy a DALL-E 3 or gpt-image-1 model from the Model catalog tab first.' : undefined,
    }, { status });
  }
}
