/**
 * GET  /api/items/content-safety — list policies (env-gated)
 * POST /api/items/content-safety — moderate text/image
 *   body: { kind: 'text', text, categories? } OR { kind: 'image', imageBase64 }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listContentSafetyPolicies, moderateText, moderateImage, FoundryError, NotDeployedError } from '@/lib/azure/foundry-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(e: any) {
  if (e instanceof NotDeployedError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
  const status = e instanceof FoundryError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
}

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const policies = await listContentSafetyPolicies();
    return NextResponse.json({ ok: true, policies });
  } catch (e: any) { return err(e); }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const body = await req.json();
    if (body?.kind === 'text') {
      if (!body?.text) return NextResponse.json({ ok: false, error: 'text required' }, { status: 400 });
      const result = await moderateText(body.text, body.categories);
      return NextResponse.json({ ok: true, kind: 'text', result });
    }
    if (body?.kind === 'image') {
      if (!body?.imageBase64) return NextResponse.json({ ok: false, error: 'imageBase64 required' }, { status: 400 });
      const result = await moderateImage(body.imageBase64);
      return NextResponse.json({ ok: true, kind: 'image', result });
    }
    return NextResponse.json({ ok: false, error: "kind must be 'text' or 'image'" }, { status: 400 });
  } catch (e: any) { return err(e); }
}
