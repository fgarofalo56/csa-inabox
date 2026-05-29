/**
 * POST /api/items/ml-model/[id]/register
 *
 * Register a NEW version of the BOUND registered model from a model artifact
 * URI (azureml://… run output, datastore path, or a registered run's outputs).
 * Real ARM PUT of a model version under the bound workspace's registry:
 *   PUT .../workspaces/{ws}/models/{modelName}/versions/{ver}
 *
 * `[id]` is the Loom item GUID; modelName + workspace come from the binding.
 *
 * Body: { modelUri: string, version?: string, modelType?: string, description?: string }
 *   412 { ok:false, code:'unbound' } when the item isn't bound yet.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { registerModelVersion, FoundryError } from '@/lib/azure/foundry-client';
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

    const version = await registerModelVersion(binding.modelName, {
      version: body?.version ? String(body.version) : undefined,
      modelUri,
      modelType: modelType as any,
      description: body?.description ? String(body.description) : `Registered via Loom for ${binding.modelName}`,
      workspaceName: binding.workspaceName,
    });
    return NextResponse.json({ ok: true, model: binding.modelName, version });
  } catch (e: any) {
    const status = e instanceof FoundryError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
