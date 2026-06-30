/**
 * POST /api/items/gql-graph/[id]/query
 *   body: { query: string, mode?: 'kql-graph' | 'opencypher', database?: string,
 *           backend?: 'adx' | 'fabric' }
 *
 * Azure-native graph query — the Loom equivalent of "Graph in Fabric" (which is
 * itself built on the Kusto graph engine). By DEFAULT this runs on Azure Data
 * Explorer (ADX) so it works across every Azure boundary (Commercial, Gov,
 * air-gapped) with NO Microsoft Fabric dependency:
 *
 *   1. The graph-model materialize step created Node_<type> (id, props) and
 *      Edge_<type> (src, dst, props) tables in ADX.
 *   2. Here we auto-discover those tables and build a labeled property graph with
 *      KQL `make-graph`, then run the caller's pattern query (KQL `graph-match`,
 *      or openCypher via the engine's `#crp query_language=opencypher` directive
 *      — the same engine surface Fabric Graph exposes).
 *
 * Fabric Graph REST remains available ONLY as an explicit opt-in
 * (backend:'fabric' + LOOM_GQL_GRAPH_BACKEND=fabric + a bound workspace) per
 * .claude/rules/no-fabric-dependency.md — it is never the default path.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { executeQuery, listTables, kustoConfigGate, defaultDatabase, KustoError } from '@/lib/azure/kusto-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Build the `make-graph` prelude from the materialized Node_ and Edge_ tables. */
function buildGraphPrelude(nodeTables: string[], edgeTables: string[]): string {
  // Each Node_<T> carries `id`; tag it with nodeLabel so graph-match patterns can
  // filter by type. Each Edge_<T> carries src/dst; tag with edgeLabel.
  // 'Node_' and 'Edge_' are both 5-char prefixes; slice them off for the label.
  const nodeUnion = nodeTables
    .map((t) => `(${t} | extend nodeLabel='${t.slice(5)}')`)
    .join(', ');
  const edgeUnion = edgeTables
    .map((t) => `(${t} | extend edgeLabel='${t.slice(5)}')`)
    .join(', ');
  return [
    // KQL reserves identifiers that start/end with `__` → SEM0041. Use plain names.
    `let LoomNodes = union ${nodeUnion};`,
    `let LoomEdges = union ${edgeUnion};`,
    `let G = LoomEdges | make-graph src --> dst with LoomNodes on id;`,
  ].join('\n');
}

export async function POST(req: NextRequest, _ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const query: string = (body?.query || '').toString();
  const mode: string = body?.mode === 'opencypher' ? 'opencypher' : 'kql-graph';
  const backend: string = body?.backend || (process.env.LOOM_GQL_GRAPH_BACKEND === 'fabric' ? 'fabric' : 'adx');
  if (!query.trim()) {
    return NextResponse.json({ ok: false, error: 'query required' }, { status: 400 });
  }

  // ── Fabric (opt-in only) ───────────────────────────────────────────────
  if (backend === 'fabric') {
    const workspace = process.env.LOOM_FABRIC_GRAPH_WORKSPACE;
    if (!workspace) {
      return NextResponse.json({
        ok: false,
        error: 'Fabric Graph backend is opt-in and requires LOOM_FABRIC_GRAPH_WORKSPACE. The default Azure-native ADX backend needs no Fabric — omit backend:"fabric" to use it.',
      }, { status: 400 });
    }
    return NextResponse.json({
      ok: false,
      error: 'Fabric Graph backend selected but the optional fabric-graph client is not enabled in this build. Use the default ADX backend.',
    }, { status: 501 });
  }

  // ── Azure-native default: ADX Kusto graph engine ───────────────────────
  const gate = kustoConfigGate();
  if (gate) {
    return NextResponse.json({
      ok: false,
      code: 'not_configured',
      error: `Graph query needs Azure Data Explorer. Set ${gate.missing} (the ADX cluster that backs Loom graphs) and grant the Console UAMI Database Viewer. No Microsoft Fabric required.`,
    }, { status: 503 });
  }

  const db = String(body?.database || defaultDatabase());
  try {
    const tables = await listTables(db);
    const nodeTables = tables.map((t) => t.name).filter((n) => n.startsWith('Node_'));
    const edgeTables = tables.map((t) => t.name).filter((n) => n.startsWith('Edge_'));
    if (nodeTables.length === 0 || edgeTables.length === 0) {
      return NextResponse.json({
        ok: false,
        error: 'No materialized graph found. Define node + edge types in the graph model and click Materialize first (creates Node_*/Edge_* tables in ADX).',
      }, { status: 400 });
    }

    const prelude = buildGraphPrelude(nodeTables, edgeTables);
    // openCypher: the ADX engine accepts the documented client-request-property
    // directives inline; the graph reference is the `G` built above. KQL-graph:
    // the caller's query references `G` directly (e.g. `G | graph-match ...`).
    const directives = mode === 'opencypher'
      ? '#crp query_language=opencypher\n#crp query_graph_reference=G\n'
      : '';
    const full = `${directives}${prelude}\n${query}`;

    const result = await executeQuery(db, full);
    return NextResponse.json({
      ok: true,
      backend: 'adx',
      mode,
      database: db,
      graph: { nodeTables, edgeTables },
      ...result,
    });
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 502;
    const raw = (e?.message || String(e)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return NextResponse.json({ ok: false, error: raw.slice(0, 600) }, { status: status === 401 || status === 403 ? 200 : 502 });
  }
}
