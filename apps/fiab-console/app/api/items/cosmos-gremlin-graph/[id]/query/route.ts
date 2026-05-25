/**
 * POST /api/items/cosmos-gremlin-graph/[id]/query
 *   body { query } — runs a Gremlin traversal against the configured graph.
 *   Returns 501 with a deferred-reason message if Cosmos Gremlin runtime
 *   isn't wired (no LOOM_COSMOS_GREMLIN_ENDPOINT, or `gremlin` not installed).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { executeGremlin, GremlinError } from '@/lib/azure/gremlin-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const query = String(body?.query || '').trim();
  if (!query) return NextResponse.json({ ok: false, error: 'query is required' }, { status: 400 });
  try {
    const result = await executeGremlin(query);
    return NextResponse.json({ ok: true, ...result });
  } catch (e: any) {
    const status = e instanceof GremlinError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), deferred: status === 501 }, { status });
  }
}
