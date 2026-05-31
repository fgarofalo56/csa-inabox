/**
 * Shared plumbing for the ADX/KQL database navigator BFF routes
 * (`/api/adx/<group>`). Each route:
 *   1. validates the session cookie,
 *   2. applies the honest config gate (LOOM_KUSTO_CLUSTER_URI),
 *   3. resolves the target database from `?id=<kql-database item id>`
 *      (falling back to the env-pinned default DB when no item is bound),
 *   4. calls a real Kusto control command and returns `{ ok, ... }` JSON.
 *
 * The database is item-scoped: each kql-database Cosmos item carries its own
 * `state.databaseName`, verified against the caller's tenant via
 * {@link loadKustoItem}. This mirrors the per-item resolution the existing
 * `/api/items/kql-database/[id]` routes already use — no new auth surface.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  kustoConfigGate, loadKustoItem, resolveDatabase, defaultDatabase, KustoError,
} from '@/lib/azure/kusto-client';

export interface AdxRouteContext {
  /** Resolved database name (item state or env default). */
  database: string;
  /** Caller oid (tenant) — already validated. */
  oid: string;
  /** The bound kql-database item id, if any. */
  itemId: string | null;
}

/** Result of {@link guardAdxRequest}: either a ready context or a NextResponse to return. */
export type AdxGuardResult =
  | { ctx: AdxRouteContext; res?: undefined }
  | { ctx?: undefined; res: NextResponse };

/**
 * Validate session + config gate + resolve the database. The kql-database
 * item id is read from `?id=`. When absent we fall back to the default DB so
 * the navigator still works when mounted standalone (dev / smoke).
 */
export async function guardAdxRequest(req: NextRequest): Promise<AdxGuardResult> {
  const session = getSession();
  if (!session) {
    return { res: NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 }) };
  }

  const gate = kustoConfigGate();
  if (gate) {
    return {
      res: NextResponse.json(
        {
          ok: false,
          code: 'not_configured',
          error: `ADX cluster not configured: set ${gate.missing}.`,
          missing: gate.missing,
        },
        { status: 503 },
      ),
    };
  }

  const itemId = req.nextUrl.searchParams.get('id')?.trim() || null;
  let database = defaultDatabase();
  if (itemId && itemId !== 'new') {
    try {
      const item = await loadKustoItem(itemId, 'kql-database', session.claims.oid);
      database = resolveDatabase(item);
    } catch (e: any) {
      const status = e instanceof KustoError ? e.status : 502;
      return { res: NextResponse.json({ ok: false, error: e?.message || String(e) }, { status }) };
    }
  }

  return { ctx: { database, oid: session.claims.oid, itemId } };
}

/** Map a thrown error to the right status code + JSON envelope. */
export function adxError(e: any): NextResponse {
  const status = e instanceof KustoError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,1023}$/;

/** Validate a Kusto entity name (letters, digits, underscore; not leading-digit). */
export function validName(name: unknown): name is string {
  return typeof name === 'string' && NAME_RE.test(name.trim());
}
