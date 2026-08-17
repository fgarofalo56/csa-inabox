/**
 * Unity Catalog granular-security wizards — BFF route (column masks + row
 * filters). This is the Databricks-side companion to the Synapse-only
 * `sql-security/route.ts` (object/column GRANT + RLS + DDM over TDS).
 *
 *   GET  /api/items/[type]/[id]/security?warehouseId=<id>&catalog=<c>&schema=<s>
 *        → live state for the wizard pickers + state panel:
 *          { ok, backend:'databricks-uc', catalog, columnMasks[], rowFilters[],
 *            tables[], columns[] }
 *        (tables[] requires schema; columns[] requires schema + table.)
 *
 *   POST /api/items/[type]/[id]/security
 *        body { wizard:'column-mask'|'row-filter', params, preview?, warehouseId, catalog? }
 *          - preview:true  → { ok, sql } WITHOUT executing
 *          - preview:false → executes CREATE FUNCTION then ALTER TABLE and returns
 *                            { ok, sql, executionMs, executedBy }
 *        body { action:'drop-mask'|'drop-filter', params, warehouseId, catalog? }
 *        body { action:'verify', verify:{ catalog, schema, tableName }, warehouseId }
 *          - runs the sample SELECT (admin/UAMI view) + reads information_schema
 *            to prove the mask/filter binding is live, and explains how the
 *            constrained principal sees the effect at query time.
 *
 * Backends dispatched by [type] (Azure-native — NO Microsoft Fabric):
 *   - databricks-sql-warehouse → Databricks Unity Catalog via `ucSql`, the AUDITED
 *     Statement-Execution wrapper (lib/azure/uc-sql.ts). Every mask/filter CREATE,
 *     ALTER and DROP this route issues lands in the Loom Unity access trail
 *     (`_auditLog itemType:'loom-unity'` + `LoomAudit_CL`) — issue #2622.
 *
 * AUTH: the Databricks client builds every request with the Container App MI's
 * Microsoft Entra bearer token (no PAT). The client NEVER sends raw SQL — it
 * sends structured params; the SQL is built server-side by
 * lib/sql/uc-security-builders.ts (back-tick-quoted identifiers + allowlisted
 * types + escaped literals), so there is no injection path.
 *
 * BOUNDARY GATE: Unity Catalog (Entra-connected metastore) is a Commercial/GCC
 * capability. At GCC-High / IL5 / DoD the route returns an honest gate pointing
 * to the Synapse Dedicated SQL pool column-GRANT + RLS path instead.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * GHSA-v8r7-c2p5-mjf2 — THE HOLE THIS FILE USED TO BE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `getSession()` at the top of each verb was the ENTIRE authorization, and
 * `[id]` was never destructured at all: both handlers did `const { type } =
 * await ctxParams(ctx)`. The item id sat in the URL and was read nowhere — not
 * for ownership, not even for attribution — while the execution coordinates came
 * off the REQUEST: `catalog` and `warehouseId` from the query string on GET,
 * from the body on POST. They reached `ucSql(warehouseId, sql, { target:
 * catalog })`, which runs on Unity Catalog AS THE CONSOLE MANAGED IDENTITY.
 *
 * What it runs is not read-only. The POST path issues `CREATE OR REPLACE
 * FUNCTION`, then `ALTER TABLE … SET MASK` / `SET ROW FILTER`; the drop actions
 * issue `ALTER TABLE … DROP MASK` / `DROP ROW FILTER`. So any authenticated
 * session named a warehouse and a catalog and had the Console MI create
 * functions and ATTACH OR REMOVE column masks and row filters on tables there.
 * Masking and row-level security are exactly the controls a caller must not be
 * able to drop.
 *
 * WHY NO CONTROL SAW IT — and why the allowlist entry is DELETED rather than
 * reworded. `check-route-guards.mjs` carried this path with the reason
 *
 *     "security-scan over a shared Azure backend resolved by item-type gate"
 *
 * `resolveWarehouseId(warehouseIdParam)` is what that reason points at, and its
 * own doc-comment says it "honours an explicit warehouseId" — i.e. the entry
 * asserts an item-type gate resolves the backend, while the function it names is
 * DESIGNED to let the caller override it. The word "resolved" was doing work the
 * code did not do. Rewording would have preserved exactly that failure, so the
 * entry is gone and the route now passes CHECK 2 on a real guard signal. Its
 * twin `[type]/[id]/sql-security` carried the identical sentence and was fixed
 * the same way in #3648.
 *
 * ── WHAT IS AND IS NOT CLOSED ───────────────────────────────────────────────
 *
 * LAYER 1 — OWN THE ROUTE ITEM. Both verbs now run `guardSynapseItemRequest`,
 *   the backend-agnostic Layer-1 guard the two siblings in this same directory
 *   (`[id]/optimize`, `[id]/statistics`) already adopted for GHSA-v2g8-gp3r-rg4r:
 *   session → the canonical `authorizeItemWorkspace` ladder (owner →
 *   tenant-admin → shared-ACL) resolved FROM THE ITEM → a fail-closed item load.
 *   404-not-403, so an id cannot be probed for existence across tenants.
 *
 *   WRITE-SCOPED ON BOTH VERBS — no `allowReadRoles`, including on the GET, and
 *   that is deliberate rather than copied. This route's twin `sql-security`
 *   records the rule: the GET's reads are `information_schema.column_masks` and
 *   `.row_filters` — WHICH COLUMNS ARE MASKED AND WHICH TABLES CARRY A ROW
 *   FILTER, i.e. the catalog's protection map, which is a reconnaissance list
 *   for the POST that drops them. The sibling `[id]/statistics` GET does pass
 *   `allowReadRoles`, and the difference is the sensitivity of what is read, not
 *   an inconsistency. A read-only Viewer of a shared workspace therefore now
 *   gets the 404 rather than the map; the message names both causes.
 *
 * LAYER 3 — DELIBERATELY NOT INVENTED, and this is the honest part.
 *   `warehouseId` and `catalog` remain CALLER-NAMED, because no item→warehouse
 *   and no item→catalog binding exists anywhere in this tree to resolve them
 *   from: `sql-warehouse-editor.tsx` picks its warehouse from a LIVE
 *   `listWarehouses()` response (`:255`) and never persists it to item state,
 *   and the catalog is typed into the panel. Both coordinates are nonetheless
 *   bounded BY CONSTRUCTION to this deployment's own estate — `ucSql` →
 *   `executeStatement` → `dbxFetch` targets `LOOM_DATABRICKS_HOSTNAME`, so
 *   unlike the ARM-id class this advisory opened with, no other subscription or
 *   workspace is reachable and no credential can be egressed to a caller-named
 *   host. Neither value is interpolated into a path either: `warehouseId` goes
 *   into the `warehouse_id` JSON field and `catalog` through
 *   `uc-security-builders.ts`, which back-tick-quotes and refuses control
 *   characters. A shape check here would therefore be ceremony, and a ceremonial
 *   layer that reads as closure is worse than none.
 *
 *   RESIDUAL, RECORDED RATHER THAN IMPLIED AWAY: after this change an
 *   authenticated caller who owns ANY `databricks-sql-warehouse` item can still
 *   name any catalog in this deployment's own metastore and drop its masks and
 *   row filters. LAYER 1 IS A FLOOR HERE, NOT A BOUND — the same ledger entry
 *   `[id]/optimize` and `[id]/statistics` carry, for the same reason. Closing it
 *   needs a per-item Unity Catalog ownership model that does not exist, plus a
 *   backfill for every existing install; that is a design decision with a
 *   brownfield migration and is deliberately not attempted here.
 */

