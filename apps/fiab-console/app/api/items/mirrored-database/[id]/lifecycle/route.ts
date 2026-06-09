/**
 * POST /api/items/mirrored-database/[id]/lifecycle?workspaceId=...
 *   body: { action: 'stop' | 'start' | 'restart' }
 *
 * Unified replication lifecycle control with a before/after status receipt
 * (satisfying the acceptance criterion: "status before/after + ADF run state").
 *
 *   stop    → marks the mirror Stopped in Cosmos; the source change feed +
 *             already-landed snapshots remain. Subsequent source changes are NOT
 *             replicated until Start/Restart (confirmable via the Monitor tab).
 *   start   → runs the direct-engine snapshot (incremental when CT watermarks
 *             exist, full snapshot otherwise) and persists real per-table metrics.
 *   restart → clears all per-table change-tracking watermarks → full re-snapshot
 *             of every table from scratch.
 *
 * The response always includes before.mirroringStatus, after.mirroringStatus,
 * and (when LOOM_ADF_NAME is configured) adfLastRun so the client can compare
 * states. All operations call real Azure backends (Cosmos + TDS/ADLS via the
 * mirror engine + ADF queryPipelineRuns) — no mocks.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';
import {
  runMirrorSnapshot, restartMirrorSnapshot, getMirrorStatus,
  type MirrorSource, type MirrorTableSpec, type MirrorTableResult,
} from '@/lib/azure/mirror-engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// A full re-snapshot of several tables (TDS read + ADLS write each) can take a while.
export const maxDuration = 300;

function err(error: string, status: number) { return NextResponse.json({ ok: false, error }, { status }); }

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
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  const body = await req.json().catch(() => ({}));
  const action = body?.action;
  if (action !== 'stop' && action !== 'start' && action !== 'restart') {
    return err("action must be 'stop', 'start', or 'restart'", 400);
  }

  try {
    const items = await itemsContainer();
    const { resource: existing } = await items.item((await ctx.params).id, workspaceId).read<WorkspaceItem>();
    if (!existing || existing.itemType !== 'mirrored-database') return err('mirrored database not found', 404);
    const state = (existing.state || {}) as Record<string, any>;
    const before = { mirroringStatus: state.mirroringStatus || 'NotStarted' };

    if (action === 'stop') {
      const nextState = { ...state, mirroringStatus: 'Stopped', lastStateChange: new Date().toISOString() };
      const next: WorkspaceItem = { ...existing, state: nextState, updatedAt: new Date().toISOString() };
      await items.item(existing.id, workspaceId).replace(next);
      // Best-effort ADF telemetry so the receipt still carries the ADF run state.
      const monitor = await getMirrorStatus(existing.id, workspaceId, nextState, existing.displayName);
      return NextResponse.json({
        ok: true, action,
        before, after: { mirroringStatus: 'Stopped' },
        adfLastRun: monitor.adfLastRun,
        note: 'Mirror stopped. The source change feed and landed snapshots remain; Start to resume. ' +
          'New source changes are not replicated while stopped.',
      });
    }

    // ---- start / restart: run the real Azure-native mirror ----
    const src = sourceFromState(state);
    const prevTableStatus = (action === 'restart'
      ? []
      : (Array.isArray(state.tablesStatus) ? state.tablesStatus : [])) as MirrorTableResult[];

    const run = action === 'restart'
      ? await restartMirrorSnapshot(existing.id, workspaceId, src)
      : await runMirrorSnapshot(existing.id, workspaceId, src, prevTableStatus);

    const mirroringStatus = run.status === 'Running' ? 'Running' : run.status === 'Gated' ? 'NotStarted' : 'Error';
    const nextState = {
      ...state,
      mirroringStatus,
      lastStateChange: new Date().toISOString(),
      tablesStatus: run.tables,
      lastRun: { at: new Date().toISOString(), status: run.status, basePath: run.basePath, note: run.note, error: run.error, gate: run.gate, changeFeed: run.changeFeed },
    };
    const next: WorkspaceItem = { ...existing, state: nextState, updatedAt: new Date().toISOString() };
    await items.item(existing.id, workspaceId).replace(next);

    const monitor = await getMirrorStatus(existing.id, workspaceId, nextState, existing.displayName);

    if (run.status === 'Gated') {
      return NextResponse.json({
        ok: false, action,
        before, after: { mirroringStatus },
        gate: run.gate, adfLastRun: monitor.adfLastRun, note: run.note,
      });
    }
    return NextResponse.json({
      ok: run.ok, action,
      before, after: { mirroringStatus },
      tables: run.tables,
      changeFeed: run.changeFeed,
      basePath: run.basePath,
      adfLastRun: monitor.adfLastRun,
      note: run.note,
      error: run.error,
    });
  } catch (e: any) { return err(e?.message || String(e), 500); }
}
