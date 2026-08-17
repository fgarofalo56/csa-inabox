/**
 * Shared plumbing for the ADX/KQL database navigator BFF routes
 * (`/api/adx/<group>`). Each route:
 *   1. validates the session cookie,
 *   2. applies the honest config gate (LOOM_KUSTO_CLUSTER_URI),
 *   3. resolves the target database from `?id=<kql-database item id>`
 *      (falling back to the env-pinned default DB only when NO item is named),
 *   4. calls a real Kusto control command and returns `{ ok, ... }` JSON.
 *
 * The database is item-scoped: each kql-database Cosmos item carries its own
 * `state.databaseName`, and the caller is authorized against that item's
 * workspace through the canonical `authorizeItemWorkspace` ladder before it is
 * read. An id the caller may not reach — or that names no kql-database item —
 * is REFUSED (404); it does not fall through to the shared default database.
 * See {@link guardAdxRequest} for the defect that behaviour replaces.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiHonestGateError } from '@/lib/api/gate-envelope';
import { authorizeItemWorkspace } from '@/lib/auth/workspace-guard';
import { cosmosIdFromLoomId } from '@/app/api/items/_lib/loom-content-id';
import { UNSAVED_ITEM_ID } from '@/app/api/items/_lib/synapse-item-scope';
import {
  kustoConfigGate, loadKustoItemUnscoped, resolveDatabase, defaultDatabase, resolvedClusterUri, KustoError,
} from '@/lib/azure/kusto-client';

export interface AdxRouteContext {
  /** Resolved database name (item state or env default). */
  database: string;
  /** Caller oid (tenant) — already validated. */
  oid: string;
  /** The bound kql-database item id, if any. */
  itemId: string | null;
  /**
   * Registry-first ADX cluster URI (brownfield §2.5): an attached existing ADX
   * cluster's URI when one is bound to the tenant, else the env-pinned default.
   * Routes pass this into kusto calls via `opts.clusterUri` so the navigator
   * targets the attached cluster.
   */
  clusterUri: string;
}

/** Result of {@link guardAdxRequest}: either a ready context or a NextResponse to return. */
export type AdxGuardResult =
  | { ctx: AdxRouteContext; res?: undefined }
  | { ctx?: undefined; res: NextResponse };

/** The Cosmos item family the `?id=` param names. */
const ITEM_TYPE = 'kql-database';

/**
 * The refusal for an id that names no `kql-database` item the caller may reach.
 *
 * 404-NOT-403, and IDENTICAL for "no such item" and "not yours" — the same
 * non-leaking convention `authorizeItemWorkspace` documents, so the response
 * never discloses that an item the caller cannot see exists.
 */
const NOT_FOUND = 'KQL database not found';

/**
 * Validate session + config gate + resolve the database.
 *
 * THE HOLE THIS CLOSES (GHSA-v2g8-gp3r-rg4r, second remediation pass). This
 * guard used to read:
 *
 *     const item = await loadKustoItem(itemId, 'kql-database', session.claims.oid);
 *     database = resolveDatabase(item);          // ← no null check
 *
 * `loadKustoItem` returns **null** when the caller does not own the item, and
 * nothing checked for it — `resolveDatabase(null)` falls straight through to
 * `defaultDatabase()`. So naming another tenant's item did not refuse; it
 * silently proceeded against the deployment's SHARED DEFAULT database.
 *
 * BE PRECISE ABOUT THE SEVERITY, because it is not the headline of this
 * advisory. This was NOT a cross-tenant read: the other tenant's database name
 * is never reached, and the shared default DB is inside every workspace's scope
 * by construction, so a caller naming ANY id operated on it either way. What
 * was wrong is that the route reported and behaved as though ownership had been
 * established. It was **not an owner check**, and it **failed open** instead of
 * refusing — on the helper that 12 route files / 28 handlers under `/api/adx/*`
 * depend on, and that was cited throughout this advisory's first remediation as
 * "the correct pattern already in the tree".
 *
 * THE FIX MIRRORS ITS ITEM-SCOPED SUCCESSOR, `_lib/adx-item-scope.ts::
 * guardAdxItemRequest` (PR #3600) — same two layers, same refusal shape, same
 * status code:
 *
 *   LAYER 1 — AUTHORIZE THE CALLER against the item's workspace through the
 *     canonical `authorizeItemWorkspace` ladder (owner → tenant admin →
 *     shared-ACL). The workspace is resolved FROM THE ITEM, so authorization
 *     cannot be skipped by omitting a parameter.
 *
 *   LAYER 2 — BIND THE DATABASE to that item, and FAIL CLOSED when the id names
 *     no item: `authorizeItemWorkspace` deliberately returns null (= allow) for
 *     an id naming nothing, and with no item there is no scope to bind, so
 *     proceeding would run unbound on the shared cluster. That is the exact
 *     fall-through being removed.
 *
 * WHY THE LADDER AND NOT A BARE `if (!item) return 404`. A bare null check on
 * `loadKustoItem` would have shipped a DIFFERENT defect. That helper's
 * ownership test is `workspacesContainer().item(item.workspaceId, oid).read()`
 * — a point-read on the CALLER's own partition — and `workspace-guard.ts`
 * records at length (#2941 / #2942) that this shape answers "did this caller
 * CREATE this workspace", never "may this caller ACCESS it". A tenant admin or
 * a shared-ACL member gets null from it. Today they silently receive the
 * default DB (wrong data, no error); under a bare null check they would receive
 * a hard 404 and a red banner in a working editor — a dead end
 * (`auto-bind-by-default.md`). The ladder refuses the foreign caller AND
 * resolves the right database for the legitimate non-creator, so this is a
 * strict improvement in both directions rather than a trade.
 *
 * WHAT IS DELIBERATELY PRESERVED. The docstring's "fall back to the default DB
 * so the navigator still works when mounted standalone" behaviour is KEPT for
 * the two cases that genuinely mean "no item is bound" — no `?id=` at all
 * (`tests/service-health.mjs` probes both `/overview` and `/tables` this way,
 * and `entity-diagram-sources.readKqlDatabaseGraph` omits it when its source
 * carries no itemId), and {@link UNSAVED_ITEM_ID}, the literal `new` an editor
 * shows before its first save. It is removed ONLY where it was produced by an
 * ownership lookup FAILING. Those two are explicit signals; a failed lookup is
 * not, and per `auto-bind-by-default.md` the unbound path must be opted into,
 * never inherited from a denied authorization.
 *
 * READ vs WRITE. All 11 GET handlers on these routes are `.show`-only, so they
 * pass `allowReadRoles` and a Viewer of a shared workspace keeps their reads.
 * The 17 POST/PATCH/DELETE handlers issue real DDL (`.create` / `.alter` /
 * `.drop` / `.alter … policy`) and stay write-scoped, so sharing can never
 * escalate a read-only member into a writer.
 */
