/**
 * Triggers wired to the BOUND ADF pipeline.
 *
 *   GET  /api/items/adf-pipeline/[id]/triggers
 *        → list triggers whose properties.pipelines[] reference the bound pipeline
 *   POST /api/items/adf-pipeline/[id]/triggers
 *        body: { name, properties }          → upsert a trigger
 *        body: { name, action: 'start'|'stop'|'delete' } → lifecycle action
 *
 * `[id]` is the Loom item GUID; the Azure pipeline name is resolved from the
 * item's state.pipelineName binding. 412 when unbound. Real ARM REST. No mocks.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listTriggers, upsertTrigger, deleteTrigger, startTrigger, stopTrigger,
  type AdfTrigger,
} from '@/lib/azure/adf-client';
import { resolveBinding, bindingErrorResponse } from '@/lib/azure/pipeline-binding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  let pipelineName: string;
  try {
    ({ pipelineName } = await resolveBinding(id, 'adf-pipeline', session.claims.oid));
  } catch (e) {
    const { status, body } = bindingErrorResponse(e);
    return NextResponse.json(body, { status });
  }
  try {
    const all = await listTriggers();
    const wired = all.filter((t) =>
      (t.properties?.pipelines || []).some((p) => p.pipelineReference?.referenceName === pipelineName),
    );
    return NextResponse.json({
      ok: true,
      boundTo: pipelineName,
      triggers: wired.map((t) => ({
        name: t.name,
        type: t.properties?.type,
        runtimeState: t.properties?.runtimeState,
      })),
    });
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
    ({ pipelineName } = await resolveBinding(id, 'adf-pipeline', session.claims.oid));
  } catch (e) {
    const { status, body } = bindingErrorResponse(e);
    return NextResponse.json(body, { status });
  }
  const body = await req.json().catch(() => ({}));
  const name: string | undefined = body?.name;
  if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });

  try {
    if (body.action === 'start') { await startTrigger(name); return NextResponse.json({ ok: true, action: 'start' }); }
    if (body.action === 'stop')  { await stopTrigger(name);  return NextResponse.json({ ok: true, action: 'stop' }); }
    if (body.action === 'delete'){ await deleteTrigger(name); return NextResponse.json({ ok: true, action: 'delete' }); }

    // Upsert a schedule trigger wired to the bound pipeline. Caller may pass
    // full `properties`; otherwise we build a daily ScheduleTrigger (Stopped).
    const properties: AdfTrigger['properties'] = body.properties || {
      type: 'ScheduleTrigger',
      runtimeState: 'Stopped',
      pipelines: [{ pipelineReference: { referenceName: pipelineName, type: 'PipelineReference' }, parameters: {} }],
      typeProperties: {
        recurrence: { frequency: 'Day', interval: 1, startTime: new Date().toISOString(), timeZone: 'UTC' },
      },
    };
    // Always force the pipeline reference so the trigger fires the BOUND pipeline.
    properties.pipelines = [{ pipelineReference: { referenceName: pipelineName, type: 'PipelineReference' }, parameters: (properties.pipelines?.[0]?.parameters) || {} }];
    const saved = await upsertTrigger(name, { name, properties });
    return NextResponse.json({ ok: true, trigger: { name: saved.name, type: saved.properties?.type, runtimeState: saved.properties?.runtimeState } });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
