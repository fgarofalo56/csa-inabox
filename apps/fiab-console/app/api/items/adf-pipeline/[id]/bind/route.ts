/**
 * Resource-binding endpoint for an ADF pipeline Loom item.
 *
 *   GET  /api/items/adf-pipeline/[id]/bind
 *        → { ok, bound: string|null, pipelines: [{name}] }
 *          Returns the current binding (state.pipelineName) plus the list of
 *          REAL pipelines in the factory so the editor can render its picker.
 *
 *   POST /api/items/adf-pipeline/[id]/bind
 *        body: { pipelineName }                 → bind to an EXISTING pipeline
 *        body: { create: true, pipelineName }   → CREATE a new empty pipeline
 *                                                  via the real upsert REST, then bind
 *
 * `[id]` is the Loom Cosmos item GUID. Binding is persisted to the item's
 * `state.pipelineName`. Real ARM REST via adf-client; real Cosmos write via
 * persistBinding. No mocks.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listPipelines, upsertPipeline } from '@/lib/azure/adf-client';
import { factoryOverrideFromSearchParams, withFactoryOverride } from '@/lib/azure/adf-factory-context';
import {
  loadPipelineItem, persistBinding, bindingErrorResponse, ItemNotFoundError,
  pipelineDefinitionFromContent,
} from '@/lib/azure/pipeline-binding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'adf-pipeline';
// An interactively-created pipeline tile aliases to 'data-pipeline' at persist
// time (catalog aliasOf), while bundle-installed items may carry 'adf-pipeline'.
// Accept BOTH so every persisted form of an ADF pipeline resolves.
const ACCEPTED_TYPES = [ITEM_TYPE, 'data-pipeline'];
const NAME_RE = /^[A-Za-z0-9_-]{1,140}$/;

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  // The editor appends the SELECTED factory's coords (factorySubscriptionId /
  // factoryResourceGroup / factoryName) when a factory is picked; the pipeline
  // list then comes from THAT factory instead of the env default (fixing the
  // "No pipelines found" divergence from the Factory Resources tree). Absent →
  // env-default factory (unchanged).
  const override = factoryOverrideFromSearchParams(req.nextUrl.searchParams);
  try {
    const item = await loadPipelineItem(id, ACCEPTED_TYPES, session.claims.oid);
    if (!item) throw new ItemNotFoundError(ITEM_TYPE, id);
    const bound = typeof item.state?.pipelineName === 'string' ? (item.state.pipelineName as string) : null;
    // Best-effort: list real pipelines for the picker. If the factory env vars
    // aren't set, surface the message instead of failing the whole response.
    let pipelines: Array<{ name: string }> = [];
    let listError: string | undefined;
    try {
      pipelines = (await withFactoryOverride(override, () => listPipelines())).map((p) => ({ name: p.name }));
    } catch (e: any) {
      listError = e?.message || String(e);
    }
    // Preview graph for bundle-installed (unbound) items: surface the rich
    // activity graph stamped into state.content so the editor can render the
    // FULLY BUILT-OUT canvas while the bind gate still prompts the user to push
    // it to a real ADF factory pipeline. Null when no pipeline content.
    const preview = bound ? null : pipelineDefinitionFromContent(item.state?.content);
    // Surface the SELECTED factory the item was bound against (persisted at bind
    // time) so the editor rehydrates its factory picker + Factory Resources tree
    // on reload — keeping the tree, the bind list, and the bound item all on the
    // same factory. Null when bound to the env-default factory (no coords saved).
    const st = (item.state || {}) as Record<string, unknown>;
    const bf = {
      name: typeof st.factory === 'string' && st.factory ? st.factory : undefined,
      subscriptionId: typeof st.factorySubscriptionId === 'string' && st.factorySubscriptionId ? st.factorySubscriptionId : undefined,
      resourceGroup: typeof st.factoryResourceGroup === 'string' && st.factoryResourceGroup ? st.factoryResourceGroup : undefined,
    };
    const boundFactory = bf.name || bf.subscriptionId || bf.resourceGroup ? bf : null;
    return NextResponse.json({ ok: true, bound, pipelines, listError, preview, boundFactory });
  } catch (e) {
    const { status, body } = bindingErrorResponse(e);
    return NextResponse.json(body, { status });
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const pipelineName = typeof body?.pipelineName === 'string' ? body.pipelineName.trim() : '';
  const create = body?.create === true;
  if (!pipelineName) {
    return NextResponse.json({ ok: false, error: 'pipelineName is required' }, { status: 400 });
  }
  if (!NAME_RE.test(pipelineName)) {
    return NextResponse.json({ ok: false, error: 'pipelineName must be 1-140 chars: letters, digits, _ or -' }, { status: 400 });
  }
  // The SELECTED factory (query params) is where Create-&-bind provisions the
  // new pipeline, and its coords are persisted onto the item so every later
  // run/save/validate targets the same factory the item was bound against.
  const override = factoryOverrideFromSearchParams(req.nextUrl.searchParams);
  try {
    if (create) {
      // Create a new empty pipeline in the SELECTED (or env-default) factory via
      // the real upsert REST, then bind the Loom item to it.
      await withFactoryOverride(override, () =>
        upsertPipeline(pipelineName, { name: pipelineName, properties: { activities: [] } }),
      );
    }
    const item = await persistBinding(id, ACCEPTED_TYPES, session.claims.oid, {
      pipelineName,
      factory: override?.factoryName ?? '',
      factorySubscriptionId: override?.subscriptionId ?? '',
      factoryResourceGroup: override?.resourceGroup ?? '',
    });
    return NextResponse.json({ ok: true, bound: pipelineName, created: create, item });
  } catch (e) {
    const { status, body: errBody } = bindingErrorResponse(e);
    return NextResponse.json(errBody, { status });
  }
}
