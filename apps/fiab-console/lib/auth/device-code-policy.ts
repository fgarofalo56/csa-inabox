/**
 * Least-privilege policy for sessions minted by the CLI / VS Code device-code
 * sign-in (#4805).
 *
 * OPERATOR DECISION 2026-09-30, "Guardrails in-product": a session obtained
 * through the non-interactive device-code flow (`POST /api/auth/cli-session`,
 * stamped `authVia: 'device_code'`) is hardened in these ways, independent of
 * any tenant Conditional Access policy:
 *
 *   (a) a SHORTER lifetime — {@link DEVICE_CODE_SESSION_MAX_AGE_SECS}, counted
 *       from the original mint; `/api/auth/refresh` never extends it;
 *   (b) NO ADMIN SURFACES — `/admin/*` pages and `/api/admin/*` routes (see
 *       middleware.ts), every tenant-admin / admin-tier capability gate (see
 *       lib/auth/feature-gate.ts) and the Data Landing Zone admin-tier gate
 *       (lib/auth/dlz-gate.ts) refuse it with {@link deviceCodeAdminRefusal};
 *   (c) a per-IP rate limit and a concurrent-stream cap on starting the sign-in
 *       (app/api/auth/cli-session/route.ts);
 *   (d) NOTHING THAT OUTLIVES IT — it cannot create, reveal or rotate a durable
 *       credential (API tokens, service keys, subscription keys, signed callback
 *       URLs, sharing recipients, storage credentials) or grant anyone standing
 *       access (role assignments, permissions, shares, security roles, access
 *       approvals). Every such route is listed in {@link DURABLE_ACCESS_ROUTES};
 *       middleware.ts refuses the listed methods with {@link refuseNonInteractive}
 *       before the route runs. Where only PART of a route's answer is durable,
 *       the route withholds that part itself: a self-serve catalog request takes
 *       the governed path (app/api/catalog/request-access), and a custom-app
 *       Eventstream source is created without returning its SAS connection
 *       string (app/api/items/eventstream/[id]/source). Admin-tier key routes
 *       are refused by the DLZ gate (b). lib/auth/__tests__/durable-access-routes.test.ts
 *       fails when a route that calls a credential- or grant-minting primitive
 *       is none of these and is not exempted with a reason.
 *
 * All of it stays available to the same user through an interactive browser
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

/** What the user should do — `hint` is the field the CLI and the VS Code extension show. */
export const INTERACTIVE_SIGN_IN_HINT =
  'Sign in to the Loom console in a browser and do this there.';

function refusal(message: string, extra: Record<string, unknown> = {}): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      error: 'forbidden',
      code: 'interactive_sign_in_required',
      message,
      reason: message,
      hint: INTERACTIVE_SIGN_IN_HINT,
      remediation: INTERACTIVE_SIGN_IN_HINT,
      ...extra,
    },
    { status: 403 },
  );
}

/** (b) The 403 an admin surface returns to a device-code session. */
export function deviceCodeAdminRefusal(): NextResponse {
  return refusal(INTERACTIVE_SIGN_IN_REQUIRED_REASON);
}

/** The sentence a (d) refusal carries for `action` ("Creating a personal API token", …). */
export function nonInteractiveRefusalReason(action: string): string {
  return (
    `${action} requires an interactive browser sign-in. A CLI / VS Code device-code ` +
    'session cannot create, reveal or rotate credentials or grant access, because those outlive the session.'
  );
}

/**
 * (d) Refuse a durable-credential or access-grant action for a device-code
 * session: returns the 403, or `null` when the session is interactive (or
 * absent — authentication is the route's own job).
 */
export function refuseNonInteractive(
  session: Pick<SessionPayload, 'authVia'> | null | undefined,
  action: string,
): NextResponse | null {
  if (!isDeviceCodeSession(session)) return null;
  return refusal(nonInteractiveRefusalReason(action), { action });
}

/**
 * Whether a capability check is ADMIN-TIER: an `admin.*` capability, or any
 * capability demanded at the Admin role. Device-code sessions are refused these;
 * Reader / Contributor checks on non-admin capabilities are unaffected.
 */
export function isAdminTierCapability(capabilityId: string, requiredRole: string): boolean {
  return requiredRole === 'Admin' || capabilityId === 'admin' || capabilityId.startsWith('admin.');
}

/** One (d) route: a Next matcher path (`:param` segments only), the refused methods, and the action. */
export interface DurableAccessRoute {
  readonly matcher: string;
  readonly methods: readonly string[];
  readonly action: string;
}

/**
 * (d) EVERY route method that creates, reveals or rotates a durable credential
 * or grants standing access. `middleware.ts` lists each `matcher` in its
 * `config.matcher` (Next requires that list to be a literal; the test pins the
 * two to the same set) and refuses the listed methods for a device-code session.
 * Revocations (DELETE) are not listed: removing access is the safe direction.
 */
