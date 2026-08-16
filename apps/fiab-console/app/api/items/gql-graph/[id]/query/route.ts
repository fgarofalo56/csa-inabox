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
 *
 * SECURITY — GHSA-v2g8-gp3r-rg4r. This route is the SIBLING of
 * `graph-model/[id]/query` and carried the identical defect, which the first
 * pass at that advisory missed: `_ctx` accepted and ignored (so `[id]` was
 * never read), `getSession()` as the only check, `const db =
 * String(body?.database || defaultDatabase())` straight into `executeQuery`,
 * and the caller's `query` CONCATENATED RAW after the generated prelude.
 *
 * No bypass was needed. Point `database` at a graph database you own so the
 * `Node_*`/`Edge_*` discovery below is satisfied, then send
 * `database('victim').['Secrets'] | take 100` as `query` — it lands verbatim in
 * the executed text and runs as the Console's UAMI, which reaches every
 * database on the shared ADX cluster. Fixing `graph-model/[id]/query` alone
 * would have RELOCATED the read primitive to this URL rather than removing it.
 *
 * Both bindings are applied here, exactly as on the sibling: the caller is
 * authorized against the gql-graph item and the database is resolved FROM THAT
 * ITEM (`_lib/adx-item-scope.ts`), and the assembled KQL is refused if it
 * carries a `database(…)` / `cluster(…)` qualifier.
 */
import { NextRequest, NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/azure/rate-limiter';
import { executeQuery, listTables, kustoConfigGate, KustoError } from '@/lib/azure/kusto-client';
import {
  guardAdxItemRequest, crossDatabaseReference, crossDatabaseRefused,
} from '../../../_lib/adx-item-scope';

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

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  // LAYER 1 + LAYER 2 — authorize the caller against the gql-graph item and take
  // the database FROM THAT ITEM. Read-only surface, so shared read roles are
  // admitted, matching the sibling graph-model query pane.
  const guard = await guardAdxItemRequest({
    itemId: id,
    itemType: 'gql-graph',
    notFound: 'graph not found',
    allowReadRoles: true,
  });
  if (guard.res) return guard.res;
  const { session: s, database: db } = guard.ctx;

  const limited = await enforceRateLimit(s, 'query');
  if (limited) return limited;

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

    // The database is pinned above; this stops the caller's `query` — which is
    // concatenated RAW after the prelude — from stepping out of it. Checked on
    // the ASSEMBLED text, so a qualifier cannot be smuggled in through either
    // half. `buildGraphPrelude` only ever names local `Node_*`/`Edge_*` tables,
    // so a legitimate graph query never trips this.
    const qualifier = crossDatabaseReference(full);
    if (qualifier) return crossDatabaseRefused(qualifier, db);

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
