/**
 * GET /api/items/mirrored-database/[id]/tables?workspaceId=...
 *   → { ok, tables: [{schema, table}] }
 *
 * The CREDENTIAL-AWARE table enumerator: unlike the flat
 * /api/items/mirrored-database/source-tables route (which always queries as the
 * Console UAMI), this resolves the mirror's STORED connection and, when that
 * connection carries a SQL login / connection string, resolves the Key Vault
 * secretRef to authenticate to the source with it. So a source that only accepts
 * SQL auth (no Entra admin for the UAMI) still enumerates its real tables — and
 * the credential is read from Key Vault on the server, never sent to the client
 * and never stored in plaintext in Cosmos.
 *
 * Per-family enumerators (same as the mirror engine): SQL catalog (sys.tables) /
 * PostgreSQL information_schema / Cosmos containers. Honest gate when the source
 * family isn't directly enumerable.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { listTablesWithAuth } from '@/lib/azure/sql-objects-client';
import type { SqlExplicitAuth } from '@/lib/azure/azure-sql-client';
import { listPostgresTables } from '@/lib/azure/postgres-flex-client';
import { listContainers } from '@/lib/azure/cosmos-account-client';
import { loadConnection } from '@/lib/azure/connections-store';
import { getKeyVaultSecretValue } from '@/lib/azure/kv-secrets-client';
import { MIRROR_SQL_FAMILY, MIRROR_PG_FAMILY, MIRROR_COSMOS_FAMILY } from '@/lib/azure/mirror-engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number) { return NextResponse.json({ ok: false, error }, { status }); }

/**
 * Resolve the SQL auth for the mirror's stored connection. Returns:
 *   - SqlExplicitAuth when the connection carries a SQL login / connection string
 *     (the secret is fetched from Key Vault by secretRef).
 *   - undefined when the connection is Entra-MI (or there is no connection) — the
 *     caller then enumerates as the Console UAMI.
 */
async function resolveSqlAuth(tenantId: string, connectionId?: string): Promise<SqlExplicitAuth | undefined> {
  if (!connectionId) return undefined;
  const conn = await loadConnection(tenantId, connectionId);
  if (!conn || !conn.secretRef) return undefined;
  if (conn.authMethod === 'connection-string') {
    const connectionString = await getKeyVaultSecretValue(conn.secretRef);
    return { connectionString };
  }
  if (conn.authMethod === 'sql-password') {
    if (!conn.username) return undefined; // can't build SQL auth without a login
    const password = await getKeyVaultSecretValue(conn.secretRef);
    return { user: conn.username, password };
  }
  // service-principal / account-key are not TDS logins — fall back to UAMI.
  return undefined;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);

  try {
    const items = await itemsContainer();
    const { resource } = await items.item((await ctx.params).id, workspaceId).read<WorkspaceItem>();
    if (!resource || resource.itemType !== 'mirrored-database') return err('mirrored database not found', 404);
    const st = (resource.state || {}) as Record<string, any>;
    const def = st?.definition?.properties?.source?.typeProperties || {};
    const sourceType = String(st.sourceType || st?.definition?.properties?.source?.type || '');
    const server = String(st.server || def.server || '');
    const database = String(st.database || def.database || '');
    const connectionId: string | undefined = st.connectionId || undefined;

    if (!database) return err('this mirror has no source database set; edit the mirror first', 400);

    let tables: Array<{ schema: string; table: string }> = [];
    if (MIRROR_SQL_FAMILY.has(sourceType)) {
      if (!server) return err('this mirror has no source server set; edit the mirror first', 400);
      const auth = await resolveSqlAuth(s.claims.oid, connectionId);
      tables = (await listTablesWithAuth(server, database, auth)).map((t) => ({ schema: t.schema, table: t.name }));
    } else if (MIRROR_PG_FAMILY.has(sourceType)) {
      if (!server) return err('this mirror has no source server set; edit the mirror first', 400);
      tables = await listPostgresTables(server, database);
    } else if (MIRROR_COSMOS_FAMILY.has(sourceType)) {
      tables = (await listContainers(database)).map((c: any) => ({ schema: 'cosmos', table: c.name || c.id }));
    } else {
      return NextResponse.json(
        { ok: false, gate: true, error: `${sourceType || 'This source'} can't be enumerated here — leave the table list empty to mirror everything the engine discovers.` },
        { status: 200 },
      );
    }
    tables.sort((a, b) => `${a.schema}.${a.table}`.localeCompare(`${b.schema}.${b.table}`));
    return NextResponse.json({ ok: true, tables });
  } catch (e: any) {
    if (e?.code === 404) return err('mirrored database not found', 404);
    return err(e?.message || String(e), e?.status || 500);
  }
}
