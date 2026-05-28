/**
 * GET    /api/items/synapse-pipeline/[id]/triggers
 *   List Synapse triggers wired to this pipeline.
 * POST   /api/items/synapse-pipeline/[id]/triggers
 *   Create/upsert a trigger and wire it to this pipeline.
 * PUT    /api/items/synapse-pipeline/[id]/triggers?triggerName=...&action=start|stop
 * DELETE /api/items/synapse-pipeline/[id]/triggers?triggerName=...
 *
 * Talks to the Synapse dev REST API ({workspace}.dev.azuresynapse.net/triggers).
 * Same wire format as ADF, distinct host + bearer audience.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listTriggers, upsertTrigger, startTrigger, stopTrigger, deleteTrigger,
  type SynapseTrigger,
} from '@/lib/azure/synapse-dev-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number) {
  return NextResponse.json({ ok: false, error }, { status });
}

export async function GET(_req: NextRequest, ctx: { params: { id: string } }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  try {
    const all = await listTriggers();
    const mine = all.filter((t) =>
      (t.properties?.pipelines || []).some((p) => p.pipelineReference?.referenceName === ctx.params.id),
    );
    return NextResponse.json({
      ok: true,
      triggers: mine.map((t) => ({
        name: t.name,
        type: t.properties?.type,
        runtimeState: t.properties?.runtimeState,
        description: t.properties?.description,
        properties: t.properties,
      })),
    });
  } catch (e: any) {
    return err(e?.message || String(e), e?.status || 502);
  }
}

export async function POST(req: NextRequest, ctx: { params: { id: string } }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const body = await req.json().catch(() => null) as { name?: string; properties?: SynapseTrigger['properties'] } | null;
  if (!body?.name || !body?.properties) return err('body must be { name, properties }', 400);
  try {
    const wired: SynapseTrigger = {
      name: body.name,
      properties: {
        ...body.properties,
        type: body.properties.type || 'ScheduleTrigger',
        pipelines: body.properties.pipelines && body.properties.pipelines.length > 0
          ? body.properties.pipelines
          : [{
              pipelineReference: { referenceName: ctx.params.id, type: 'PipelineReference' as const },
              parameters: {},
            }],
      },
    };
    const trigger = await upsertTrigger(body.name, wired);
    return NextResponse.json({ ok: true, trigger });
  } catch (e: any) {
    return err(e?.message || String(e), e?.status || 502);
  }
}

export async function PUT(req: NextRequest, _ctx: { params: { id: string } }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const triggerName = req.nextUrl.searchParams.get('triggerName');
  const action = req.nextUrl.searchParams.get('action');
  if (!triggerName) return err('triggerName required', 400);
  if (action !== 'start' && action !== 'stop') return err('action must be start|stop', 400);
  try {
    if (action === 'start') await startTrigger(triggerName);
    else await stopTrigger(triggerName);
    return NextResponse.json({ ok: true, triggerName, action });
  } catch (e: any) {
    return err(e?.message || String(e), e?.status || 502);
  }
}

export async function DELETE(req: NextRequest, _ctx: { params: { id: string } }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const triggerName = req.nextUrl.searchParams.get('triggerName');
  if (!triggerName) return err('triggerName required', 400);
  try {
    await deleteTrigger(triggerName);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return err(e?.message || String(e), e?.status || 502);
  }
}
