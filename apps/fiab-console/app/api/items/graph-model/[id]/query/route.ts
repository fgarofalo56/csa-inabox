/**
 * POST /api/items/graph-model/[id]/query
 *   Run a graph query over the materialized graph-model tables in Azure Data
 *   Explorer. Azure-native, NO Fabric — the engine is ADX `make-graph` +
 *   `graph-match`. GQL/openCypher is translated to KQL via the shared
 *   `cypherToKql` translator over a `make-graph` source expression built from
 *   the model's node + edge tables; raw KQL is also accepted.
 *
 *   Body: { gql?, kql?, nodeTables?:string[], edgeTables?:string[] }
 *     - gql  : MATCH (a:Customer)-[e:PLACED]->(b:Order) RETURN a.id, b.id
 *     - kql  : full KQL (run verbatim; advanced/escape hatch)
 *   Returns: { ok, database, mode, kql, columns, columnTypes, rows, rowCount,
 *             executionMs } | { ok:false, error, gate? }
 *
 * SECURITY — GHSA-v2g8-gp3r-rg4r. This route ran on `getSession()` alone and
 * took `const database = String(body?.database || defaultDatabase())`, so any
 * signed-in user could execute KQL against any database on the shared ADX
 * cluster AS THE CONSOLE'S UAMI (there is no OBO fallback in the Kusto client —
 * the caller's own ADX RBAC is never consulted). It was the READ half of the
 * primitive `[id]/materialize` completed: copy any table into a table you own,
 * then read it back here.
 *
 * Two bindings close it, and both are needed:
 *   1. The caller is authorized against the graph-model item and the database is
 *      resolved FROM THAT ITEM (`_lib/adx-item-scope.ts`, the item-route form of
 *      the `guardAdxRequest` convention). `body.database` is no longer read.
 *   2. Caller-authored KQL is refused when it carries a `database(…)` /
 *      `cluster(…)` qualifier. Pinning the connection's database is NOT
 *      sufficient on its own: KQL can address any database the connection
 *      identity reaches from inside the query text, which for the Console UAMI
 *      is all of them. The translated-GQL path cannot emit those qualifiers
 *      (`graphSource` only ever names `safeIdent`-ed local tables), so this
 *      constrains the raw-KQL escape hatch only.
 */
import { NextRequest, NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/azure/rate-limiter';
import { executeQuery, kustoConfigGate, KustoError } from '@/lib/azure/kusto-client';
import { cypherToKql, TranslationError } from '@/lib/azure/cypher-kql-translator';
import {
  guardAdxItemRequest, crossDatabaseReference, crossDatabaseRefused,
} from '../../../_lib/adx-item-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function safeIdent(s: string): string { return String(s).replace(/[^A-Za-z0-9_]/g, '_'); }

/** A `make-graph` source expression over the model's node/edge tables. Each
 *  unioned row carries a `Label` column (the type name) the translator's
 *  `(a:Label)` predicates compare against. */
function graphSource(nodeTables: string[], edgeTables: string[]): string {
  const nodeSet = nodeTables.length ? nodeTables.map(safeIdent).join(', ') : 'Node_*';
  const edgeSet = edgeTables.length ? edgeTables.map(safeIdent).join(', ') : 'Edge_*';
  return (
    `union withsource=__t ${edgeSet} | extend Label = trim_start('Edge_', __t)\n` +
    `| make-graph src --> dst with (union withsource=__t ${nodeSet} | extend Label = trim_start('Node_', __t)) on id`
  );
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  // LAYER 1 + LAYER 2 — authorize the caller against the graph-model item and
  // take the database FROM THAT ITEM. Read-only surface, so shared Viewer /
  // Contributor roles are admitted (`allowReadRoles`), matching how the editor's
  // query pane is used by workspace members who cannot edit the model.
  const guard = await guardAdxItemRequest({
    itemId: id,
    itemType: 'graph-model',
    notFound: 'graph model not found',
    allowReadRoles: true,
  });
  if (guard.res) return guard.res;
  const { session, database } = guard.ctx;

  const limited = await enforceRateLimit(session, 'query');
  if (limited) return limited;

  const gate = kustoConfigGate();
  if (gate) {
    return NextResponse.json({
      ok: false,
      gate: { remediation: `Azure Data Explorer is not configured. Set ${gate.missing} to query the graph.` },
      error: `ADX not configured (${gate.missing})`,
    });
  }

  const body = await req.json().catch(() => ({}));
  const rawKql = (body?.kql || '').toString().trim();
  const gql = (body?.gql || '').toString().trim();
  const nodeTables: string[] = Array.isArray(body?.nodeTables) ? body.nodeTables : [];
  const edgeTables: string[] = Array.isArray(body?.edgeTables) ? body.edgeTables : [];

  let kql = rawKql;
  let mode: 'gql' | 'kql' = 'kql';
  if (!kql) {
    if (!gql) return NextResponse.json({ ok: false, error: 'gql or kql is required' }, { status: 400 });
    try {
      kql = cypherToKql(gql, graphSource(nodeTables, edgeTables));
      mode = 'gql';
    } catch (e: any) {
      const hint = e instanceof TranslationError && (e as any).hint ? ` (${(e as any).hint})` : '';
      return NextResponse.json({ ok: false, error: `Could not translate GQL: ${e?.message || String(e)}${hint}` }, { status: 400 });
    }
  }
  if (kql.length > 65_536) return NextResponse.json({ ok: false, error: 'query too large (>64KB)' }, { status: 413 });

  // The database is pinned above; this stops the query TEXT from stepping out of
  // it. Checked on the final KQL (raw or translated), never only on the input.
  const qualifier = crossDatabaseReference(kql);
  if (qualifier) return crossDatabaseRefused(qualifier, database);

  try {
    const result = await executeQuery(database, kql);
    return NextResponse.json({ ok: true, database, mode, kql, ...result, executedBy: session.claims.upn });
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body, kql }, { status });
  }
}
