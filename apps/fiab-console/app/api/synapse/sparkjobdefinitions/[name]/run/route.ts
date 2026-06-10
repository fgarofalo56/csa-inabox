/**
 * Run a Spark job definition as a Livy batch against its target Spark Big Data
 * pool. Backs the Spark-job-definition editor's "Submit" button + the Runs tab.
 *
 *   POST /api/synapse/sparkjobdefinitions/[name]/run
 *     → reads the saved definition, submits a Livy batch from its jobProperties
 *       (file, className, args, sizing) and returns { ok, batchId, state, appId }.
 *
 *   GET  /api/synapse/sparkjobdefinitions/[name]/run            → list recent batches on the pool
 *   GET  /api/synapse/sparkjobdefinitions/[name]/run?batch=ID   → poll a single batch's status
 *
 * The batch runs against the definition's targetBigDataPool — a real Synapse
 * Spark pool, Azure-native, no Fabric. The definition's `file` must be an
 * abfss:// URI to the main .py/.jar; an empty file returns an honest gate.
 *
 * Real Synapse Livy REST (api-version 2019-11-01-preview) via synapse-dev-client.
 * Honest 503 gate when LOOM_SYNAPSE_WORKSPACE unset. No mocks.
 *
 * Learn: https://learn.microsoft.com/rest/api/synapse/data-plane/spark-batch/create-spark-batch-job
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { synapseConfigGate, getSparkJobDefinition } from '@/lib/azure/synapse-artifacts-client';
import {
  submitSparkBatchJob, listSparkBatchJobs, getSparkBatchJob,
  type SparkBatchRequest,
} from '@/lib/azure/synapse-dev-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NAME_RE = /^[A-Za-z0-9_]{1,260}$/;

function gate() {
  const g = synapseConfigGate();
  if (g) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', error: `Synapse workspace not configured: set ${g.missing}.`, missing: g.missing },
      { status: 503 },
    );
  }
  return null;
}

export async function POST(_req: NextRequest, ctx: { params: Promise<{ name: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const name = decodeURIComponent((await ctx.params).name).trim();
  if (!NAME_RE.test(name)) return NextResponse.json({ ok: false, error: 'invalid Spark job definition name' }, { status: 400 });

  try {
    const def = await getSparkJobDefinition(name);
    if (!def) return NextResponse.json({ ok: false, error: `Spark job definition '${name}' not found` }, { status: 404 });
    const pool = def.properties?.targetBigDataPool?.referenceName;
    const jp = def.properties?.jobProperties;
    if (!pool) {
      return NextResponse.json({ ok: false, code: 'no_pool', error: 'This definition has no target Spark pool — set one in the editor.' }, { status: 409 });
    }
    if (!jp?.file) {
      return NextResponse.json(
        { ok: false, code: 'no_file', error: 'This definition has no main file. Set the main definition file (abfss:// URI to a .py or .jar) before submitting.' },
        { status: 409 },
      );
    }
    const job: SparkBatchRequest = {
      name: `loom-sjd-${name}-${Date.now()}`,
      file: jp.file,
      className: jp.className,
      args: jp.args,
      jars: jp.jars,
      pyFiles: jp.pyFiles,
      files: jp.files,
      conf: jp.conf,
      driverMemory: jp.driverMemory,
      driverCores: jp.driverCores,
      executorMemory: jp.executorMemory,
      executorCores: jp.executorCores,
      numExecutors: jp.numExecutors,
    };
    const batch = await submitSparkBatchJob(pool, job);
    return NextResponse.json({ ok: true, batchId: batch.id, state: batch.state, appId: batch.appId, pool });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ name: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const name = decodeURIComponent((await ctx.params).name).trim();
  if (!NAME_RE.test(name)) return NextResponse.json({ ok: false, error: 'invalid Spark job definition name' }, { status: 400 });

  try {
    const def = await getSparkJobDefinition(name);
    if (!def) return NextResponse.json({ ok: false, error: `Spark job definition '${name}' not found` }, { status: 404 });
    const pool = def.properties?.targetBigDataPool?.referenceName;
    if (!pool) return NextResponse.json({ ok: true, runs: [], note: 'no target pool set' });

    const batchParam = req.nextUrl.searchParams.get('batch');
    if (batchParam != null && batchParam !== '') {
      const batchId = Number(batchParam);
      if (!Number.isFinite(batchId)) return NextResponse.json({ ok: false, error: 'batch must be a number' }, { status: 400 });
      const b = await getSparkBatchJob(pool, batchId);
      return NextResponse.json({ ok: true, run: { id: b.id, state: b.state, appId: b.appId, result: b.result, submittedAt: b.submittedAt } });
    }

    const list = await listSparkBatchJobs(pool, 0, 25);
    const runs = (list.sessions || []).map((b) => ({ id: b.id, state: b.state, appId: b.appId, result: b.result, submittedAt: b.submittedAt }));
    return NextResponse.json({ ok: true, runs });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
