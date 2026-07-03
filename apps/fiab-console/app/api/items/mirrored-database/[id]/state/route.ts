/**
 * POST /api/items/mirrored-database/[id]/state?workspaceId=...
 *   body: { action: 'start' | 'stop' }
 *
 * Start runs the REAL Azure-native mirror (no Fabric): it reads the mirror's
 * stored source config, enables the source change feed, snapshots each table to
 * ADLS Bronze, and persists real per-table metrics. Stop marks the mirror
 * Stopped (the change feed + landed data remain). See lib/azure/mirror-engine.ts.
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api/respond';
import { getSession } from '@/lib/auth/session';
import { assertOwner } from '@/lib/auth/workspace-guard';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { runMirrorSnapshot, type MirrorSource, type MirrorTableSpec, type MirrorTableResult } from '@/lib/azure/mirror-engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Snapshotting several tables (TDS read + ADLS write each) can take a while.
export const maxDuration = 300;



/** Resolve the mirror's source config from item.state (with definition fallback). */
function sourceFromState(state: Record<string, any>): MirrorSource {
  const def = state?.definition?.properties?.source?.typeProperties || {};
  const tables: MirrorTableSpec[] = Array.isArray(state?.tables)
    ? state.tables.filter((t: any) => t?.schema && t?.table).map((t: any) => ({ schema: String(t.schema), table: String(t.table) }))
    : [];
  return {
    sourceType: String(state?.sourceType || state?.definition?.properties?.source?.type || ''),
    server: String(state?.server || def.server || ''),
    database: String(state?.database || def.database || ''),
    tables,
  };
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return apiError('workspaceId required', 400);
  if (!(await assertOwner(workspaceId, s.claims.oid))) return apiError('mirrored database not found', 404);
  const body = await req.json().catch(() => ({}));
  const action = body?.action;
  if (action !== 'start' && action !== 'stop') return apiError("action must be 'start' or 'stop'", 400);

  try {
    const items = await itemsContainer();
    const { resource: existing } = await items.item((await ctx.params).id, workspaceId).read<WorkspaceItem>();
    if (!existing || existing.itemType !== 'mirrored-database') return apiError('mirrored database not found', 404);
    const state = (existing.state || {}) as Record<string, any>;

    if (action === 'stop') {
      const next: WorkspaceItem = {
        ...existing,
        state: { ...state, mirroringStatus: 'Stopped', lastStateChange: new Date().toISOString() },
        updatedAt: new Date().toISOString(),
      };
      await items.item(existing.id, workspaceId).replace(next);
      return NextResponse.json({ ok: true, action, status: { mirroringStatus: 'Stopped' }, note: 'Mirror stopped. The change feed and landed snapshots remain; Start to re-sync.' });
    }

    // ---- start: run the real Azure-native mirror ----
    const src = sourceFromState(state);
    // Per-table watermarks from the prior run let the SQL family sync only the
    // changes since last Start (incremental); the first run has none → snapshot.
    const prevTableStatus = (Array.isArray(state.tablesStatus) ? state.tablesStatus : []) as MirrorTableResult[];
    const run = await runMirrorSnapshot(existing.id, workspaceId, src, prevTableStatus);

    const mirroringStatus = run.status === 'Running' ? 'Running' : run.status === 'Gated' ? 'NotStarted' : 'Error';
    const next: WorkspaceItem = {
      ...existing,
      state: {
        ...state,
        mirroringStatus,
        lastStateChange: new Date().toISOString(),
        tablesStatus: run.tables,
        lastRun: { at: new Date().toISOString(), status: run.status, engine: run.engine, cdcName: run.cdcName, basePath: run.basePath, note: run.note, error: run.error, gate: run.gate, changeFeed: run.changeFeed },
      },
      updatedAt: new Date().toISOString(),
    };
    await items.item(existing.id, workspaceId).replace(next);

    if (run.status === 'Gated') {
      return NextResponse.json({ ok: false, action, status: { mirroringStatus }, gate: run.gate, note: run.note }, { status: 200 });
    }
    return NextResponse.json({
      ok: run.ok,
      action,
      status: { mirroringStatus },
      tables: run.tables,
      engine: run.engine,
      cdcName: run.cdcName,
      changeFeed: run.changeFeed,
      basePath: run.basePath,
      note: run.note,
      error: run.error,
    });
  } catch (e: any) { return apiError(e?.message || String(e), 500); }
}
