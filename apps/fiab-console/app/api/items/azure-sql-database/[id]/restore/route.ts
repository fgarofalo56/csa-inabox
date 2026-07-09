/**
 * Azure SQL Database — point-in-time restore.
 *
 *   GET  /api/items/azure-sql-database/[id]/restore
 *        ?server=&database=                     → { ok, window, droppedDatabases }
 *        ?server=&mode=status&op=<asyncUrl>      → { ok, status, raw }
 *        ?server=&mode=status&target=<db>        → { ok, status, raw }  (fallback)
 *   POST /api/items/azure-sql-database/[id]/restore
 *        body { server, sourceDatabase|restorableDroppedDatabaseId,
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
 * This route operates on a SHARED Azure SQL server resolved by ARM from the
 * caller-supplied server/database — there is no per-tenant Cosmos item to
 * owner-check (same class as the sibling scale/replication/firewall routes,
 * which are route-guard allowlisted). getSession() gates that the caller is
 * signed in.
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiOk, apiError, apiUnauthorized, apiHonestError, apiServerError } from '@/lib/api/respond';
import {
  getRestorableWindow,
  listRestorableDroppedDatabases,
  startPointInTimeRestore,
  getRestoreOperationStatus,
  AzureSqlError,
} from '@/lib/azure/azure-sql-client';
import { validateRestoreRequest } from '@/lib/azure/sql-restore-model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RESTORE_ROLE_HINT =
  'Grant the console UAMI the "SQL DB Contributor" role ' +
  '(9b7fa17d-e63e-47b0-bb0a-15c516ac86ec) on the SQL server\'s resource group, ' +
  'or deploy platform/fiab/bicep/modules/admin-plane/sql-rbac.bicep by setting ' +
  'loomAzureSqlServerRg in your bicep parameters.';

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return apiUnauthorized();

  const url = new URL(req.url);
  const server = (url.searchParams.get('server') || '').trim();
  if (!server) return apiError('server is required', 400);

  try {
    if (url.searchParams.get('mode') === 'status') {
      const op = url.searchParams.get('op') || undefined;
      const target = url.searchParams.get('target') || undefined;
      const status = await getRestoreOperationStatus({ asyncOperationUrl: op, server, targetDatabase: target });
      return apiOk({ status: status.status, raw: status.raw, opError: status.error });
    }
    const database = (url.searchParams.get('database') || '').trim();
    if (!database) return apiError('database is required', 400);
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
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return apiUnauthorized();

  const body = await req.json().catch(() => ({} as any));
  const server = String(body?.server || '').trim();
  const targetDatabase = String(body?.targetDatabase || '').trim();
  const restorePointInTime = String(body?.restorePointInTime || '').trim();
  const sourceDatabase = body?.sourceDatabase ? String(body.sourceDatabase).trim() : undefined;
  const restorableDroppedDatabaseId = body?.restorableDroppedDatabaseId
    ? String(body.restorableDroppedDatabaseId).trim()
    : undefined;
  const sourceDatabaseDeletionDate = body?.sourceDatabaseDeletionDate
    ? String(body.sourceDatabaseDeletionDate).trim()
    : undefined;

  if (!server) return apiError('server is required', 400);

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
}
