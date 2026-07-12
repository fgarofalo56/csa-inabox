/**
 * GET /api/lakehouse/paths?container=&prefix=
 * Flat directory listing of an ADLS Gen2 path.
 *
 * EH-P1-OBO (#1800): when the global OBO data-plane mode is `on`
 * (LOOM_OBO_DATA_PLANE — default `off`, see lib/azure/data-access-mode.ts),
 * the listing is attempted AS THE SIGNED-IN USER via their delegated Azure
 * Storage token (adls-user-client); per that mode's documented contract a
 * missing delegated token FALLS BACK to the shared service identity (never
 * fails the call vs. today), and the response reports which `identity` served
 * it. With the mode off (default) the behavior is byte-identical to before.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { KNOWN_CONTAINERS, listPaths, type KnownContainer, type PathEntry } from '@/lib/azure/adls-client';
import { listPathsAsUser, AdlsUserTokenError } from '@/lib/azure/adls-user-client';
import { oboMode } from '@/lib/azure/data-access-mode';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const container = req.nextUrl.searchParams.get('container') || '';
  const prefix = req.nextUrl.searchParams.get('prefix') || '';
  const maxResults = Number(req.nextUrl.searchParams.get('maxResults') || '200');

  if (!container) {
    return NextResponse.json({ ok: false, error: 'container is required' }, { status: 400 });
  }
  if (!(KNOWN_CONTAINERS as readonly string[]).includes(container)) {
    return NextResponse.json({ ok: false, error: `unknown container: ${container}` }, { status: 404 });
  }

  try {
    const max = Math.min(maxResults, 1000);
    let paths: PathEntry[];
    let identity: 'user' | 'service' = 'service';
    if (oboMode() === 'on') {
      try {
        paths = await listPathsAsUser(session.claims.oid, container, prefix, max);
        identity = 'user';
      } catch (e) {
        // Mode-policy fallback (data-access-mode `on`): no delegated token →
        // degrade to the shared service identity, never fail the call vs. today.
        if (!(e instanceof AdlsUserTokenError)) throw e;
        paths = await listPaths(container as KnownContainer, prefix, max);
      }
    } else {
      paths = await listPaths(container as KnownContainer, prefix, max);
    }
    return NextResponse.json({ ok: true, container, prefix, paths, identity });
  } catch (e: any) {
    const status = e?.statusCode === 404 ? 404 : 502;
    return NextResponse.json(
      { ok: false, error: e?.message || String(e), code: e?.code },
      { status },
    );
  }
}
