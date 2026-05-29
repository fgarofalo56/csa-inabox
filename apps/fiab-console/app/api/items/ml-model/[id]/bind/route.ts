/**
 * Resource-binding endpoint for an ml-model Loom item.
 *
 *   GET  /api/items/ml-model/[id]/bind
 *        ?workspaceName=<ws>   (optional — list models in that workspace)
 *        → { ok, bound:{ modelName, workspaceName?, version? }|null,
 *            workspaces:[{name,kind,isHub}], models:[{name,latestVersion}],
 *            workspacesError?, modelsError? }
 *
 *   POST /api/items/ml-model/[id]/bind
 *        body: { modelName, workspaceName?, version? }   → bind the Loom item
 *
 * `[id]` is the Loom Cosmos item GUID. Binding is persisted to the item's
 * `state.modelName` / `state.workspaceName` / `state.version`. Real AML REST
 * via foundry-client (ARM workspaces + model registry list); real Cosmos write
 * via persistModelBinding. No mocks.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listMlWorkspaces, listModels } from '@/lib/azure/foundry-client';
import {
  loadModelItem, persistModelBinding, readModelBindingFromState,
  modelBindingErrorResponse, ModelItemNotFoundError, ML_MODEL_ITEM_TYPE,
} from '@/lib/azure/model-binding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NAME_RE = /^[A-Za-z0-9_.-]{1,255}$/;

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const workspaceName = url.searchParams.get('workspaceName')?.trim() || undefined;
  try {
    const item = await loadModelItem(id, ML_MODEL_ITEM_TYPE, session.claims.oid);
    if (!item) throw new ModelItemNotFoundError(ML_MODEL_ITEM_TYPE, id);
    const bound = readModelBindingFromState(item);

    // Best-effort: list real AML workspaces for the picker. Env-gate / RBAC
    // failures surface as a message, not a hard failure of the whole response.
    let workspaces: Array<{ name: string; kind?: string; isHub?: boolean }> = [];
    let workspacesError: string | undefined;
    try {
      workspaces = (await listMlWorkspaces()).map((w) => ({ name: w.name, kind: w.kind, isHub: w.isHub }));
    } catch (e: any) {
      workspacesError = e?.message || String(e);
    }

    // List models in the selected (or already-bound) workspace.
    const wsForModels = workspaceName || bound.workspaceName;
    let models: Array<{ name: string; latestVersion?: string }> = [];
    let modelsError: string | undefined;
    try {
      models = (await listModels(wsForModels)).map((m) => ({ name: m.name, latestVersion: m.latestVersion }));
    } catch (e: any) {
      modelsError = e?.message || String(e);
    }

    return NextResponse.json({
      ok: true,
      bound: bound.modelName ? bound : null,
      workspaces,
      models,
      workspacesError,
      modelsError,
    });
  } catch (e) {
    const { status, body } = modelBindingErrorResponse(e);
    return NextResponse.json(body, { status });
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const modelName = typeof body?.modelName === 'string' ? body.modelName.trim() : '';
  const workspaceName = typeof body?.workspaceName === 'string' ? body.workspaceName.trim() : undefined;
  const version = typeof body?.version === 'string' ? body.version.trim() : undefined;
  if (!modelName) {
    return NextResponse.json({ ok: false, error: 'modelName is required' }, { status: 400 });
  }
  if (!NAME_RE.test(modelName)) {
    return NextResponse.json({ ok: false, error: 'modelName must be 1-255 chars: letters, digits, . _ or -' }, { status: 400 });
  }
  try {
    const item = await persistModelBinding(id, ML_MODEL_ITEM_TYPE, session.claims.oid, { modelName, workspaceName, version });
    return NextResponse.json({ ok: true, bound: { modelName, workspaceName, version }, item });
  } catch (e) {
    const { status, body: errBody } = modelBindingErrorResponse(e);
    return NextResponse.json(errBody, { status });
  }
}