import { NextRequest, NextResponse } from 'next/server';
import type { SessionPayload } from '@/lib/auth/session';
import { guardSynapseItemRequest, UNSAVED_ITEM_ID } from '../../../_lib/synapse-item-scope';
import {
  databricksConfigGate,
  listWarehouses,
  type QueryResult,
} from '@/lib/azure/databricks-client';
import { ucSql } from '@/lib/azure/uc-sql';
import { isGovCloud, cloudBoundaryLabel } from '@/lib/azure/cloud-endpoints';
import {
  buildUcColumnMask,
  buildUcDropColumnMask,
  buildUcRowFilter,
  buildUcDropRowFilter,
  ucListColumnMasks,
  ucListRowFilters,
  ucListSchemas,
  ucListTablesInSchema,
  ucListColumnsForTable,
  ucSelectSample,
  UcBuildError,
  type UcColumnMaskParams,
  type UcRowFilterParams,
  type UcSecurityDdl,
} from '@/lib/sql/uc-security-builders';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SUPPORTED_TYPES = new Set(['databricks-sql-warehouse']);

/** Honest gate object — UI renders a MessageBar with `error`. */
interface Gate { gated: true; error: string }

function rowsToObjects(r: QueryResult): Record<string, unknown>[] {
  return r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));
}

