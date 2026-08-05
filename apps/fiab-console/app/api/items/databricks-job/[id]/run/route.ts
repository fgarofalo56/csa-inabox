/**
 * POST /api/items/databricks-job/[id]/run?jobId=123
 *   body { params?: RunNowParams | Record<string,string> }
 *   → { ok, run_id, number_in_job }
 *
 * Real backend: POST /api/2.1/jobs/run-now (via runJob). The body carries the
 * per-task-type run parameters Databricks accepts on run-now (notebook_params,
 * python_params, python_named_params, jar_params, spark_submit_params,
 * sql_params, dbt_commands, job_parameters, pipeline_params).
 *
 * #2997 — this handler USED TO BE `POST(req)`: it never accepted `ctx.params`,
 * so `[id]` was not merely unenforced, it was never read, and `runJob` ran on a
 * caller-supplied `jobId` behind nothing but `getSession()`. Any signed-in user
 * could execute any tenant's job in the shared Databricks workspace, as the
 * Console. It is now WRITE-scoped (the body executes) and the jobId is bound to
 * the item — see `_lib/job-scope.ts`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { runJob } from '@/lib/azure/databricks-client';
import type { RunNowParams } from '@/lib/azure/databricks-client';
import { authorizeDatabricksJobItem, resolveAuthorizedJobId } from '../../_lib/job-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { item, denied } = await authorizeDatabricksJobItem(id, {
    workspaceId: req.nextUrl.searchParams.get('workspaceId'),
  });
  if (denied) return denied;

  const bound = await resolveAuthorizedJobId(item, id, req.nextUrl.searchParams.get('jobId'));
  if (!bound.ok) return NextResponse.json({ ok: false, error: bound.error }, { status: bound.status });

  const body = await req.json().catch(() => ({}));
  const params = (body?.params ?? undefined) as RunNowParams | Record<string, string> | undefined;
  try {
    const r = await runJob(bound.jobId, params);
    return NextResponse.json({ ok: true, ...r });
  } catch (e: any) {
    const status = e?.status === 403 ? 403 : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
