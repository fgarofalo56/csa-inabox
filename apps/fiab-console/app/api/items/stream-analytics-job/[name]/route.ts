/**
 * GET /api/items/stream-analytics-job/[name]
 *   Detail for a single ASA job, including inputs, outputs and the
 *   current transformation (query). Real ARM call; honest gate on
 *   missing config.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getJob, AsaNotConfiguredError } from '@/lib/azure/stream-analytics-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HINT =
  'Provision an ASA job (bicep: platform/fiab/bicep/modules/landing-zone/stream-analytics.bicep, ' +
  'flag enableStreamAnalytics=true) and set LOOM_ASA_RG (and LOOM_ASA_SUB if different).';

export async function GET(_req: Request, ctx: { params: { name: string } }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const name = ctx.params?.name;
  if (!name) return NextResponse.json({ ok: false, error: 'name required' }, { status: 400 });
  try {
    const job = await getJob(name);
    return NextResponse.json({ ok: true, job });
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
