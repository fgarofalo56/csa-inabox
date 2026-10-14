/**
 * POST /api/admin/estate/pause — pause the Loom estate (PAUSE tier only).
 *
 * ── WHAT THIS DOES AND WHAT IT REFUSES TO DO ───────────────────────────────
 * Does:    issues the NATIVE pause/stop/suspend verb on the resources this Loom
 *          install is positively established to own. Nothing is deleted, no SKU
 *          is changed, no data is touched.
 * Refuses: to act on anything not POSITIVELY identified as this estate's; to act
 *          on a set that changed since the operator saw the preview; to act
 *          without a typed confirmation; to report PAUSED on a dispatch.
 *
 * ── THE SAFETY GATES, IN THE ORDER THEY RUN ────────────────────────────────
 *   0. `LOOM_ESTATE_PAUSE_ENABLED` — THE ARMING SWITCH, unset by default in
 *      every cloud. The deploy DOES set every env var the manifest is built
 *      from (`LOOM_SYNAPSE_DEDICATED_POOL`, `LOOM_KUSTO_CLUSTER_NAME`,
 *      `LOOM_AAS_SERVER_NAME`, …), so without this gate merging would arm a
 *      one-click pause of ~$3,000/mo on an estate that auto-rolls on every
 *      merge, with no live receipt that resume works and R-CAP-2 unimplemented.
 *      See `ESTATE_PAUSE_ENABLED_ENV` for the full reasoning.
 *   1. `withTenantAdmin` — the wrapper, never an inline check. See the note in
 *      `../state/route.ts`: `enforceCapability`/`requireTenantAdmin` return
 *      `NextResponse | null`, so the authorization IS the caller's
 *      `if (gate) return gate;` line — and on 2026-08-07 deleting that one line
 *      left three separate route-guard checkers green over an open route. The
 *      wrapper takes the handler as an ARGUMENT, so there is no line to delete.
 *   2. `confirm` — a typed echo of the estate id. The repo's established
 *      destructive-action guard (`admin/scaling/adx/route.ts` echoes the cluster
 *      name). There is no per-route CSRF token in this codebase.
 *   3. `confirmToken` — a DRIFT guard, 409 on mismatch, exactly like
 *      `/api/admin/updates/apply`'s `confirmTag`. The operator confirmed a
 *      SPECIFIC set of resources; if the resolved set has changed since, we
 *      refuse rather than pause something they never saw. REQUIRED (#3989): an
 *      absent token is refused too, because the previous `body.confirmToken &&
 *      …` shape let any caller skip the gate by omitting the field while the
 *      error text still promised the guarantee it was no longer providing.
 *      #4243: the comparison is `evaluateDrift`, never a raw `!==` — a "the
 *      set changed" refusal is issued ONLY on a positively-observed change;
 *      a failed (throttled/unreachable) discovery read refuses with a RETRY
 *      message instead, and every refusal on this gate writes an audit row.
 *   4. Re-verify per resource, inside the orchestrator, immediately before each
 *      ARM call (R-SCOPE-3), and actuate the VERIFIED id (`assertActuationTarget`).
 *
 * Returns 202 with the per-resource dispatch results. The estate is left
 * PAUSING; `GET /api/admin/estate/state` is what confirms it reached PAUSED,
 * from fresh authoritative ARM reads.
 *
 * Dual audit per §7: `auditLogContainer()` (Cosmos) + `emitAuditEvent()` (SIEM).
 */
import type { NextRequest } from 'next/server';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { callerFromSession } from '@/lib/estate/estate-caller';
import { handlePausePost, type PauseBody } from '@/lib/estate/estate-power-handlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The gates above now live in `@/lib/estate/estate-power-handlers` (shared with the
// service-principal route `/api/estate/power`), so the two entry points cannot drift.
export const POST = withTenantAdmin(async (req: NextRequest, { session }) => {
  const body = (await req.json().catch(() => ({}))) as PauseBody;
  return handlePausePost(callerFromSession(session), body);
});
