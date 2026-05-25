/**
 * GET /api/items/databricks-job/[id]/runs?jobId=123  → { ok, runs }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listJobRuns } from '@/lib/azure/databricks-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const jobIdStr = req.nextUrl.searchParams.get('jobId');
  const jobId = jobIdStr ? Number(jobIdStr) : undefined;
  if (jobIdStr && !Number.isFinite(jobId))
    return NextResponse.json({ ok: false, error: 'jobId must be numeric' }, { status: 400 });
  try {
    const runs = await listJobRuns(jobId, 25);
    return NextResponse.json({ ok: true, runs });
  } catch (e: any) {
    const status = e?.status === 403 ? 403 : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
