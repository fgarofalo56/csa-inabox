/**
 * POST /api/connections/[id]/objects
 *
 * ANALYZE (browse) for a SAVED Loom Connection — the schema → tables tree the
 * Connections page's "Analyze data" dialog expands, so a saved connection is
 * usable for exploration (not just a credential record). This is the connection-
 * keyed twin of the report designer's POST /api/items/report/[id]/connector-
 * objects: it loads the stored connection (tenant-scoped), derives the provider,
 * and delegates to the SAME per-provider introspection + NavNode wire adapter —
 * every node is a REAL introspected object (no-vaporware); an unconfigured
 * backend returns an honest 412 gate. NO Fabric / Power BI / OneLake host is
 * reached on any branch (no-fabric-dependency).
 *
 * Scope: the tabular providers whose introspection reads the CONNECTION'S own
 * backend or the deployment's Azure-native default — SQL family (azure-sql /
 * synapse / generic-sql), Databricks SQL, PostgreSQL, Cosmos DB, and ADX. ADLS /
 * Storage and the non-tabular types (Event Hubs / Service Bus / Key Vault) are
 * honest-gated (browse an ADLS account via the OneLake catalog / shortcuts).
 *
 * 200 → { ok:true, provider, level, capabilities, nodes: NavNode[] }
 * 412 → { ok:false, code:'gate', error, missing? }   (honest, actionable)
 * 400 → { ok:false, error }                           (non-browsable connType)
 * 404 → connection not found · 401 → unauthenticated · 5xx → backend error
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadConnection } from '@/lib/azure/connections-store';
import {
  gate,
  bad,
  fail,
  providerForConnType,
  introspectSql,
  introspectDatabricks,
  introspectPostgres,
  introspectCosmos,
  introspectAdx,
  type NavigatorObject,
  type ObjectsRequest,
} from '@/lib/report/navigator/introspect';
import { resolveCoords, respond } from '@/lib/report/navigator/wire';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const id = (await ctx.params).id;
  const conn = await loadConnection(session.claims.oid, id);
  if (!conn) return NextResponse.json({ ok: false, error: 'connection not found' }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as ObjectsRequest;
  const coords = resolveCoords(body);
  const level = coords.level;

  // ADLS / Storage + the non-tabular types have no connection-scoped tabular tree
  // here — direct the user to the account-correct surface (honest, never a mock).
  if (conn.type === 'storage-adls') {
    return gate(
      `A "${conn.name}" ADLS / Storage connection is browsed by its files in the OneLake catalog or by ` +
        'creating a shortcut — not as a SQL-style table tree. Open OneLake catalog or "Create shortcut" ' +
        'to explore this account.',
      'connType',
    );
  }
  if (conn.type === 'event-hub' || conn.type === 'service-bus' || conn.type === 'key-vault') {
    return gate(
      `A "${conn.type}" connection isn't a tabular data source, so it has no schema to analyze. Use it as ` +
        'a streaming / secret source where it is bound (eventstream, activator, or an item secret).',
      'connType',
    );
  }

  try {
    const provider = providerForConnType(conn.type);
    let objects: NavigatorObject[] | NextResponse;
    switch (provider) {
      case 'sql':
        try {
          objects = await introspectSql(conn, level, coords.schema);
        } catch (e: any) {
          if (e?.gateMissing) return gate(e.message, e.gateMissing);
          throw e;
        }
        break;
      case 'databricks':
        objects = await introspectDatabricks(conn, level, coords.catalog, coords.schema);
        break;
      case 'postgres':
        objects = await introspectPostgres(conn, level, coords.schema);
        break;
      case 'cosmos':
        objects = await introspectCosmos(conn, level);
        break;
      case 'adx':
        objects = await introspectAdx(conn, level);
        break;
      default:
        return bad(
          `A "${conn.type}" connection isn't browsable as a tabular source. Pick an Azure SQL, Synapse, ` +
            'Databricks SQL, PostgreSQL, Cosmos DB, or Azure Data Explorer connection.',
        );
    }
    if (objects instanceof NextResponse) return objects;
    return respond(provider, coords, objects);
  } catch (e: any) {
    return fail(e);
  }
}
