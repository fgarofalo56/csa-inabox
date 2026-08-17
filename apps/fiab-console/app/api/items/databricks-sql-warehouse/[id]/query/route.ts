/**
 * POST /api/items/databricks-sql-warehouse/[id]/query
 * body { sql, warehouseId, catalog?, schema?, parameters?, clientQueryId? }
 *
 * `sql` may contain `:name` named parameter markers; `parameters[]` supplies
 * their values. The values are bound by the Databricks Statement Execution API,
 * never concatenated into the SQL — injection-safe.
 *
 * If warehouse isn't RUNNING, returns 409 { state } so UI can call /start.
 * When clientQueryId is supplied, the server-assigned statement_id is
 * registered against it so a parallel /cancel request can abort the run.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * GHSA-v2g8-gp3r-rg4r — THE HOLE THIS FILE USED TO BE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE ADVISORY RECORDS THIS ROUTE AS UNAUTHORIZED, SEPARATELY AND BY NAME. It
 * is worth restating exactly, because the shape is subtle enough that the
 * published inventory called it `owner-scoped` on `main`:
 *
 *   `withSession` was the entire authorization. `warehouseId` came from the
 *   BODY. `[id]` WAS read — but in exactly ONE place, `recordQueryRun`, i.e.
 *   the FinOps attribution receipt. It never reached an authorization call.
 *
 * So the route ran CALLER-AUTHORED SQL on a CALLER-CHOSEN warehouse, and the
 * two owner-shaped tokens a name scan could see (`routeParams.id`,
 * `session.claims.oid`) were both inside the billing record. That is the
 * finding `_route-auth-scope.mjs` (#3625/#3643) was rewritten to catch:
 * presence read as enforcement.
 *
 * IT IS NOT A READ, and it must not be scoped as one. `sql` is unrestricted —
 * there is no `^select` shape check here of the kind the sibling `[id]/ctas`
 * carries — so the same handler executes `SELECT`, `INSERT`, `CREATE TABLE`,
 * `DROP TABLE` and `GRANT` alike on Unity Catalog. `streaming-object-dialog.tsx:149`
 * is a shipped in-product caller that uses it precisely to run CREATE DDL. It
 * is also the READ half of the advisory's materialize-then-read pair: the
 * sibling `[id]/clone` lands a victim table somewhere the caller can name, and
 * this route reads it back.
 *
 * ── WHAT IS AND IS NOT CLOSED ───────────────────────────────────────────────
 *
 * LAYER 0 — AUTHENTICATION via the route-toolkit `withSession` wrapper, which
 *   this file already used, kept ABOVE the `id === 'new'` gate. The ordering is
 *   load-bearing, not cosmetic: `guardSynapseItemRequest` reads the session
 *   ITSELF, so leaning on it for authentication would put the unsaved-item
 *   short-circuit above the session read and `…/new` would answer 200 to a
 *   caller with NO cookie where it previously returned 401. That regression was
 *   MEASURED on #3655. `apps/fiab-console` has NO `middleware.ts` (verified),
 *   so this handler is the only enforcement point.
 *
 * LAYER 1 — OWN THE ROUTE ITEM. `guardSynapseItemRequest` against the SQL
 *   warehouse item, WRITE-SCOPED (no `allowReadRoles`) — the same guard the
 *   siblings `[id]/ctas` and `[id]/clone` run. Write-scoped is a DELIBERATE
 *   read/write-split decision, asserted rather than assumed in
 *   `__tests__/ghsa-v2g8-warehouse-query.test.ts`: the route name says "query"
 *   but the statement is arbitrary, so admitting a shared read role here would
 *   hand a Viewer arbitrary DDL. 404-not-403.
 *
 * LAYER 3 — NOT PRESENT, and named rather than implied. `warehouseId`, `sql`,
 *   `catalog` and `schema` all stay caller-supplied. No item→warehouse binding
 *   exists in this tree — `sql-warehouse-editor.tsx` picks the warehouse from a
 *   live `listWarehouses()` and never persists it — and a state-anchored
 *   binding could not close it, because `_lib/databricks-resource-binding.ts:12-27`
 *   records that `PATCH /api/cosmos-items/[type]/[id]` replaces `state`
 *   WHOLESALE from the request body, so the caller would write the value the
 *   bound reads. It IS bounded by construction to this deployment's own
 *   Databricks workspace (`dbxFetch` → `LOOM_DATABRICKS_HOSTNAME`).
 *
 *   RESIDUAL, RECORDED SO THIS IS NOT READ AS CLOSURE: a caller who can write
 *   ANY `databricks-sql-warehouse` item can still run arbitrary SQL on any
 *   warehouse in this deployment. LAYER 1 IS A FLOOR, NOT A BOUND, AND THE
 *   FLOOR IS SELF-SERVICE — `createOwnedItem` (`_lib/item-crud.ts:423`) lets any
 *   session holder create a qualifying item in a workspace they own, so this
 *   moves the reachable population from "any authenticated session" to "any
 *   authenticated session, plus one POST". The real bound needs the
 *   item→warehouse binding tracked in #3669 and is deliberately NOT improvised
 *   here.
 */

