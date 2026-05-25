/**
 * GET /api/items/tracing?hours=24&operation=<name> — App Insights traces
 * bound to the Foundry hub workspace.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { queryTraces, FoundryError, NotDeployedError } from '@/lib/azure/foundry-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const hours = Number(req.nextUrl.searchParams.get('hours')) || 24;
  const operation = req.nextUrl.searchParams.get('operation') || undefined;
  try {
    const traces = await queryTraces({ hours, operation });
    return NextResponse.json({ ok: true, traces, hours, operation });
  } catch (e: any) {
    if (e instanceof NotDeployedError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
    const status = e instanceof FoundryError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
