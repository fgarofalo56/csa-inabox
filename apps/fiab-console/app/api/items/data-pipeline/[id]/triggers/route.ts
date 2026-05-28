/**
 * GET    /api/items/data-pipeline/[id]/triggers?workspaceId=...
 *   List ADF triggers that reference this pipeline.
 *
 * POST   /api/items/data-pipeline/[id]/triggers?workspaceId=...
 *   body: { name, properties: { type, recurrence, ... } }
 *   Create a new ADF trigger and wire it to this pipeline. If the body
 *   already contains a `properties.pipelines` array, it is honored; otherwise
 *   a default pipeline ref is injected for this pipeline.
 *
 * PUT    /api/items/data-pipeline/[id]/triggers?workspaceId=...&triggerName=...&action=start|stop
 *   Start/stop an existing trigger.
 *
 * DELETE /api/items/data-pipeline/[id]/triggers?workspaceId=...&triggerName=...
 *   Delete a trigger.
 *
 * All operations go through adf-client against the deployed factory. No
 * mock data — empty pipelines just return triggers=[] because the factory
 * genuinely has no triggers wired to that pipeline yet.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import {
  listTriggers, upsertTrigger, startTrigger, stopTrigger, deleteTrigger,
  type AdfTrigger,
} from '@/lib/azure/adf-client';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number) {
  return NextResponse.json({ ok: false, error }, { status });
}

async function getAdfName(id: string, workspaceId: string): Promise<string | null> {
  const items = await itemsContainer();
  const { resource } = await items.item(id, workspaceId).read<WorkspaceItem>();
  if (!resource || resource.itemType !== 'data-pipeline') return null;
  return (resource.state as any)?.adfPipelineName || null;
}

export async function GET(req: NextRequest, ctx: { params: { id: string } }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  try {
    const adfName = await getAdfName(ctx.params.id, workspaceId);
    if (!adfName) return NextResponse.json({ ok: true, triggers: [] });
    const all = await listTriggers();
    const mine = all.filter((t) =>
      (t.properties?.pipelines || []).some((p) => p.pipelineReference?.referenceName === adfName),
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
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  const body = await req.json().catch(() => null) as { name?: string; properties?: AdfTrigger['properties'] } | null;
  if (!body?.name || !body?.properties) return err('body must be { name, properties }', 400);
  try {
    const adfName = await getAdfName(ctx.params.id, workspaceId);
    if (!adfName) return err('Pipeline has no ADF backing — save first', 409);
    // Wire trigger to this pipeline if caller didn't already.
    const wired: AdfTrigger = {
      name: body.name,
      properties: {
        ...body.properties,
        type: body.properties.type || 'ScheduleTrigger',
        pipelines: body.properties.pipelines && body.properties.pipelines.length > 0
          ? body.properties.pipelines
          : [{
              pipelineReference: { referenceName: adfName, type: 'PipelineReference' as const },
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

export async function PUT(req: NextRequest, ctx: { params: { id: string } }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  const triggerName = req.nextUrl.searchParams.get('triggerName');
  const action = req.nextUrl.searchParams.get('action');
  if (!workspaceId) return err('workspaceId required', 400);
  if (!triggerName) return err('triggerName required', 400);
  if (action !== 'start' && action !== 'stop') return err('action must be start|stop', 400);
  try {
    const adfName = await getAdfName(ctx.params.id, workspaceId);
    if (!adfName) return err('Pipeline has no ADF backing', 409);
    if (action === 'start') await startTrigger(triggerName);
    else await stopTrigger(triggerName);
    return NextResponse.json({ ok: true, triggerName, action });
  } catch (e: any) {
    return err(e?.message || String(e), e?.status || 502);
  }
}

export async function DELETE(req: NextRequest, ctx: { params: { id: string } }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  const triggerName = req.nextUrl.searchParams.get('triggerName');
  if (!workspaceId) return err('workspaceId required', 400);
  if (!triggerName) return err('triggerName required', 400);
  try {
    const adfName = await getAdfName(ctx.params.id, workspaceId);
    if (!adfName) return err('Pipeline has no ADF backing', 409);
    await deleteTrigger(triggerName);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return err(e?.message || String(e), e?.status || 502);
  }
}
