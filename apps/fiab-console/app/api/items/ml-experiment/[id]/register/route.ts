/**
 * POST /api/items/ml-experiment/[id]/register
 *
 * Register a model from a completed run's output. Real ARM PUT of a model
 * version under the hub registry pointing at the run's output artifact.
 *
 * Body: { modelName: string, modelUri?: string, version?: string, description?: string }
 * When modelUri is omitted we derive azureml://jobs/<run>/outputs/artifacts/model.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getJob, registerModelVersion, FoundryError } from '@/lib/azure/foundry-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  try {
    const body = await req.json().catch(() => ({}));
    const modelName = String(body?.modelName || '').trim();
    if (!modelName) return NextResponse.json({ ok: false, error: 'modelName required' }, { status: 400 });

    // Validate the run exists (id is a run/job name).
    const job = await getJob(id);
    if (!job) return NextResponse.json({ ok: false, error: `run ${id} not found` }, { status: 404 });

    const modelUri = String(body?.modelUri || `azureml://jobs/${id}/outputs/artifacts/paths/model/`);
    const version = await registerModelVersion(modelName, {
      version: body?.version ? String(body.version) : undefined,
      modelUri,
      modelType: 'mlflow_model',
      description: body?.description ? String(body.description) : `Registered from run ${id}`,
    });
    return NextResponse.json({ ok: true, model: modelName, version });
  } catch (e: any) {
    const status = e instanceof FoundryError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
