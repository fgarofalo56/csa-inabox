/**
 * Fine-tuning job — events sub-route (WS-1.3).
 *   GET /api/items/fine-tuning-job/[id]/events?job=<jobId>
 * Returns the real AOAI fine-tuning job events (status transitions + per-step
 * training/validation loss) for the training-progress panel.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getJobEvents, CsError } from '@/lib/azure/fine-tuning-client';
import { resolveFineTuningItem, fineTuningItemErrorResponse } from '@/lib/azure/fine-tuning-item';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  try {
    await resolveFineTuningItem(id, session.claims.oid);
  } catch (e) {
    const { status, body } = fineTuningItemErrorResponse(e);
    return NextResponse.json(body, { status });
  }
  const jobId = req.nextUrl.searchParams.get('job')?.trim();
  if (!jobId) return NextResponse.json({ ok: false, error: 'job query param is required' }, { status: 400 });
  try {
    const events = await getJobEvents(jobId);
    return NextResponse.json({ ok: true, events });
  } catch (e: any) {
    const status = e instanceof CsError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
