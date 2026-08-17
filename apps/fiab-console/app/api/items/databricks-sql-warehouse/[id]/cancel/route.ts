/**
 * POST /api/items/databricks-sql-warehouse/[id]/cancel
 * body: { statementId } | { clientQueryId }
 *
 * Cancels a running Databricks SQL statement via
 *   POST /api/2.0/sql/statements/{statement_id}/cancel
 * Grounded in the SQL Statement Execution API "cancel" operation
 * (https://learn.microsoft.com/azure/databricks/api/workspace/statementexecution/cancelexecution).
 *
 * The client generates a clientQueryId before issuing /query; the query route
 * registers clientQueryId -> statement_id as soon as the statement is submitted,
 * so this route can resolve and cancel the statement while /query is still
 * polling. A direct statementId is also accepted.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * GHSA-v2g8-gp3r-rg4r — THE HOLE THIS FILE USED TO BE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `POST(req: NextRequest)` took NO `ctx`, so `[id]` was never read. `getSession()`
 * was the entire authorization, and `body.statementId` went verbatim to
 * `cancelStatement(statementId)` on the shared Databricks workspace as the
 * Console identity.
 *
 * IT IS NOT THE SAME SHAPE AS ITS SIBLINGS AND IS TREATED ON ITS OWN EVIDENCE:
 * there is no `warehouseId` here at all. The caller-supplied coordinate is a
 * STATEMENT id, and the effect is to ABORT A RUNNING QUERY — someone else's.
 * Paired with `[id]/query-history`, which hands out `statement_id`s across the
 * whole workspace, an unowned caller could enumerate other tenants' in-flight
 * statements and kill them: a targeted denial of service, not a read.
 *
 * `cancelByClientId` is narrower — the `clientQueryId → statement_id` map is
 * in-process, so it only reaches statements this replica submitted — but it is
 * still not caller-scoped, and it is not the dangerous half.
 *
 * ── WHAT IS AND IS NOT CLOSED ───────────────────────────────────────────────
 *
 * LAYER 0 — AUTHENTICATION via `withSession`, ABOVE the `id === 'new'` gate AND
 *   above the config gate. Ordering MEASURED on #3655.
 *
 * LAYER 1 — OWN THE ROUTE ITEM, WRITE-SCOPED (no `allowReadRoles`). Cancelling
 *   terminates work in flight; a shared read role must not reach it. Asserted
 *   in `__tests__/ghsa-v2g8-warehouse-reads.test.ts` rather than assumed.
 *
 *   THE CONFIG GATE MOVED BELOW THE GUARD, matching `[id]/ctas` and the
 *   `[id]/clone` placement #3665 made deliberately — an unowned caller no longer
 *   learns the deployment's Databricks configuration state from a 503 that fired
 *   before authorization.
 *
 * LAYER 3 — NOT PRESENT, and named: `statementId` stays caller-supplied, and
 *   nothing in this tree records which Loom item a Databricks `statement_id`
 *   belongs to. The in-process `clientQueryId` map is a cancellation aid, not an
 *   ownership record — it does not survive a replica. FLOOR, NOT BOUND — #3669.
 */
import { NextRequest, NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { guardSynapseItemRequest, UNSAVED_ITEM_ID } from '../../../_lib/synapse-item-scope';
import { cancelStatement, cancelByClientId, databricksConfigGate } from '@/lib/azure/databricks-client';

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
 * REACHABLE: `cancel` (`sql-warehouse-editor.tsx:635`) fires whenever a tab has
 * an in-flight `queryId`, and that file has NO `isNew` anywhere (measured,
 * `grep -c` = 0). 200 + `code:'unsaved_item'`, and the status is immaterial to
 * this particular caller — `cancel` DISCARDS the response entirely (`await
 * clientFetch(...)` inside a bare `try`/`catch {}`) because the query promise
 * resolves to `canceled` regardless. 200 is chosen to match the family rather
 * than because this caller inspects it; recorded so the choice is not mistaken
 * for a constraint.
 */
function unsavedItemGate(): NextResponse {
  return NextResponse.json({
    ok: false,
    code: 'unsaved_item',
    error:
      'Save this SQL warehouse item first — cancelling runs in the name of the saved item, and ' +
      'an unsaved item has no owner to check that against yet.',
  }, { status: 200 });
}

export const POST = withSession<{ id: string }>(async (req: NextRequest, { session, params }) => {
  const { id: itemId } = params;
  if (itemId === UNSAVED_ITEM_ID) return unsavedItemGate();

  // LAYER 1. WRITE-SCOPED — cancelling terminates work in flight.
  const guard = await guardSynapseItemRequest({
    itemId,
    itemType: ITEM_TYPE,
    notFound: ITEM_UNREACHABLE,
  });
  if (guard.res) return guard.res;

  // BELOW the guard — an unowned caller must not learn the deployment's
  // Databricks configuration state.
  const gate = databricksConfigGate();
  if (gate) {
    return NextResponse.json(
      { ok: false, error: `Databricks not configured — set ${gate.missing}.`, code: 'not_configured' },
      { status: 503 },
    );
  }

  const body = await req.json().catch(() => ({}));
  const statementId = (body?.statementId || '').toString().trim();
  const clientQueryId = (body?.clientQueryId || '').toString().trim();

  if (!statementId && !clientQueryId) {
    return NextResponse.json(
      { ok: false, error: 'statementId (or clientQueryId) is required' },
      { status: 400 },
    );
  }

  try {
    if (statementId) {
      await cancelStatement(statementId);
      return NextResponse.json({ ok: true, canceled: true, statementId, canceledBy: session.claims?.upn });
    }
    const r = await cancelByClientId(clientQueryId);
    // canceled:false simply means the statement is no longer in-flight on this
    // replica (already finished, or running on another instance). Still ok:true.
    return NextResponse.json({ ok: true, canceled: r.canceled, statementId: r.statementId, canceledBy: session.claims?.upn });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
});
