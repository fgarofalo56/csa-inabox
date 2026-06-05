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
import {
  loadPipelineItem, persistBinding, bindingErrorResponse, ItemNotFoundError,
  pipelineDefinitionFromContent,
} from '@/lib/azure/pipeline-binding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'adf-pipeline';
const NAME_RE = /^[A-Za-z0-9_-]{1,140}$/;

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  try {
    const item = await loadPipelineItem(id, ITEM_TYPE, session.claims.oid);
    if (!item) throw new ItemNotFoundError(ITEM_TYPE, id);
    const bound = typeof item.state?.pipelineName === 'string' ? (item.state.pipelineName as string) : null;
    // Best-effort: list real pipelines for the picker. If the factory env vars
    // aren't set, surface the message instead of failing the whole response.
    let pipelines: Array<{ name: string }> = [];
    let listError: string | undefined;
    try {
      pipelines = (await listPipelines()).map((p) => ({ name: p.name }));
    } catch (e: any) {
      listError = e?.message || String(e);
    }
    // Preview graph for bundle-installed (unbound) items: surface the rich
    // activity graph stamped into state.content so the editor can render the
    // FULLY BUILT-OUT canvas while the bind gate still prompts the user to push
    // it to a real ADF factory pipeline. Null when no pipeline content.
    const preview = bound ? null : pipelineDefinitionFromContent(item.state?.content);
    return NextResponse.json({ ok: true, bound, pipelines, listError, preview });
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
  try {
    if (create) {
      // Create a new empty pipeline in the factory via the real upsert REST,
      // then bind the Loom item to it.
      await upsertPipeline(pipelineName, { name: pipelineName, properties: { activities: [] } });
    }
    const item = await persistBinding(id, ITEM_TYPE, session.claims.oid, { pipelineName });
    return NextResponse.json({ ok: true, bound: pipelineName, created: create, item });
  } catch (e) {
    const { status, body: errBody } = bindingErrorResponse(e);
    return NextResponse.json(errBody, { status });
  }
}