import { NextRequest, NextResponse } from 'next/server';
import { tenantScopeId } from '@/lib/auth/session';
import { withSession } from '@/lib/api/route-toolkit';
import { guardSynapseItemRequest, UNSAVED_ITEM_ID } from '../../../_lib/synapse-item-scope';
import { enforceRateLimit } from '@/lib/azure/rate-limiter';
import { executeStatement, getWarehouse, registerPendingStatement, clearPendingStatement, type DbxQueryParam } from '@/lib/azure/databricks-client';
import { recordQueryRun } from '@/lib/finops/query-run';

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
 * REACHABLE, checked at the call sites rather than assumed.
 * `app/items/[type]/[id]/page.tsx:164` renders the editor unconditionally, so
 * `/items/databricks-sql-warehouse/new` mounts it with `id="new"`
 * (`lib/editors/__tests__/databricks-sql-warehouse.test.tsx:23` renders exactly
 * that). `sql-warehouse-editor.tsx` contains NO `isNew` anywhere — measured,
 * `grep -c isNew` = 0, exit 1 — and its mount effect (:245) fills `warehouseId`
 * from the live `listWarehouses()` response, so `run` (:602), `dbxCountRows`
 * (:399) and `streaming-object-dialog.tsx:149` all fire on an unsaved item.
 * `guardSynapseItemRequest` FAILS CLOSED on an id naming no item — correctly —
 * so without this gate a freshly created item would 404 on its first query.
 * That is a dead end (`auto-bind-by-default.md`) and a day-one red state
 * (`ux-baseline.md`, "new-item first-open is clean").
 *
 * 200, matching the siblings fixed in #3665, and CHECKED against this route's
 * callers rather than copied: `run` branches only on `res.status === 409 &&
 * json.state` and otherwise assigns the whole payload to the tab result, which
 * renders `error` as the result-pane message; `dbxCountRows` reads `j?.ok` and
 * yields null. So a 200 gate body surfaces the actionable sentence and nothing
 * red.
 *
 * Match `UNSAVED_ITEM_ID` EXACTLY. Real ids are `crypto.randomUUID()`
 * (`_lib/item-crud.ts:467`), so special-casing the literal `new` downgrades
 * nothing; a substring or prefix test would let a real id skip the guard.
 */
function unsavedItemGate(): NextResponse {
  return NextResponse.json({
    ok: false,
    code: 'unsaved_item',
    error:
      'Save this SQL warehouse item first — a query runs in the name of the saved item, and an ' +
      'unsaved item has no owner to check that against yet.',
  }, { status: 200 });
}

