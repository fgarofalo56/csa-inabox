/**
 * GET /api/items/databricks-sql-warehouse/[id]/schema?warehouseId=&catalog=&schema=
 *
 * Returns the Unity Catalog tree, scoped progressively:
 *   - no catalog                    → { catalogs }
 *   - catalog, no schema            → { catalogs, schemas }
 *   - catalog + schema              → { catalogs, schemas, tables, views, functions,
 *                                        streamingTables, materializedViews }
 *   - catalog + schema + table      → { columns }  (DESCRIBE TABLE — IntelliSense)
 *
 * Each level runs a single SHOW … / DESCRIBE statement against the warehouse.
 * At the schema leaf level tables / views / user-functions enumerate in
 * parallel (SHOW TABLES / SHOW VIEWS / SHOW USER FUNCTIONS), and — for DBX-7 —
 * `information_schema.tables.table_type` classifies the DLT-backed
 * STREAMING_TABLE / MATERIALIZED_VIEW objects into their own nodes (best-effort;
 * a catalog without information_schema, e.g. hive_metastore, simply reports
 * none).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * GHSA-v2g8-gp3r-rg4r — THE HOLE THIS FILE USED TO BE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `GET(req: NextRequest)` took NO `ctx`, so `[id]` was never read. `getSession()`
 * was the entire authorization and `?warehouseId=` was used verbatim.
 *
 * THIS IS THE FAMILY'S ENUMERATION PRIMITIVE, and it is worth naming precisely
 * rather than rating it as "just a read". `SHOW CATALOGS` on a caller-named
 * warehouse returns EVERY Unity Catalog catalog that warehouse's identity can
 * see, then `SHOW SCHEMAS` / `SHOW TABLES` / `SHOW VIEWS` / `SHOW USER FUNCTIONS`
 * walk down into any of them. Loom runs these as the Console identity, so the
 * caller's own UC grants are never consulted. It is the discovery half of the
 * advisory's materialize-then-read pair: this route tells an attacker WHICH
 * table to name, and `[id]/clone` or `[id]/query` fetch it.
 *
 * ── WHAT IS AND IS NOT CLOSED ───────────────────────────────────────────────
 *
 * LAYER 0 — AUTHENTICATION via the route-toolkit `withSession` wrapper, ABOVE
 *   the `id === 'new'` gate. `guardSynapseItemRequest` reads the session itself,
 *   so a gate above it answers 200 to a caller with NO cookie — the regression
 *   review MEASURED on #3655. `apps/fiab-console` has no `middleware.ts`
 *   (verified), so this handler is the only enforcement point.
 *
 * LAYER 1 — OWN THE ROUTE ITEM. `guardSynapseItemRequest`, READ-SCOPED
 *   (`allowReadRoles: true`). The read scope is a DELIBERATE decision, asserted
 *   in `__tests__/ghsa-v2g8-warehouse-reads.test.ts` rather than assumed: every
 *   statement this handler emits is `SHOW …` or `DESCRIBE TABLE`, i.e.
 *   catalog introspection with no write of any kind, and the Explorer tree is
 *   exactly what a shared Viewer needs in order to read. Contrast the sibling
 *   `[id]/query`, which is write-scoped because its `sql` is unrestricted.
 *
 * LAYER 3 — NOT PRESENT, and named. `warehouseId`, `catalog`, `schema` and
 *   `table` stay caller-supplied; no item→warehouse binding exists in this tree
 *   and a state-anchored one could not close it
 *   (`_lib/databricks-resource-binding.ts:12-27`). FLOOR, NOT BOUND — see the
 *   ledger in `check-route-guards.mjs`'s NOW_GUARDED block and #3669.
 */

