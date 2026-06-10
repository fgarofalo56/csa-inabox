/**
 * POST /api/foundry/fine-tuning/cancel — cancel a running/queued fine-tuning job.
 *   body: { jobId, account?, rg? }
 * AOAI: POST {endpoint}/openai/v1/fine_tuning/jobs/{id}/cancel
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { cancelFineTuningJob, CsError, CsNotConfiguredError } from '@/lib/azure/foundry-cs-client';
import { selectorFromBody } from '../../_selector';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const body = await req.json();
    const jobId = String(body?.jobId || '').trim();
    if (!jobId) return NextResponse.json({ ok: false, error: 'jobId required' }, { status: 400 });
    const { job } = await cancelFineTuningJob(jobId, selectorFromBody(body));
    return NextResponse.json({ ok: true, job });
  } catch (e: any) {
    if (e instanceof CsNotConfiguredError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
    const status = e instanceof CsError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
