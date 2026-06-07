/**
 * POST /api/items/ml-model/[id]/register
 *
 * Register a NEW version of the BOUND registered model from a model artifact
 * URI (azureml://… run output, datastore path, or a registered run's outputs).
 *
 * Two backends, picked by whether a source run id is supplied:
 *   - WITHOUT runId — real ARM PUT of a model version under the bound
 *     workspace's registry:  PUT .../workspaces/{ws}/models/{name}/versions/{ver}
 *   - WITH runId (register-FROM-RUN) — real MLflow REST
 *     `model-versions/create` with `run_id`, so the new version records lineage
 *     back to the training run (the ARM PUT path cannot carry run lineage).
 *
 * `[id]` is the Loom item GUID; modelName + workspace come from the binding.
 *
 * Body: { modelUri: string, version?: string, modelType?: string,
 *         description?: string, runId?: string }
 *   412 { ok:false, code:'unbound' }              when the item isn't bound yet.
 *   412 { ok:false, code:'mlflow_unconfigured' }  when runId given but AML MLflow env unset.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { registerModelVersion, FoundryError } from '@/lib/azure/foundry-client';
import {
  createMlflowModelVersion, MlflowNotConfiguredError, MlflowError,
} from '@/lib/azure/mlflow-client';
import {
  resolveModelBinding, modelBindingErrorResponse, ML_MODEL_ITEM_TYPE,
} from '@/lib/azure/model-binding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MODEL_TYPES = new Set(['custom_model', 'mlflow_model', 'triton_model']);

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
    const modelUri = String(body?.modelUri || '').trim();
    if (!modelUri) return NextResponse.json({ ok: false, error: 'modelUri is required (e.g. azureml://jobs/<run>/outputs/artifacts/paths/model/)' }, { status: 400 });
    const modelType = MODEL_TYPES.has(String(body?.modelType)) ? String(body.modelType) : 'mlflow_model';
    const runId = String(body?.runId || '').trim();
    const description = body?.description ? String(body.description) : `Registered via Loom for ${binding.modelName}`;

    // Register-from-run: MLflow REST so the version records source-run lineage.
    if (runId) {
      try {
        const version = await createMlflowModelVersion(
          binding.modelName,
          { source: modelUri, runId, description },
          binding.workspaceName,
        );
        return NextResponse.json({ ok: true, model: binding.modelName, version, lineage: { runId: version.runId || runId } });
      } catch (e: any) {
        if (e instanceof MlflowNotConfiguredError) {
          return NextResponse.json(
            { ok: false, code: 'mlflow_unconfigured', error: e.message, hint: e.hint, missing: e.missing },
            { status: 412 },
          );
        }
        const status = e instanceof MlflowError ? e.status : 502;
        return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
      }
    }

    // Default ARM PUT path (no run lineage captured).
    const version = await registerModelVersion(binding.modelName, {
      version: body?.version ? String(body.version) : undefined,
      modelUri,
      modelType: modelType as any,
      description,
      workspaceName: binding.workspaceName,
    });
    return NextResponse.json({ ok: true, model: binding.modelName, version });
  } catch (e: any) {
    const status = e instanceof FoundryError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
