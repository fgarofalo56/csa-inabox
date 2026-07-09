/**
 * ML-model PREDICT — guided batch-scoring stepper backend (rel-T84).
 *
 * The Azure-native equivalent of Fabric's PREDICT: score a Delta/lakehouse
 * table with a registered Azure ML MLflow model on Spark, writing a scored
 * Delta table. No Fabric dependency — the model is an AML registered model
 * (`models:/<name>/<version>`) and the compute is AML Serverless Spark
 * (Commercial / GCC) or Synapse Spark via Livy (the Azure-native default, and
 * the only path in Gov). Works with LOOM_DEFAULT_FABRIC_WORKSPACE unset.
 *
 *   GET  /api/items/ml-model/[id]/predict?version=<v>
 *     → { ok, features:[…], featureSource, datastores:[…], compute:{…}, tracking }
 *       Pickers for the wizard: candidate feature names (from the model's
 *       MLflow signature if stamped, else the bundle definition), abfss input
 *       roots (real AML datastores), and whether Spark compute is configured.
 *
 *   POST /api/items/ml-model/[id]/predict
 *     body { version, inputMode, inputRef, inputFormat?, features[], passthroughColumns?,
 *            predictionColumn, resultType, outputMode, outputRef, writeMode }
 *     → builds the scoring PySpark (predict-codegen) and submits a REAL Spark
 *       job. AML → standalone Serverless Spark job; Synapse → interactive Livy
 *       session/statement (persisted on the item so the status poller can drive
 *       it past a 60-90s cold start under Front Door's 30s cap).
 *       { ok, backend, runId, status, outputRef, generatedCode }
 *
 * All real Azure REST — no mocks. Honest 503 infra-gate (naming the exact env
 * var / role) when neither AML Serverless Spark nor a Synapse Spark pool is
 * configured; the full wizard surface still renders.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { isGovCloud } from '@/lib/azure/cloud-endpoints';
import {
  resolveModelBinding, modelBindingErrorResponse, ML_MODEL_ITEM_TYPE,
} from '@/lib/azure/model-binding';
import { getModelVersion } from '@/lib/azure/foundry-client';
import {
  buildPredictPySpark, validatePredictSpec, azuremlTrackingUri,
  PREDICT_RESULT_TYPES,
  type PredictSpec, type FeatureMapping, type PredictResultType,
} from '@/lib/azure/predict-codegen';
import { createLivySession, getLivySession } from '@/lib/azure/synapse-livy-client';
import { apiError, apiServerError } from '@/lib/api/respond';
import {
  upsertPredictHistory, type PredictHistoryEntry, type PredictHistoryMap,
} from '@/lib/azure/predict-history';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Honest 4xx/503 gate envelope ({ok:false,error,hint}) — delegates to the
 *  unified apiError so the BFF error shape stays consistent. 5xx paths use
 *  apiServerError so raw exception text never reaches the client. */
function err(error: string, status: number, hint?: string) {
  return apiError(error, status, hint ? { hint } : undefined);
}

/**
 * Resolve the Spark backend for PREDICT scoring jobs — identical policy to the
 * notebook %%pyspark router: Gov / IL5 → Synapse Livy (AML Serverless Spark
 * isn't offered in Gov); Commercial / GCC with LOOM_AML_SPARK → AML; else the
 * Synapse Livy Azure-native default.
 */
function resolveSparkBackend(): 'aml' | 'synapse' {
  if (isGovCloud()) return 'synapse';
  if ((process.env.LOOM_CLOUD_TIER || '').trim().toUpperCase() === 'IL5') return 'synapse';
  if ((process.env.LOOM_AML_SPARK || '').trim()) return 'aml';
  return 'synapse';
}

/** Synapse Spark pool used for scoring jobs (falls back to the notebook pool). */
function scoringSparkPool(): string {
  return (process.env.LOOM_SYNAPSE_SPARK_POOL || process.env.LOOM_SPARK_POOL || '').trim();
}