export async function guardAdxRequest(req: NextRequest): Promise<AdxGuardResult> {
  const session = getSession();
  if (!session) {
    return { res: NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 }) };
  }

  // WS-D2: the ADX/Kusto config gate normalized onto the shared gate envelope.
  // The CHECK is unchanged (`kustoConfigGate()`, still gating on
  // LOOM_KUSTO_CLUSTER_URI); only the response SHAPE is normalized — now
  // { ok:false, gated:true, gate:{ id:'svc-adx', remediation, fixItHref } } with
  // the back-compat code/error/missing mirrors intact (same 503, same message).
  const gate = kustoConfigGate();
  if (gate) {
    return {
      res: apiHonestGateError('svc-adx', {
        missing: [gate.missing],
        message: `ADX cluster not configured: set ${gate.missing}.`,
      }),
    };
  }

  const itemId = req.nextUrl.searchParams.get('id')?.trim() || null;
  let database = defaultDatabase();
  if (itemId && itemId !== UNSAVED_ITEM_ID) {
    try {
      // LAYER 1 — authorize the caller against the item's own workspace.
      const denied = await authorizeItemWorkspace(session, {
        workspaceId: null,
        itemId,
        itemType: ITEM_TYPE,
        // Read-only `.show` handlers admit any workspace role; every mutating
        // handler stays write-scoped (Owner/Admin/Member).
        ...(req.method === 'GET' ? { allowReadRoles: true } : {}),
        notFound: NOT_FOUND,
      });
      if (denied) return { res: denied };

      // LAYER 2 — bind the database to that item, refusing when the id names no
      // kql-database item. `cosmosIdFromLoomId` is the IDENTITY function for
      // every id that is not `loom:`-prefixed (see `_lib/loom-content-id`), so
      // applying it at this Cosmos chokepoint costs nothing and keeps a
      // synthetic list id from 404-ing on an item that is sitting right there.
      const item = await loadKustoItemUnscoped(cosmosIdFromLoomId(itemId), ITEM_TYPE);
      if (!item) {
        return { res: NextResponse.json({ ok: false, error: NOT_FOUND }, { status: 404 }) };
      }
      database = resolveDatabase(item);
    } catch (e: any) {
      const status = e instanceof KustoError ? e.status : 502;
      return { res: NextResponse.json({ ok: false, error: e?.message || String(e) }, { status }) };
    }
  }

  // Registry-first cluster resolution (brownfield §2.5) — an attached existing
  // ADX cluster wins over the env default; resolvedClusterUri falls back to the
  // env-bound cluster (and swallows any registry blip) so the navigator never
  // breaks. Tenant PK = claims.tid ?? oid.
  const clusterUri = await resolvedClusterUri(session.claims.tid || session.claims.oid);

  return { ctx: { database, oid: session.claims.oid, itemId, clusterUri } };
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
