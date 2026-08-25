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
import { apiError } from '@/lib/api/respond';
import { authorizeItemWorkspace } from '@/lib/auth/workspace-guard';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { listTablesWithAuth } from '@/lib/azure/sql-objects-client';
import type { SqlExplicitAuth } from '@/lib/azure/azure-sql-client';
import { listPostgresTables } from '@/lib/azure/postgres-flex-client';
import { listContainers } from '@/lib/azure/cosmos-account-client';
// One shared credential path (lib/azure/connection-auth) — this route used to
// carry a private copy of this logic, which is exactly why the replication path
// could diverge from it and silently ignore the stored connection.
import { resolveSqlAuth, resolveConnectionType } from '@/lib/azure/connection-auth';
import { describeMirrorConnMismatch } from '@/lib/azure/mirror-source-compat';
import { withSession } from '@/lib/api/route-toolkit';
import { MIRROR_SQL_FAMILY, MIRROR_PG_FAMILY, MIRROR_COSMOS_FAMILY, MIRROR_ADF_COPY_FAMILY } from '@/lib/azure/mirror-engine';
import { listSnowflakeTables } from '@/lib/azure/snowflake-adf';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';



export const GET = withSession<{ id: string }>(async (req: NextRequest, { session: s, params }) => {
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return apiError('workspaceId required', 400);
  // #2947 — was owner-only `assertOwner` ("did you CREATE this workspace"),
  // which 404'd a tenant admin / shared member. Canonical ladder, read-scoped.
  {
    const denied = await authorizeItemWorkspace(s, {
      workspaceId, itemId: params.id, itemType: 'mirrored-database',
      allowReadRoles: true,
      notFound: 'mirrored database not found',
    });
    if (denied) return denied;
  }

  try {
    const items = await itemsContainer();
    const { resource } = await items.item(params.id, workspaceId).read<WorkspaceItem>();
    if (!resource || resource.itemType !== 'mirrored-database') return apiError('mirrored database not found', 404);
    const st = (resource.state || {}) as Record<string, any>;
    const def = st?.definition?.properties?.source?.typeProperties || {};
    const sourceType = String(st.sourceType || st?.definition?.properties?.source?.type || '');
    const server = String(st.server || def.server || '');
    const database = String(st.database || def.database || '');
    const connectionId: string | undefined = st.connectionId || undefined;

    if (!database) return apiError('this mirror has no source database set; edit the mirror first', 400);

    // Same refusal as the pre-create enumerator, for the SAME reason: the family
    // dispatch below reads `sourceType` only, so a mirror typed Azure SQL with a
    // Snowflake connection bound would be read over TDS against a hostname this
    // platform constructs. Checked before any branch dials (R7).
    {
      const connType = await resolveConnectionType(s.claims.oid, connectionId);
      const mismatch = describeMirrorConnMismatch({ sourceType, connType });
      if (mismatch) return NextResponse.json({ ok: false, gate: true, error: mismatch.message }, { status: 200 });
    }

    let tables: Array<{ schema: string; table: string }> = [];
    if (MIRROR_SQL_FAMILY.has(sourceType)) {
      if (!server) return apiError('this mirror has no source server set; edit the mirror first', 400);
      const auth = await resolveSqlAuth(s.claims.oid, connectionId);
      tables = (await listTablesWithAuth(server, database, auth)).map((t) => ({ schema: t.schema, table: t.name }));
    } else if (MIRROR_PG_FAMILY.has(sourceType)) {
      if (!server) return apiError('this mirror has no source server set; edit the mirror first', 400);
      tables = await listPostgresTables(server, database);
    } else if (MIRROR_COSMOS_FAMILY.has(sourceType)) {
      tables = (await listContainers(database)).map((c: any) => ({ schema: 'cosmos', table: c.name || c.id }));
    } else if (MIRROR_ADF_COPY_FAMILY.has(sourceType)) {
      // Snowflake: enumerated via the ADF Lookup that uses the mirror's own
      // auto-bound linked service, so the credential path here is the SAME one
      // the Copy runtime replicates with.
      const listed = await listSnowflakeTables(s.claims.oid, connectionId, database);
      if ('gate' in listed) {
        return NextResponse.json({ ok: false, gate: true, error: listed.gate.message }, { status: 200 });
      }
      const sf = listed.tables
        .map((t) => ({ schema: t.schema, table: t.table, isIceberg: t.isIceberg }))
        .sort((a, b) => `${a.schema}.${a.table}`.localeCompare(`${b.schema}.${b.table}`));
      return NextResponse.json({ ok: true, tables: sf, icebergKnown: listed.icebergKnown });
    } else {
      return NextResponse.json(
        { ok: false, gate: true, error: `${sourceType || 'This source'} can't be enumerated here — leave the table list empty to mirror everything the engine discovers.` },
        { status: 200 },
      );
    }
    tables.sort((a, b) => `${a.schema}.${a.table}`.localeCompare(`${b.schema}.${b.table}`));
    return NextResponse.json({ ok: true, tables });
  } catch (e: any) {
    if (e?.code === 404) return apiError('mirrored database not found', 404);
    return apiError(e?.message || String(e), e?.status || 500);
  }
});
