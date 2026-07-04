/**
 * /api/me — current session claims for the topbar avatar. Returns
 * null user when unauthenticated (so the UI renders Sign in rather
 * than blowing up).
 *
 * Also returns `isTenantAdmin` — the SINGLE shell-level source of admin
 * truth (rel-T54). The shell probes this once and every consumer (left
 * nav, catalog/governance rails) reads the cached result rather than
 * refetching, so admin-only destinations (Admin portal, Setup, the
 * cross-plane /admin/* links) are hidden for non-admins instead of
 * letting them walk into a wall of per-page 403 gates. This reuses the
 * exact fail-closed `isTenantAdmin` claims check that every BFF route
 * enforces (lib/auth/feature-gate) — the UI hide is presentation only;
 * the server-side gate remains the hard authority.
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { isTenantAdmin } from '@/lib/auth/feature-gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ authenticated: false, user: null, isTenantAdmin: false });
  return NextResponse.json({
    authenticated: true,
    user: {
      name: s.claims.name,
      email: s.claims.email,
      upn: s.claims.upn,
      oid: s.claims.oid,
    },
    isTenantAdmin: isTenantAdmin(s),
  });
}
