/**
 * POST /api/items/databricks-job/[id]/run?jobId=123
 *   body { params?: RunNowParams | Record<string,string> }
 *   → { ok, run_id, number_in_job }
 *
 * Real backend: POST /api/2.1/jobs/run-now (via runJob). The body carries the
 * per-task-type run parameters Databricks accepts on run-now (notebook_params,
 * python_params, python_named_params, jar_params, spark_submit_params,
 * sql_params, dbt_commands, job_parameters, pipeline_params).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { runJob } from '@/lib/azure/databricks-client';
import type { RunNowParams } from '@/lib/azure/databricks-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const jobIdStr = req.nextUrl.searchParams.get('jobId');
  const jobId = jobIdStr ? Number(jobIdStr) : NaN;
  if (!Number.isFinite(jobId))
    return NextResponse.json({ ok: false, error: 'jobId is required' }, { status: 400 });
  const body = await req.json().catch(() => ({}));
  const params = (body?.params ?? undefined) as RunNowParams | Record<string, string> | undefined;
  try {
    const r = await runJob(jobId, params);
    return NextResponse.json({ ok: true, ...r });
  } catch (e: any) {
    const status = e?.status === 403 ? 403 : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
