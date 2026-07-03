/**
 * POST /api/items/graph-model/[id]/query
 *   Run a graph query over the materialized graph-model tables in Azure Data
 *   Explorer. Azure-native, NO Fabric — the engine is ADX `make-graph` +
 *   `graph-match`. GQL/openCypher is translated to KQL via the shared
 *   `cypherToKql` translator over a `make-graph` source expression built from
 *   the model's node + edge tables; raw KQL is also accepted.
 *
 *   Body: { database?, gql?, kql?, nodeTables?:string[], edgeTables?:string[] }
 *     - gql  : MATCH (a:Customer)-[e:PLACED]->(b:Order) RETURN a.id, b.id
 *     - kql  : full KQL (run verbatim; advanced/escape hatch)
 *   Returns: { ok, database, mode, kql, columns, columnTypes, rows, rowCount,
 *             executionMs } | { ok:false, error, gate? }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { enforceRateLimit } from '@/lib/azure/rate-limiter';
import { executeQuery, defaultDatabase, kustoConfigGate, KustoError } from '@/lib/azure/kusto-client';
import { cypherToKql, TranslationError } from '@/lib/azure/cypher-kql-translator';

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

export async function POST(req: NextRequest, _ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
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
  const database = String(body?.database || defaultDatabase());
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

  try {
    const result = await executeQuery(database, kql);
    return NextResponse.json({ ok: true, database, mode, kql, ...result, executedBy: session.claims.upn });
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body, kql }, { status });
  }
}
