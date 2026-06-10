/**
 * GET  /api/foundry/fine-tuning/[jobId]            — job detail + training events.
 * POST /api/foundry/fine-tuning/[jobId]            — cancel the job (body: { action:'cancel' }).
 *
 * Azure OpenAI fine-tuning data-plane:
 *   job    = GET  {endpoint}/openai/v1/fine_tuning/jobs/{id}
 *   events = GET  {endpoint}/openai/v1/fine_tuning/jobs/{id}/events
 *   cancel = POST {endpoint}/openai/v1/fine_tuning/jobs/{id}/cancel
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  getFineTuningJob,
  listFineTuningEvents,
  cancelFineTuningJob,
  CsError,
  CsNotConfiguredError,
} from '@/lib/azure/foundry-cs-client';
import { selectorFromQuery, selectorFromBody } from '../../_selector';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function fail(e: any) {
  if (e instanceof CsNotConfiguredError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
  const status = e instanceof CsError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body, notDeployed: status === 404 }, { status });
}

export async function GET(req: NextRequest, { params }: { params: { jobId: string } }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const jobId = decodeURIComponent(params.jobId);
  try {
    const selector = selectorFromQuery(req);
    const [job, { events }] = await Promise.all([
      getFineTuningJob(jobId, selector),
      listFineTuningEvents(jobId, selector).catch(() => ({ events: [] as any[] })),
    ]);
    return NextResponse.json({ ok: true, job, events });
  } catch (e: any) {
    return fail(e);
  }
}

export async function POST(req: NextRequest, { params }: { params: { jobId: string } }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const jobId = decodeURIComponent(params.jobId);
  try {
    const body = await req.json().catch(() => ({}));
    if (body?.action && body.action !== 'cancel') {
      return NextResponse.json({ ok: false, error: `unsupported action "${body.action}"` }, { status: 400 });
    }
    const job = await cancelFineTuningJob(jobId, selectorFromBody(body));
    return NextResponse.json({ ok: true, job });
  } catch (e: any) {
    return fail(e);
  }
}
