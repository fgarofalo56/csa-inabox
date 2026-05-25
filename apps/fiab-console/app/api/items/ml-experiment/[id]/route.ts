/**
 * GET /api/items/ml-experiment/[id]
 *
 * `id` is either a job name or an experimentName. Strategy:
 *   1. Try getJob(id) — if hit, return single-job response.
 *   2. Otherwise treat as experiment grouping: filter all jobs by experimentName.
 *
 * Response: { ok, kind: 'job'|'experiment', job?, experimentName?, runs?: FoundryJob[] }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getJob, listJobs, FoundryError } from '@/lib/azure/foundry-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: { params: { id: string } }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const id = decodeURIComponent(ctx.params.id);
  try {
    const job = await getJob(id).catch((e) => {
      if (e instanceof FoundryError && (e.status === 404 || e.status === 400)) return null;
      throw e;
    });
    if (job) {
      return NextResponse.json({ ok: true, kind: 'job', job });
    }
    // Fall back: treat id as experiment name and list runs under it.
    const all = await listJobs();
    const runs = all.filter((j) => (j.experimentName || '') === id);
    if (runs.length === 0) {
      return NextResponse.json(
        { ok: false, error: `No job or experiment named "${id}"`, status: 404 },
        { status: 404 },
      );
    }
    return NextResponse.json({ ok: true, kind: 'experiment', experimentName: id, runs });
  } catch (e: any) {
    const status = e instanceof FoundryError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
