/**
 * Triggers wired to a specific ADF pipeline.
 *
 *   GET  /api/items/adf-pipeline/[id]/triggers
 *        → list triggers whose properties.pipelines[] reference this pipeline
 *   POST /api/items/adf-pipeline/[id]/triggers
 *        body: { name, properties }          → upsert a trigger
 *        body: { name, action: 'start'|'stop'|'delete' } → lifecycle action
 *
 * Real ARM REST via adf-client. No mocks.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listTriggers, upsertTrigger, deleteTrigger, startTrigger, stopTrigger,
  type AdfTrigger,
} from '@/lib/azure/adf-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const pipelineName = (await ctx.params).id;
  try {
    const all = await listTriggers();
    const wired = all.filter((t) =>
      (t.properties?.pipelines || []).some((p) => p.pipelineReference?.referenceName === pipelineName),
    );
    return NextResponse.json({
      ok: true,
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
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const pipelineName = (await ctx.params).id;
  const body = await req.json().catch(() => ({}));
  const name: string | undefined = body?.name;
  if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });

  try {
    if (body.action === 'start') { await startTrigger(name); return NextResponse.json({ ok: true, action: 'start' }); }
    if (body.action === 'stop')  { await stopTrigger(name);  return NextResponse.json({ ok: true, action: 'stop' }); }
    if (body.action === 'delete'){ await deleteTrigger(name); return NextResponse.json({ ok: true, action: 'delete' }); }

    // Upsert a schedule trigger wired to this pipeline. Caller may pass full
    // `properties`; otherwise we build a daily ScheduleTrigger in Stopped state.
    const properties: AdfTrigger['properties'] = body.properties || {
      type: 'ScheduleTrigger',
      runtimeState: 'Stopped',
      pipelines: [{ pipelineReference: { referenceName: pipelineName, type: 'PipelineReference' }, parameters: {} }],
      typeProperties: {
        recurrence: { frequency: 'Day', interval: 1, startTime: new Date().toISOString(), timeZone: 'UTC' },
      },
    };
    // Always force the pipeline reference so the trigger fires THIS pipeline.
    properties.pipelines = [{ pipelineReference: { referenceName: pipelineName, type: 'PipelineReference' }, parameters: (properties.pipelines?.[0]?.parameters) || {} }];
    const saved = await upsertTrigger(name, { name, properties });
    return NextResponse.json({ ok: true, trigger: { name: saved.name, type: saved.properties?.type, runtimeState: saved.properties?.runtimeState } });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