/** Whether Spark compute (either backend) is configured, for the honest UI gate. */
function computeStatus(): { backend: 'aml' | 'synapse'; configured: boolean; missing?: string } {
  const backend = resolveSparkBackend();
  if (backend === 'aml') {
    return { backend, configured: true };
  }
  const pool = scoringSparkPool();
  return pool
    ? { backend, configured: true }
    : {
        backend,
        configured: false,
        missing: 'LOOM_SYNAPSE_SPARK_POOL (or LOOM_SPARK_POOL) — a deployed Synapse Spark pool; grant the Console UAMI the "Synapse Compute Operator" role on it',
      };
}

/** Best-effort azureml:// tracking URI for the bound workspace (so `models:/` resolves on Synapse). */
async function resolveTrackingUri(workspaceName?: string): Promise<string | undefined> {
  try {
    const { mlflowConfig } = await import('@/lib/azure/mlflow-client');
    return azuremlTrackingUri(mlflowConfig(workspaceName).base) || undefined;
  } catch {
    return undefined; // AML Serverless Spark auto-configures its own registry.
  }
}

/**
 * Best-effort feature-name extraction from a model version's stamped MLflow
 * signature (registered-model metadata) or the bundle definition. The wizard
 * always lets the user add/edit the mapping, so an empty result is fine.
 */
function extractSignatureFeatures(
  props: Record<string, string> | undefined,
  tags: Record<string, string> | undefined,
): { features: string[]; source: 'signature' | 'none' } {
  const blobs: string[] = [];
  for (const bag of [props, tags]) {
    if (!bag) continue;
    for (const [k, v] of Object.entries(bag)) {
      if (/signature|inputs?|schema/i.test(k) && typeof v === 'string' && v.includes('{')) blobs.push(v);
    }
  }
  for (const blob of blobs) {
    try {
      const parsed = JSON.parse(blob);
      const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.inputs) ? parsed.inputs : null;
      if (Array.isArray(arr)) {
        const names = arr
          .map((e: any) => (typeof e === 'string' ? e : e?.name))
          .filter((n: any): n is string => typeof n === 'string' && !!n.trim());
        if (names.length) return { features: names, source: 'signature' };
      }
    } catch { /* not a signature blob — keep scanning */ }
  }
  return { features: [], source: 'none' };
}

// ============================================================
// GET — wizard pickers (feature candidates + input datastores + compute gate)
// ============================================================

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return err('unauthenticated', 401);
  const { id } = await ctx.params;

  let binding;
  try {
    binding = await resolveModelBinding(id, ML_MODEL_ITEM_TYPE, session.claims.oid);
  } catch (e) {
    const { status, body } = modelBindingErrorResponse(e);
    return NextResponse.json(body, { status });
  }

  const version = (req.nextUrl.searchParams.get('version') || binding.version || '').trim();

  // Feature candidates — MLflow signature (if stamped) → bundle definition → none.
  let features: string[] = [];
  let featureSource: 'signature' | 'bundle' | 'none' = 'none';
  if (version) {
    try {
      const mv = await getModelVersion(binding.modelName, version, binding.workspaceName);
      const sig = extractSignatureFeatures(mv?.properties, mv?.tags);
      if (sig.features.length) { features = sig.features; featureSource = 'signature'; }
    } catch { /* non-fatal — fall through to bundle / manual */ }
  }
  if (!features.length) {
    const content = (binding.item.state as any)?.content;
    const bundleFeatures = Array.isArray(content?.features)
      ? content.features.map((f: any) => (typeof f === 'string' ? f : f?.name)).filter((n: any): n is string => !!n)
      : [];
    if (bundleFeatures.length) { features = bundleFeatures; featureSource = 'bundle'; }
  }

  // Real AML datastores → abfss:// input roots (hints for the input-path picker).
  let datastores: Array<{ name: string; abfssPath: string }> = [];
  try {
    const { listDatastores } = await import('@/lib/azure/aml-client');
    datastores = (await listDatastores())
      .filter((d) => !!d.abfssPath)
      .map((d) => ({ name: d.name, abfssPath: d.abfssPath as string }));
  } catch { /* non-fatal — the user can still type an abfss path */ }

  const tracking = await resolveTrackingUri(binding.workspaceName);

  return NextResponse.json({
    ok: true,
    model: { name: binding.modelName, workspaceName: binding.workspaceName || null, version: version || null },
    features,
    featureSource,
    datastores,
    compute: computeStatus(),
    tracking: { configured: !!tracking },
    resultTypes: PREDICT_RESULT_TYPES,
  });
}

