/**
 * GET /api/items/[type]/[id]/monitoring?warehouseId=<id>&window=<seconds>
 *
 * Powers the warehouse Monitoring tab — a running-clusters / query-load line
 * chart plus a recent-query table — with REAL backend data:
 *
 *   - databricks-sql-warehouse → GET /api/2.0/sql/warehouses/{warehouseId}/events
 *     (running clusters over time) + /api/2.0/sql/history/queries (recent
 *     statements). Azure Databricks REST, AAD token, no Fabric.
 *   - synapse-dedicated-sql-pool / warehouse (Fabric "Warehouse" Azure-native
 *     default) → sys.dm_pdw_exec_requests via TDS — bucketed query load + the
 *     most recent requests. No Fabric, no Power BI.
 *
 * Honest gates: a missing LOOM_DATABRICKS_HOSTNAME / LOOM_SYNAPSE_WORKSPACE
 * returns 503 { code: 'not_configured', missing } so the UI shows a precise
 * MessageBar; a Paused Synapse pool returns 409 { code: 'pool_paused' }.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * GHSA-v8r7-c2p5-mjf2 — THE HOLE THIS FILE USED TO BE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `const { type } = await props.params` — `[id]` was never destructured, so the
 * item id sat in the URL and was read nowhere. `getSession()` was the entire
 * authorization. On the Databricks branch `warehouseId` came off the query
 * string and was REQUIRED (400 without it), then went straight to
 * `listWarehouseEvents(warehouseId, 200)` and `listQueryHistory({ warehouseId
 * })` as the Console identity.
 *
 * BE PRECISE ABOUT WHAT THIS IS AND IS NOT. It is READ-ONLY — no DDL, no
 * mutation, no rule deletion — so it is materially less severe than the UC
 * `[id]/security` and `[id]/alerts` entries recorded alongside it. What it
 * leaked is `query_text`: the SUBMITTED SQL of every statement run on any
 * warehouse the Console identity can reach, which is other tenants' query text.
 * That is information disclosure of exactly the kind the `warehouse/[id]/query`
 * family was fixed for, and it is the whole of the finding.
 *
 * THE SYNAPSE BRANCH WAS NEVER PART OF IT, stated so the fix is not read as
 * wider than it is: `dedicatedTarget()` derives workspace AND pool from
 * `LOOM_SYNAPSE_WORKSPACE` / `LOOM_SYNAPSE_DEDICATED_POOL`, the branch takes no
 * caller coordinate at all, and its DMV reads are pool-wide either way. Layer 1
 * is a real addition there too (it was equally unauthorized) but the disclosure
 * finding is the Databricks branch only.
 *
 * WHY NO CONTROL SAW IT — and why the allowlist entry is DELETED rather than
 * reworded. `check-route-guards.mjs` carried this path with
 *
 *     "read-only monitoring over a shared Azure backend resolved by item type"
 *
 * "read-only" is true. "resolved by item type" is true of the Synapse branch and
 * FALSE of the Databricks branch, which requires a caller-supplied
 * `?warehouseId=`. A reason that is accurate about a sibling branch reads as
 * verified — the same wording defect this advisory records for `sql-security`
 * and the UC `security` route, one directory apart, on the same sentence.
 * Rewording preserves that failure, so the entry is gone.
 *
 * ── WHAT IS AND IS NOT CLOSED ───────────────────────────────────────────────
 *
 * LAYER 1 — OWN THE ROUTE ITEM. `guardSynapseItemRequest`, the backend-agnostic
 *   Layer-1 guard the siblings `[id]/optimize` and `[id]/statistics` already
 *   use, with `allowReadRoles: true` because this handler genuinely only reads —
 *   the same scope `[id]/statistics`'s GET carries. 404-not-403.
 *
 * LAYER 3 — NOT PRESENT, and named. `warehouseId` stays caller-named because no
 *   item→warehouse binding exists in this tree: `sql-warehouse-editor.tsx` picks
 *   it from a LIVE `listWarehouses()` response (`:255`) and never persists it to
 *   item state, which is why the panel passes it as a prop rather than reading
 *   it back. It is bounded by construction to this deployment's own Databricks
 *   workspace (`dbxFetch` → `LOOM_DATABRICKS_HOSTNAME`) and is URL-encoded into
 *   the path / set as a `URLSearchParams` filter value, never interpolated.
 *
 *   RESIDUAL, RECORDED: an authenticated caller who owns any item of the route's
 *   `[type]` can still read the event timeline and query history — including
 *   `query_text` — of any warehouse in this deployment. LAYER 1 IS A FLOOR HERE,
 *   NOT A BOUND, the same ledger entry the two siblings carry. Closing it needs
 *   a per-item warehouse binding that does not exist today.
 */