/**
 * The ITEM-TYPE gate — a PURE function of the URL segment. No backend, no
 * Cosmos, no environment: it discloses nothing an unauthenticated caller could
 * not already infer from the path they typed, which is why it may run before
 * authorization. The CONFIG and BOUNDARY gates may not — see
 * {@link resolveBackendGate}.
 */
function resolveTypeGate(type: string): Gate | null {
  if (!SUPPORTED_TYPES.has(type)) {
    return {
      gated: true,
      error:
        `Unity Catalog column masks and row filters apply to Databricks SQL Warehouse items. ` +
        `For Synapse / warehouse items use the SQL granular-security wizards (Column GRANT + RLS) instead.`,
    };
  }
  return null;
}

/**
 * The DEPLOYMENT gates: is Databricks configured, and is Unity Catalog available
 * at this sovereign boundary.
 *
 * RUNS AFTER LAYER 1, DELIBERATELY. Both answers describe the ESTATE — which
 * `LOOM_*` env vars this Console is missing, and which cloud it runs in — so
 * returning either to a caller who has not been authorized against the route
 * item is an estate-configuration disclosure, and it also masks the denial from
 * anyone reading the response. `ghsa-shared-backend-dispatchers.test.ts` already
 * pins this ordering for the sibling routes ("the guard runs BEFORE the config
 * gate"); this route now shares it.
 */
function resolveBackendGate(): Gate | null {
  const cfg = databricksConfigGate();
  if (cfg) {
    return {
      gated: true,
      error:
        `Databricks is not configured in this deployment. Set ${cfg.missing} on the Console ` +
        `(landing-zone bicep deploys the Databricks workspace and stamps LOOM_DATABRICKS_HOSTNAME).`,
    };
  }
  if (isGovCloud()) {
    return {
      gated: true,
      error:
        `Unity Catalog column masks and row filters are not available at the ${cloudBoundaryLabel()} boundary. ` +
        `UC requires a Commercial or GCC Databricks workspace (Microsoft Entra-connected metastore). ` +
        `At this boundary, use the Synapse Dedicated SQL pool column-level GRANT ` +
        `(GRANT SELECT ON [s].[t](cols) TO [principal]) and Row-Level Security (CREATE SECURITY POLICY) ` +
        `wizards instead — open the warehouse / dedicated-pool editor's "Column & Row security" dialog.`,
    };
  }
  return null;
}

/** The route's honest-gate shape: 200 + `gated:true`, rendered by the panel as a
 *  warning MessageBar rather than a red error. */
function gate(error: string, code?: string): NextResponse {
  return NextResponse.json({ ok: false, gated: true, ...(code ? { code } : {}), error }, { status: 200 });
}

/**
 * The 404 body for an item the caller cannot reach — naming BOTH causes and
 * asserting NEITHER.
 *
 * `authorizeItemWorkspace` denies for two different situations — the item does
 * not exist, or it exists and the caller's workspace role is read-only — and
 * this route cannot tell them apart without a second read, which is precisely
 * the cross-tenant existence probe 404-not-403 exists to prevent. So the status
 * stays 404 and the message states the disjunction rather than picking a side,
 * per `deploy-integrity.md` R7: an error must not assert a cause it did not
 * establish.
 *
 * The read-role half is a REAL consequence of write-scoping this route's GET
 * (see the header): a Viewer/Contributor of a shared workspace could previously
 * reach it — that was the vulnerability — and a bare "not found" would leave
 * them nothing to act on.
 */
const ITEM_UNREACHABLE =
  'This item is not available to you. Either it does not exist, or your role in its ' +
  'workspace is read-only — the Unity Catalog security wizards read the catalog’s ' +
  'protection map and execute mask/filter DDL, so they require write access. Ask a ' +
  'workspace owner for a Contributor-or-higher role if you need them.';

