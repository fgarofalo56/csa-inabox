/**
 * Azure SQL Database — point-in-time restore.
 *
 *   GET  /api/items/azure-sql-database/[id]/restore
 *        → { ok, window, droppedDatabases }                (bound server + database)
 *        ?mode=status&op=<asyncUrl>   → { ok, status, raw }
 *        ?mode=status&target=<db>     → { ok, status, raw }  (fallback)
 *   POST /api/items/azure-sql-database/[id]/restore
 *        body { sourceDatabase|restorableDroppedDatabaseId,
 *               sourceDatabaseDeletionDate?, targetDatabase, restorePointInTime }
 *        → { ok, targetDatabaseId, asyncOperationUrl, status }
 *
 * Pure Azure SQL control plane (Microsoft.Sql/servers/databases
 * createMode=PointInTimeRestore) — zero Microsoft Fabric dependency. A restore
 * always creates a NEW database. Requires the console UAMI to hold
 * "SQL DB Contributor" (9b7fa17d-e63e-47b0-bb0a-15c516ac86ec) — or Contributor
 * — on the server's resource group (same role the scale panel documents). ARM
 * 403 surfaces verbatim with a `hint` so the editor renders an honest gate
 * (no-vaporware.md).
 *
 * AUTHORITY (GHSA-v8r7-c2p5-mjf2). This route USED TO take `server` from the
 * query string / body with `[id]` never read, and its own header asserted that
 * there was "no per-tenant Cosmos item to owner-check". That premise was false:
 * the sibling `[id]/connect` persists exactly such a binding, and `[id]/query`
 * has resolved its target from it since #2723. A restore MOVES DATA — it
 * materialises a readable copy of a source database — so the pre-fix shape let
 * any signed-in caller copy another tenant's database, in any subscription the
 * Console UAMI could reach, into a database they could then query.
 *
 * THREE coordinates are pinned here, not one:
 *   - `server`                     → the item's bound server (withBoundSqlServer).
 *   - `sourceDatabase`             → must be the item's bound database. Pinning
 *                                    only the server would still let a caller
 *                                    restore ANY database on it into a new one
 *                                    they own and read.
 *   - `restorableDroppedDatabaseId`→ a full ARM id copied verbatim into
 *                                    `properties.sourceDatabaseId`, so it is
 *                                    admitted against the bound server's own
 *                                    `restorableDroppedDatabases` scope.
 *
 * `targetDatabase` stays caller-chosen: it is the NEW database's name, created
 * on the pinned server, which is the feature.
 *
 * A FOURTH coordinate exists and is NOT pinned here, stated rather than left to
 * be discovered: GET `?mode=status&op=<asyncOperationUrl>` forwards that URL to
 * `getRestoreOperationStatus`, which polls it directly. It is bounded by that
 * function's own SSRF guard — the URL's origin must equal the configured
 * sovereign ARM host — so it cannot leave ARM, and it returns only an LRO status
 * document. It is a genuine residual (an LRO id for an operation on another
 * subscription could be polled), not a claim of completeness.
 */
import { apiOk, apiError, apiHonestError, apiServerError } from '@/lib/api/respond';
import {
  getRestorableWindow,
  listRestorableDroppedDatabases,
  startPointInTimeRestore,
  getRestoreOperationStatus,
  AzureSqlError,
} from '@/lib/azure/azure-sql-client';
import { validateRestoreRequest } from '@/lib/azure/sql-restore-model';
import {
  withBoundSqlServer,
  admitBoundServerChild,
  scopeRefused,
} from '@/app/api/items/_lib/sql-server-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RESTORE_ROLE_HINT =
  'Grant the console UAMI the "SQL DB Contributor" role ' +
  '(9b7fa17d-e63e-47b0-bb0a-15c516ac86ec) on the SQL server\'s resource group, ' +
  'or deploy platform/fiab/bicep/modules/admin-plane/sql-rbac.bicep by setting ' +
  'loomAzureSqlServerRg in your bicep parameters.';

