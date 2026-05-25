/**
 * GET /api/items/ml-experiment — list jobs (runs grouped by experimentName).
 *   Response: { ok, jobs, experiments } where `experiments` is a name→count rollup.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listJobs, FoundryError } from '@/lib/azure/foundry-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const jobs = await listJobs();
    const counts: Record<string, number> = {};
    for (const j of jobs) {
      const k = j.experimentName || '(no experiment)';
      counts[k] = (counts[k] || 0) + 1;
    }
    const experiments = Object.entries(counts)
      .map(([name, runCount]) => ({ name, runCount }))
      .sort((a, b) => b.runCount - a.runCount);
    return NextResponse.json({ ok: true, jobs, experiments });
  } catch (e: any) {
    const status = e instanceof FoundryError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
