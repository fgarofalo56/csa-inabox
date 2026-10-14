/**
 * POST /api/admin/estate/resume — bring the paused Loom estate back up.
 *
 * ── THE ONE THING THIS ROUTE MUST NEVER DO ─────────────────────────────────
 * Report success it has not established. Resume is a ~15-minute operation at
 * best (ADX ~10 min plus unbounded hot-cache rehydration; a Synapse pool
 * "several minutes", and it reports `ONLINE` 2-3 minutes BEFORE it can serve a
 * query). No HTTP request that starts a resume can possibly know how it ended.
 *
 * So this route returns **202 Accepted** with the estate in `RESUMING` and a
 * `monitorUrl`. `GET /api/admin/estate/state` is what confirms the outcome, and
 * it produces `RUNNING` only when EVERY resource passes BOTH an authoritative
 * ARM read AND a real data-plane probe. Anything less is `RESUME_FAILED`
 * (R-CAP-4) — a distinct, loud state with a per-resource remediation, never a
 * spinner that eventually says "done".
 *
 * ── AND THE THING IT MUST BE ABLE TO DO ────────────────────────────────────
 * Work when the pause did not. Azure does not reserve capacity while a resource
 * is stopped: on 2026-08-22 the GCC-High ADX cluster auto-stopped and could not
 * restart (`InsufficientResourcesForSubscription`). When that happens the
 * response CLASSIFIES the failure and names the declared fallback SKU rather
 * than emitting a stack trace. Applying the fallback automatically (R-CAP-2) is
 * a tracked follow-up and is deliberately NOT done here — Loom will not change
 * the operator's SKU without being asked.
 *
 * Authorization is `withTenantAdmin` — the wrapper, never an inline check. No
 * typed confirmation: resume is the SAFE direction, and per PRP §5 an operator
 * must always be able to bring the estate back with one click.
 *
 * ── AND IT IS DELIBERATELY *NOT* BEHIND `LOOM_ESTATE_PAUSE_ENABLED` ───────
 * The pause route is. This one is not, and that asymmetry is the point: the
 * arming switch exists to stop an unvalidated feature from STOPPING things, not
 * to stop an operator from starting them again. Gating resume would mean an
 * estate paused while the flag was set becomes unrecoverable through the
 * product the moment someone unsets it — turning a safety control into an
 * outage. Resume is transitively gated anyway: it needs a persisted snapshot,
 * and only a gated pause can create one.
 *
 * ── CLOUD BOUNDARY ─────────────────────────────────────────────────────────
 * Cloud-agnostic via `armBase()`, but **Azure Government is UNTESTED** — no Gov
 * deploy, no Gov ARM call. Named as untested per `cloud-parity.md`; PRP work
 * item W7 owns the Gov path.
 *
 * Dual audit per §7: `auditLogContainer()` (Cosmos) + `emitAuditEvent()` (SIEM).
 */
import type { NextRequest } from 'next/server';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { callerFromSession } from '@/lib/estate/estate-caller';
import { handleResumePost } from '@/lib/estate/estate-power-handlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The body lives in `@/lib/estate/estate-power-handlers`, shared with the
// service-principal route `/api/estate/power`.
export const POST = withTenantAdmin(async (_req: NextRequest, { session }) => {
  return handleResumePost(callerFromSession(session));
});