import { NextRequest, NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { guardSynapseItemRequest, UNSAVED_ITEM_ID } from '../../../_lib/synapse-item-scope';
import { executeStatement, getWarehouse } from '@/lib/azure/databricks-client';
import { quoteIdent } from '@/lib/sql/quoting';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'databricks-sql-warehouse';

/** 404 body naming BOTH causes and asserting neither (`deploy-integrity.md` R7). */
const ITEM_UNREACHABLE =
  'This SQL warehouse item is not available to you. Either it does not exist, or you have no ' +
  'role in its workspace. Ask a workspace owner to share it with you.';

/**
 * The unsaved-item honest gate — after authentication, before the guard.
 *
 * REACHABLE, checked at the call site: `sql-warehouse-editor.tsx` has NO `isNew`
 * anywhere (measured, `grep -c isNew` = 0) and `refreshCatalogs` (:275) fires as
 * soon as the mount effect picks a warehouse, so this GET runs on an unsaved
 * item. `guardSynapseItemRequest` FAILS CLOSED on an id naming no item, so
 * without this gate a freshly created item would 404 on first open — a dead end
 * (`auto-bind-by-default.md`) and a day-one red state (`ux-baseline.md`).
 *
 * 200, and checked against THIS route's callers rather than copied: every
 * schema consumer (`refreshCatalogs` :275, `openCatalog` :310, `openSchema`
 * :329, column completion :358) branches on `j.ok` and silently leaves the tree
 * empty when it is false. So the gate reads as "tree not populated yet", which
 * is the truth for an unsaved item, and paints nothing red.
 *
 * Match `UNSAVED_ITEM_ID` EXACTLY — real ids are `crypto.randomUUID()`
 * (`_lib/item-crud.ts:467`), so a substring test would let a real id skip the
 * ownership check.
 */
function unsavedItemGate(): NextResponse {
  return NextResponse.json({
    ok: false,
    code: 'unsaved_item',
    error:
      'Save this SQL warehouse item first — the catalog tree is read in the name of the saved ' +
      'item, and an unsaved item has no owner to check that against yet.',
  }, { status: 200 });
}

function firstColumn(rows: unknown[][]): string[] {
  return rows.map((r) => String(r[0])).filter(Boolean);
}

// SHOW TABLES / SHOW VIEWS return [namespace, name, isTemporary] — name is col 1.
function tableNames(rows: unknown[][]): string[] {
  return rows.map((r) => String(r[1] ?? r[0])).filter(Boolean);
}

// SHOW USER FUNCTIONS returns one column of fully-qualified names
// (`catalog.schema.func`). Surface just the function name for the tree.
function functionNames(rows: unknown[][]): string[] {
  return rows
    .map((r) => {
      const fq = String(r[0] ?? '');
      const last = fq.split('.').pop();
      return (last || fq).trim();
    })
    .filter(Boolean);
}

export const GET = withSession<{ id: string }>(async (req: NextRequest, { params }) => {
  const { id: itemId } = params;
  if (itemId === UNSAVED_ITEM_ID) return unsavedItemGate();

  // LAYER 1. READ-SCOPED — every statement below is `SHOW …` / `DESCRIBE TABLE`,
  // pure catalog introspection, and the Explorer tree is what a shared Viewer
  // needs in order to read at all.
  const guard = await guardSynapseItemRequest({
    itemId,
    itemType: ITEM_TYPE,
    notFound: ITEM_UNREACHABLE,
    allowReadRoles: true,
  });
  if (guard.res) return guard.res;

  const warehouseId = req.nextUrl.searchParams.get('warehouseId');
  const catalog = req.nextUrl.searchParams.get('catalog') || undefined;
  const schema = req.nextUrl.searchParams.get('schema') || undefined;
  const table = req.nextUrl.searchParams.get('table') || undefined;
  if (!warehouseId) return NextResponse.json({ error: 'warehouseId is required' }, { status: 400 });

  const w = await getWarehouse(warehouseId).catch(() => null);
  if (!w || w.state !== 'RUNNING') {
    return NextResponse.json(
      { ok: false, state: w?.state || 'UNKNOWN', message: 'Warehouse not RUNNING — schema unavailable.' },
      { status: 409 },
    );
  }

  try {
    // Column-completion request: catalog + schema + table → DESCRIBE TABLE.
    // DESCRIBE returns [col_name, data_type, comment]; rows after a blank /
    // '#'-prefixed line are partition metadata, not columns — stop there.
    if (catalog && schema && table) {
      const descRes = await executeStatement(
        warehouseId,
        `DESCRIBE TABLE \`${catalog}\`.\`${schema}\`.\`${table}\``,
      );
      const columns: string[] = [];
      for (const r of descRes.rows) {
        const name = String(r[0] ?? '').trim();
        if (!name || name.startsWith('#')) break;
        columns.push(name);
      }
      return NextResponse.json({ ok: true, state: 'RUNNING', columns });
    }

    const catalogsRes = await executeStatement(warehouseId, 'SHOW CATALOGS');
    const catalogs = firstColumn(catalogsRes.rows);

    let schemas: string[] | undefined;
    let tables: string[] | undefined;
    let views: string[] | undefined;
    let functions: string[] | undefined;
    let streamingTables: string[] | undefined;
    let materializedViews: string[] | undefined;

    if (catalog) {
      // Quote with backticks; users may pass `system`, `main`, `hive_metastore`, etc.
      const schemasRes = await executeStatement(warehouseId, `SHOW SCHEMAS IN \`${catalog}\``);
      schemas = firstColumn(schemasRes.rows);

      if (schema) {
        const ns = `\`${catalog}\`.\`${schema}\``;
        // Tables, views, user functions, and the DLT-backed object-type map
        // enumerate in parallel. Views / functions / information_schema degrade
        // to [] (not a hard failure) if the principal lacks visibility or the
        // catalog predates the command (e.g. hive_metastore).
        const typeSql =
          `SELECT table_name, table_type FROM ${quoteIdent(catalog, 'databricks-sql')}.information_schema.tables ` +
          `WHERE table_schema = :sch`;
        const [tablesRes, viewsRes, funcsRes, typesRes] = await Promise.all([
          executeStatement(warehouseId, `SHOW TABLES IN ${ns}`),
          executeStatement(warehouseId, `SHOW VIEWS IN ${ns}`).catch(() => ({ rows: [] as unknown[][] })),
          executeStatement(warehouseId, `SHOW USER FUNCTIONS IN ${ns}`).catch(() => ({ rows: [] as unknown[][] })),
          executeStatement(warehouseId, typeSql, undefined, undefined, [{ name: 'sch', value: schema }]).catch(
            () => ({ rows: [] as unknown[][] }),
          ),
        ]);
        const allTableNames = tableNames(tablesRes.rows);
        const rawViews = tableNames(viewsRes.rows);
        functions = functionNames(funcsRes.rows);

        // Classify DLT-backed objects from information_schema.table_type
        // (STREAMING_TABLE / MATERIALIZED_VIEW). Rows are [table_name, table_type].
        const streamingSet = new Set<string>();
        const mvSet = new Set<string>();
        for (const r of typesRes.rows) {
          const nm = String(r[0] ?? '').trim();
          const tt = String(r[1] ?? '').trim().toUpperCase();
          if (!nm) continue;
          if (tt === 'STREAMING_TABLE') streamingSet.add(nm);
          else if (tt === 'MATERIALIZED_VIEW') mvSet.add(nm);
        }
        streamingTables = allTableNames.filter((t) => streamingSet.has(t));
        materializedViews = allTableNames.filter((t) => mvSet.has(t));
        // Views exclude anything reclassified as a streaming table / MV (an MV can
        // surface in SHOW VIEWS), so each object appears under exactly one node.
        views = rawViews.filter((v) => !streamingSet.has(v) && !mvSet.has(v));
        const viewSet = new Set([...views, ...rawViews]);
        // Plain tables exclude views, streaming tables, and materialized views.
        tables = allTableNames.filter(
          (t) => !viewSet.has(t) && !streamingSet.has(t) && !mvSet.has(t),
        );
      }
    }

    return NextResponse.json({
      ok: true,
      state: 'RUNNING',
      catalogs,
      schemas,
      tables,
      views,
      functions,
      streamingTables,
      materializedViews,
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, state: 'RUNNING', error: e?.message || String(e) },
      { status: 502 },
    );
  }
});
