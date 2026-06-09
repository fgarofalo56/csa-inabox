/**
 * POST /api/items/azure-sql-database/[id]/mirroring
 *   body { server, database, tables? } — enable Azure-native change replication
 *   AND (when LOOM_BRONZE_URL is configured and this is a saved Loom item) land a
 *   real snapshot of the database's tables to ADLS Bronze.
 *
 *   Step 1 — Enable the source change feed via the real `sys.sp_change_feed_enable_db`
 *            (Azure-native CDC, NO Microsoft Fabric). A permission/feature error
 *            surfaces verbatim as config.state:'Error'.
 *   Step 2 — When ADLS Bronze is configured, run the Loom mirror engine to snapshot
 *            each table to Bronze (real TDS read + ADLS write) and return the Bronze
 *            base path + a ready-to-run Synapse Serverless OPENROWSET per table. The
 *            second Start reads only Change-Tracking deltas (incremental).
 *
 *   No Fabric workspace is read or required on any path. When Bronze isn't
 *   configured, or the item isn't a saved Loom item (no workspace to scope the
 *   landing folder), Step 2 is skipped with an honest note — Step 1 still runs.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { enableMirroring } from '@/lib/azure/azure-sql-client';
import { runMirrorSnapshot, type MirrorSource, type MirrorTableSpec, type MirrorTableResult } from '@/lib/azure/mirror-engine';
import { loadOwnedItem } from '../../../_lib/item-crud';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Snapshotting several tables (TDS read + ADLS write each) can take a while.
export const maxDuration = 300;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  if (!body?.server || !body?.database) {
    return NextResponse.json({ ok: false, error: 'server + database required' }, { status: 400 });
  }

  // 1) Enable the Azure-native change feed (real DDL; no Fabric).
  const config = await enableMirroring(body.server, body.database);

  // 2) Land a real Bronze snapshot when the landing zone is configured AND this is
  //    a saved Loom item (so we have a workspace to scope the mirrors/<ws>/<id>/
  //    folder + somewhere to persist watermarks for the next incremental Start).
  if (!process.env.LOOM_BRONZE_URL) {
    return NextResponse.json({
      ok: true,
      config,
      bronzeNote:
        'Change feed enabled. Configure the ADLS Bronze landing zone (set LOOM_BRONZE_URL — a DLZ Bicep output) to land replicated tables to Bronze Delta and get a Synapse Serverless query per table.',
    });
  }

  const oid = session.claims.oid;
  const owned = await loadOwnedItem(id, 'azure-sql-database', oid).catch(() => null);
  if (!owned) {
    return NextResponse.json({
      ok: true,
      config,
      bronzeNote:
        'Change feed enabled. Save this database as a Loom item (it has no bound workspace yet) to land its tables to ADLS Bronze and persist incremental Change-Tracking watermarks.',
    });
  }

  const state = (owned.state || {}) as Record<string, any>;
  const explicitTables: MirrorTableSpec[] = Array.isArray(body?.tables)
    ? body.tables.filter((t: any) => t?.schema && t?.table).map((t: any) => ({ schema: String(t.schema), table: String(t.table) }))
    : [];
  const src: MirrorSource = {
    sourceType: 'AzureSqlDatabase',
    server: String(body.server),
    database: String(body.database),
    tables: explicitTables.length ? explicitTables : undefined,
  };
  // Per-table watermarks from the prior Start drive incremental sync; first run snapshots.
  const prevTableStatus = (Array.isArray(state.mirrorTablesStatus) ? state.mirrorTablesStatus : []) as MirrorTableResult[];

  const run = await runMirrorSnapshot(id, owned.workspaceId, src, prevTableStatus);

  // Persist the run so the next Start syncs incrementally and the receipt survives.
  try {
    const items = await itemsContainer();
    const next: WorkspaceItem = {
      ...owned,
      state: {
        ...state,
        mirrorTablesStatus: run.tables,
        mirrorLastRun: { at: new Date().toISOString(), status: run.status, basePath: run.basePath, note: run.note, error: run.error, gate: run.gate, changeFeed: run.changeFeed },
      },
      updatedAt: new Date().toISOString(),
    };
    await items.item(owned.id, owned.workspaceId).replace(next);
  } catch { /* persistence is best-effort; the snapshot already landed in Bronze */ }

  return NextResponse.json({
    ok: true,
    config,
    bronze: {
      status: run.status,
      backend: run.backend,
      basePath: run.basePath,
      tables: run.tables,
      gate: run.gate,
      note: run.note,
      error: run.error,
    },
  });
}
