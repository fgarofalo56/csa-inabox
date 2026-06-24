/**
 * GET /api/loom/compute-targets — unified picker source for any editor that
 * needs to choose a real Azure-native execution target. Returns the merged
 * list of:
 *   - Synapse Spark pools (ARM-discovered from Loom's Synapse workspace)
 *   - Databricks clusters (Databricks API on Loom's Databricks workspace)
 *   - Synapse Dedicated SQL pools (for warehouse-shaped workloads)
 *   - Synapse Serverless SQL (always-on)
 *
 * Each entry has `kind` so the caller knows which Run endpoint to POST to.
 *
 * Shape:
 *   { ok: true, computes: [
 *     { id, name, kind: 'synapse-spark' | 'databricks-cluster' |
 *               'synapse-dedicated-sql' | 'synapse-serverless-sql',
 *       state?, sku?, nodeSize?, runEndpoint }
 *   ]}
 *
 * Used by: notebook, data-pipeline, dataflow, spark-job-definition, and any
 * other editor that needs to pick a compute backend.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listSparkPools } from '@/lib/azure/synapse-dev-client';
import { listClusters, createCluster, type ClusterSpec } from '@/lib/azure/databricks-client';
import { findPreset, databricksConfFor, databricksClusterLogConf } from '@/lib/spark/config-presets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ComputeTarget {
  id: string;
  name: string;
  kind: 'synapse-spark' | 'databricks-cluster' | 'synapse-dedicated-sql' | 'synapse-serverless-sql' | 'aml-ci';
  state?: string;
  sku?: string;
  nodeSize?: string;
  runEndpoint: string;
}

/**
 * Bound a discovery probe so an unreachable PE-only endpoint (Synapse dev /
 * Databricks) can never hang the request into a Front Door origin-timeout 503.
 * On timeout we surface an honest error row and keep going — the picker still
 * renders the always-on Serverless target. Prevents the aggressive client
 * retry loop that otherwise floods the connection pool (and starves sibling
 * POSTs like shortcut-create with "Failed to fetch").
 */
