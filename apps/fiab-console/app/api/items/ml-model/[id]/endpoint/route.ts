/**
 * GET  /api/items/ml-model/[id]/endpoint  — list managed online endpoints in
 *      the bound model's workspace (so the editor can show existing endpoints).
 * POST /api/items/ml-model/[id]/endpoint  — create a managed online (real-time)
 *      endpoint + deployment serving the BOUND registered model version.
 *
 * `[id]` is the Loom item GUID; the AML model name + workspace come from the
 * persisted binding (state.modelName / state.workspaceName) — NOT the route id.
 * Real ARM PUTs against the bound workspace:
 *   1. PUT onlineEndpoints/{name}
 *   2. PUT onlineEndpoints/{name}/deployments/blue with model=azureml:<name>:<ver>
 *
 * Body (POST): { version?: string, instanceType?: string, endpointName?: string }
 *   412 { ok:false, code:'unbound' } when the item isn't bound yet.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  getModel,
  listModelVersions,
  listOnlineEndpoints,
  createOnlineEndpoint,
  createOnlineDeployment,
  FoundryError,
} from '@/lib/azure/foundry-client';
import {
  resolveModelBinding, modelBindingErrorResponse, ML_MODEL_ITEM_TYPE,
} from '@/lib/azure/model-binding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function endpointNameFor(model: string): string {
  const base = `ep-${model}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 30);
  return `${base}-${Date.now().toString(36).slice(-4)}`;
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
    const endpoints = await listOnlineEndpoints(binding.workspaceName);
    return NextResponse.json({ ok: true, endpoints });
  } catch (e: any) {
    const status = e instanceof FoundryError ? e.status : 502;
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
    const model = await getModel(binding.modelName, binding.workspaceName);
    if (!model) return NextResponse.json({ ok: false, error: `model ${binding.modelName} not found` }, { status: 404 });
    const versions = await listModelVersions(binding.modelName, binding.workspaceName).catch(() => []);
    const version = String(body?.version || binding.version || model.latestVersion || versions[0]?.version || '1');
    const endpointName = String(body?.endpointName || endpointNameFor(binding.modelName));

    const endpoint = await createOnlineEndpoint(endpointName, { authMode: 'Key', workspaceName: binding.workspaceName });
    const deployment = await createOnlineDeployment(endpointName, 'blue', {
      modelId: `azureml:${binding.modelName}:${version}`,
      instanceType: body?.instanceType ? String(body.instanceType) : undefined,
      instanceCount: 1,
      workspaceName: binding.workspaceName,
    });
    return NextResponse.json({
      ok: true, endpoint, deployment,
      message: `Real-time endpoint "${endpointName}" provisioning with ${binding.modelName}:${version}.`,
    });
  } catch (e: any) {
    const status = e instanceof FoundryError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
