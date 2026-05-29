/**
 * GET /api/items/ml-model/[id]
 *
 * Resolve the Loom item's resource binding (state.modelName + optional
 * state.workspaceName) and return the bound AML registered model + its
 * versions. `[id]` is the Loom Cosmos item GUID, NOT the model name — the
 * model name comes from the persisted binding (this fixes the confirmed
 * 404 where the GUID was used as the model name).
 *
 *   200 { ok, model, versions, binding:{ workspaceName?, version? } }
 *   412 { ok:false, code:'unbound' }    — item exists, not yet bound
 *   404 { ok:false, code:'not_found' }  — item not in tenant
 *
 * Real AML REST via foundry-client (ARM model registry under the bound
 * workspace). No mocks.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getModel, listModelVersions, FoundryError } from '@/lib/azure/foundry-client';
import {
  resolveModelBinding, modelBindingErrorResponse, ML_MODEL_ITEM_TYPE,
} from '@/lib/azure/model-binding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
    const model = await getModel(binding.modelName, binding.workspaceName);
    if (!model) {
      return NextResponse.json({
        ok: false,
        code: 'model_missing',
        error: `Bound model "${binding.modelName}" not found in workspace "${binding.workspaceName || '(hub)'}". It may have been deleted — re-bind in the editor.`,
      }, { status: 404 });
    }
    const versions = await listModelVersions(binding.modelName, binding.workspaceName).catch(() => []);
    return NextResponse.json({
      ok: true,
      model,
      versions,
      binding: { workspaceName: binding.workspaceName, version: binding.version },
    });
  } catch (e: any) {
    const status = e instanceof FoundryError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