// ============================================================
// POST — build + submit the batch-scoring Spark job
// ============================================================

interface PredictBody {
  version?: string;
  inputMode?: 'delta-path' | 'table';
  inputRef?: string;
  inputFormat?: 'delta' | 'parquet';
  features?: Array<{ feature?: string; column?: string }>;
  passthroughColumns?: string[];
  predictionColumn?: string;
  resultType?: string;
  outputMode?: 'delta-path' | 'table';
  outputRef?: string;
  writeMode?: 'overwrite' | 'append';
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return err('unauthenticated', 401);
  const { id } = await ctx.params;

  let binding: Awaited<ReturnType<typeof resolveModelBinding>>;
  try {
    binding = await resolveModelBinding(id, ML_MODEL_ITEM_TYPE, session.claims.oid);
  } catch (e) {
    const { status, body } = modelBindingErrorResponse(e);
    return NextResponse.json(body, { status });
  }

  const body = (await req.json().catch(() => ({}))) as PredictBody;
  const version = (body.version || binding.version || '').trim();
  if (!version) return err('A model version is required to score (Step 1).', 400);

  const features: FeatureMapping[] = (body.features || [])
    .map((f) => ({ feature: (f.feature || '').trim(), column: (f.column || f.feature || '').trim() }))
    .filter((f) => f.feature);

  const resultType = (PREDICT_RESULT_TYPES as readonly string[]).includes(body.resultType || '')
    ? (body.resultType as PredictResultType)
    : 'double';

  const trackingUri = await resolveTrackingUri(binding.workspaceName);

  const spec: PredictSpec = {
    modelName: binding.modelName,
    version,
    trackingUri,
    inputMode: body.inputMode === 'table' ? 'table' : 'delta-path',
    inputRef: (body.inputRef || '').trim(),
    inputFormat: body.inputFormat === 'parquet' ? 'parquet' : 'delta',
    features,
    passthroughColumns: (body.passthroughColumns || []).map((c) => (c || '').trim()).filter(Boolean),
    predictionColumn: (body.predictionColumn || 'prediction').trim(),
    resultType,
    outputMode: body.outputMode === 'table' ? 'table' : 'delta-path',
    outputRef: (body.outputRef || '').trim(),
    writeMode: body.writeMode === 'append' ? 'append' : 'overwrite',
  };

  const specErr = validatePredictSpec(spec);
  if (specErr) return err(specErr, 400);

  let code: string;
  try {
    code = buildPredictPySpark(spec);
  } catch (e: any) {
    return err(e?.message || String(e), 400);
  }

  const backend = resolveSparkBackend();

  // Build a run-history entry (persisted on the item so the wizard can list past
  // scoring jobs — FGC-18 "run history persisted"). Filled with the runId below.
  const makeHistoryEntry = (runId: string, be: 'aml' | 'synapse', status: PredictHistoryEntry['status']): PredictHistoryEntry => ({
    runId, backend: be, version, inputRef: spec.inputRef, outputRef: spec.outputRef,
    featureCount: spec.features.length, startedAt: new Date().toISOString(), status,
  });

  /** Best-effort: persist a history entry onto the item (never blocks the run). */
  async function persistHistory(entry: PredictHistoryEntry, extraState?: Record<string, unknown>): Promise<void> {
    try {
      const items = await itemsContainer();
      const item = binding.item;
      const state = (item.state as any) || {};
      const predictHistory: PredictHistoryMap = upsertPredictHistory(state.predictHistory, entry);
      await items.item(item.id, item.workspaceId).replace({
        ...item,
        state: { ...state, ...(extraState || {}), predictHistory },
        updatedAt: new Date().toISOString(),
      } as WorkspaceItem);
    } catch { /* non-fatal — history is a convenience, not the run itself */ }
  }

