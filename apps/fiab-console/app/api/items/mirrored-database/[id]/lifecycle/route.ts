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
import { NextResponse } from 'next/server';
import { apiError, apiServerError } from '@/lib/api/respond';
import { withSession } from '@/lib/api/route-toolkit';
import { authorizeItemWorkspace } from '@/lib/auth/workspace-guard';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';
import {
  runMirrorSnapshot, restartMirrorSnapshot, getMirrorStatus,
  type MirrorSource, type MirrorTableSpec, type MirrorTableResult,
} from '@/lib/azure/mirror-engine';
import {
  resolveSqlAuthDescribed, resolvePgAuthDescribed, UAMI_AUTH,
  type ConnectionAuthDescriptor,
} from '@/lib/azure/connection-auth';
import { MIRROR_PG_FAMILY } from '@/lib/azure/mirror-engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// A full re-snapshot of several tables (TDS read + ADLS write each) can take a while.
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
    includeIcebergTables: !!(state?.includeIcebergTables ?? def.includeIcebergTables),
    syncMode: ((): MirrorSource['syncMode'] => {
      const m = String(state?.syncMode ?? def.syncMode ?? '').trim();
      return m === 'snapshot' || m === 'incremental' || m === 'continuous' ? m : undefined;
    })(),
  };
}

/**
 * Attach the mirror's stored source credential to the MirrorSource.
 *
 * This is the step that was MISSING: the mirroring wizard collects a Loom
 * Connection and `/sources` persists its `connectionId` on the item, but
 * `sourceFromState()` never read it, `MirrorSource` had no field for it, and
 * the engine contained zero references to it. Every Start/Restart therefore
 * ran as the Console UAMI and silently ignored the credential the operator
 * configured — a source reachable only by a stored SQL login could have its
 * tables browsed (that route did resolve the connection) but never replicated.
 *
 * The resolved secret lives only on the in-memory MirrorSource for the duration
 * of this request. It is never written back to item state and never returned in
 * the response — only the non-secret `ConnectionAuthDescriptor` is, so the
 * receipt can state WHICH identity read the source without exposing anything.
 */
async function withSourceAuth(
  tenantId: string, src: MirrorSource, connectionId?: string,
): Promise<{ src: MirrorSource; descriptor: ConnectionAuthDescriptor }> {
  if (!connectionId) return { src, descriptor: UAMI_AUTH };
  if (MIRROR_PG_FAMILY.has(src.sourceType)) {
    const { auth, descriptor } = await resolvePgAuthDescribed(tenantId, connectionId);
    return { src: { ...src, pgAuth: auth }, descriptor };
  }
  const { auth, descriptor } = await resolveSqlAuthDescribed(tenantId, connectionId);
  return { src: { ...src, auth }, descriptor };
}

export const POST = withSession(async (req, { session: s, params }) => {
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return apiError('workspaceId required', 400);
  // #2947 — was owner-only `assertOwner` ("did you CREATE this workspace"),
  // which 404'd a tenant admin / shared member. Canonical ladder, write-scoped.
  {
    const denied = await authorizeItemWorkspace(s, {
      workspaceId, itemId: params.id, itemType: 'mirrored-database',
      notFound: 'mirrored database not found',
    });
    if (denied) return denied;
  }
  const body = await req.json().catch(() => ({}));
  const action = body?.action;
  if (action !== 'stop' && action !== 'start' && action !== 'restart') {
    return apiError("action must be 'stop', 'start', or 'restart'", 400);
  }

  try {
    const items = await itemsContainer();
    const { resource: existing } = await items.item(params.id, workspaceId).read<WorkspaceItem>();
    if (!existing || existing.itemType !== 'mirrored-database') return apiError('mirrored database not found', 404);
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
    // Bind the operator's stored connection credential (Key Vault-backed) to
    // the run. Without this the engine reads as the Console UAMI regardless of
    // what the mirroring wizard collected.
    const { src, descriptor: sourceAuth } = await withSourceAuth(
      s.claims.oid, sourceFromState(state), state.connectionId ? String(state.connectionId) : undefined,
    );
    const prevTableStatus = (action === 'restart'
      ? []
      : (Array.isArray(state.tablesStatus) ? state.tablesStatus : [])) as MirrorTableResult[];

    // N6 — enforce the ODCS contracts bound to this mirror at ingestion.
    const enforceCtx = { tenantId: s.claims.oid };
    const run = action === 'restart'
      ? await restartMirrorSnapshot(existing.id, workspaceId, src, enforceCtx)
      : await runMirrorSnapshot(existing.id, workspaceId, src, prevTableStatus, enforceCtx);

    const mirroringStatus = run.status === 'Running' ? 'Running' : run.status === 'Gated' ? 'NotStarted' : 'Error';
    const nextState = {
      ...state,
      mirroringStatus,
      lastStateChange: new Date().toISOString(),
      tablesStatus: run.tables,
      // `sourceAuth` is the NON-SECRET descriptor (identity + connection name +
      // auth method). No credential material is persisted here — the resolved
      // secret never leaves the in-memory MirrorSource for this request.
      lastRun: { at: new Date().toISOString(), status: run.status, basePath: run.basePath, note: run.note, error: run.error, gate: run.gate, changeFeed: run.changeFeed, sourceAuth },
    };
    const next: WorkspaceItem = { ...existing, state: nextState, updatedAt: new Date().toISOString() };
    await items.item(existing.id, workspaceId).replace(next);

    const monitor = await getMirrorStatus(existing.id, workspaceId, nextState, existing.displayName);

    if (run.status === 'Gated') {
      return NextResponse.json({
        ok: false, action,
        before, after: { mirroringStatus },
        gate: run.gate, adfLastRun: monitor.adfLastRun, note: run.note,
        sourceAuth,
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
      // Which identity read the source. Non-secret by construction.
      sourceAuth,
    });
  } catch (e: any) { return apiServerError(e); }
});
