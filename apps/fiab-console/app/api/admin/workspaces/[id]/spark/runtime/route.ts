/**
 * Spark / compute configuration — Runtime tab (F13).
 *
 *   GET  /api/admin/workspaces/[id]/spark/runtime
 *          → { ok, versions: SparkVersion[], nodeTypes: NodeType[],
 *              config: WorkspaceSparkConfig['runtime'] }
 *   POST /api/admin/workspaces/[id]/spark/runtime
 *          body { spark_version, node_type_id, driver_node_type_id?,
 *                 autoscale?: { min_workers, max_workers }, num_workers? }
 *          → persists to Cosmos (workspace-spark-config). These defaults are
 *            merged into the ClusterSpec when a cluster is created/edited from
 *            this workspace's template, applying them to a real Databricks session.
 *
 * Spark version keys + node-type catalog come live from Databricks REST.
 * Azure-native default; honest 503 gate when no Databricks host.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireWorkspace } from '@/lib/auth/workspace-guard';
import {
  sparkConfigGate,
  getSparkConfig,
  upsertSparkConfig,
  listRuntimeVersions,
  listAvailableNodeTypes,
} from '@/lib/clients/spark-config-client';

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
    const [versions, nodeTypes, config] = await Promise.all([
      listRuntimeVersions(),
      listAvailableNodeTypes(),
      getSparkConfig(id),
    ]);
    return NextResponse.json({
      ok: true,
      versions,
      nodeTypes: nodeTypes.map((n) => ({
        id: n.node_type_id,
        memoryMb: n.memory_mb,
        cores: n.num_cores,
        category: n.category,
        description: n.description,
      })),
      config: config.runtime,
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
    spark_version?: string;
    node_type_id?: string;
    driver_node_type_id?: string;
    autoscale?: { min_workers: number; max_workers: number };
    num_workers?: number;
  };
  if (!body.spark_version || !body.node_type_id) {
    return NextResponse.json(
      { ok: false, error: 'spark_version and node_type_id are required' },
      { status: 400 },
    );
  }
  try {
    const config = await upsertSparkConfig(
      id,
      {
        runtime: {
          spark_version: body.spark_version,
          node_type_id: body.node_type_id,
          driver_node_type_id: body.driver_node_type_id,
          autoscale: body.autoscale,
          // autoscale and num_workers are mutually exclusive on a ClusterSpec.
          num_workers: body.autoscale ? undefined : body.num_workers,
        },
      },
      guard.session!.claims.oid,
    );
    return NextResponse.json({ ok: true, config: config.runtime });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
