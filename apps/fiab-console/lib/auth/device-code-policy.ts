/**
 * Least-privilege policy for sessions minted by the CLI / VS Code device-code
 * sign-in (#4805).
 *
 * OPERATOR DECISION 2026-09-30, "Guardrails in-product": a session obtained
 * through the non-interactive device-code flow (`POST /api/auth/cli-session`,
 * stamped `authVia: 'device_code'`) is hardened in three ways, independent of
 * any tenant Conditional Access policy:
 *
 *   (a) a SHORTER lifetime — {@link DEVICE_CODE_SESSION_MAX_AGE_SECS}, counted
 *       from the original mint; `/api/auth/refresh` never extends it;
 *   (b) NO ADMIN SURFACES — `/admin/*` pages and `/api/admin/*` routes (see
 *       middleware.ts) and every tenant-admin / admin-tier capability gate (see
 *       lib/auth/feature-gate.ts) refuse it with {@link deviceCodeAdminRefusal};
 *   (c) a per-IP rate limit and a concurrent-stream cap on starting the sign-in
 *       (app/api/auth/cli-session/route.ts).
 *
 * Admin actions stay available to the same user through an interactive browser
 * sign-in, which is where the tenant's full sign-in policy applies.
 */
import { NextResponse } from 'next/server';
import type { SessionPayload } from './session';

/** (a) Device-code session lifetime, seconds: 1 hour (operator decision 2026-09-30). */
export const DEVICE_CODE_SESSION_MAX_AGE_SECS = 60 * 60;

/** True for a session minted by the device-code sign-in. */
export function isDeviceCodeSession(session: Pick<SessionPayload, 'authVia'> | null | undefined): boolean {
  return session?.authVia === 'device_code';
}

/** The reason every admin refusal carries — one string, so callers and tests agree. */
export const INTERACTIVE_SIGN_IN_REQUIRED_REASON =
  'Admin actions require an interactive browser sign-in. This session was created by the ' +
  'CLI / VS Code device-code sign-in, which is limited to non-admin work.';

/** (b) The 403 an admin surface returns to a device-code session. */
export function deviceCodeAdminRefusal(): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      error: 'forbidden',
      code: 'interactive_sign_in_required',
      reason: INTERACTIVE_SIGN_IN_REQUIRED_REASON,
      remediation: 'Sign in to the Loom console in a browser and perform this action there.',
    },
    { status: 403 },
  );
}

/**
 * Whether a capability check is ADMIN-TIER: an `admin.*` capability, or any
 * capability demanded at the Admin role. Device-code sessions are refused these;
 * Reader / Contributor checks on non-admin capabilities are unaffected.
 */
export function isAdminTierCapability(capabilityId: string, requiredRole: string): boolean {
  return requiredRole === 'Admin' || capabilityId === 'admin' || capabilityId.startsWith('admin.');
}
