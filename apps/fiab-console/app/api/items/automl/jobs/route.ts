/**
 * GET /api/items/automl/jobs
 *
 * Run monitoring: list the workspace's AutoML jobs (jobType eq 'AutoML') for the
 * editor's runs table. Real ARM GET .../workspaces/{ws}/jobs with a $filter.
 *
 * Query: ?maxResults=N (default 200, capped 1000).
 *
 * Honest gate: 200 + { ok:false, configured:false, hint } when env unset.
 * Azure-native default — no Fabric dependency.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listAutoMlJobs, automlConfigGate, AutoMlError } from '@/lib/azure/aml-automl-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const gate = automlConfigGate();
  if (gate) {
    return NextResponse.json(
      {
        ok: false,
        configured: false,
        error: 'Azure ML workspace not configured',
        hint: `Set ${gate.missing} so AutoML runs can be listed for this workspace.`,
        jobs: [],
      },
      { status: 200 },
    );
  }

  const url = new URL(req.url);
  const maxRaw = Number(url.searchParams.get('maxResults'));
  const maxResults = Number.isFinite(maxRaw) ? Math.max(1, Math.min(1000, Math.floor(maxRaw))) : undefined;

  try {
    const jobs = await listAutoMlJobs({ maxResults });
    return NextResponse.json({ ok: true, configured: true, jobs });
  } catch (e: any) {
    const status = e instanceof AutoMlError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
