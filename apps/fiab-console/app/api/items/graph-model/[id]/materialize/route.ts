/**
 * POST /api/items/graph-model/[id]/materialize
 *   "Build graph" — materialize a saved graph-model schema into Azure Data
 *   Explorer AND (when source tables are bound) LOAD data, then verify the
 *   graph is constructible with a real `make-graph` query. Azure-native, NO
 *   Fabric — the engine is ADX `make-graph` / `graph-match`.
 *
 *   Per node type → `.create-merge table Node_<name> (id:string, <props…>)`;
 *   per edge type → `.create-merge table Edge_<name> (src:string, dst:string,
 *   <props…>)`. When a type carries a source binding (sourceTable + key
 *   columns + property→column mappings) we additionally `.set-or-append` the
 *   typed/cast rows projected from the source table, so the graph has DATA in
 *   it (closes the empty-tables gap). A final batched count query returns
 *   per-table row counts + a `make-graph` relationship count receipt.
 *
 *   Body: { nodes:[{ name, properties:[{name,type,sourceColumn?}],
 *           sourceDatabase?, sourceTable?, keyColumns?:string[] }],
 *           edges:[{ name, properties:[…], sourceDatabase?, sourceTable?,
 *           originKeyColumns?:string[], targetKeyColumns?:string[] }] }
 *
 *   Returns: { ok, database, created:[{kind,name,command,ok,error?}],
 *             loaded:[{kind,name,table,rows,command,ok,error?}],
 *             counts:{ [table]: rows }, graph:{ relationships } | null,
 *             gate?:{ remediation } }
 *
 * SECURITY — GHSA-v2g8-gp3r-rg4r. This was the worst route in that advisory and
 * both of its halves are fixed here.
 *
 *   1. NO AUTHORIZATION AT ALL. The handler was
 *      `withSession<{ id: string }>(async (req: NextRequest) => …)` — it did not
 *      bind `session`, did not accept `params`, and never read `[id]`. Any
 *      signed-in user, owning nothing, in any tenant, reached it.
 *
 *   2. THE TARGET AND SOURCE DATABASES CAME FROM THE BODY.
 *      `const db = String(body?.database || defaultDatabase())` fed
 *      `.create-merge table` DDL, and `sourceRef(sourceDatabase, sourceTable)`
 *      fed `.set-or-append <t> <| database('<any db>').['<any table>']` — a
 *      CROSS-DATABASE COPY executed as the Console's UAMI, which reaches every
 *      database on the shared cluster. Paired with `[id]/query` (which also took
 *      `body.database`) that is a complete read primitive: copy any table into a
 *      table you own, then read it back. The DDL alone was the lesser half.
 *
 * The fix adopts the convention `app/api/adx/_shared.ts::guardAdxRequest`
 * already carries on thirteen `/api/adx/*` routes, via the item-route form in
 * `_lib/adx-item-scope.ts`: the caller is authorized against the graph-model
 * item, the TARGET database is resolved FROM THAT ITEM (`state.database` — the
 * editor's own "Target ADX database" field, saved before every build), and each
 * SOURCE database is validated against the databases bound to items in that
 * item's workspace. `body.database` is no longer read at all.
 */
import { kqlEscapeSingle } from '@/lib/azure/kql-escape';
import { NextRequest, NextResponse } from 'next/server';
import { executeMgmtCommand, executeQuery, listTables, kustoConfigGate, KustoError } from '@/lib/azure/kusto-client';
import { guardAdxItemRequest, scopeAdxDatabase, workspaceAdxScope } from '../../../_lib/adx-item-scope';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Prop = { name: string; type?: string; sourceColumn?: string };
type Decl = {
  name: string; properties?: Prop[];
  sourceDatabase?: string; sourceTable?: string;
  keyColumns?: string[]; originKeyColumns?: string[]; targetKeyColumns?: string[];
};

function kustoType(t?: string): string {
  const v = (t || 'string').toLowerCase();
  if (['int', 'long', 'real', 'bool', 'datetime', 'dynamic', 'guid', 'decimal', 'timespan'].includes(v)) return v;
  if (v === 'number' || v === 'float' || v === 'double') return 'real';
  if (v === 'boolean') return 'bool';
  return 'string';
}

/** KQL scalar cast function for a target column type. */
function castFn(t: string): string {
  switch (kustoType(t)) {
    case 'int': return 'toint';
    case 'long': return 'tolong';
    case 'real': return 'toreal';
    case 'decimal': return 'todecimal';
    case 'datetime': return 'todatetime';
    case 'timespan': return 'totimespan';
    case 'bool': return 'tobool';
    case 'guid': return 'toguid';
    case 'dynamic': return 'todynamic';
    default: return 'tostring';
  }
}

function safeIdent(s: string): string {
  return String(s).replace(/[^A-Za-z0-9_]/g, '_');
}
/** Bracket-quote an arbitrary ADX identifier (tolerates spaces/hyphens). */
function bq(name: string): string {
  return `['${kqlEscapeSingle(String(name))}']`;
}
/** A composite-key expression: strcat(tostring(['k1']),'|',tostring(['k2'])). */
function keyExpr(cols: string[]): string {
  const parts = cols.filter(Boolean).map((c) => `tostring(${bq(c)})`);
  if (parts.length === 1) return parts[0];
  const woven: string[] = [];
  parts.forEach((p, i) => { if (i) woven.push("'|'"); woven.push(p); });
  return `strcat(${woven.join(', ')})`;
}

