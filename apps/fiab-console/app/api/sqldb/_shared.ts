/**
 * Shared plumbing for the Azure SQL / Fabric SQL database object-navigator
 * BFF routes (`/api/sqldb/<group>`). Each route:
 *   1. validates the session cookie,
 *   2. resolves the target TDS connection (server + database) item-scoped via
 *      `?workspaceId=<loom ws>` + `?id=<Fabric SqlDatabase id>` — mirroring
 *      the ADX navigator's per-item resolution — falling back to the env
 *      defaults when mounted standalone (dev/smoke),
 *   3. applies the honest config gate ({@link sqlConfigGate}) when no
 *      connection can be resolved,
 *   4. runs real `sys.*` catalog queries over TDS and returns `{ ok, ... }`.
 *
 * Underscore-prefixed file — Next.js does not treat this as a route.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { workspacesContainer } from '@/lib/azure/cosmos-client';
import { getFabricSqlDatabaseConnection, FabricError } from '@/lib/azure/fabric-client';
import { AzureSqlError } from '@/lib/azure/azure-sql-client';
import { sqlConfigGate } from '@/lib/azure/sql-objects-client';
import type { Workspace } from '@/lib/types/workspace';

export interface SqlDbRouteContext {
  server: string;
  database: string;
  oid: string;
  itemId: string | null;
}

export type SqlDbGuardResult =
  | { ctx: SqlDbRouteContext; res?: undefined }
  | { ctx?: undefined; res: NextResponse };

function fabricWsIdOf(ws: Workspace | null): string | null {
  if (!ws) return null;
  const cap: any = (ws as any).capacity;
  if (cap && typeof cap === 'object') return cap.fabricWorkspaceId || cap.id || null;
  // capacity may be a bare string id on legacy records.
  return typeof cap === 'string' && cap ? cap : null;
}

async function loadWs(id: string, tenantId: string): Promise<Workspace | null> {
  const c = await workspacesContainer();
  try {
    const { resource } = await c.item(id, tenantId).read<Workspace>();
    return resource?.tenantId === tenantId ? resource : null;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}

/**
 * Validate session + resolve the TDS connection. The Fabric SQL database id
 * is read from `?id=` and its workspace from `?workspaceId=`. When the item
 * connection can't be resolved we fall back to the env defaults so the
 * navigator still works standalone; if neither yields a server the honest
 * gate fires.
 */
export async function guardSqlDbRequest(req: NextRequest): Promise<SqlDbGuardResult> {
  const session = getSession();
  if (!session) {
    return { res: NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 }) };
  }

  const itemId = req.nextUrl.searchParams.get('id')?.trim() || null;
  const workspaceId = req.nextUrl.searchParams.get('workspaceId')?.trim() || null;

  let server = '';
  let database = '';

  if (itemId && itemId !== 'new' && workspaceId) {
    try {
      const ws = await loadWs(workspaceId, session.claims.oid);
      if (!ws) {
        return { res: NextResponse.json({ ok: false, error: 'workspace not found or not owned by your tenant' }, { status: 404 }) };
      }
      const fabricWs = fabricWsIdOf(ws);
      if (!fabricWs) {
        return {
          res: NextResponse.json({
            ok: false,
            code: 'not_configured',
            error: 'No Fabric workspace attached to this Loom workspace.',
            missing: 'workspace.capacity.fabricWorkspaceId',
          }, { status: 503 }),
        };
      }
      const conn = await getFabricSqlDatabaseConnection(fabricWs, itemId);
      if (conn) { server = conn.server; database = conn.database; }
    } catch (e: any) {
      const status = e instanceof FabricError ? e.status : 502;
      return { res: NextResponse.json({ ok: false, error: e?.message || String(e), hint: e?.hint }, { status }) };
    }
  }

  // Standalone / fallback: env defaults (same vars the SQL editors read).
  if (!server) {
    server = (process.env.NEXT_PUBLIC_LOOM_AZURE_SQL_DEFAULT_SERVER || process.env.LOOM_AZURE_SQL_DEFAULT_SERVER || '').trim();
    database = database || (process.env.NEXT_PUBLIC_LOOM_AZURE_SQL_DEFAULT_DB || process.env.LOOM_AZURE_SQL_DEFAULT_DB || '').trim();
  }

  const gate = sqlConfigGate(server);
  if (gate) {
    return {
      res: NextResponse.json({
        ok: false,
        code: 'not_configured',
        error: `Azure SQL connection not configured: set ${gate.missing}.`,
        missing: gate.missing,
      }, { status: 503 }),
    };
  }
  if (!database) {
    return {
      res: NextResponse.json({
        ok: false,
        code: 'not_configured',
        error: 'Azure SQL database name not resolved (no bound connection and NEXT_PUBLIC_LOOM_AZURE_SQL_DEFAULT_DB unset).',
        missing: 'NEXT_PUBLIC_LOOM_AZURE_SQL_DEFAULT_DB',
      }, { status: 503 }),
    };
  }

  return { ctx: { server, database, oid: session.claims.oid, itemId } };
}

/** Map a thrown error to the right status + JSON envelope. */
export function sqlDbError(e: any): NextResponse {
  const status = e instanceof AzureSqlError ? e.status : 502;
  return NextResponse.json({
    ok: false,
    error: e?.message || String(e),
    code: e?.code,
    sqlNumber: e?.number,
  }, { status });
}
