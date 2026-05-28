/**
 * POST /api/items/power-automate-flow/[id]/run?envId=<env> — trigger manual run.
 * Body: { inputs?: {...} } — passed as triggerOutputs to the manual trigger.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { runFlow, PowerPlatformError } from '@/lib/azure/powerplatform-client';

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
  const envId = req.nextUrl.searchParams.get('envId');
  if (!envId) return NextResponse.json({ ok: false, error: 'envId query param required' }, { status: 400 });
  try {
    let body: any = {};
    try { body = await req.json(); } catch { /* empty body ok */ }
    const out = await runFlow(envId, (await ctx.params).id, body?.inputs);
    return NextResponse.json({ ok: true, runName: out.runName });
  } catch (e: any) { return err(e); }
}
