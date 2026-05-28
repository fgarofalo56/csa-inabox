/**
 * POST /api/items/stream-analytics-job/[name]/state
 *   Body: { action: 'start' | 'stop' }
 *   Real ARM POST against /streamingjobs/{name}/(start|stop). Returns 202
 *   from Azure; we surface as { ok: true } once accepted.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { startJob, stopJob, AsaNotConfiguredError } from '@/lib/azure/stream-analytics-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HINT =
  'Provision an ASA job (bicep: platform/fiab/bicep/modules/landing-zone/stream-analytics.bicep, ' +
  'flag enableStreamAnalytics=true) and set LOOM_ASA_RG (and LOOM_ASA_SUB if different).';

export async function POST(req: NextRequest, ctx: { params: { name: string } }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const name = ctx.params?.name;
  if (!name) return NextResponse.json({ ok: false, error: 'name required' }, { status: 400 });
  const body = await req.json().catch(() => null) as { action?: string } | null;
  if (!body || (body.action !== 'start' && body.action !== 'stop')) {
    return NextResponse.json(
      { ok: false, error: "body must be { action: 'start' | 'stop' }" },
      { status: 400 },
    );
  }
  try {
    if (body.action === 'start') await startJob(name);
    else await stopJob(name);
    return NextResponse.json({ ok: true, action: body.action });
  } catch (e: any) {
    if (e instanceof AsaNotConfiguredError) {
      return NextResponse.json({ ok: false, error: e.message, hint: HINT }, { status: 501 });
    }
    return NextResponse.json(
      { ok: false, error: e?.message || String(e), hint: HINT },
      { status: 502 },
    );
  }
}
