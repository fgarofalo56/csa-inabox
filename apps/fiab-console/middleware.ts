/**
 * Admin-surface guard for device-code sessions (#4805; operator decision
 * 2026-09-30, "Guardrails in-product").
 *
 * Scope is deliberately NARROW: the matcher below runs this only for `/admin/*`
 * pages and `/api/admin/*` routes. For every such request it decodes the
 * `loom_session` cookie with the SAME decoder `getSession()` uses and, when the
 * session was minted by the CLI / VS Code device-code sign-in
 * (`authVia: 'device_code'`), answers 403 `interactive_sign_in_required`. Every
 * other request — no cookie, an undecodable cookie, a browser session — passes
 * through untouched, and the route's own authorization runs as before.
 *
 * WHY HERE. The `/api/admin/*` tree authorizes through several helpers
 * (tenant admin, capability grants, domain admin, workspace admin). Guarding the
 * PATH once covers all of them, including routes that add a new helper later.
 * Gates that live OUTSIDE `/admin` (tenant-admin and admin-tier capability
 * checks) are covered at their source in lib/auth/feature-gate.ts.
 *
 * Runtime is Node.js (stable for middleware in Next 15.5), so the session is
 * decrypted by the one node:crypto implementation rather than a second one.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { COOKIE_NAME, decodeSessionCookie } from '@/lib/auth/session';
import { deviceCodeAdminRefusal, isDeviceCodeSession } from '@/lib/auth/device-code-policy';

export function middleware(req: NextRequest): NextResponse {
  const raw = req.cookies.get(COOKIE_NAME)?.value;
  if (raw && isDeviceCodeSession(decodeSessionCookie(raw))) {
    return deviceCodeAdminRefusal();
  }
  return NextResponse.next();
}

export const config = {
  runtime: 'nodejs',
  matcher: ['/admin', '/admin/:path*', '/api/admin', '/api/admin/:path*'],
};
