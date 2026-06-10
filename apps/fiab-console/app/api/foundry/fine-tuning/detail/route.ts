/**
 * GET /api/foundry/fine-tuning/detail?jobId=<id>[&account=&rg=]
 *   Returns the job's event log + checkpoints for the job-detail drill-down.
 * AOAI:
 *   events      = GET {endpoint}/openai/v1/fine_tuning/jobs/{id}/events
 *   checkpoints = GET {endpoint}/openai/v1/fine_tuning/jobs/{id}/checkpoints
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  getFineTuningJobEvents,
  listFineTuningCheckpoints,
  CsError,
  CsNotConfiguredError,
} from '@/lib/azure/foundry-cs-client';
import { selectorFromQuery } from '../../_selector';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const jobId = req.nextUrl.searchParams.get('jobId')?.trim();
  if (!jobId) return NextResponse.json({ ok: false, error: 'jobId required' }, { status: 400 });
  const selector = selectorFromQuery(req);
  try {
    const [{ events }, { checkpoints }] = await Promise.all([
      getFineTuningJobEvents(jobId, selector),
      listFineTuningCheckpoints(jobId, selector).catch(() => ({ checkpoints: [] })),
    ]);
    return NextResponse.json({ ok: true, jobId, events, checkpoints });
  } catch (e: any) {
    if (e instanceof CsNotConfiguredError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
    const status = e instanceof CsError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
