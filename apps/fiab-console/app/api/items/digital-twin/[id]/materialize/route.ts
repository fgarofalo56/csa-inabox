/**
 * POST /api/items/digital-twin/[id]/materialize  (FGC-12)
 *   "Build twin graph" — materialize the saved twin model into Azure Data
 *   Explorer AND (where entities/relationships are mapped to source tables)
 *   LOAD data, then verify the graph is constructible with a real `make-graph`
 *   query. Azure-native, NO Fabric — the engine is ADX `make-graph` /
 *   `graph-match`, exactly the graph-model materialize pipeline.
 *
 *   Per entity → `.create-merge table DT_<key>_E_<name> (id, <props…>)`; per
 *   relationship → `.create-merge table DT_<key>_R_<name> (src, dst, rel,
 *   <props…>)`. Mapped types additionally `.set-or-append` the typed/cast rows
 *   projected from their bound source table. A final batched count query returns
 *   per-table row counts + a `make-graph` relationship-count receipt.
 *
 *   The twin model is read from the OWNER-CHECKED Cosmos item (never trusted
 *   from the body), so this route is tenant-scoped by construction.
 *
 *   Returns: { ok, database, twinKey, created:[…], loaded:[…], counts:{…},
 *             graph:{ relationships } | null, gate?:{ remediation } }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem } from '../../../_lib/item-crud';
import { executeMgmtCommand, executeQuery, defaultDatabase, kustoConfigGate, KustoError } from '@/lib/azure/kusto-client';
import {
  normalizeTwinModel, buildTwinMaterialize, buildTwinRelationshipCount, twinKey,
} from '@/lib/editors/digital-twin-model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;

  const item = await loadOwnedItem(id, 'digital-twin', s.claims.oid);
  if (!item) return NextResponse.json({ ok: false, error: 'not found or not writable' }, { status: 404 });

  const gate = kustoConfigGate();
  if (gate) {
    return NextResponse.json({
      ok: false,
      gate: { remediation: `Azure Data Explorer is not configured. Set ${gate.missing} (the ADX cluster that backs Loom twins) and grant the Console UAMI Database Viewer/Ingestor to build the twin graph. No Microsoft Fabric required.` },
      error: `ADX not configured (${gate.missing})`,
    });
  }

  const model = normalizeTwinModel(item.state as Record<string, unknown>);
  if (model.entities.length === 0) {
    return NextResponse.json({ ok: false, error: 'No entities defined. Add at least one entity in the model designer before building.' }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  const db = String(body?.database || model.database || defaultDatabase());
  const key = twinKey(id);
  const plan = buildTwinMaterialize(model, key);

  const created: Array<{ kind: string; name: string; command: string; ok: boolean; error?: string }> = [];
  const loaded: Array<{ kind: string; name: string; table: string; rows: number | null; command: string; ok: boolean; error?: string }> = [];

  // ── 1. Create typed tables ──────────────────────────────────────────────
  for (const c of plan.creates) {
    try { await executeMgmtCommand(db, c.command); created.push({ kind: c.kind, name: c.name, command: c.command, ok: true }); }
    catch (e: any) {
      const status = e instanceof KustoError ? e.status : 502;
      created.push({ kind: c.kind, name: c.name, command: c.command, ok: false, error: `${status}: ${e?.message || String(e)}` });
    }
  }

  // ── 2. Load data from bound source tables (`.set-or-append`) ─────────────
  for (const l of plan.loads) {
    try {
      const r = await executeMgmtCommand(db, l.command);
      const rc = r.columns.findIndex((col) => /record|rowcount|count/i.test(col));
      const rows = rc >= 0 && r.rows[0] ? Number(r.rows[0][rc]) : null;
      loaded.push({ kind: l.kind, name: l.name, table: l.table, rows: Number.isFinite(rows as number) ? rows : null, command: l.command, ok: true });
    } catch (e: any) {
      loaded.push({ kind: l.kind, name: l.name, table: l.table, rows: null, command: l.command, ok: false, error: e?.message || String(e) });
    }
  }

  // ── 3. Verify: real per-table counts + a make-graph relationship count ───
  const counts: Record<string, number> = {};
  const allTables = [...plan.nodeTables, ...plan.edgeTables];
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
  const countCmd = buildTwinRelationshipCount(plan.nodeTables, plan.edgeTables);
  if (countCmd) {
    try {
      const gr = await executeQuery(db, countCmd);
      graph = { relationships: gr.rows[0] ? Number(gr.rows[0][0]) || 0 : 0 };
    } catch { /* make-graph verify best-effort (e.g. no rows yet) */ }
  }

  return NextResponse.json({ ok: true, database: db, twinKey: key, created, loaded, counts, graph });
}
