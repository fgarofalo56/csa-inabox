/**
 * /api/me — current session claims for the topbar avatar. Returns
 * null user when unauthenticated (so the UI renders Sign in rather
 * than blowing up).
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ authenticated: false, user: null });
  return NextResponse.json({
    authenticated: true,
    user: {
      name: s.claims.name,
      email: s.claims.email,
      upn: s.claims.upn,
      oid: s.claims.oid,
    },
  });
}
