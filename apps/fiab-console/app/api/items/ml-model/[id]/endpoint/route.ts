/**
 * POST /api/items/ml-model/[id]/endpoint
 *
 * Create a managed online (real-time) endpoint serving a registered model
 * version. Real ARM PUTs against the Foundry hub workspace:
 *   1. PUT onlineEndpoints/{name}
 *   2. PUT onlineEndpoints/{name}/deployments/{name} with model=azureml:<id>:<ver>
 *
 * Body: { version?: string, instanceType?: string, endpointName?: string }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  getModel,
  listModelVersions,
  createOnlineEndpoint,
  createOnlineDeployment,
  FoundryError,
} from '@/lib/azure/foundry-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function endpointNameFor(model: string): string {
  const base = `ep-${model}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 30);
  return `${base}-${Date.now().toString(36).slice(-4)}`;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  try {
    const body = await req.json().catch(() => ({}));
    const model = await getModel(id);
    if (!model) return NextResponse.json({ ok: false, error: `model ${id} not found` }, { status: 404 });
    const versions = await listModelVersions(id).catch(() => []);
    const version = String(body?.version || model.latestVersion || versions[0]?.version || '1');
    const endpointName = String(body?.endpointName || endpointNameFor(id));

    const endpoint = await createOnlineEndpoint(endpointName, { authMode: 'Key' });
    const deployment = await createOnlineDeployment(endpointName, 'blue', {
      modelId: `azureml:${id}:${version}`,
      instanceType: body?.instanceType ? String(body.instanceType) : undefined,
      instanceCount: 1,
    });
    return NextResponse.json({ ok: true, endpoint, deployment, message: `Real-time endpoint "${endpointName}" provisioning with ${id}:${version}.` });
  } catch (e: any) {
    const status = e instanceof FoundryError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