import { NextRequest, NextResponse } from 'next/server';
import { guardSynapseItemRequest, UNSAVED_ITEM_ID } from '../../../_lib/synapse-item-scope';
import {
  databricksConfigGate,
  listWarehouseEvents,
  listQueryHistory,
} from '@/lib/azure/databricks-client';
import { synapseConfigGate } from '@/lib/azure/synapse-artifacts-client';
import { dedicatedTarget, executeQuery } from '@/lib/azure/synapse-sql-client';
import { getPoolState } from '@/lib/azure/synapse-pool-arm';
import {
  DEFAULT_WINDOW_SECS,
  buildClusterTimeline,
  mapDbxQueries,
  buildSynapseTimeline,
  mapSynapseQueries,
  synapseTimelineSql,
  synapseRecentRequestsSql,
  type MonitoringPayload,
} from '@/lib/azure/warehouse-monitoring';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DBX_TYPE = 'databricks-sql-warehouse';
const SYNAPSE_TYPES = new Set(['synapse-dedicated-sql-pool', 'warehouse']);

/** Turn an executeQuery() column/row-array result into keyed records. */
function toRecords(result: { columns: string[]; rows: unknown[][] }): Array<Record<string, unknown>> {
  return result.rows.map((row) => {
    const rec: Record<string, unknown> = {};
    result.columns.forEach((c, i) => { rec[c] = row[i]; });
    return rec;
  });
}

/**
 * The 404 body for an item the caller cannot reach — naming BOTH causes and
 * asserting NEITHER (`deploy-integrity.md` R7). Read-scoped here, so the second
 * cause is narrower than on the mutating siblings: only a caller with NO role at
 * all in the item's workspace is refused.
 */
const ITEM_UNREACHABLE =
  'This item is not available to you. Either it does not exist, or you have no role in ' +
  'its workspace. Ask a workspace owner to share it with you.';

/**
 * The unsaved-item honest gate, returned INSTEAD of Layer 1's 404 and before the
 * guard runs.
 *
 * REACHABLE FROM TWO OF THE THREE CALL SITES, checked rather than assumed:
 *
 *   `databricks/sql-warehouse-editor.tsx:1244` — the Monitoring tab renders
 *     unconditionally; that editor has NO `isNew` guard anywhere in the file.
 *   `synapse-sql-editors.tsx:1099`             — same shape; the string `isNew`
 *     does not occur in that file at all.
 *   `phase3/warehouse-editor.tsx:725`          — SAFE, and it is the model: it
 *     renders `isNew ? <MessageBar …"Save the warehouse first"> :
 *     <WarehouseMonitoringTab …>`. This gate is that same answer, moved to the
 *     route so the other two editors get it and a direct API call cannot skip it.
 *
 * `WarehouseMonitoringTab` fetches on mount (`useEffect(() => { void load(); })`,
 * unconditional) and paints a `!ok` response with NO recognised `code` as a RED
 * "Could not load monitoring" banner — so a bare 404 here would be a red error
 * on a freshly created item (`ux-baseline.md`) reached by clicking one tab. The
 * gate therefore carries `code: 'unsaved_item'`, which the panel now renders as
 * a warning with an accurate title.
 *
 * 200, NOT 4xx, and deliberately: this is the "not yet applicable" state of a
 * read surface, not a refusal of a hostile request, and the panel's own
 * `data.ok` branches key off the body rather than the status.
 */
