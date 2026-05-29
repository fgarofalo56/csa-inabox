/**
 * POST /api/items/cosmos-gremlin-graph/[id]/query
 *   body { query } — runs a Gremlin traversal against the configured graph.
 *   Returns 503 (Service Unavailable) with a deferred-reason message + the
 *   exact env vars / role to set if the Cosmos Gremlin runtime isn't wired
 *   (no LOOM_COSMOS_GREMLIN_ENDPOINT, or `gremlin` npm package not installed).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { executeGremlin, GremlinError } from '@/lib/azure/gremlin-client';
import { gqlToGremlin, TranslationError } from '@/lib/azure/cypher-kql-translator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  let query = String(body?.query || '').trim();
  const lang = String(body?.lang || 'gremlin');
  if (!query) return NextResponse.json({ ok: false, error: 'query is required' }, { status: 400 });

  // GQL best-effort: translate ISO GQL MATCH…RETURN to a Gremlin traversal
  // before execution. On a translation miss, return a 422 with the hint so
  // the editor can tell the user to write Gremlin directly (honest, not 501).
  let translated: string | undefined;
  if (lang === 'gql') {
    try {
      translated = gqlToGremlin(query);
      query = translated;
    } catch (e: any) {
      const t = e instanceof TranslationError ? e : new TranslationError(String(e));
      return NextResponse.json({ ok: false, error: `GQL → Gremlin translation failed: ${t.message}`, hint: t.hint }, { status: 422 });
    }
  }

  try {
    const result = await executeGremlin(query);
    return NextResponse.json({ ok: true, translated, ...result });
  } catch (e: any) {
    const status = e instanceof GremlinError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), deferred: status === 503 }, { status });
  }
}
