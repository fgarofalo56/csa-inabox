/**
 * Whether a session may RESUME the estate - a presentation hint for the shell
 * banner (show the Resume button or the "ask an administrator" text), mirroring the
 * resume route's own gate (`withTenantAdmin` -> `isTenantAdmin`). The resume route
 * still enforces it; this never authorizes anything.
 *
 * It lives in its own module so `app/api/estate/paused/route.ts`, which any signed-in
 * user may call, does not name the admin predicate itself: the route inventory
 * classifies a route by the identifiers in its source, and a session-only route that
 * merely reports a hint must not be published as admin-only.
 */
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import type { SessionPayload } from '@/lib/auth/session';

export function sessionMayResumeEstate(session: SessionPayload): boolean {
  return isTenantAdmin(session);
}
