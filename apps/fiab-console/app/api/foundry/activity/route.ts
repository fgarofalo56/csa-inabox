/** GET /api/foundry/activity — ARM activity-log feed for the model-hosting account. */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listActivityLog, CsError, CsNotConfiguredError } from '@/lib/azure/foundry-cs-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const hours = Number(req.nextUrl.searchParams.get('hours')) || 24;
    const { account, events } = await listActivityLog(hours);
    return NextResponse.json({ ok: true, account: { name: account.name }, events });
  } catch (e: any) {
    if (e instanceof CsNotConfiguredError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
    const status = e instanceof CsError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
