/**
 * GET  /api/items/synapse-pipeline/[id]/triggers
 *      — list triggers referencing the BOUND pipeline.
 * POST /api/items/synapse-pipeline/[id]/triggers
 *      body: { name, action?: 'start'|'stop'|'delete', properties? }
 *      Upsert/start/stop/delete a trigger. When `properties` is provided we PUT
 *      the trigger (idempotent upsert) — Synapse requires the pipeline
 *      reference to be embedded in `properties.pipelines`.
 *
 * `[id]` is the Loom item GUID; the Azure pipeline name is resolved from the
 * item's state.pipelineName binding. 412 when unbound.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listTriggersForPipeline,
  upsertTrigger,
  startTrigger,
  stopTrigger,
  deleteTrigger,
  type SynapseTrigger,
} from '@/lib/azure/synapse-dev-client';
import { resolveBinding, bindingErrorResponse } from '@/lib/azure/pipeline-binding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  let pipelineName: string;
  try {
    ({ pipelineName } = await resolveBinding(id, 'synapse-pipeline', session.claims.oid));
  } catch (e) {
    const { status, body } = bindingErrorResponse(e);
    return NextResponse.json(body, { status });
  }
  try {
    const triggers = await listTriggersForPipeline(pipelineName);
    return NextResponse.json({ ok: true, triggers, boundTo: pipelineName });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  let pipelineName: string;
  try {
    ({ pipelineName } = await resolveBinding(id, 'synapse-pipeline', session.claims.oid));
  } catch (e) {
    const { status, body } = bindingErrorResponse(e);
    return NextResponse.json(body, { status });
  }

  const body = await req.json().catch(() => ({}));
  const name = typeof body?.name === 'string' ? body.name : '';
  if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });

  const action = typeof body?.action === 'string' ? body.action : undefined;
  try {
    if (action === 'start') {
      await startTrigger(name);
      return NextResponse.json({ ok: true, action: 'started', name });
    }
    if (action === 'stop') {
      await stopTrigger(name);
      return NextResponse.json({ ok: true, action: 'stopped', name });
    }
    if (action === 'delete') {
      await deleteTrigger(name);
      return NextResponse.json({ ok: true, action: 'deleted', name });
    }
    // Upsert path — requires properties.type + typeProperties; we wire the
    // pipeline reference (to the BOUND pipeline name) if not already present.
    if (!body?.properties) {
      return NextResponse.json({ ok: false, error: 'properties required for upsert (or pass action=start|stop|delete)' }, { status: 400 });
    }
    const props = body.properties;
    const hasPipelineRef = Array.isArray(props.pipelines)
      && props.pipelines.some((p: any) => p?.pipelineReference?.referenceName === pipelineName);
    if (!hasPipelineRef) {
      props.pipelines = [
        ...(Array.isArray(props.pipelines) ? props.pipelines : []),
        { pipelineReference: { referenceName: pipelineName, type: 'PipelineReference' }, parameters: {} },
      ];
    }
    const spec: SynapseTrigger = { name, properties: props };
    const trigger = await upsertTrigger(name, spec);
    return NextResponse.json({ ok: true, trigger });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