function unsavedItemGate(): NextResponse {
  return NextResponse.json({
    ok: false,
    code: 'unsaved_item',
    error:
      'Save this item first — monitoring reads the live backend in the name of the saved ' +
      'item, and an unsaved item has no owner to check that against yet.',
  }, { status: 200 });
}

export async function GET(req: NextRequest, props: { params: Promise<{ type: string; id: string }> }) {
  const { type, id } = await props.params;
  if (id === UNSAVED_ITEM_ID) return unsavedItemGate();

  // LAYER 1. Read-scoped: this handler only reads, so shared read roles are
  // admitted — the same scope the sibling `[id]/statistics` GET carries.
  const guard = await guardSynapseItemRequest({
    itemId: id,
    itemType: type,
    notFound: ITEM_UNREACHABLE,
    allowReadRoles: true,
  });
  if (guard.res) return guard.res;

  const windowSecs = (() => {
    const n = Number(req.nextUrl.searchParams.get('window'));
    return Number.isFinite(n) && n > 0 ? Math.min(86_400, Math.floor(n)) : DEFAULT_WINDOW_SECS;
  })();

  // ── Databricks SQL Warehouse ──────────────────────────────────────────────
  if (type === DBX_TYPE) {
    const gate = databricksConfigGate();
    if (gate) {
      return NextResponse.json(
        { ok: false, code: 'not_configured', missing: gate.missing, error: `Databricks is not configured — set ${gate.missing}.` },
        { status: 503 },
      );
    }
    const warehouseId = req.nextUrl.searchParams.get('warehouseId') || undefined;
    if (!warehouseId) {
      return NextResponse.json({ ok: false, code: 'missing_warehouse', error: 'warehouseId query param is required.' }, { status: 400 });
    }
    try {
      const [events, history] = await Promise.all([
        listWarehouseEvents(warehouseId, 200),
        listQueryHistory({ warehouseId, maxResults: 50 }),
      ]);
      const payload: MonitoringPayload = {
        ok: true,
        engine: type,
        seriesLabel: 'Running clusters',
        windowSecs,
        clusterTimeline: buildClusterTimeline(events, windowSecs),
        queries: mapDbxQueries(history.entries),
        rawEvents: events.slice(0, 5),
      };
      return NextResponse.json(payload);
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
    }
  }

  // ── Synapse Dedicated SQL pool (Fabric "Warehouse" Azure-native default) ────
  if (SYNAPSE_TYPES.has(type)) {
    const gate = synapseConfigGate();
    if (gate) {
      return NextResponse.json(
        { ok: false, code: 'not_configured', missing: gate.missing, error: `Synapse is not configured — set ${gate.missing}.` },
        { status: 503 },
      );
    }
    // A paused pool cannot serve DMV queries — surface the precise resume gate.
    const state = await getPoolState().catch(() => null);
    if (state && state.state !== 'Online') {
      return NextResponse.json(
        { ok: false, code: 'pool_paused', state: state.state, sku: state.sku, error: `Dedicated SQL pool is ${state.state}. Resume it to view live monitoring.` },
        { status: 409 },
      );
    }
    try {
      const target = dedicatedTarget();
      const [timelineRes, recentRes] = await Promise.all([
        executeQuery(target, synapseTimelineSql(windowSecs)),
        executeQuery(target, synapseRecentRequestsSql(windowSecs)),
      ]);
      const timelineRecords = toRecords(timelineRes) as Array<{ bucket: unknown; query_count: unknown }>;
      const recentRecords = toRecords(recentRes);
      const payload: MonitoringPayload = {
        ok: true,
        engine: type,
        seriesLabel: 'Queries started (5-min buckets)',
        windowSecs,
        clusterTimeline: buildSynapseTimeline(timelineRecords),
        queries: mapSynapseQueries(recentRecords),
        rawEvents: recentRecords.slice(0, 5),
      };
      return NextResponse.json(payload);
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message || String(e), code: e?.code }, { status: 502 });
    }
  }

  return NextResponse.json(
    { ok: false, code: 'unsupported_item_type', error: `Monitoring is available for SQL warehouses and dedicated pools, not '${type}'.` },
    { status: 400 },
  );
}
