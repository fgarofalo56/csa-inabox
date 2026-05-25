/**
 * GET /api/lakehouse/paths?container=&prefix=
 * Flat directory listing of an ADLS Gen2 path.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { KNOWN_CONTAINERS, listPaths, type KnownContainer } from '@/lib/azure/adls-client';

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
    const paths = await listPaths(container as KnownContainer, prefix, Math.min(maxResults, 1000));
    return NextResponse.json({ ok: true, container, prefix, paths });
  } catch (e: any) {
    const status = e?.statusCode === 404 ? 404 : 502;
    return NextResponse.json(
      { ok: false, error: e?.message || String(e), code: e?.code },
      { status },
    );
  }
}
