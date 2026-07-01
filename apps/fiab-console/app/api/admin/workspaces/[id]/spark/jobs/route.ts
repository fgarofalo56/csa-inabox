/**
 * Spark / compute configuration — Jobs tab (F13).
 *
 *   GET  /api/admin/workspaces/[id]/spark/jobs
 *          → { ok, config: WorkspaceSparkConfig['jobs'], sparkConf: Record<string,string> }
 *          sparkConf is the materialized spark_conf dict (preview of what will be
 *          applied to clusters created from this workspace's template).
 *   POST /api/admin/workspaces/[id]/spark/jobs
 *          body { session_timeout_minutes, optimistic_admission, reserve_cores,
 *                 dynamic_executors?, min_executors?, max_executors? }
 *          → persists to Cosmos. These settings map to ClusterSpec fields:
 *              session_timeout_minutes → autotermination_minutes
 *              optimistic_admission    → spark.databricks.optimisticAdmission
 *              reserve_cores           → spark.databricks.driver.reservedCores
 *              dynamic_executors       → ClusterSpec.autoscale (NOT
 *                                        spark.dynamicAllocation.* — unsupported
 *                                        on Databricks classic clusters)
 *          and are merged into the ClusterSpec on cluster create/edit, applying
 *          to a real Databricks session.
 *
 * No Databricks REST call on this route — pure Cosmos persistence. Honest 503
 * gate when no Databricks host (so the surface stays consistent with the others).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireWorkspace } from '@/lib/auth/workspace-guard';
import {
  sparkConfigGate,
  getSparkConfig,
  upsertSparkConfig,
} from '@/lib/clients/spark-config-client';
import { buildJobSparkConf } from '@/lib/azure/databricks-scale-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Authorize (401 unauth / 404 not owner-or-admin) THEN honest 503 config gate.
 * Authorization runs first so an unauthorized caller can't probe config state. */
async function guardWorkspace(id: string) {
  const w = await requireWorkspace(id);
  if (w.resp) return { resp: w.resp };
  const g = sparkConfigGate();
  if (g) {
    return {
      resp: NextResponse.json(
        { ok: false, gated: true, code: g.code, error: g.message, missing: g.missing },
        { status: 503 },
      ),
    };
  }
  return { session: w.session };
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await guardWorkspace(id);
  if (guard.resp) return guard.resp;
  try {
    const config = await getSparkConfig(id);
    return NextResponse.json({
      ok: true,
      config: config.jobs,
      sparkConf: buildJobSparkConf(config.jobs),
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await guardWorkspace(id);
  if (guard.resp) return guard.resp;
  const body = (await req.json().catch(() => ({}))) as {
    session_timeout_minutes?: number;
    optimistic_admission?: boolean;
    reserve_cores?: number;
    dynamic_executors?: boolean;
    min_executors?: number;
    max_executors?: number;
  };
  try {
    const jobs = {
      session_timeout_minutes:
        typeof body.session_timeout_minutes === 'number' ? body.session_timeout_minutes : 60,
      optimistic_admission: !!body.optimistic_admission,
      reserve_cores: typeof body.reserve_cores === 'number' ? body.reserve_cores : 0,
      dynamic_executors: !!body.dynamic_executors,
      min_executors: body.min_executors,
      max_executors: body.max_executors,
    };
    const config = await upsertSparkConfig(id, { jobs }, guard.session!.claims.oid);
    return NextResponse.json({
      ok: true,
      config: config.jobs,
      sparkConf: buildJobSparkConf(config.jobs),
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