export const POST = withSession<{ id: string }>(async (req: NextRequest, { session, params: routeParams }) => {
  // Rate limiting stays FIRST, deliberately. It is keyed to the CALLER'S OWN
  // session, so it discloses nothing about the route item, and it bounds the
  // cost of hammering the Cosmos read that Layer 1 performs below.
  const limited = await enforceRateLimit(session, 'query');
  if (limited) return limited;

  const itemId = routeParams.id;
  if (itemId === UNSAVED_ITEM_ID) return unsavedItemGate();

  // LAYER 1. WRITE-SCOPED — `sql` is unrestricted, so this handler executes DDL
  // and DML, not only SELECT. A shared read role must not reach it.
  const guard = await guardSynapseItemRequest({
    itemId,
    itemType: ITEM_TYPE,
    notFound: ITEM_UNREACHABLE,
  });
  if (guard.res) return guard.res;

  const body = await req.json().catch(() => ({}));
  const sql = (body?.sql || '').toString().trim();
  const warehouseId = (body?.warehouseId || '').toString().trim();
  const catalog = body?.catalog ? String(body.catalog) : undefined;
  const schema = body?.schema ? String(body.schema) : undefined;
  const clientQueryId = (body?.clientQueryId || '').toString().trim();
  // Named parameters — bound by Databricks, NOT string-concatenated.
  const parameters: DbxQueryParam[] = (Array.isArray(body?.parameters) ? body.parameters : [])
    .filter((p: any) => p && typeof p.name === 'string')
    .map((p: any) => ({
      name: String(p.name),
      value: p.value == null ? null : String(p.value),
      type: p.type ? String(p.type) : undefined,
    }));

  if (!sql) return NextResponse.json({ error: 'sql is required' }, { status: 400 });
  if (!warehouseId) return NextResponse.json({ error: 'warehouseId is required' }, { status: 400 });
  if (sql.length > 65_536) return NextResponse.json({ error: 'sql too large (>64KB)' }, { status: 413 });

  // State pre-check — bail fast with 409 so UI can prompt Start.
  const w = await getWarehouse(warehouseId).catch(() => null);
  if (w && w.state !== 'RUNNING') {
    return NextResponse.json(
      { ok: false, error: `Warehouse is ${w.state}. Call /start first.`, state: w.state },
      { status: 409 },
    );
  }

  try {
    const started = Date.now();
    const result = await executeStatement(
      warehouseId, sql, catalog, schema, parameters,
      clientQueryId ? (sid) => registerPendingStatement(clientQueryId, sid) : undefined,
    );
    // B-N19e — FOCUS cost attribution for this SQL-warehouse run (best-effort).
    void recordQueryRun({
      tenantId: tenantScopeId(session), userOid: session.claims.oid, userName: session.claims.upn,
      engine: 'databricks-sql', statement: sql, durationMs: Date.now() - started,
      rowCount: (result as { rowCount?: number }).rowCount,
      queryId: clientQueryId || undefined,
      itemId: routeParams.id, itemType: 'databricks-sql-warehouse',
      resourceId: warehouseId,
    });
    return NextResponse.json({
      ok: true,
      ...result,
      warehouseId,
      // Receipt: the parameterized statement actually sent + the bound params,
      // proving values travelled out-of-band (not concatenated into the SQL).
      statement: sql,
      parameters: parameters.map((p) => ({ name: p.name, value: p.value, type: p.type })),
      parametersCount: parameters.length,
      executedBy: session.claims?.upn,
    });
  } catch (e: any) {
    // A user Cancel surfaces as a terminal CANCELED state from the poll loop.
    const canceled = /CANCELED/i.test(e?.message || '') || e?.code === 'STATEMENT_CANCELED';
    return NextResponse.json(
      {
        ok: false,
        canceled,
        error: canceled ? 'Query canceled by user.' : (e?.message || String(e)),
        code: e?.code,
      },
      { status: canceled ? 200 : 502 },
    );
  } finally {
    if (clientQueryId) clearPendingStatement(clientQueryId);
  }
});
