/**
 * POST /api/items/azure-sql-database/[id]/mirroring
 *   body { tables? } — enable Azure-native change replication on THIS item's
 *   bound database AND (when LOOM_BRONZE_URL is configured) land a real snapshot
 *   of its tables to ADLS Bronze.
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
 *   configured, Step 2 is skipped with an honest note — Step 1 still runs.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AUTHORITY (GHSA-v8r7-c2p5-mjf2). This was the worst of the thirteen routes the
 * first pass left, and it is an EXFILTRATION primitive, not a DDL one.
 *
 * BEFORE, in source order:
 *
 *   - `enableMirroring(body.server, body.database)` ran under a bare
 *     `withSession` — real `sys.sp_change_feed_enable_db` DDL on a
 *     caller-named database, before ANY ownership check.
 *   - `loadOwnedItem` was not called until AFTER that DDL, and only inside the
 *     `LOOM_BRONZE_URL` branch — where FAILING it returned `ok: true` with a
 *     note. An authorization check whose failure is a 200 is not a check.
 *   - Past it, `MirrorSource` was built from `body.server` / `body.database` and
 *     `runMirrorSnapshot(id, owned.workspaceId, src, …)` performed a full TDS
 *     READ of the caller-named database and landed it in the CALLER'S OWN
 *     workspace Bronze folder. Any signed-in user could name any database the
 *     Console UAMI could reach and read it out into storage they control.
 *   - `enableMirroring` reaches TDS through `azure-sql-client.getPool`, which
 *     composes `server.includes('.') ? server : `${server}.${sqlHostSuffix()}``
 *     and then presents an Entra ACCESS TOKEN for the SQL scope to whatever host
 *     that yields — so an FQDN in `body.server` also egressed a live credential.
 *
 * NOW: `withBoundSqlServer` hands this handler an AUTHORIZED item and an
 * ADMITTED server, so there is no id-shaped parameter left to accept and ignore.
 * The snapshot's `MirrorSource` is built from those admitted coordinates, never
 * from the body — that is the half of this fix that closes the exfiltration, and
 * it is asserted separately from the DDL half in the specs. `admitGovernedServer`
 * reduces an FQDN to its first DNS label, so no reachable value can name a host
 * outside this cloud's SQL suffix, closing the credential-egress path too.
 *
 * `tables` stays caller-chosen — WHICH tables of your own database to mirror is
 * the feature; WHOSE database is not.
 */

import { NextResponse } from 'next/server';
import { enableMirroring } from '@/lib/azure/azure-sql-client';
import { runMirrorSnapshot, type MirrorSource, type MirrorTableSpec, type MirrorTableResult } from '@/lib/azure/mirror-engine';
import { withBoundSqlServer } from '@/app/api/items/_lib/sql-server-scope';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Snapshotting several tables (TDS read + ADLS write each) can take a while.
export const maxDuration = 300;

export const POST = withBoundSqlServer(
  { provider: 'sql', requireDatabase: true },
  async (_req, { session, item, server, database, body }) => {
    // 1) Enable the Azure-native change feed (real DDL; no Fabric) on the
    //    ITEM'S bound database. Reached only after the owner check, unlike
    //    before, where this line ran first and unauthorized.
    const config = await enableMirroring(server, database);

    // 2) Land a real Bronze snapshot when the landing zone is configured. The
    //    item is already authorized by the wrapper, so there is no second
    //    ownership branch here — and therefore no path on which a failed
    //    ownership check returns ok:true.
    if (!process.env.LOOM_BRONZE_URL) {
      return NextResponse.json({
        ok: true,
        config,
        bronzeNote:
          'Change feed enabled. Configure the ADLS Bronze landing zone (set LOOM_BRONZE_URL — a DLZ Bicep output) to land replicated tables to Bronze Delta and get a Synapse Serverless query per table.',
      });
    }

    const oid = session.claims.oid;
    const state = (item.state || {}) as Record<string, any>;
    const explicitTables: MirrorTableSpec[] = Array.isArray(body?.tables)
      ? (body.tables as any[])
          .filter((t: any) => t?.schema && t?.table)
          .map((t: any) => ({ schema: String(t.schema), table: String(t.table) }))
      : [];
    // THE SNAPSHOT SOURCE IS THE ADMITTED BINDING, NOT THE BODY. This is the
    // exfiltration half of the finding: `runMirrorSnapshot` opens a real TDS
    // connection to `src.server` / `src.database` and writes what it reads into
    // `mirrors/<workspaceId>/<id>/` — the caller's own Bronze folder.
    const src: MirrorSource = {
      sourceType: 'AzureSqlDatabase',
      server,
      database,
      tables: explicitTables.length ? explicitTables : undefined,
    };
    // Per-table watermarks from the prior Start drive incremental sync; first run snapshots.
    const prevTableStatus = (Array.isArray(state.mirrorTablesStatus) ? state.mirrorTablesStatus : []) as MirrorTableResult[];

    // N6 — enforce the ODCS contracts bound to this mirror at ingestion.
    const run = await runMirrorSnapshot(item.id, item.workspaceId, src, prevTableStatus, { tenantId: oid });

    // Persist the run so the next Start syncs incrementally and the receipt survives.
    try {
      const items = await itemsContainer();
      const next: WorkspaceItem = {
        ...item,
        state: {
          ...state,
          mirrorTablesStatus: run.tables,
          mirrorLastRun: { at: new Date().toISOString(), status: run.status, basePath: run.basePath, note: run.note, error: run.error, gate: run.gate, changeFeed: run.changeFeed },
        },
        updatedAt: new Date().toISOString(),
      };
      await items.item(item.id, item.workspaceId).replace(next);
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
  },
);