  try {
    // ---- AML Serverless Spark (Commercial / GCC, LOOM_AML_SPARK set) ----
    if (backend === 'aml') {
      const { submitAmlSparkCell, AmlSparkNotConfiguredError } = await import('@/lib/azure/aml-spark-client');
      try {
        const sub = await submitAmlSparkCell(code, `predict-${id}`);
        const runId = `aml:${sub.jobName}`;
        await persistHistory(makeHistoryEntry(runId, 'aml', 'submitted'));
        return NextResponse.json({
          ok: true,
          backend: 'aml',
          runId,
          status: 'Queued',
          outputRef: spec.outputRef,
          generatedCode: code,
        });
      } catch (e: any) {
        if (e instanceof AmlSparkNotConfiguredError) return err(e.message, 503, e.hint);
        throw e;
      }
    }

    // ---- Synapse Spark via Livy (Azure-native default; only path in Gov) ----
    const pool = scoringSparkPool();
    if (!pool) {
      return err(
        'No Spark compute configured for PREDICT scoring jobs.',
        503,
        'Set LOOM_SYNAPSE_SPARK_POOL (or LOOM_SPARK_POOL) to a deployed Synapse Spark pool and grant the Console UAMI the "Synapse Compute Operator" role on it — or set LOOM_AML_SPARK to an Azure ML workspace for Serverless Spark (Commercial / GCC only).',
      );
    }

    // Reuse a warm pyspark session cached on the item if one is live; else create.
    const items = await itemsContainer();
    const item = binding.item;
    const state = (item.state as any) || {};
    let sessionId: number | undefined;
    let sessState = 'starting';
    const saved = state.predictSparkSession;
    if (saved && saved.pool === pool && typeof saved.id === 'number') {
      try {
        const live = await getLivySession(pool, saved.id);
        if (['idle', 'busy', 'starting', 'not_started'].includes(live.state)) {
          sessionId = saved.id; sessState = live.state;
        }
      } catch { /* stale → recreate */ }
    }
    if (sessionId === undefined) {
      const sess = await createLivySession(pool, { kind: 'pyspark', name: `loom-predict-${Date.now()}` });
      sessionId = sess.id; sessState = sess.state;
    }
    const runId = `synapse-spark:${pool}:${sessionId}`;

    // Persist the pending statement + session so the status poller submits it
    // once the session reaches idle (Front Door can't hold a 60-90s cold start).
    // Also record the run-history entry (keyed by the base runId) so the wizard
    // can list past scoring jobs (FGC-18 "run history persisted").
    try {
      const predictRuns = { ...(state.predictRuns || {}) };
      predictRuns[runId] = { source: code, outputRef: spec.outputRef, cellId: `predict-${id}` };
      const predictHistory: PredictHistoryMap = upsertPredictHistory(
        state.predictHistory,
        makeHistoryEntry(runId, 'synapse', 'submitted'),
      );
      await items.item(item.id, item.workspaceId).replace({
        ...item,
        state: { ...state, predictRuns, predictHistory, predictSparkSession: { pool, id: sessionId, kind: 'pyspark' } },
        updatedAt: new Date().toISOString(),
      } as WorkspaceItem);
    } catch { /* non-fatal — the poller re-derives from runId */ }

    return NextResponse.json({
      ok: true,
      backend: 'synapse',
      runId,
      status: sessState,
      outputRef: spec.outputRef,
      generatedCode: code,
    });
  } catch (e: any) {
    // Honest gate errors carry an explicit <500 status (+ hint) — surface them.
    if (e?.status && e.status < 500) return err(e.message, e.status, e?.hint);
    return apiServerError(e, 'scoring job submission failed', 'predict_submit_error');
  }
}
