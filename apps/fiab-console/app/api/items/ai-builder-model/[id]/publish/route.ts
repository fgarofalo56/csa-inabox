/**
 * POST /api/items/ai-builder-model/[id]/publish?envId=<env>
 *   Publishes/activates the trained model via msdyn_AIConfigurationActivate.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { publishAiBuilderModel, PowerPlatformError } from '@/lib/azure/powerplatform-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(e: any) {
  const status = e instanceof PowerPlatformError ? e.status : 502;
  return NextResponse.json(
    { ok: false, error: e?.message || String(e), hint: e?.hint, endpoint: e?.endpoint, body: e?.body },
    { status },
  );
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const envId = req.nextUrl.searchParams.get('envId') || (await req.json().catch(() => ({})))?.envId;
  if (!envId) return NextResponse.json({ ok: false, error: 'envId is required' }, { status: 400 });
  try {
    const r = await publishAiBuilderModel(String(envId), (await ctx.params).id);
    return NextResponse.json(r);
  } catch (e: any) { return err(e); }
}
