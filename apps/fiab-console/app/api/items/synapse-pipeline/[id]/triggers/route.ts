/**
 * GET  /api/items/synapse-pipeline/[id]/triggers
 *      — list triggers referencing this pipeline.
 * POST /api/items/synapse-pipeline/[id]/triggers
 *      body: { name, action?: 'start'|'stop'|'delete', properties? }
 *      Upsert/start/stop/delete a trigger. When `properties` is provided
 *      we PUT the trigger (idempotent upsert) — Synapse requires the
 *      pipeline reference to be embedded in `properties.pipelines`.
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

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: { params: { id: string } }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const triggers = await listTriggersForPipeline(ctx.params.id);
    return NextResponse.json({ ok: true, triggers });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest, ctx: { params: { id: string } }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
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
    // Upsert path — requires properties.type + typeProperties; we wire
    // the pipeline reference if not already present.
    if (!body?.properties) {
      return NextResponse.json({ ok: false, error: 'properties required for upsert (or pass action=start|stop|delete)' }, { status: 400 });
    }
    const props = body.properties;
    const hasPipelineRef = Array.isArray(props.pipelines)
      && props.pipelines.some((p: any) => p?.pipelineReference?.referenceName === ctx.params.id);
    if (!hasPipelineRef) {
      props.pipelines = [
        ...(Array.isArray(props.pipelines) ? props.pipelines : []),
        { pipelineReference: { referenceName: ctx.params.id, type: 'PipelineReference' }, parameters: {} },
      ];
    }
    const spec: SynapseTrigger = { name, properties: props };
    const trigger = await upsertTrigger(name, spec);
    return NextResponse.json({ ok: true, trigger });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
