/**
 * POST /api/items/spark-job-definition/[id]/submit
 *
 * Loads the persisted spec from Cosmos (state.spec) and submits a Livy
 * batch job against the configured Synapse Spark pool. Optional body
 * fields override the persisted spec for a one-off run:
 *   { pool?, file?, className?, args?, conf?, name? }
 *
 * When `spec.environmentId` points at a Loom `environment` item, that
 * environment's Spark conf + custom JARs are merged into the batch
 * request at submit time (the batch's own conf/jars win on conflict) so
 * the "Environment" selection in the editor actually changes the job.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { submitSparkBatchJob, type SparkBatchRequest } from '@/lib/azure/synapse-dev-client';
import { jerr, loadOwnedItem } from '../../../_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'spark-job-definition';

type SparkLanguage = 'PySpark' | 'Spark' | 'SparkR';

interface SparkSpec {
  language?: SparkLanguage;
  file?: string;
  className?: string;
  args?: string[];
  jars?: string[];
  pyFiles?: string[];
  files?: string[];
  conf?: Record<string, string>;
  pool?: string;
  environmentId?: string;
  driverMemory?: string;
  driverCores?: number;
  executorMemory?: string;
  executorCores?: number;
  numExecutors?: number;
}

/** Drop empty / whitespace entries from a string array; undefined if none remain. */
function clean(arr?: string[]): string[] | undefined {
  if (!arr) return undefined;
  const out = arr.map((s) => (s || '').trim()).filter(Boolean);
  return out.length ? out : undefined;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const override = (await req.json().catch(() => ({}))) as Partial<SparkSpec> & { name?: string };
  try {
    const item = await loadOwnedItem((await ctx.params).id, ITEM_TYPE, session.claims.oid);
    if (!item) return jerr('not found', 404);
    const spec: SparkSpec = { ...((item.state as any)?.spec || {}), ...override };
    if (!spec.pool) return jerr('spec.pool is required', 400);
    if (!spec.file) return jerr('spec.file is required', 400);

    // --- Environment merge (optional) ----------------------------------------
    // If the SJD references a Loom `environment` item, fold its Spark conf and
    // custom JARs into this batch. The SJD's own conf/jars take precedence.
    let mergedConf: Record<string, string> = { ...(spec.conf || {}) };
    let mergedJars: string[] = [...(clean(spec.jars) || [])];
    if (spec.environmentId) {
      const env = await loadOwnedItem(spec.environmentId, 'environment', session.claims.oid);
      if (env) {
        const envState: any = env.state || {};
        const envConf: Record<string, string> = envState.conf || {};
        for (const [k, v] of Object.entries(envConf)) {
          if (!(k in mergedConf)) mergedConf[k] = String(v);
        }
        const envJars = clean(envState.jars) || [];
        for (const j of envJars) if (!mergedJars.includes(j)) mergedJars.push(j);
      }
    }

    const job: SparkBatchRequest = {
      name: override.name || `loom-${item.displayName.replace(/[^A-Za-z0-9_-]/g, '_')}-${Date.now()}`,
      file: spec.file,
      // className is only meaningful for Scala/Java jars; never send it for
      // PySpark / SparkR where the "main class" field is hidden in the editor.
      className: spec.language === 'Spark' ? (spec.className || undefined) : undefined,
      args: clean(spec.args),
      jars: mergedJars.length ? mergedJars : undefined,
      pyFiles: clean(spec.pyFiles),
      files: clean(spec.files),
      conf: Object.keys(mergedConf).length ? mergedConf : undefined,
      driverMemory: spec.driverMemory || undefined,
      driverCores: spec.driverCores,
      executorMemory: spec.executorMemory || undefined,
      executorCores: spec.executorCores,
      numExecutors: spec.numExecutors,
    };
    const submitted = await submitSparkBatchJob(spec.pool, job);
    return NextResponse.json({ ok: true, pool: spec.pool, job: submitted });
  } catch (e: any) {
    return jerr(e?.message || String(e), 502);
  }
}
