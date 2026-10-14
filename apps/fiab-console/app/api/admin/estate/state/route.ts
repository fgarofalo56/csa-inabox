/**
 * GET /api/admin/estate/state — the estate's pause state, live.
 *
 * This is the READ half of the pause/resume feature and it does three things:
 *
 *   1. When the estate is RUNNING, it returns the DRY RUN (R-SCOPE-4): exactly
 *      what a pause would act on, each row with the owning tag that put it
 *      there, plus the POPULATION report so an empty preview explains itself
 *      instead of looking like a broken feature.
 *   2. When the estate is PAUSING or RESUMING, it POLLS — re-reading
 *      authoritative ARM for every snapshot resource and, on the resume side,
 *      issuing a real data-plane probe. This is what promotes PAUSING -> PAUSED
 *      and RESUMING -> RUNNING | RESUME_FAILED. The UI polls this route; the
 *      state machine advances here, never in the browser.
 *   3. It reports capacity risk (R-CAP-3) so the confirm dialog can state, per
 *      resource, what a resume might not get back.
 *
 * SAFE TO CALL ON PAGE LOAD. It performs ARM GETs and (on a resume poll) a
 * cheap data-plane query. It issues no pause or resume verb, ever.
 *
 * Authorization is `withTenantAdmin` from the route toolkit, NOT an inline
 * check. The wrapper takes the handler as an argument, so there is no
 * `if (gate) return gate;` line in this file for someone to delete — which is
 * the exact failure shape measured on 2026-08-07, when removing that one line
 * from `app/api/setup/deploy/route.ts` left THREE separate route-guard checkers
 * green over an open route.
 *
 * ── CLOUD BOUNDARY: cloud-AGNOSTIC, not cloud-VERIFIED ────────────────────
 * `arm-client` resolves its host through `armBase()` and this path has no
 * `api.github.com` dependency, so a Gov console WOULD render this card and
 * actuate Gov ARM directly. That is a statement about behaviour; it is not a
 * receipt. **Azure Government is UNTESTED** — no Gov deploy, no Gov ARM call,
 * no Gov browser walk — and per `cloud-parity.md` an untested boundary is named
 * as untested rather than implied working. PRP work item **W7** owns the Gov
 * path. The `LOOM_ESTATE_PAUSE_ENABLED` opt-in is unset in every boundary
 * including Gov, so the surface is inert there until deliberately armed. The
 * detected boundary is returned as `cloud` so the UI can say which one it is.
 */
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { callerFromSession } from '@/lib/estate/estate-caller';
import { handleStateRead } from '@/lib/estate/estate-power-handlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The read/poll logic lives in `@/lib/estate/estate-power-handlers`, shared with the
// service-principal route `/api/estate/power`. The response now also carries `power`
// (last activity, idle time, auto-pause setting, last pause/resume).
export const GET = withTenantAdmin(async (_req, { session }) => {
  return handleStateRead(callerFromSession(session));
});
