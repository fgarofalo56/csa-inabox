/**
 * POST /api/items/mirrored-database/[id]/state?workspaceId=...
 *   body: { action: 'start' | 'stop' }
 *
 * v3.25: persists action to Cosmos. The actual CDC stream runtime is the
 * loom-mirroring-engine container app (existing); wiring this state
 * action to its control plane lands in a follow-up.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number) { return NextResponse.json({ ok: false, error }, { status }); }

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  const body = await req.json().catch(() => ({}));
  const action = body?.action;
  if (action !== 'start' && action !== 'stop') return err("action must be 'start' or 'stop'", 400);
  try {
    const items = await itemsContainer();
    const { resource: existing } = await items.item((await ctx.params).id, workspaceId).read<WorkspaceItem>();
    if (!existing || existing.itemType !== 'mirrored-database') return err('mirrored database not found', 404);
    const desired = action === 'start' ? 'Running' : 'Stopped';
    const next: WorkspaceItem = {
      ...existing,
      state: { ...(existing.state || {}), mirroringStatus: desired, lastStateChange: new Date().toISOString() },
      updatedAt: new Date().toISOString(),
    };
    await items.item(existing.id, workspaceId).replace(next);
    return NextResponse.json({
      ok: true,
      action,
      status: { mirroringStatus: desired },
      note: 'Status persisted to Cosmos. The loom-mirroring-engine dispatcher lands in a follow-up; CDC stream is not yet live in this release.',
    });
  } catch (e: any) { return err(e?.message || String(e), 500); }
}
