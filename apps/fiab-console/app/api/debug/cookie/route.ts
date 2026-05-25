/**
 * Tiny diagnostic endpoint. Helps us pinpoint where Set-Cookie is
 * being stripped — through Next.js's NextResponse, through ACA's
 * Envoy, or through Azure Front Door. Returns a tiny JSON payload
 * with three different Set-Cookie attempts on the same response so
 * we can see which (if any) reach the browser.
 *
 * GET /api/debug/cookie?secret=<env LOOM_VERSION>
 *
 * Returns 404 unless the secret matches the running version — keeps
 * curious crawlers from poking it.
 */
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const expected = process.env.LOOM_VERSION ?? 'dev';
  if (req.nextUrl.searchParams.get('secret') !== expected) {
    return new NextResponse('Not found', { status: 404 });
  }

  // Attempt 1: raw Web Response with Set-Cookie in headers
  const raw = new Response(JSON.stringify({ via: 'raw-Response' }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'set-cookie': 'loom_dbg_raw=alpha; Path=/; Max-Age=300; HttpOnly; Secure; SameSite=Lax',
    },
  });
  // Attach two more Set-Cookies via Headers API (will append, not replace,
  // per RFC since Set-Cookie is a multi-value header)
  raw.headers.append('set-cookie', 'loom_dbg_append=bravo; Path=/; Max-Age=300; HttpOnly; Secure; SameSite=Lax');

  return raw;
}
