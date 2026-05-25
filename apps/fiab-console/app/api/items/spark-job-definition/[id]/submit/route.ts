/**
 * POST /api/items/spark-job-definition/[id]/submit
 *
 * Loads the persisted spec from Cosmos (state.spec) and submits a Livy
 * batch job against the configured Synapse Spark pool. Optional body
 * fields override the persisted spec for a one-off run:
 *   { pool?, file?, className?, args?, conf?, name? }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { submitSparkBatchJob, type SparkBatchRequest } from '@/lib/azure/synapse-dev-client';
import { jerr, loadOwnedItem } from '../../../_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'spark-job-definition';

interface SparkSpec {
  file?: string;
  className?: string;
  args?: string[];
  conf?: Record<string, string>;
  pool?: string;
  driverMemory?: string;
  executorMemory?: string;
  numExecutors?: number;
}

export async function POST(req: NextRequest, ctx: { params: { id: string } }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const override = (await req.json().catch(() => ({}))) as Partial<SparkSpec> & { name?: string };
  try {
    const item = await loadOwnedItem(ctx.params.id, ITEM_TYPE, session.claims.oid);
    if (!item) return jerr('not found', 404);
    const spec: SparkSpec = { ...((item.state as any)?.spec || {}), ...override };
    if (!spec.pool) return jerr('spec.pool is required', 400);
    if (!spec.file) return jerr('spec.file is required', 400);
    const job: SparkBatchRequest = {
      name: override.name || `loom-${item.displayName.replace(/[^A-Za-z0-9_-]/g, '_')}-${Date.now()}`,
      file: spec.file,
      className: spec.className,
      args: spec.args,
      conf: spec.conf,
      driverMemory: spec.driverMemory,
      executorMemory: spec.executorMemory,
      numExecutors: spec.numExecutors,
    };
    const submitted = await submitSparkBatchJob(spec.pool, job);
    return NextResponse.json({ ok: true, pool: spec.pool, job: submitted });
  } catch (e: any) {
    return jerr(e?.message || String(e), 502);
  }
}
