/**
 * GET /api/items/databricks-sql-warehouse/[id]/query-profile?queryId=<statement_id>
 *
 * Fetches a single query's execution profile from Databricks via
 * GET /api/2.0/sql/history/queries/{statement_id}?include_metrics=true
 *
 * Returns:
 *   { ok, query_id, status, query_text, duration, user_name, warehouse_id,
 *     rows_produced, error_message, spark_ui_url, statement_type,
 *     photon_coverage_pct, metrics: { compilation_time_ms, execution_time_ms,
 *       photon_total_time_ms, total_time_ms, read_bytes, read_remote_bytes,
 *       write_remote_bytes, read_cache_bytes, rows_read_count,
 *       rows_produced_count, result_fetch_time_ms, ... },
 *     plans_state, plans }
 *
 * `metrics` are the real IO/Photon numbers the Databricks Query Profile UI
 * renders. `spark_ui_url` is the authoritative deep-link to the full physical
 * plan DAG; `plans`/`plans_state` carry the inline plan tree when the
 * workspace returns it.
 *
 * Auth: the BFF MI must own the query or hold CAN MONITOR on the warehouse.
 * No mock data — real Databricks REST. Azure-native (no Fabric dependency).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * GHSA-v2g8-gp3r-rg4r — THE HOLE THIS FILE USED TO BE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `GET(req: NextRequest)` took NO `ctx`, so `[id]` was never read. `getSession()`
 * was the entire authorization, and `?queryId=` went verbatim into
 * `getQueryProfile(queryId)`.
 *
 * THE "Auth:" LINE ABOVE WAS THE DEFECT, STATED AS A FEATURE. "The BFF MI must
 * own the query or hold CAN MONITOR on the warehouse" describes the CONSOLE
 * IDENTITY's Databricks permissions — which are broad by construction — and says
 * nothing about the CALLER. Any authenticated session could name any
 * `statement_id` in the shared workspace and receive `query_text` (the full SQL),
 * `user_name` (who ran it), the IO/Photon metrics and the plan tree. Paired with
 * the sibling `[id]/query-history`, which HANDS OUT statement ids workspace-wide,
 * that is a complete cross-tenant read of other tenants' SQL and its execution.
 *
 * IT IS NOT "SAME SHAPE" AS ITS SIBLINGS, and that is why it is treated on its
 * own evidence: it takes `queryId`, not `warehouseId`, so the family's
 * caller-supplied-warehouse framing does not describe it. The exposure is a
 * caller-supplied STATEMENT id instead, which is strictly more direct.
 *
 * ── WHAT IS AND IS NOT CLOSED ───────────────────────────────────────────────
 *
 * LAYER 0 — AUTHENTICATION via `withSession`, ABOVE both the `id === 'new'` gate
 *   AND the config gate (see below). Ordering MEASURED on #3655.
 *
 * LAYER 1 — OWN THE ROUTE ITEM, READ-SCOPED (`allowReadRoles: true`) — this
 *   handler only reads a profile.
 *
 *   THE CONFIG GATE NOW SITS BELOW THE GUARD, matching `[id]/ctas` and the
 *   `[id]/clone` placement #3665 made deliberately. Previously an unowned caller
 *   received the 503 naming `LOOM_DATABRICKS_HOSTNAME` and the bicep module
 *   path, i.e. learned the deployment's Databricks configuration state before
 *   any authorization ran.
 *
 * LAYER 3 — NOT PRESENT, and named. `queryId` stays caller-supplied: there is no
 *   record anywhere in this tree tying a Databricks `statement_id` back to a Loom
 *   item, so there is nothing to check it against. `[id]/query` registers
 *   `clientQueryId → statement_id` only in an in-process map for cancellation,
 *   which does not survive a replica and is not an ownership record. FLOOR, NOT
 *   BOUND — see #3669.
 */
import { NextRequest, NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { guardSynapseItemRequest, UNSAVED_ITEM_ID } from '../../../_lib/synapse-item-scope';
import { getQueryProfile, databricksConfigGate } from '@/lib/azure/databricks-client';

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
 * REACHABLE: `openProfile` (`sql-warehouse-editor.tsx:750`) is reached from a
 * history row, and that file has NO `isNew` anywhere (measured, `grep -c` = 0).
 * 200 + `code:'unsaved_item'`: `openProfile` throws on `!j.ok` and renders the
 * message as the profile dialog's error text.
 */
function unsavedItemGate(): NextResponse {
  return NextResponse.json({
    ok: false,
    code: 'unsaved_item',
    error:
      'Save this SQL warehouse item first — a query profile is read in the name of the saved ' +
      'item, and an unsaved item has no owner to check that against yet.',
  }, { status: 200 });
}

export const GET = withSession<{ id: string }>(async (req: NextRequest, { params }) => {
  const { id: itemId } = params;
  if (itemId === UNSAVED_ITEM_ID) return unsavedItemGate();

  // LAYER 1. READ-SCOPED — this handler only reads a profile.
  const guard = await guardSynapseItemRequest({
    itemId,
    itemType: ITEM_TYPE,
    notFound: ITEM_UNREACHABLE,
    allowReadRoles: true,
  });
  if (guard.res) return guard.res;

  // BELOW the guard, deliberately — an unowned caller must not learn the
  // deployment's Databricks configuration state from a gate that fires first.
  const gate = databricksConfigGate();
  if (gate) {
    return NextResponse.json(
      {
        ok: false,
        code: 'not_configured',
        error: `Databricks not configured: set ${gate.missing}. Deploy the Azure Databricks workspace (platform/fiab/bicep/modules/analytics/databricks.bicep) and wire LOOM_DATABRICKS_HOSTNAME.`,
      },
      { status: 503 },
    );
  }

  const queryId = req.nextUrl.searchParams.get('queryId');
  if (!queryId) {
    return NextResponse.json({ ok: false, error: 'queryId is required' }, { status: 400 });
  }

  try {
    const profile = await getQueryProfile(queryId);
    const metrics = profile.metrics || {};
    const photonPct =
      metrics.execution_time_ms && metrics.photon_total_time_ms != null
        ? Math.round((metrics.photon_total_time_ms / metrics.execution_time_ms) * 100)
        : null;
    return NextResponse.json({
      ok: true,
      query_id: profile.query_id,
      status: profile.status,
      query_text: profile.query_text,
      query_start_time_ms: profile.query_start_time_ms,
      query_end_time_ms: profile.query_end_time_ms,
      duration: profile.duration,
      user_name: profile.user_name,
      warehouse_id: profile.warehouse_id,
      rows_produced: profile.rows_produced,
      error_message: profile.error_message,
      spark_ui_url: profile.spark_ui_url,
      statement_type: profile.statement_type,
      metrics,
      photon_coverage_pct: photonPct,
      plans_state: profile.plans_state,
      plans: profile.plans,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
});
