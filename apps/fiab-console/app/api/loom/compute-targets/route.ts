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
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listSparkPools } from '@/lib/azure/synapse-dev-client';
import { listClusters } from '@/lib/azure/databricks-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ComputeTarget {
  id: string;
  name: string;
  kind: 'synapse-spark' | 'databricks-cluster' | 'synapse-dedicated-sql' | 'synapse-serverless-sql';
  state?: string;
  sku?: string;
  nodeSize?: string;
  runEndpoint: string;
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
    const pools = await listSparkPools();
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
    const clusters = await listClusters();
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
      const pools = await listDedicatedSqlPools();
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

  return NextResponse.json({ ok: true, computes, errors });
}