/** Authorized to proceed, or the response to return verbatim. */
type Authorized = { ok: true; session: SessionPayload } | { ok: false; res: NextResponse };

/**
 * LAYER 1 + the gates, in the one order both verbs use.
 *
 *   1. item-type gate   — pure URL function, discloses nothing.
 *   2. UNSAVED ITEM     — the honest gate, NOT a 404 (see below).
 *   3. LAYER 1          — `guardSynapseItemRequest`, write-scoped.
 *   4. deployment gates — config + sovereign boundary, only once authorized.
 *
 * STEP 2 IS THE DEAD-END FIX, and it is reachable. `UcSecurityPanel` has exactly
 * one mount — `sql-warehouse-editor.tsx:1980`, inside the "Column & row
 * security" dialog — and that editor has NO `isNew` guard anywhere in the file:
 * the ribbon action at `:913` is `onClick: () => setUcSecOpen(true)`,
 * unconditional, and the page renders the editor's full ribbon immediately at
 * `/items/databricks-sql-warehouse/new`. The panel fetches on mount and paints a
 * non-gated `!ok` as a RED "Could not load UC security state" banner
 * (`lib/panes/uc-security-panel.tsx`), so without this branch Layer 1 would put
 * a red banner four clicks from a create page — `ux-baseline.md` ("new-item
 * first-open is clean") and `auto-bind-by-default.md` (a dead end) both forbid
 * it. The gate carries `code:'unsaved_item'` so the panel can title it truthfully
 * instead of "Configuration required", which would be a false statement.
 */
async function authorizeUcSecurityRequest(type: string, id: string): Promise<Authorized> {
  const typeGate = resolveTypeGate(type);
  if (typeGate) return { ok: false, res: gate(typeGate.error) };

  if (id === UNSAVED_ITEM_ID) {
    return {
      ok: false,
      res: gate(
        'Save this item first — Unity Catalog column masks and row filters are applied ' +
          'in the name of the saved warehouse item, and an unsaved item has no owner to ' +
          'check them against yet.',
        'unsaved_item',
      ),
    };
  }

  // LAYER 1 — write-scoped on BOTH verbs; see the header for why the GET too.
  const guard = await guardSynapseItemRequest({
    itemId: id,
    itemType: type,
    notFound: ITEM_UNREACHABLE,
  });
  if (guard.res) return { ok: false, res: guard.res };

  const backendGate = resolveBackendGate();
  if (backendGate) return { ok: false, res: gate(backendGate.error) };

  return { ok: true, session: guard.ctx.session };
}

/**
 * Resolve the SQL warehouse to run against. Honours an explicit warehouseId
 * (the editor's warehouse picker); otherwise falls back to the first RUNNING
 * warehouse, then any warehouse (executeStatement tolerates STARTING).
 *
 * CALLER-NAMED, AND THAT IS NOT AN OVERSIGHT — see the header's Layer 3 note.
 * It is bounded to this deployment's own Databricks workspace by `dbxFetch`, and
 * the ownership check that now precedes every call to it is the boundary.
 */
async function resolveWarehouseId(requested?: string): Promise<string> {
  if (requested) return requested;
  const warehouses = await listWarehouses();
  const running = warehouses.find((w) => w.state === 'RUNNING') || warehouses[0];
  if (!running) {
    throw new Error('No SQL warehouse found. Create or start a SQL warehouse in the Databricks workspace.');
  }
  return running.id;
}

async function ctxParams(ctx: { params: Promise<{ type: string; id: string }> }) {
  return ctx.params;
}

// ============================================================
// GET — live UC security state for the pickers + state panel
// ============================================================

