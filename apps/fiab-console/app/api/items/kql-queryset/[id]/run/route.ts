/**
 * POST /api/items/kql-queryset/[id]/run
 * Body: { queryIdx: number } OR { kql: string, database?: string }
 * Executes the indexed saved query (or an ad-hoc kql).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { enforceRateLimit } from '@/lib/azure/rate-limiter';
import {
  executeQuery, executeMgmtCommand, loadKustoItem, resolveDatabase, KustoError,
  laConfigGate,
} from '@/lib/azure/kusto-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const limited = await enforceRateLimit(session, 'query');
  if (limited) return limited;

  const body = await req.json().catch(() => ({}));
  try {
    const item = await loadKustoItem((await ctx.params).id, 'kql-queryset', session.claims.oid);
    if (!item) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });

    // Cross-service source binder — a query bound to Log Analytics / App
    // Insights executes via the ADX cluster() proxy, which requires the LA
    // workspace ARM resource ID to be configured. Gate up front so the client
    // receives a precise 503 instead of a confusing ADX 400 about an
    // unresolvable cluster() target.
    const sourceType = typeof body?.sourceType === 'string' ? body.sourceType : 'adx';
    if (sourceType !== 'adx') {
      const gate = laConfigGate();
      if (gate) {
        return NextResponse.json(
          { ok: false, error: `Cross-service queries require ${gate.missing} to be configured.` },
          { status: 503 },
        );
      }
    }

    let kql: string;
    let database: string;
    const saved: Array<{ kql: string; database?: string }> = Array.isArray(item.state?.queries) ? item.state!.queries : [];
    if (typeof body?.queryIdx === 'number') {
      const q = saved[body.queryIdx];
      if (!q) return NextResponse.json({ ok: false, error: 'queryIdx out of range' }, { status: 400 });
      kql = q.kql;
      database = q.database || resolveDatabase(item);
    } else if (typeof body?.kql === 'string' && body.kql.trim()) {
      kql = body.kql.trim();
      database = (body?.database && String(body.database)) || resolveDatabase(item);
    } else {
      return NextResponse.json({ ok: false, error: 'queryIdx or kql is required' }, { status: 400 });
    }

    if (kql.length > 65_536) return NextResponse.json({ ok: false, error: 'kql too large (>64KB)' }, { status: 413 });

    const isMgmt = kql.startsWith('.');
    const result = isMgmt
      ? await executeMgmtCommand(database, kql)
      : await executeQuery(database, kql);
    return NextResponse.json({
      ok: true,
      database,
      mode: isMgmt ? 'mgmt' : 'query',
      ...result,
      executedBy: session.claims.upn,
    });
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
