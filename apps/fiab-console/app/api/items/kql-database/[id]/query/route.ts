/**
 * POST /api/items/kql-database/[id]/query
 * Body: { kql: string, db?: string }
 * Executes KQL against the resolved database (or override).
 * Mgmt commands (starting with `.`) are routed to the mgmt endpoint.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { enforceRateLimit } from '@/lib/azure/rate-limiter';
import {
  executeQuery, executeMgmtCommand, loadKustoItem, resolveDatabase, KustoError,
} from '@/lib/azure/kusto-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const limited = await enforceRateLimit(session, 'query');
  if (limited) return limited;

  const body = await req.json().catch(() => ({}));
  const kql = (body?.kql || '').toString().trim();
  if (!kql) return NextResponse.json({ ok: false, error: 'kql is required' }, { status: 400 });
  if (kql.length > 65_536) return NextResponse.json({ ok: false, error: 'kql too large (>64KB)' }, { status: 413 });

  try {
    const item = await loadKustoItem((await ctx.params).id, 'kql-database', session.claims.oid);

    // Follower (database-shortcut) databases are strictly read-only. Block any
    // write/control command before it reaches ADX so the user gets a clear
    // message instead of a raw cluster rejection. Queries (no leading dot) and
    // read-only `.show` commands still pass through.
    if (item?.state?.isFollower) {
      const lower = kql.toLowerCase();
      const writeCmd = /^\.(create|drop|ingest|alter|purge|append|set|set-or-append|set-or-replace|move|rename|merge|clear|delete|enable|disable|cancel|export|attach|detach|replace|add|execute database script)\b/;
      if (writeCmd.test(lower)) {
        return NextResponse.json({
          ok: false,
          error:
            'This KQL database is a read-only follower (database shortcut). Write operations ' +
            '(.create, .drop, .ingest, .alter, .purge, etc.) are blocked. Run queries against ' +
            'the follower, or switch to the leader database to write data.',
        }, { status: 403 });
      }
    }

    const database = (body?.db && String(body.db)) || resolveDatabase(item);
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