export const GET = withBoundSqlServer(
  { provider: 'sql', allowReadRoles: true },
  async (req, { server, database }) => {
    const url = new URL(req.url);
    try {
      if (url.searchParams.get('mode') === 'status') {
        const op = url.searchParams.get('op') || undefined;
        // `target` names the NEW database a restore is creating on the bound
        // server, so it is not the bound database and stays caller-supplied;
        // the server it is read against is pinned.
        const target = url.searchParams.get('target') || undefined;
        const status = await getRestoreOperationStatus({ asyncOperationUrl: op, server, targetDatabase: target });
        return apiOk({ status: status.status, raw: status.raw, opError: status.error });
      }
      if (!database) {
        return apiError(
          'This item has no bound database. Open the Connect tab and pick a database before restoring.',
          409,
          { code: 'no_bound_connection' },
        );
      }
      const [window, droppedDatabases] = await Promise.all([
        getRestorableWindow(server, database),
        listRestorableDroppedDatabases(server).catch(() => []),
      ]);
      return apiOk({ window, droppedDatabases });
    } catch (e: any) {
      if (e instanceof AzureSqlError) {
        const hint = e.status === 403 ? RESTORE_ROLE_HINT : undefined;
        return apiHonestError(e, e.status, hint ? `${e.message} — ${hint}` : undefined);
      }
      return apiServerError(e, 'Failed to read the restorable window');
    }
  },
);

export const POST = withBoundSqlServer(
  { provider: 'sql' },
  async (_req, { session, server, database, body }) => {
    const targetDatabase = String(body?.targetDatabase || '').trim();
    const restorePointInTime = String(body?.restorePointInTime || '').trim();
    const submittedSource = body?.sourceDatabase ? String(body.sourceDatabase).trim() : undefined;
    const sourceDatabaseDeletionDate = body?.sourceDatabaseDeletionDate
      ? String(body.sourceDatabaseDeletionDate).trim()
      : undefined;

    // A LIVE-source restore reads the item's OWN bound database. A body source
    // that names a different one is refused rather than silently substituted —
    // restoring a database other than the one the operator named would be worse
    // than saying no.
    let sourceDatabase: string | undefined;
    if (submittedSource || (!body?.restorableDroppedDatabaseId && database)) {
      if (!database) {
        return apiError(
          'This item has no bound database. Open the Connect tab and pick a database before restoring.',
          409,
          { code: 'no_bound_connection' },
        );
      }
      if (submittedSource && submittedSource.toLowerCase() !== database.toLowerCase()) {
        return apiError(
          'The requested source database does not match this item’s bound connection.',
          403,
          { code: 'database_mismatch' },
        );
      }
      sourceDatabase = database;
    }

    // A DROPPED-source restore carries a full ARM id that ARM copies straight
    // into sourceDatabaseId — admit it against the bound server's own scope.
    let restorableDroppedDatabaseId: string | undefined;
    if (body?.restorableDroppedDatabaseId) {
      const admitted = admitBoundServerChild(
        body.restorableDroppedDatabaseId,
        server,
        'sql',
        'restorableDroppedDatabases',
      );
      if (!admitted.ok) return scopeRefused(admitted);
      restorableDroppedDatabaseId = admitted.id;
    }

    // Server-side re-validation of the request shape (the same pure rules the UI
    // gates on). The window bounds are re-read from ARM so a stale client window
    // cannot push an out-of-range restore point.
    try {
      const window = sourceDatabase ? await getRestorableWindow(server, sourceDatabase) : null;
      const existingNames = body?.existingNames && Array.isArray(body.existingNames)
        ? body.existingNames.map(String)
        : undefined;
      const v = validateRestoreRequest({
        window: sourceDatabase ? window : undefined,
        // For a dropped-DB restore there is no live window to bound against here;
        // skip the window check (ARM validates the dropped DB's own retention).
        restorePointInTime,
        targetDatabase,
        existingNames,
        sourceDatabase,
      });
      // Only enforce the window bound for a LIVE source (dropped restores skip it).
      if (sourceDatabase && !v.ok) return apiError(v.error || 'invalid restore request', 400);
      if (!sourceDatabase && !targetDatabase) return apiError('targetDatabase is required', 400);

      const result = await startPointInTimeRestore({
        server,
        targetDatabase,
        restorePointInTime,
        sourceDatabase,
        restorableDroppedDatabaseId,
        sourceDatabaseDeletionDate,
      });
      if (!result.ok) {
        const status = result.errorStatus || 502;
        const hint = status === 403 ? RESTORE_ROLE_HINT : undefined;
        return apiError(
          hint ? `${result.error} — ${hint}` : (result.error || 'restore failed'),
          status,
          { hint },
        );
      }
      return apiOk({
        targetDatabaseId: result.targetDatabaseId,
        asyncOperationUrl: result.asyncOperationUrl,
        status: result.status,
        restoredBy: session.claims.upn,
      });
    } catch (e: any) {
      if (e instanceof AzureSqlError) {
        const hint = e.status === 403 ? RESTORE_ROLE_HINT : undefined;
        return apiHonestError(e, e.status, hint ? `${e.message} — ${hint}` : undefined);
      }
      return apiServerError(e, 'Failed to start the restore');
    }
  },
);
