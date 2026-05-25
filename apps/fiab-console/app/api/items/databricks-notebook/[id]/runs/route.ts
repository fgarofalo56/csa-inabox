/**
 * GET /api/items/databricks-notebook/[id]/runs?runId=12345
 *   (runId set) → { ok, run, output }    — single run with cell output
 *   (no runId)  → { ok, runs }            — recent runs across the workspace
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listJobRuns, getJobRun, getRunOutput } from '@/lib/azure/databricks-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const runIdParam = req.nextUrl.searchParams.get('runId');
  try {
    if (runIdParam) {
      const runId = Number(runIdParam);
      if (!Number.isFinite(runId))
        return NextResponse.json({ ok: false, error: 'runId must be a number' }, { status: 400 });
      const [run, output] = await Promise.all([
        getJobRun(runId),
        getRunOutput(runId).catch(() => null),
      ]);
      return NextResponse.json({ ok: true, run, output });
    }
    const runs = await listJobRuns(undefined, 25);
    return NextResponse.json({ ok: true, runs });
  } catch (e: any) {
    const status = e?.status === 403 ? 403 : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
