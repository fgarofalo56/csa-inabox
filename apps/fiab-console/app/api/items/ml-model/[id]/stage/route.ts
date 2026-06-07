/**
 * GET  /api/items/ml-model/[id]/stage  — list the BOUND model's MLflow
 *      model-versions, each carrying `current_stage` (None | Staging |
 *      Production | Archived) + source `run_id` (lineage). ARM model versions
 *      don't carry stage (it's an MLflow-layer concept) so the editor decorates
 *      its version table with this.
 * POST /api/items/ml-model/[id]/stage  — transition a model version to a new
 *      stage via the real MLflow REST `model-versions/transition-stage`. The
 *      returned model_version IS the registry receipt.
 *
 * `[id]` is the Loom item GUID; the AML model name + workspace come from the
 * persisted binding (state.modelName / state.workspaceName) — NOT the route id.
 *
 * Stages live on the MLflow surface AML hosts, per Microsoft Learn
 * "how-to-manage-models-mlflow". Real REST, no mocks. When the AML/MLflow
 * tracking endpoint isn't configured in this deployment the route returns an
 * honest gate (code:'mlflow_unconfigured' + the exact env vars to set) so the
 * editor shows a Fluent MessageBar instead of crashing.
 *
 * Body (POST): { version: string, stage: 'None'|'Staging'|'Production'|'Archived',
 *                archiveExistingVersions?: boolean }
 *   412 { ok:false, code:'unbound' }              when the item isn't bound yet.
 *   412 { ok:false, code:'mlflow_unconfigured' }  when AML MLflow env is unset.
 *   400 { ok:false }                              when stage/version is invalid.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  searchMlflowModelVersions,
  transitionModelVersionStage,
  isMlflowModelStage,
  MLFLOW_MODEL_STAGES,
  MlflowNotConfiguredError,
  MlflowError,
} from '@/lib/azure/mlflow-client';
import {
  resolveModelBinding, modelBindingErrorResponse, ML_MODEL_ITEM_TYPE,
} from '@/lib/azure/model-binding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function mlflowGate(e: MlflowNotConfiguredError) {
  return NextResponse.json(
    { ok: false, code: 'mlflow_unconfigured', error: e.message, hint: e.hint, missing: e.missing },
    { status: 412 },
  );
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  let binding;
  try {
    binding = await resolveModelBinding(id, ML_MODEL_ITEM_TYPE, session.claims.oid);
  } catch (e) {
    const { status, body } = modelBindingErrorResponse(e);
    return NextResponse.json(body, { status });
  }
  try {
    const versions = await searchMlflowModelVersions(binding.modelName, binding.workspaceName);
    return NextResponse.json({ ok: true, model: binding.modelName, stages: MLFLOW_MODEL_STAGES, versions });
  } catch (e: any) {
    if (e instanceof MlflowNotConfiguredError) return mlflowGate(e);
    const status = e instanceof MlflowError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  let binding;
  try {
    binding = await resolveModelBinding(id, ML_MODEL_ITEM_TYPE, session.claims.oid);
  } catch (e) {
    const { status, body } = modelBindingErrorResponse(e);
    return NextResponse.json(body, { status });
  }
  try {
    const body = await req.json().catch(() => ({}));
    const version = String(body?.version || '').trim();
    if (!version) return NextResponse.json({ ok: false, error: 'version is required' }, { status: 400 });
    const stage = String(body?.stage || '').trim();
    if (!isMlflowModelStage(stage)) {
      return NextResponse.json(
        { ok: false, error: `stage must be one of ${MLFLOW_MODEL_STAGES.join(', ')}` },
        { status: 400 },
      );
    }
    const modelVersion = await transitionModelVersionStage(binding.modelName, version, stage, {
      archiveExisting: !!body?.archiveExistingVersions,
      workspace: binding.workspaceName,
    });
    return NextResponse.json({
      ok: true,
      model: binding.modelName,
      modelVersion,
      // The raw MLflow model_version (post-transition) — the registry receipt.
      receipt: modelVersion,
      message: `${binding.modelName} v${version} transitioned to ${modelVersion.currentStage || stage}.`,
    });
  } catch (e: any) {
    if (e instanceof MlflowNotConfiguredError) return mlflowGate(e);
    const status = e instanceof MlflowError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