function withTimeout<T>(p: Promise<T>, ms: number, kind: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${kind} discovery timed out after ${ms}ms (endpoint unreachable from the Console VNet?)`)), ms),
    ),
  ]);
}

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const computes: ComputeTarget[] = [];
  const errors: { kind: string; error: string }[] = [];

  // Always-on Serverless SQL — no provisioning, always available.
  if (process.env.LOOM_SYNAPSE_WORKSPACE) {
    computes.push({
      id: `serverless:${process.env.LOOM_SYNAPSE_WORKSPACE}`,
      name: `${process.env.LOOM_SYNAPSE_WORKSPACE} (Serverless SQL — always on)`,
      kind: 'synapse-serverless-sql',
      state: 'Online',
      sku: 'pay-per-query',
      runEndpoint: '/api/items/synapse-serverless-sql-pool/{id}/query',
    });
  }

  // Synapse Spark pools — ARM discovery
  try {
    const pools = await withTimeout(listSparkPools(), 8000, 'synapse-spark');
    for (const p of pools) {
      computes.push({
        id: `spark:${p.name}`,
        name: `${p.name} (Synapse Spark)`,
        kind: 'synapse-spark',
        state: 'Available',
        nodeSize: (p as any).nodeSize,
        sku: (p as any).nodeSizeFamily || (p as any).sparkVersion,
        runEndpoint: '/api/items/spark-job-definition/{id}/submit',
      });
    }
  } catch (e: any) {
    errors.push({ kind: 'synapse-spark', error: e?.message || String(e) });
  }

  // Databricks clusters
  try {
    const clusters = await withTimeout(listClusters(), 8000, 'databricks-cluster');
    for (const c of clusters) {
      computes.push({
        id: `databricks:${c.cluster_id}`,
        name: `${c.cluster_name} (Databricks)`,
        kind: 'databricks-cluster',
        state: c.state,
        nodeSize: c.node_type_id,
        sku: c.spark_version,
        runEndpoint: '/api/items/databricks-notebook/{id}/run',
      });
    }
  } catch (e: any) {
    errors.push({ kind: 'databricks-cluster', error: e?.message || String(e) });
  }

  // Synapse Dedicated SQL pools — also via ARM
  try {
    const { listDedicatedSqlPools } = await import('@/lib/azure/synapse-dev-client');
    if (typeof listDedicatedSqlPools === 'function') {
      const pools = await withTimeout(listDedicatedSqlPools(), 8000, 'synapse-dedicated-sql');
      for (const p of pools) {
        computes.push({
          id: `dedicated-sql:${p.name}`,
          name: `${p.name} (Synapse Dedicated SQL)`,
          kind: 'synapse-dedicated-sql',
          state: (p as any).status,
          sku: (p as any).sku?.name,
          runEndpoint: '/api/items/synapse-dedicated-sql-pool/{id}/query',
        });
      }
    }
  } catch { /* helper not exported in this build — skip silently */ }

  // Azure ML Compute Instances — the AML notebook path's compute. Added when
  // LOOM_AML_WORKSPACE is configured (deploy-planner mlWorkspace module). The
  // notebook editor filters to kind === 'aml-ci' when its workspace toggle is
  // set to Azure ML. Azure-native — no Fabric dependency.
  try {
    const { amlIsConfigured, listCIs, ciIsRunning } = await import('@/lib/azure/aml-client');
    if (amlIsConfigured()) {
      const cis = await withTimeout(listCIs(), 8000, 'aml-ci');
      for (const ci of cis) {
        computes.push({
          id: `aml-ci:${ci.name}`,
          name: `${ci.name} (AML Compute Instance)`,
          kind: 'aml-ci',
          state: ci.state,
          nodeSize: ci.vmSize,
          sku: ci.vmSize,
          runEndpoint: '/api/items/notebook/{id}/run',
        });
        void ciIsRunning; // running-state computed client-side from `state`
      }
    }
  } catch (e: any) {
    errors.push({ kind: 'aml-ci', error: e?.message || String(e) });
  }

  return NextResponse.json({ ok: true, computes, errors });
}

/**
 * POST /api/loom/compute-targets — create a new compute target.
 *
 * Currently scoped to Databricks interactive clusters (the gap the operator
 * hit: "I have no way to … create a new cluster"). Synapse Spark pool creation
 * is an ARM workspace-capacity operation handled in the Synapse pool editor;
 * Serverless/Dedicated SQL are provisioned by Bicep — so create here = a real
 * Databricks /api/2.0/clusters/create.
 *
 * Body (all collected via guided dropdowns in <ComputePicker>, no raw JSON):
 *   { kind: 'databricks-cluster', cluster_name, spark_version, node_type_id,
 *     num_workers?, autotermination_minutes? }
 *
 * Returns the new cluster id so the caller can select + start it. Failures
 * (insufficient permission, bad node type, quota) surface verbatim — no mocks.
 */
export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    kind?: string;
    cluster_name?: string;
    spark_version?: string;
    node_type_id?: string;
    num_workers?: number;
    autotermination_minutes?: number;
    /** Best-practice preset id (from lib/spark/config-presets) — expands to a
     *  cluster shape (autoscale/Photon/spot/autoterm) + curated spark_conf. */
    presetId?: string;
    /** Structured spark.* overrides from the builder (merged over the preset). */
    spark_conf?: Record<string, string>;
    /** Builder fields (override the preset shape when supplied). */
    photon?: boolean;
    spot?: boolean;
    min_workers?: number;
    max_workers?: number;
  };

  if (body.kind && body.kind !== 'databricks-cluster') {
    return NextResponse.json(
      { ok: false, error: `Create is only supported for Databricks clusters here. Synapse Spark pools are created in the Synapse pool editor; SQL pools are deployed by Bicep.` },
      { status: 400 },
    );
  }

  const missing: string[] = [];
  if (!body.cluster_name) missing.push('cluster_name');
  if (!body.spark_version) missing.push('spark_version');
  if (!body.node_type_id) missing.push('node_type_id');
  if (missing.length) {
    return NextResponse.json({ ok: false, error: `Missing: ${missing.join(', ')}` }, { status: 400 });
  }

  // Expand the chosen preset (if any), then let explicit builder fields win.
  const preset = findPreset(body.presetId);
  const shape = preset?.databricks;

  // spark_conf precedence: preset's Databricks confs first, builder rows last.
  const sparkConf: Record<string, string> = {
    ...(preset ? databricksConfFor(preset) : {}),
    ...(body.spark_conf || {}),
  };

  // Autoscale vs fixed: a preset (or explicit min/max) → autoscale; else num_workers.
  const minW = typeof body.min_workers === 'number' ? body.min_workers : shape?.minWorkers;
  const maxW = typeof body.max_workers === 'number' ? body.max_workers : shape?.maxWorkers;
  const useAutoscale = typeof minW === 'number' && typeof maxW === 'number' && maxW > minW;

  const photon = typeof body.photon === 'boolean' ? body.photon : !!shape?.photon;
  const spot = typeof body.spot === 'boolean' ? body.spot : !!shape?.spot;
  const autoterm =
    typeof body.autotermination_minutes === 'number'
      ? body.autotermination_minutes
      : shape?.autoterminationMinutes ?? 30;

  const spec: ClusterSpec = {
    cluster_name: body.cluster_name!,
    spark_version: body.spark_version!,
    node_type_id: body.node_type_id!,
    autotermination_minutes: autoterm,
    runtime_engine: photon ? 'PHOTON' : 'STANDARD',
    custom_tags: { 'loom-managed': 'true', ...(body.presetId ? { 'loom-preset': body.presetId } : {}) },
  };
  if (Object.keys(sparkConf).length) spec.spark_conf = sparkConf;
  if (useAutoscale) spec.autoscale = { min_workers: minW!, max_workers: maxW! };
  else spec.num_workers = typeof body.num_workers === 'number' ? body.num_workers : (typeof minW === 'number' ? minW : 2);
  if (spot) spec.azure_attributes = { availability: 'SPOT_WITH_FALLBACK_AZURE', first_on_demand: 1 };
  // Honest log-delivery: only when LOOM_DATABRICKS_CLUSTER_LOG_PATH is configured.
  const logConf = databricksClusterLogConf();
  if (logConf) spec.cluster_log_conf = logConf;

  try {
    const { cluster_id } = await createCluster(spec);
    return NextResponse.json({
      ok: true,
      created: { id: `databricks:${cluster_id}`, cluster_id, kind: 'databricks-cluster' },
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