export const DURABLE_ACCESS_ROUTES: readonly DurableAccessRoute[] = [
  // Loom-issued bearer credentials.
  { matcher: '/api/developer/tokens', methods: ['POST'], action: 'Creating a personal API token' },
  // Service keys, subscription keys and signed URLs (created, revealed or rotated).
  { matcher: '/api/apim/subscriptions', methods: ['POST'], action: 'Creating an API Management subscription' },
  { matcher: '/api/apim/subscriptions/:sid', methods: ['PATCH'], action: "Changing an API Management subscription's state" },
  { matcher: '/api/apim/subscriptions/:sid/keys', methods: ['GET'], action: 'Reading API Management subscription keys' },
  { matcher: '/api/marketplace/subscriptions', methods: ['POST'], action: 'Creating an API subscription' },
  { matcher: '/api/marketplace/subscriptions/:sid', methods: ['PATCH'], action: "Changing an API subscription's state" },
  { matcher: '/api/marketplace/subscriptions/:sid/keys', methods: ['POST'], action: 'Reading API subscription keys' },
  { matcher: '/api/marketplace/subscriptions/:sid/keys/regenerate', methods: ['POST'], action: 'Regenerating API subscription keys' },
  { matcher: '/api/marketplace/products/:id/subscribe', methods: ['POST'], action: 'Subscribing to a marketplace product' },
  { matcher: '/api/dab/:id/publish', methods: ['POST'], action: 'Publishing a Data API and issuing its subscription keys' },
  { matcher: '/api/items/data-product/:id/publish-api', methods: ['POST'], action: 'Publishing a data product API and issuing its subscription keys' },
  { matcher: '/api/azure/iothub/policies', methods: ['GET'], action: 'Reading IoT Hub shared access keys' },
  { matcher: '/api/foundry/keys', methods: ['GET'], action: 'Reading AI Foundry account keys' },
  { matcher: '/api/monitor/logic-app-callback', methods: ['POST'], action: 'Reading a Logic App trigger callback URL' },
  { matcher: '/api/databricks/unity-catalog/storage-credentials', methods: ['POST', 'PATCH'], action: 'Creating or changing a Unity Catalog storage credential' },
  // Sharing with parties outside the tenant.
  { matcher: '/api/marketplace/sharing/recipients', methods: ['POST'], action: 'Creating a Delta Sharing recipient' },
  { matcher: '/api/marketplace/sharing/recipients/:name', methods: ['PATCH'], action: 'Enabling or disabling a Delta Sharing recipient' },
  { matcher: '/api/marketplace/sharing/shares', methods: ['POST'], action: 'Creating a Delta Sharing share' },
  { matcher: '/api/marketplace/sharing/shares/:name', methods: ['PATCH'], action: 'Changing a Delta Sharing share' },
  { matcher: '/api/external-shares', methods: ['POST'], action: 'Creating an external share' },
  { matcher: '/api/external-shares/:id/accept', methods: ['POST'], action: 'Accepting an external share' },
  // Standing access grants and the policies that bound them.
  { matcher: '/api/workspaces/:id/role-assignments', methods: ['POST'], action: 'Adding a workspace role assignment' },
  { matcher: '/api/workspaces/:id/permissions', methods: ['POST'], action: 'Granting workspace permissions' },
  { matcher: '/api/items/:type/:id/permissions', methods: ['POST'], action: 'Granting item permissions' },
  { matcher: '/api/items/:type/:id/share', methods: ['POST'], action: 'Sharing an item' },
  { matcher: '/api/items/:type/:id/security-roles', methods: ['POST', 'PUT'], action: 'Changing item security roles' },
  { matcher: '/api/items/:type/:id/security', methods: ['POST'], action: 'Changing item security policies' },
  { matcher: '/api/items/:type/:id/sql-security', methods: ['POST'], action: 'Changing SQL grants and security policies' },
  { matcher: '/api/items/:type/:id/onelake-security/:role/rls', methods: ['POST'], action: "Changing a OneLake security role's row filter" },
  { matcher: '/api/items/:type/:id/onelake-security/:role/cls', methods: ['POST'], action: "Changing a OneLake security role's column rules" },
  { matcher: '/api/lakehouse/permissions', methods: ['POST'], action: 'Granting lakehouse permissions' },
  { matcher: '/api/onelake/security', methods: ['POST'], action: 'Granting OneLake storage access' },
  { matcher: '/api/catalog/permissions', methods: ['POST'], action: 'Granting catalog permissions' },
  { matcher: '/api/databricks/unity-catalog/grants', methods: ['PATCH'], action: 'Changing Unity Catalog grants' },
  { matcher: '/api/setup/landing-zones/grant', methods: ['POST'], action: 'Granting landing-zone roles' },
  { matcher: '/api/access-requests/:id/decision', methods: ['POST'], action: 'Deciding an access request' },
  { matcher: '/api/access-requests/bulk-decision', methods: ['POST'], action: 'Deciding access requests in bulk' },
  { matcher: '/api/data-products/:id/access-requests', methods: ['PATCH'], action: 'Deciding a data product access request' },
  { matcher: '/api/access-governance/group-sync', methods: ['POST'], action: 'Syncing group-based access grants' },
  { matcher: '/api/access-governance/assignments/:id/activate', methods: ['POST'], action: 'Activating an eligible access assignment' },
  { matcher: '/api/governance/policies', methods: ['POST'], action: 'Creating a governance policy' },
];

/**
 * The pathname RegExp for a matcher: literal segments, and `:name` for exactly
 * one segment. Derived, never hand-written, so a table row cannot disagree with
 * its own regex; the test checks Next's matcher agrees on real URLs.
 */
export function matcherToRegExp(matcher: string): RegExp {
  const body = matcher
    .split('/')
    .map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${body}/?$`);
}

const COMPILED = DURABLE_ACCESS_ROUTES.map((r) => ({ ...r, re: matcherToRegExp(r.matcher) }));

/** The (d) route row a request hits, or null. */
export function durableAccessRouteFor(pathname: string, method: string): DurableAccessRoute | null {
  const m = method.toUpperCase();
  for (const r of COMPILED) {
    if (r.methods.includes(m) && r.re.test(pathname)) return r;
  }
  return null;
}