export async function GET(req: NextRequest, ctx: { params: Promise<{ type: string; id: string }> }) {
  const { type, id } = await ctxParams(ctx);
  const auth = await authorizeUcSecurityRequest(type, id);
  if (!auth.ok) return auth.res;

  const catalog = req.nextUrl.searchParams.get('catalog') || undefined;
  const schema = req.nextUrl.searchParams.get('schema') || undefined;
  const table = req.nextUrl.searchParams.get('table') || undefined;
  const warehouseIdParam = req.nextUrl.searchParams.get('warehouseId') || undefined;

  if (!catalog) {
    // Without a catalog there is no information_schema to read. The panel asks
    // the user to pick a catalog first; return an empty-but-ok shell.
    return NextResponse.json({
      ok: true, backend: 'databricks-uc', catalog: null,
      columnMasks: [], rowFilters: [], tables: [], columns: [],
      needsCatalog: true,
    });
  }

  let warehouseId: string;
  try {
    warehouseId = await resolveWarehouseId(warehouseIdParam);
  } catch (e: any) {
    return NextResponse.json({ ok: false, gated: true, error: e?.message || String(e) }, { status: 200 });
  }

  async function safe(label: string, sql: string): Promise<{ rows: Record<string, unknown>[]; error?: string }> {
    try {
      const r = await ucSql(warehouseId, sql, { target: catalog });
      return { rows: rowsToObjects(r) };
    } catch (e: any) {
      return { rows: [], error: `${label}: ${e?.message || String(e)}` };
    }
  }

  try {
    const reads: Promise<{ rows: Record<string, unknown>[]; error?: string }>[] = [
      safe('columnMasks', ucListColumnMasks(catalog)),
      safe('rowFilters', ucListRowFilters(catalog)),
      safe('schemas', ucListSchemas(catalog)),
      schema ? safe('tables', ucListTablesInSchema(catalog, schema)) : Promise.resolve({ rows: [] }),
      schema && table
        ? safe('columns', ucListColumnsForTable(catalog, schema, table))
        : Promise.resolve({ rows: [] }),
    ];
    const [masks, filters, schemas, tables, columns] = await Promise.all(reads);

    const warnings = [masks.error, filters.error, schemas.error, tables.error, columns.error].filter(Boolean) as string[];

    return NextResponse.json({
      ok: true,
      backend: 'databricks-uc',
      catalog,
      schema: schema || null,
      table: table || null,
      columnMasks: masks.rows,
      rowFilters: filters.rows,
      schemas: schemas.rows,
      tables: tables.rows,
      columns: columns.rows,
      ...(warnings.length ? { warnings } : {}),
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

// ============================================================
// POST — preview / execute a wizard, drop a binding, or verify
// ============================================================

export async function POST(req: NextRequest, ctx: { params: Promise<{ type: string; id: string }> }) {
  const { type, id } = await ctxParams(ctx);
  const auth = await authorizeUcSecurityRequest(type, id);
  if (!auth.ok) return auth.res;
  const { session } = auth;

  const body = await req.json().catch(() => ({}));
  const action = String(body?.action || 'wizard');
  const catalog = body?.catalog ? String(body.catalog) : undefined;

  let warehouseId: string;
  try {
    warehouseId = await resolveWarehouseId(body?.warehouseId ? String(body.warehouseId) : undefined);
  } catch (e: any) {
    return NextResponse.json({ ok: false, gated: true, error: e?.message || String(e) }, { status: 200 });
  }

  // ---- Verify: prove the mask/filter binding is live + show the admin view ----
  if (action === 'verify') {
    const v = body?.verify || {};
    const vCatalog = String(v.catalog || catalog || '');
    const vSchema = String(v.schema || '');
    const vTable = String(v.tableName || v.table || '');
    if (!vCatalog || !vSchema || !vTable) {
      return NextResponse.json({ ok: false, error: 'verify requires catalog, schema and tableName' }, { status: 400 });
    }
    let sampleSql: string;
    let masksSql: string;
    let filtersSql: string;
    try {
      sampleSql = ucSelectSample(vCatalog, vSchema, vTable, Number(v.limit) || 10);
      masksSql = ucListColumnMasks(vCatalog);
      filtersSql = ucListRowFilters(vCatalog);
    } catch (e: any) {
      const status = e instanceof UcBuildError ? 400 : 500;
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
    }
    try {
      const target = [vCatalog, vSchema, vTable].filter(Boolean).join('.');
      const sample = await ucSql(warehouseId, sampleSql, { target });
      const masks = rowsToObjects(await ucSql(warehouseId, masksSql, { target }))
        .filter((m) => String(m.table_name) === vTable && String(m.schema_name) === vSchema);
      const filters = rowsToObjects(await ucSql(warehouseId, filtersSql, { target }))
        .filter((f) => String(f.table_name) === vTable && String(f.schema_name) === vSchema);
      return NextResponse.json({
        ok: true,
        sql: sampleSql,
        adminView: { columns: sample.columns, rows: sample.rows, rowCount: sample.rowCount },
        masksApplied: masks,
        rowFiltersApplied: filters,
        executedBy: session.claims.upn,
        note:
          'The sample SELECT runs as the Console managed identity (an admin view — unmasked values, ' +
          'all rows). The bound column masks / row filter above are evaluated at query time via ' +
          'CURRENT_USER() / IS_ACCOUNT_GROUP_MEMBER(): a constrained principal running the same ' +
          'SELECT sees masked column values and only the rows the row filter permits.',
      });
    } catch (e: any) {
      return NextResponse.json({ ok: false, sql: sampleSql, error: e?.message || String(e), code: e?.code }, { status: 502 });
    }
  }

  // ---- Drop a binding (single statement) ----
  if (action === 'drop-mask' || action === 'drop-filter') {
    const params = body?.params ?? {};
    let sql: string;
    try {
      sql = action === 'drop-mask'
        ? buildUcDropColumnMask({
            catalog: String(params.catalog || catalog || ''),
            schema: String(params.schema || ''),
            tableName: String(params.tableName || ''),
            columnName: String(params.columnName || ''),
          })
        : buildUcDropRowFilter({
            catalog: String(params.catalog || catalog || ''),
            schema: String(params.schema || ''),
            tableName: String(params.tableName || ''),
          });
    } catch (e: any) {
      const status = e instanceof UcBuildError ? 400 : 500;
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
    }
    if (body?.preview === true) return NextResponse.json({ ok: true, preview: true, sql });
    try {
      const r = await ucSql(warehouseId, sql, {
        target: [params.catalog || catalog, params.schema, params.tableName, params.columnName]
          .filter(Boolean).map(String).join('.'),
      });
      return NextResponse.json({ ok: true, sql, executionMs: r.executionMs, executedBy: session.claims.upn });
    } catch (e: any) {
      return NextResponse.json({ ok: false, sql, error: e?.message || String(e), code: e?.code }, { status: 502 });
    }
  }

  // ---- Wizard: build the two-statement DDL from structured params ----
  const wizard = String(body?.wizard || '');
  const preview = body?.preview === true;
  const params = body?.params ?? {};

  let ddl: UcSecurityDdl;
  try {
    if (wizard === 'column-mask') {
      ddl = buildUcColumnMask({ ...params, catalog: params.catalog || catalog } as UcColumnMaskParams);
    } else if (wizard === 'row-filter') {
      ddl = buildUcRowFilter({ ...params, catalog: params.catalog || catalog } as UcRowFilterParams);
    } else {
      return NextResponse.json({ ok: false, error: `unknown wizard: ${wizard}` }, { status: 400 });
    }
  } catch (e: any) {
    const status = e instanceof UcBuildError ? 400 : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }

  // Preview pane: return the generated SQL without touching the warehouse.
  if (preview) {
    return NextResponse.json({ ok: true, preview: true, sql: ddl.combined, functionName: ddl.functionName });
  }

  // Execute: CREATE OR REPLACE FUNCTION first, then ALTER TABLE … SET MASK/FILTER.
  const started = Date.now();
  try {
    await ucSql(warehouseId, ddl.functionSql, { target: ddl.functionName });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, sql: ddl.combined, stage: 'create-function', error: e?.message || String(e), code: e?.code },
      { status: 502 },
    );
  }
  try {
    await ucSql(warehouseId, ddl.alterSql, {
      target: [params.catalog || catalog, params.schema, params.tableName, params.columnName]
        .filter(Boolean).map(String).join('.'),
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, sql: ddl.combined, stage: 'alter-table', error: e?.message || String(e), code: e?.code },
      { status: 502 },
    );
  }
  return NextResponse.json({
    ok: true,
    sql: ddl.combined,
    functionName: ddl.functionName,
    executionMs: Date.now() - started,
    executedBy: session.claims.upn,
  });
}
