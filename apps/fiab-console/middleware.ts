/**
 * Least-privilege guard for device-code sessions (#4805; operator decision
 * 2026-09-30, "Guardrails in-product").
 *
 * Scope is deliberately NARROW: the matcher below runs this only for
 *   - `/admin/*` pages and `/api/admin/*` routes (guardrail (b)), and
 *   - the routes that create, reveal or rotate a durable credential or grant
 *     standing access (guardrail (d)), listed ONCE in
 *     `DURABLE_ACCESS_ROUTES` (lib/auth/device-code-policy.ts).
 * For each such request it decodes the `loom_session` cookie with the SAME
 * decoder `getSession()` uses and, when the session was minted by the CLI /
 * VS Code device-code sign-in (`authVia: 'device_code'`), answers 403
 * `interactive_sign_in_required`. A (d) route is refused only for its listed
 * methods, so reading a roster or revoking a grant still works. Every other
 * request — no cookie, an undecodable cookie, a browser session — passes
 * through untouched, and the route's own authorization runs as before.
 *
 * WHY HERE. The admin tree and the credential / grant routes authorize through
 * many different helpers (tenant admin, capability grants, domain admin,
 * workspace admin, approval authority, DLZ tier, the bound SQL server). One
 * check on the PATH, before any of them, covers all of them — including a
 * helper added later — and never depends on a route remembering to call it.
 * Gates that live OUTSIDE these paths (tenant-admin, admin-tier capability and
 * DLZ checks) are covered at their source in lib/auth/feature-gate.ts and
 * lib/auth/dlz-gate.ts.
 *
 * `config.matcher` must be a literal (Next reads it at build time), so it
 * repeats the table's matchers; lib/auth/__tests__/durable-access-routes.test.ts
 * fails unless the two are the same set, and checks Next's own matcher agrees.
 *
 * Runtime is Node.js (stable for middleware in Next 15.5), so the session is
 * decrypted by the one node:crypto implementation rather than a second one.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { COOKIE_NAME, decodeSessionCookie } from '@/lib/auth/session';
import {
  deviceCodeAdminRefusal,
  durableAccessRouteFor,
  isDeviceCodeSession,
  refuseNonInteractive,
} from '@/lib/auth/device-code-policy';

const ADMIN_TREE_RE = /^\/(?:api\/)?admin(?:\/|$)/;

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  const admin = ADMIN_TREE_RE.test(pathname);
  const durable = admin ? null : durableAccessRouteFor(pathname, req.method);
  if (!admin && !durable) return NextResponse.next();
  const raw = req.cookies.get(COOKIE_NAME)?.value;
  const session = raw ? decodeSessionCookie(raw) : null;
  if (!isDeviceCodeSession(session)) return NextResponse.next();
  if (admin) return deviceCodeAdminRefusal();
  return refuseNonInteractive(session, durable!.action) ?? NextResponse.next();
}

export const config = {
  runtime: 'nodejs',
  matcher: [
    // (b) admin surfaces
    '/admin',
    '/admin/:path*',
    '/api/admin',
    '/api/admin/:path*',
    // (d) durable credentials and access grants — the matchers of DURABLE_ACCESS_ROUTES
    '/api/developer/tokens',
    '/api/apim/subscriptions',
    '/api/apim/subscriptions/:sid',
    '/api/apim/subscriptions/:sid/keys',
    '/api/marketplace/subscriptions',
    '/api/marketplace/subscriptions/:sid',
    '/api/marketplace/subscriptions/:sid/keys',
    '/api/marketplace/subscriptions/:sid/keys/regenerate',
    '/api/marketplace/products/:id/subscribe',
    '/api/dab/:id/publish',
    '/api/items/data-product/:id/publish-api',
    '/api/azure/iothub/policies',
    '/api/foundry/keys',
    '/api/monitor/logic-app-callback',
    '/api/databricks/unity-catalog/storage-credentials',
    '/api/marketplace/sharing/recipients',
    '/api/marketplace/sharing/recipients/:name',
    '/api/marketplace/sharing/shares',
    '/api/marketplace/sharing/shares/:name',
    '/api/external-shares',
    '/api/external-shares/:id/accept',
    '/api/workspaces/:id/role-assignments',
    '/api/workspaces/:id/permissions',
    '/api/items/:type/:id/permissions',
    '/api/items/:type/:id/share',
    '/api/items/:type/:id/security-roles',
    '/api/items/:type/:id/security',
    '/api/items/:type/:id/sql-security',
    '/api/items/:type/:id/onelake-security/:role/rls',
    '/api/items/:type/:id/onelake-security/:role/cls',
    '/api/lakehouse/permissions',
    '/api/onelake/security',
    '/api/catalog/permissions',
    '/api/databricks/unity-catalog/grants',
    '/api/setup/landing-zones/grant',
    '/api/access-requests/:id/decision',
    '/api/access-requests/bulk-decision',
    '/api/data-products/:id/access-requests',
    '/api/access-governance/group-sync',
    '/api/access-governance/assignments/:id/activate',
    '/api/governance/policies',
  ],
};
