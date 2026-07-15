/**
 * POST /api/items/kql-database/[id]/query
 * Body: { kql: string, db?: string }
 * Executes KQL against the resolved database (or override).
 * Mgmt commands (starting with `.`) are routed to the mgmt endpoint.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { enforceRateLimit } from '@/lib/azure/rate-limiter';
import { enforceAdmissionControl } from '@/lib/azure/capacity-guardrails';
import { recordCostAttribution } from '@/lib/azure/cost-attribution';
import { tenantScopeId } from '@/lib/auth/session';
import {
  executeQuery, executeQueryCached, executeMgmtCommand, loadKustoItem, resolveDatabase, clusterUri, KustoError,
  parseKqlPage, KQL_MAX_ROWS, type KqlPage,
} from '@/lib/azure/kusto-client';
import { normalizeAccessMode } from '@/lib/azure/sql-access-mode';
import { resolveUserRead } from '@/lib/azure/user-pool-registry';
import { jsonWithQueryCache } from '@/lib/api/query-cache-headers';

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

    // FGC-25 — capacity surge protection. A KQL query is an ADX compute job; when
    // the cluster is over its rejection threshold, admit-control rejects it early
    // (429) before it adds to the load. Read-only `.show`/mgmt is exempt (cheap
    // control-plane), and a rejection carries the rule + admin override path.
    if (!isMgmt) {
      const surge = await enforceAdmissionControl(session, { engine: 'adx', workspaceId: item?.workspaceId });
      if (surge) return surge;
    }

    // EH-P1-OBO (#1800) — per-user data-access mode. Default 'service' is
    // byte-identical to before. When this KQL database was explicitly switched
    // to "user's identity" (state.accessMode === 'user'), resolve the caller's
    // delegated ADX token (per-cluster audience) via user-pool-registry and run
    // the query AS THE USER; a missing delegated token is an honest 403 gate —
    // never a silent downgrade to the service UAMI.
    let userToken: string | undefined;
    const accessMode = normalizeAccessMode((item?.state as Record<string, unknown> | undefined)?.accessMode);
    if (accessMode === 'user') {
      const resolution = await resolveUserRead('user', 'kusto', {
        oid: session.claims.oid,
        clusterUri: clusterUri(),
      });
      if (resolution.mode === 'gate') {
        return NextResponse.json(resolution.body, { status: resolution.status });
      }
      if (resolution.mode === 'user') userToken = resolution.token;
    }

    // PSR-6 — real row-cap paging. A client paging control passes { page:{skip,take} };
    // we over-fetch take+1 and echo { hasMore, nextPage } so the grid loads more
    // rows instead of hitting the silent KQL_MAX_ROWS cap.
    const page: KqlPage | undefined = isMgmt ? undefined : parseKqlPage((body as { page?: unknown })?.page);

    const result = isMgmt
      ? await executeMgmtCommand(database, kql, { userToken })
      // Per-user (OBO) results are identity-scoped → run live (executeQueryCached
      // bypasses the shared cache when a userToken is present, but we keep the
      // explicit executeQuery call to make that intent obvious).
      : userToken
        ? await executeQuery(database, kql, { userToken, page })
        : await executeQueryCached(database, kql, { page });
    // BR-COSTATTR — tag each ADX query for the chargeback per-user drill-down.
    if (!isMgmt) {
      void recordCostAttribution({
        tenantId: tenantScopeId(session), userOid: session.claims.oid, userName: session.claims.upn,
        engine: 'adx', workspaceId: item?.workspaceId, itemId: item?.id, itemType: 'kql-database',
        resourceId: database, domainId: (item as any)?.domainId,
      });
    }

    // Uniform "load more" affordance: when an unpaged query truncated at the
    // cap, surface hasMore + the first paged window so the grid can continue.
    let hasMore = (result as { hasMore?: boolean }).hasMore ?? false;
    let nextPage = (result as { nextPage?: KqlPage }).nextPage;
    if (!isMgmt && !page && result.truncated) {
      hasMore = true;
      nextPage = { skip: result.rows.length, take: KQL_MAX_ROWS };
    }

    return jsonWithQueryCache({
      ok: true,
      database,
      mode: isMgmt ? 'mgmt' : 'query',
      accessMode,
      ...result,
      hasMore,
      ...(nextPage ? { nextPage } : {}),
      executedBy: session.claims.upn,
    }, { ifNoneMatch: req.headers.get('if-none-match'), maxAgeSec: isMgmt ? 0 : 60 });
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
