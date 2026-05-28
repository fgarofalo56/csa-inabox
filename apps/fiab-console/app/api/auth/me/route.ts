/**
 * GET /api/auth/me
 *
 * Flat session-claims shape consumed by the workspaces page "owner = me"
 * filter (apps/fiab-console/app/workspaces/page.tsx:728). The page reads
 * `me?.upn ?? me?.email ?? me?.oid` directly, so it expects a flat
 * envelope — NOT the `{ authenticated, user: {...} }` shape that the
 * existing /api/me endpoint returns.
 *
 * Returns 401 when no session cookie is present so React Query can cache
 * an empty {} via its `.catch` branch (the editor handles a non-ok
 * response by returning {} — see workspaces page line 729).
 *
 * Previously returned 404 HTML, which the editor silently parsed as
 * empty, breaking the owner filter even for the logged-in user.
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) {
    return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  }
  return NextResponse.json({
    ok: true,
    upn: s.claims.upn,
    email: s.claims.email,
    oid: s.claims.oid,
    name: s.claims.name,
  });
}
