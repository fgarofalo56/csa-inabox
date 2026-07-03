/**
 * GET /api/items/mirrored-database/[id]/monitor?workspaceId=...
 *
 * Real-time monitor snapshot for the Monitor tab:
 *   - per-table replication status from the last engine run (Cosmos tablesStatus),
 *   - true row counts + real last-sync timestamps,
 *   - a live ADLS Bronze landing-folder probe (committed file/byte counts), and
 *   - ADF pipeline-run telemetry for the provisioner-backed Bronze-copy pipeline.
 *
 * Designed for 30-second auto-refresh — GET only, no side effects. All data is
 * real (Cosmos read + ADLS list + ADF queryPipelineRuns); nothing is mocked.
 * See lib/azure/mirror-engine.ts → getMirrorStatus().
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api/respond';
import { getSession } from '@/lib/auth/session';
import { assertOwner } from '@/lib/auth/workspace-guard';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { getMirrorStatus } from '@/lib/azure/mirror-engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';



export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return apiError('workspaceId required', 400);
  if (!(await assertOwner(workspaceId, s.claims.oid))) return apiError('mirrored database not found', 404);
  try {
    const items = await itemsContainer();
    const { resource } = await items.item((await ctx.params).id, workspaceId).read<WorkspaceItem>();
    if (!resource || resource.itemType !== 'mirrored-database') return apiError('mirrored database not found', 404);
    const state = (resource.state || {}) as Record<string, any>;
    const payload = await getMirrorStatus(resource.id, workspaceId, state, resource.displayName);
    return NextResponse.json({ ok: true, ...payload });
  } catch (e: any) {
    if (e?.code === 404) return apiError('mirrored database not found', 404);
    return apiError(e?.message || String(e), 500);
  }
}