function buildCreate(table: string, columns: { name: string; type: string }[]): string {
  const cols = columns.map((c) => `${safeIdent(c.name)}:${c.type}`).join(', ');
  return `.create-merge table ${safeIdent(table)} (${cols})`;
}

/** Source ref `database('db').['table']` (db omitted → current database). */
function sourceRef(db: string | undefined, table: string): string {
  return db ? `database('${kqlEscapeSingle(db)}').${bq(table)}` : bq(table);
}

/**
 * Resolve one type's SOURCE coordinates against the item's workspace scope.
 *
 * Both halves are required. The DATABASE is validated against
 * `workspaceAdxScope` — the databases bound to items in this graph model's own
 * workspace — so `.set-or-append <| database('X')` can no longer name a
 * database the caller does not own. The TABLE is then validated against that
 * resolved database's OWN object list (`.show tables`) rather than passed
 * through, so a table name cannot address something the database does not
 * expose. Fails closed: if the table list cannot be read, the binding is
 * refused rather than attempted.
 */
async function resolveSource(
  item: WorkspaceItem,
  decl: Decl,
  targetDb: string,
  scope: Set<string>,
  tableCache: Map<string, Set<string>>,
): Promise<{ ok: true; db: string | undefined; table: string } | { ok: false; error: string }> {
  const scoped = await scopeAdxDatabase(item, decl.sourceDatabase, scope);
  if (!scoped.ok) return { ok: false, error: scoped.error };
  const db = scoped.database;
  let known = tableCache.get(db);
  if (!known) {
    try {
      known = new Set((await listTables(db)).map((t) => t.name));
    } catch (e: any) {
      return { ok: false, error: `could not verify source tables in "${db}": ${e?.message || String(e)}` };
    }
    tableCache.set(db, known);
  }
  const table = String(decl.sourceTable);
  if (!known.has(table)) {
    return { ok: false, error: `source table "${table}" does not exist in database "${db}".` };
  }
  // A source in the target database itself needs no `database()` qualifier.
  return { ok: true, db: db === targetDb ? undefined : db, table };
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  // LAYER 1 + LAYER 2 — authorize the caller against the graph-model item, and
  // take the TARGET database from that item. WRITE-scoped (no allowReadRoles):
  // this issues DDL and ingests rows.
  const guard = await guardAdxItemRequest({
    itemId: id,
    itemType: 'graph-model',
    notFound: 'graph model not found',
  });
  if (guard.res) return guard.res;
  const { item, database: db } = guard.ctx;

  const gate = kustoConfigGate();
  if (gate) {
    return NextResponse.json({
      ok: false,
      gate: { remediation: `Azure Data Explorer is not configured. Set ${gate.missing} to build the graph.` },
      error: `ADX not configured (${gate.missing})`,
    });
  }

  const body = await req.json().catch(() => ({}));
  const nodes: Decl[] = Array.isArray(body?.nodes) ? body.nodes : [];
  const edges: Decl[] = Array.isArray(body?.edges) ? body.edges : [];
  if (nodes.length === 0 && edges.length === 0) {
    return NextResponse.json({ ok: false, error: 'No node or edge definitions provided' }, { status: 400 });
  }

  // The databases this workspace may address, resolved once from Cosmos.
  const scope = await workspaceAdxScope(item);
  const tableCache = new Map<string, Set<string>>();

  const created: Array<{ kind: 'node' | 'edge'; name: string; command: string; ok: boolean; error?: string }> = [];
  const loaded: Array<{ kind: 'node' | 'edge'; name: string; table: string; rows: number | null; command: string; ok: boolean; error?: string }> = [];

  // ── 1. Create typed tables ──────────────────────────────────────────────
  for (const n of nodes) {
    if (!n?.name) continue;
    const cmd = buildCreate(`Node_${n.name}`, [
      { name: 'id', type: 'string' },
      ...(n.properties || []).map((p) => ({ name: p.name, type: kustoType(p.type) })),
    ]);
    try { await executeMgmtCommand(db, cmd); created.push({ kind: 'node', name: n.name, command: cmd, ok: true }); }
    catch (e: any) { created.push({ kind: 'node', name: n.name, command: cmd, ok: false, error: e?.message || String(e) }); }
  }
  for (const e of edges) {
    if (!e?.name) continue;
    const cmd = buildCreate(`Edge_${e.name}`, [
      { name: 'src', type: 'string' },
      { name: 'dst', type: 'string' },
      ...(e.properties || []).map((p) => ({ name: p.name, type: kustoType(p.type) })),
    ]);
    try { await executeMgmtCommand(db, cmd); created.push({ kind: 'edge', name: e.name, command: cmd, ok: true }); }
    catch (err: any) {
      const status = err instanceof KustoError ? err.status : 502;
      created.push({ kind: 'edge', name: e.name, command: cmd, ok: false, error: `${status}: ${err?.message || String(err)}` });
    }
  }

  // ── 2. Load data from bound source tables (`.set-or-append`) ─────────────
  for (const n of nodes) {
    if (!n?.name || !n.sourceTable || !(n.keyColumns && n.keyColumns.length)) continue;
    const table = `Node_${safeIdent(n.name)}`;
    const src = await resolveSource(item, n, db, scope, tableCache);
    if (!src.ok) {
      loaded.push({ kind: 'node', name: n.name, table, rows: null, command: '', ok: false, error: src.error });
      continue;
    }
    const projParts = [`id = ${keyExpr(n.keyColumns)}`];
    for (const p of (n.properties || [])) {
      if (!p?.name) continue;
      const col = p.sourceColumn || p.name;
      projParts.push(`${safeIdent(p.name)} = ${castFn(p.type || 'string')}(${bq(col)})`);
    }
    const cmd = `.set-or-append ${table} <| ${sourceRef(src.db, src.table)}\n| project ${projParts.join(', ')}`;
    try {
      const r = await executeMgmtCommand(db, cmd);
      // The ingest extent table reports rows in a RecordCount-ish column.
      const rc = r.columns.findIndex((c) => /record|rowcount|count/i.test(c));
      const rows = rc >= 0 && r.rows[0] ? Number(r.rows[0][rc]) : null;
      loaded.push({ kind: 'node', name: n.name, table, rows: Number.isFinite(rows as number) ? rows : null, command: cmd, ok: true });
    } catch (err: any) {
      loaded.push({ kind: 'node', name: n.name, table, rows: null, command: cmd, ok: false, error: err?.message || String(err) });
    }
  }
  for (const e of edges) {
    if (!e?.name || !e.sourceTable || !(e.originKeyColumns && e.originKeyColumns.length) || !(e.targetKeyColumns && e.targetKeyColumns.length)) continue;
    const table = `Edge_${safeIdent(e.name)}`;
    const src = await resolveSource(item, e, db, scope, tableCache);
    if (!src.ok) {
      loaded.push({ kind: 'edge', name: e.name, table, rows: null, command: '', ok: false, error: src.error });
      continue;
    }
    const projParts = [`src = ${keyExpr(e.originKeyColumns)}`, `dst = ${keyExpr(e.targetKeyColumns)}`];
    for (const p of (e.properties || [])) {
      if (!p?.name || p.name === 'srcType' || p.name === 'dstType') continue;
      const col = p.sourceColumn || p.name;
      projParts.push(`${safeIdent(p.name)} = ${castFn(p.type || 'string')}(${bq(col)})`);
    }
    const cmd = `.set-or-append ${table} <| ${sourceRef(src.db, src.table)}\n| project ${projParts.join(', ')}`;
    try {
      const r = await executeMgmtCommand(db, cmd);
      const rc = r.columns.findIndex((c) => /record|rowcount|count/i.test(c));
      const rows = rc >= 0 && r.rows[0] ? Number(r.rows[0][rc]) : null;
      loaded.push({ kind: 'edge', name: e.name, table, rows: Number.isFinite(rows as number) ? rows : null, command: cmd, ok: true });
    } catch (err: any) {
      loaded.push({ kind: 'edge', name: e.name, table, rows: null, command: cmd, ok: false, error: err?.message || String(err) });
    }
  }

  // ── 3. Verify: real per-table counts + a make-graph relationship count ───
  const counts: Record<string, number> = {};
  const nodeTables = nodes.filter((n) => n?.name).map((n) => `Node_${safeIdent(n.name)}`);
  const edgeTables = edges.filter((e) => e?.name).map((e) => `Edge_${safeIdent(e.name)}`);
  const allTables = [...nodeTables, ...edgeTables];
  if (allTables.length) {
    try {
      const countQ = `union withsource=__t ${allTables.join(', ')}\n| summarize Rows = count() by __t`;
      const cr = await executeQuery(db, countQ);
      const ti = cr.columns.indexOf('__t'); const ri = cr.columns.indexOf('Rows');
      for (const row of cr.rows) {
        const t = String(row[ti >= 0 ? ti : 0]).replace(/^\[?'?|'?\]?$/g, '');
        counts[t] = Number(row[ri >= 0 ? ri : 1]) || 0;
      }
    } catch { /* counts best-effort — surfaced empty, not fatal */ }
  }

  let graph: { relationships: number } | null = null;
  if (nodeTables.length && edgeTables.length) {
    try {
      const mg =
        `union withsource=__t ${edgeTables.join(', ')}\n` +
        `| make-graph src --> dst with (union withsource=__t ${nodeTables.join(', ')}) on id\n` +
        `| graph-match (a)-[e]->(b) project a, e, b\n| count`;
      const gr = await executeQuery(db, mg);
      graph = { relationships: gr.rows[0] ? Number(gr.rows[0][0]) || 0 : 0 };
    } catch { /* make-graph verify best-effort (e.g. no rows yet) */ }
  }

  return NextResponse.json({ ok: true, database: db, created, loaded, counts, graph });
}
