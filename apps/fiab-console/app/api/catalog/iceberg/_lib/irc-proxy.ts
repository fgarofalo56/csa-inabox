/**
 * N1 — shared plumbing for the Iceberg REST Catalog (IRC) proxy routes.
 *
 * Every `/api/catalog/iceberg/*` route follows the same three beats:
 *
 *   1. AUTHENTICATE the caller — browser cookie session OR a scoped Loom API
 *      token (`Authorization: Bearer loom_pat_…`). External engines (Trino,
 *      Spark, DuckDB, Snowflake) use the token path; that is precisely why the
 *      IRC proxy exists instead of exposing the catalog container.
 *   2. INJECT Entra auth on the upstream hop (lib/azure/iceberg-catalog-client
 *      `icebergAuthHeader`) and call the internal-ingress catalog.
 *   3. AUDIT the access — one `_auditLog` data-access row per request
 *      (principal, namespace/table scope, operation, timestamp, outcome), with
 *      LIST reads aggregated via `resultCount`.
 *
 * The catalog container is NEVER reachable from outside the VNet, and no route
 * here can be called anonymously.
 */

import { NextResponse, type NextRequest } from 'next/server';
import type { SessionPayload } from '@/lib/auth/session';
import { getApiSession, enforcePatAccess } from '@/lib/auth/api-session';
import { apiUnauthorized } from '@/lib/api/respond';
import { apiHonestGateError } from '@/lib/api/gate-envelope';
import {
  ICEBERG_CATALOG_GATE_ID,
  IcebergCatalogError,
  icebergCatalogConfigGate,
  icebergWarehouse,
  logIcebergAccess,
  type IcebergAccessOperation,
} from '@/lib/azure/iceberg-catalog-client';

/** The honest 503 when LOOM_ICEBERG_CATALOG_URL is unset. */
export function icebergGateResponse(): NextResponse {
  return apiHonestGateError(ICEBERG_CATALOG_GATE_ID, {
    missing: ['LOOM_ICEBERG_CATALOG_URL'],
    code: 'iceberg_catalog_not_configured',
  });
}

/** Resolved caller context handed to an IRC handler. */
export interface IrcCallerContext {
  session: SessionPayload;
  /** True when the caller authenticated with a scoped API token, not a cookie. */
  viaApiToken: boolean;
  /** Optional Loom workspace scope from `?workspaceId=` (audited when present). */
  workspaceId: string;
}

type IrcHandler = (req: NextRequest, ctx: IrcCallerContext) => Promise<NextResponse>;

/**
 * Wrap an IRC route handler with authentication (cookie OR PAT), PAT scope
 * enforcement, and the LOOM_ICEBERG_CATALOG_URL presence gate. Unauthenticated
 * callers 401 BEFORE the gate is evaluated so an anonymous probe can never
 * learn the deployment's config state.
 */
export function withIrcCaller(handler: IrcHandler) {
  return async (req: NextRequest): Promise<NextResponse> => {
    const session = await getApiSession(req);
    if (!session) return apiUnauthorized();
    const scopeDenied = enforcePatAccess(session, req.method || 'GET');
    if (scopeDenied) return scopeDenied;
    if (icebergCatalogConfigGate()) return icebergGateResponse();

    const ctx: IrcCallerContext = {
      session,
      viaApiToken: !!session.pat,
      workspaceId: (req.nextUrl.searchParams.get('workspaceId') || '').trim(),
    };
    try {
      return await handler(req, ctx);
    } catch (e) {
      return icebergErrorResponse(e);
    }
  };
}

/**
 * Map an upstream failure to a structured envelope. An `IcebergCatalogError`
 * keeps its real status + code (404 namespace-not-found stays a 404); anything
 * else becomes a 502 with a sanitized message — no stack, no upstream HTML.
 */
export function icebergErrorResponse(e: unknown): NextResponse {
  if (e instanceof IcebergCatalogError) {
    return NextResponse.json(
      { ok: false, error: e.message, code: e.code || 'iceberg_catalog_error' },
      { status: e.status },
    );
  }
  const msg = (e instanceof Error ? e.message : String(e))
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
  return NextResponse.json(
    { ok: false, error: `Iceberg REST Catalog request failed: ${msg}`, code: 'iceberg_catalog_error' },
    { status: 502 },
  );
}

/**
 * Run one IRC operation and write its data-access audit row — success AND
 * failure. Returns the operation's value so the route body stays a one-liner.
 * The audit write is awaited so a row exists before the response is sent (an
 * ATO reviewer must never see a read that produced no evidence); the writer
 * itself is failure-tolerant so audit trouble can never 500 a read.
 */
export async function auditedIrc<T>(
  ctx: IrcCallerContext,
  operation: IcebergAccessOperation,
  scope: { namespace?: string; table?: string },
  run: () => Promise<T>,
  countOf?: (value: T) => number,
): Promise<T> {
  const base = {
    actorOid: ctx.session.claims.oid,
    actorUpn: ctx.session.claims.upn,
    tenantId: ctx.session.claims.tid || ctx.session.claims.oid,
    operation,
    namespace: scope.namespace,
    table: scope.table,
    workspaceId: ctx.workspaceId,
    warehouse: icebergWarehouse(),
    viaApiToken: ctx.viaApiToken,
  };
  try {
    const value = await run();
    await logIcebergAccess({
      ...base,
      outcome: 'success',
      ...(countOf ? { resultCount: countOf(value) } : {}),
    });
    return value;
  } catch (e) {
    await logIcebergAccess({
      ...base,
      outcome: 'failure',
      detail: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }
}
