/**
 * GHSA-v8r7-c2p5-mjf2 — ITEM-SCOPED + SUBSCRIPTION-PINNED server binding for the
 * `items/<type>/[id]/**` routes that reach Azure SQL and PostgreSQL Flexible
 * Server as the Console managed identity.
 *
 * THE HOLE THIS CLOSES. Nineteen routes took a full ARM resource id, or a bare
 * server name, from the REQUEST BODY and used it verbatim against ARM or a
 * database data plane as the Console UAMI. No ownership check, no subscription
 * pin, no allowlist; `getSession()` was the whole authorization. Unlike the ADX
 * family (GHSA-v2g8-gp3r-rg4r), which is bounded by one shared Kusto cluster,
 * these follow the UAMI's ARM permissions into ANY subscription — and under
 * brownfield adopt-existing (`deploy-integrity.md` R5) that includes the
 * customer's PRE-EXISTING servers, outside Loom's own estate.
 *
 * WHY NO CONTROL SAW IT. `scripts/ci/check-route-guards.mjs` CHECK 3 falsifies a
 * shared-backend allowlist entry only for handlers that CONSUME `[id]`. These
 * handlers never touched it — `azure-sql-database/[id]/scale` is `POST(req)`
 * with no `ctx` parameter at all, so the route id is not merely ignored, it is
 * not accepted. CHECK 3 therefore reported zero, and always had. A premise test
 * that requires the handler to look at the thing cannot see a handler that
 * refuses to look at it.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE THREE LAYERS. Each is necessary; none is sufficient.
 *
 *   LAYER 1 — AUTHORIZE THE CALLER against the route item. {@link withBoundSqlServer}
 *     composes on `withWorkspaceOwner`, the canonical `loadOwnedItem` owner /
 *     workspace-ACL check. Write handlers stay write-scoped; only read-only GETs
 *     may pass `allowReadRoles`.
 *
 *   LAYER 2 — BIND THE SERVER TO THE ITEM. The target is resolved from
 *     `state.connection` — the exact shape `POST /connect` persists and the
 *     shape `_bound-connection.ts` already reads for `/query` and `/copilot`
 *     (#2723). The request body is NEVER used to CHOOSE the target; a body that
 *     names a different server or database is REJECTED (403). Silently
 *     substituting the bound server for the one the operator typed would scale,
 *     restore, or grant on a different resource than the one they named, which
 *     is worse than refusing.
 *
 *   LAYER 3 — ADMIT THE BINDING AGAINST THE GOVERNED SUBSCRIPTION SCOPE.
 *     {@link admitGovernedServer} refuses any ARM id whose subscription is not in
 *     `loomSubscriptionScope()` (the env-derived set of subscriptions the Loom
 *     deployment spans) or whose provider/type is not the one this route's
 *     backend speaks.
 *
 * WHY LAYER 3 IS THE LOAD-BEARING ONE, and layers 1+2 alone would NOT have
 * fixed this. The binding is CALLER-WRITABLE, by design and by accident:
 *
 *   - `POST /api/items/azure-sql-database/[id]/connect` — the editor's server
 *     picker. Caller-supplied `server` by definition; that is the feature.
 *   - `POST /api/items/azure-sql-database` — `createOwnedItem` accepts an
 *     arbitrary `state` object on create.
 *   - `PATCH /api/items/[type]/[id]` — replaces `state` WHOLESALE with arbitrary
 *     body JSON, no field-level validation (that route line is also the
 *     mechanism behind #3611).
 *
 * So "resolve it from item state" moves the attacker's input one hop; it does
 * not remove it. This is the precise lesson GHSA-v2g8-gp3r-rg4r recorded, where
 * an auto-bind walked a caller-supplied name into the very scope the fix read
 * from. A scope-narrowing fix is only as strong as the write path into the
 * scope — and here every write path into the binding is open to the item's own
 * owner, because picking your server IS the product.
 *
 * The only coordinate in this system that a caller cannot write is the
 * deployment's own subscription set, which comes from environment variables the
 * bicep deploy emits. That is what Layer 3 pins to, and it is why Layer 3 —
 * not Layer 2 — is what actually closes the cross-subscription class.
 *
 * KNOWN RESIDUAL, recorded rather than implied fixed. After this change a caller
 * can still point their OWN item at any server INSIDE the governed
 * subscription(s) — including a brownfield-adopted customer server that happens
 * to live there — and drive these routes at it. That is a large narrowing (the
 * whole cross-subscription reach is gone, and a bare name was already pinned to
 * `LOOM_SUBSCRIPTION_ID` by the clients' own `listServers()` lookup) but it is
 * NOT zero. Closing it needs a per-workspace registry of adopted servers whose
 * write path is NOT the item document — i.e. #3611's remit plus a brownfield
 * adoption record — and is deliberately not attempted here.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import type { SessionPayload } from '@/lib/auth/session';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { withWorkspaceOwner, type RouteHandler } from '@/lib/api/route-toolkit';
import { apiError } from '@/lib/api/respond';
import { loomSubscriptionScope } from '@/lib/azure/loom-subscriptions';

/**
 * A server reference that has been RESOLVED FROM AN ITEM and ADMITTED by
 * {@link admitGovernedServer} — never a raw request value.
 *
 * WHY A BRAND, and exactly how little it buys. Measured on the ADX equivalent
 * (`_lib/adx-item-scope.ts`): every coordinate-rebinding mutation compiled clean
 * at `tsc` exit 0, because the scoped value and the raw body value are both
 * plain `string`. Branding catches the ANNOTATED re-point
 * (`const s: ScopedSqlServer = body.server` → exit 2) and NOT the unannotated
 * rewrite (`const s = body.server` → exit 0, inferred as `string`). Both
 * mutations are semantically identical, so the brand DOES NOT close the class.
 * The route tests are the control that actually holds; this is written down so
 * nobody reads the brand as licence to stop writing them.
 */
export type ScopedSqlServer = string & { readonly __sqlScoped: unique symbol };

/** The single trusted construction point for {@link ScopedSqlServer}. */
function scoped(name: string): ScopedSqlServer {
  return name as ScopedSqlServer;
}

/**
 * Which ARM provider/type a route's backend speaks. Fixed per route by the code
 * that calls the wrapper — never derived from the item or the request, so a
 * caller cannot point a `Microsoft.Sql/servers` route at another resource type.
 */
export type SqlProviderKind = 'sql' | 'postgres';

const PROVIDER_PATH: Record<SqlProviderKind, string> = {
  sql: 'microsoft.sql/servers',
  postgres: 'microsoft.dbforpostgresql/flexibleservers',
};

const PROVIDER_LABEL: Record<SqlProviderKind, string> = {
  sql: 'Microsoft.Sql/servers',
  postgres: 'Microsoft.DBforPostgreSQL/flexibleServers',
};

/**
 * Azure logical-server / flexible-server names: 1–63 chars, alphanumerics and
 * hyphens, no leading or trailing hyphen. Deliberately strict — the value is
 * interpolated into ARM paths by the clients, and anything with a `/`, `?`, `#`,
 * `..`, or whitespace is refused rather than escaped.
 */
const SERVER_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/** `/subscriptions/<sub>/resourceGroups/<rg>/providers/<ns>/<type>/<name>` */
const SERVER_ARM_ID_RE =
  /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/([^/]+\/[^/]+)\/([^/]+)$/i;

/** A refusal carrying the HTTP shape the route should return. */
export interface ScopeRefusal {
  ok: false;
  status: number;
  code: string;
  error: string;
}

export type AdmittedServer = { ok: true; server: ScopedSqlServer } | ScopeRefusal;

function refuse(status: number, code: string, error: string): ScopeRefusal {
  return { ok: false, status, code, error };
}

/**
 * Admit a server reference against the GOVERNED SUBSCRIPTION SCOPE.
 *
 * Accepts two forms, and only two:
 *
 *   1. A FULL ARM ID. Must be well-formed, must name `provider`'s exact
 *      namespace/type, and its subscription must appear in
 *      `loomSubscriptionScope()`. This is the form the advisory turns on: the
 *      clients all branch `ref.startsWith('/') ? ref : <compose from
 *      LOOM_SUBSCRIPTION_ID>`, so an ARM id skipped the subscription pin
 *      entirely and reached any subscription the UAMI held a role in.
 *
 *   2. A BARE SERVER NAME (or an FQDN, whose first DNS label is taken — the
 *      same first-label semantics `_bound-connection.ts::sqlHostsMatch` already
 *      uses, and the form the clients' `listServers()` lookup expects). A bare
 *      name carries NO subscription, so the clients resolve it by listing
 *      servers in `LOOM_SUBSCRIPTION_ID` — it is pinned by construction and
 *      cannot address another subscription.
 *
 * FAILS CLOSED when the governed set is empty (`LOOM_SUBSCRIPTION_ID` unset):
 * with no governed set there is nothing to admit against, so an ARM id is
 * refused rather than allowed. A bare name in that state still fails downstream
 * in the client with its existing `LOOM_SUBSCRIPTION_ID not set` error.
 */
export function admitGovernedServer(ref: unknown, provider: SqlProviderKind): AdmittedServer {
  const raw = typeof ref === 'string' ? ref.trim() : '';
  if (!raw) {
    return refuse(409, 'no_bound_connection', 'This item has no bound server.');
  }

  if (raw.startsWith('/')) {
    const m = SERVER_ARM_ID_RE.exec(raw);
    if (!m) {
      return refuse(
        400,
        'malformed_server_id',
        'The bound server is not a well-formed Azure resource id.',
      );
    }
    const [, sub, , providerPath, name] = m;
    if (providerPath.toLowerCase() !== PROVIDER_PATH[provider]) {
      return refuse(
        403,
        'server_type_mismatch',
        `This surface addresses ${PROVIDER_LABEL[provider]} resources; the bound server names a different resource type.`,
      );
    }
    if (!SERVER_NAME_RE.test(name)) {
      return refuse(400, 'malformed_server_id', 'The bound server name is not a valid Azure server name.');
    }
    const governed = loomSubscriptionScope();
    if (!governed.length) {
      return refuse(
        403,
        'server_not_governed',
        'This deployment declares no governed subscription (LOOM_SUBSCRIPTION_ID is unset), so a fully-qualified server id cannot be authorized.',
      );
    }
    if (!governed.some((s) => s.toLowerCase() === sub.toLowerCase())) {
      return refuse(
        403,
        'server_not_governed',
        'The bound server is in a subscription this Loom deployment does not govern. Bind a server in this deployment’s subscription.',
      );
    }
    return { ok: true, server: scoped(raw) };
  }

  // Bare name (or FQDN → first label). No subscription is expressible here, so
  // the clients' subscription-scoped lookup is the pin.
  const label = raw.split('.')[0];
  if (!SERVER_NAME_RE.test(label)) {
    return refuse(400, 'malformed_server_name', 'The bound server is not a valid Azure server name.');
  }
  return { ok: true, server: scoped(label) };
}

/** The server + database an item is bound to, straight off `state.connection`. */
export function boundConnection(item: Pick<WorkspaceItem, 'state'> | null | undefined): {
  server: string;
  database: string;
  family: string;
} {
  const conn = (item?.state as { connection?: Record<string, unknown> } | undefined)?.connection;
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  return { server: str(conn?.server), database: str(conn?.database), family: str(conn?.family) };
}

/**
 * True when a submitted host names the SAME logical server as the bound one.
 * Tolerant of bare-name vs FQDN vs full ARM id (the editors send whichever they
 * hold), comparing on the LAST path segment's first DNS label, case-insensitively
 * — which keeps it cloud-agnostic (Commercial and Gov host suffixes compare
 * equal). An empty `submitted` is "no conflict": the caller left it implicit.
 *
 * NAME-ONLY, AND THAT IS NOT SUFFICIENT ON ITS OWN. Two different servers in two
 * different subscriptions can carry the same name, so
 * `serverRefsMatch('/subscriptions/<foreign>/…/servers/srv', 'srv')` is TRUE.
 * Measured during this fix: with only this comparison in the wrapper, a body
 * carrying a FOREIGN ARM id for a same-named server was admitted, and the route
 * was safe only because the handler happened to ignore the body — the exact
 * shape this advisory exists to remove. {@link withBoundSqlServer} therefore runs
 * the submitted value through {@link admitGovernedServer} FIRST, so an ungoverned
 * ARM id is refused before this comparison is ever reached.
 */
export function serverRefsMatch(submitted: string, bound: string): boolean {
  const key = (h: string) => {
    const t = h.trim().toLowerCase();
    if (!t) return '';
    const seg = t.startsWith('/') ? (t.split('/').pop() || '') : t;
    return seg.split('.')[0];
  };
  const s = submitted.trim();
  if (!s) return true;
  return key(s) === key(bound);
}

/** Context handed to a bound-server handler — no id-shaped parameter remains. */
export interface BoundSqlContext<P> {
  session: SessionPayload;
  /** The authorized route item. */
  item: WorkspaceItem;
  /** Awaited route params (kept for wire-compat; the target never comes from here). */
  params: P;
  /**
   * The server this request may address: the item's binding, admitted against
   * the governed subscription scope. NEVER a request value.
   */
  server: ScopedSqlServer;
  /** The item's bound database, or `''` when the binding names none. */
  database: string;
  /** The parsed JSON body (`{}` for a GET, or an unparseable/absent body). */
  body: Record<string, unknown>;
}

export type BoundSqlHandler<P> = (
  req: NextRequest,
  ctx: BoundSqlContext<P>,
) => Promise<Response> | Response;

export interface BoundSqlOpts {
  /** Cosmos itemType of the route's `[id]`. Defaults to `azure-sql-database`. */
  itemType?: string;
  /** The ARM provider this route's backend speaks. */
  provider: SqlProviderKind;
  /** Read-only handlers opt in. Anything that mutates Azure must NOT pass it. */
  allowReadRoles?: boolean;
  /**
   * Require the item's binding to name a database too. Azure SQL routes that
   * address a database scope set this; server-scope routes (firewall, AAD admin)
   * and PostgreSQL (whose database is chosen per query on a bound server) do not.
   */
  requireDatabase?: boolean;
}

const DEFAULT_ITEM_TYPE = 'azure-sql-database';

/**
 * Session → item ownership → the item's bound server → admission against the
 * governed subscription scope → refusal of a mismatching request coordinate.
 *
 * The handler receives an AUTHORIZED ITEM AND AN ADMITTED SERVER, not an id.
 * That shape is deliberate and is the strongest single design point carried
 * over from the ADX remediation: there is no id-shaped parameter left for a
 * handler to accept and ignore, which is the exact shape that made this whole
 * family invisible to `check-route-guards` CHECK 3.
 *
 * It is also unskippable in the way `withCapability` documents: the handler is
 * an ARGUMENT to the guard, so there is no `if (denied) return denied;` line a
 * later edit can drop while leaving the guard's NAME in the file.
 *
 * The body is read ONCE here and handed to the handler on `ctx.body`; a handler
 * must not call `req.json()` again (the stream is consumed).
 */
export function withBoundSqlServer<P extends { id: string } = { id: string }>(
  opts: BoundSqlOpts,
  handler: BoundSqlHandler<P>,
): RouteHandler<P> {
  const itemType = opts.itemType ?? DEFAULT_ITEM_TYPE;
  const ownerOpts = opts.allowReadRoles ? { allowReadRoles: true } : {};
  return withWorkspaceOwner<P>(itemType, ownerOpts, async (req, ctx) => {
    const body =
      req.method === 'GET' || req.method === 'HEAD'
        ? {}
        : ((await req.json().catch(() => ({}))) as Record<string, unknown>);

    // A GET carries its coordinates on the query string; everything else in the
    // body. Both are read ONLY to detect a mismatch, never to choose the target.
    const url = new URL(req.url);
    const submittedServer =
      typeof body.server === 'string' ? body.server : (url.searchParams.get('server') ?? '');
    const submittedDatabase =
      typeof body.database === 'string' ? body.database : (url.searchParams.get('database') ?? '');

    const bound = boundConnection(ctx.item);
    if (!bound.server) {
      return apiError(
        'This item has no bound server. Open the Connect tab and pick a server before running this action.',
        409,
        { code: 'no_bound_connection' },
      );
    }
    if (opts.requireDatabase && !bound.database) {
      return apiError(
        'This item has no bound database. Open the Connect tab and pick a database before running this action.',
        409,
        { code: 'no_bound_connection' },
      );
    }

    const admitted = admitGovernedServer(bound.server, opts.provider);
    if (!admitted.ok) {
      return apiError(admitted.error, admitted.status, { code: admitted.code });
    }

    // The SUBMITTED coordinate is admitted too, BEFORE it is compared.
    //
    // WHY, measured during this fix rather than reasoned: `serverRefsMatch` is a
    // NAME comparison, and two subscriptions can hold two different servers with
    // the same name. So a body carrying
    // `/subscriptions/<ungoverned>/…/servers/srv` "matched" a bound bare name
    // `srv`, was admitted, and reached the handler. Nothing bad happened only
    // because the handler ignores the body — i.e. the route's safety rested on a
    // handler continuing to not-look, which is precisely the shape that made
    // this whole family invisible in the first place. Admitting the submitted
    // value first removes that dependency: an ungoverned ARM id is refused here,
    // whatever any present or future handler does with `ctx.body`.
    if (submittedServer.trim()) {
      const admittedSubmitted = admitGovernedServer(submittedServer, opts.provider);
      if (!admittedSubmitted.ok) {
        return apiError(admittedSubmitted.error, admittedSubmitted.status, { code: admittedSubmitted.code });
      }
    }

    if (!serverRefsMatch(submittedServer, bound.server)) {
      return apiError(
        'The requested server does not match this item’s bound connection.',
        403,
        { code: 'server_mismatch' },
      );
    }    if (
      bound.database &&
      submittedDatabase.trim() &&
      submittedDatabase.trim().toLowerCase() !== bound.database.toLowerCase()
    ) {
      return apiError(
        'The requested database does not match this item’s bound connection.',
        403,
        { code: 'database_mismatch' },
      );
    }

    return handler(req, {
      session: ctx.session,
      item: ctx.item,
      params: ctx.params,
      server: admitted.server,
      database: bound.database,
      body,
    });
  });
}

/**
 * Admit a SECOND, caller-chosen server coordinate — currently only
 * `replication`'s `replicaServer`, the destination of a geo-secondary.
 *
 * Pinning the PRIMARY alone is not enough there: `enableReplication` resolves
 * `replicaServer` through the identical `startsWith('/')` branch, so a full ARM
 * id sent as the replica pointed an ARM PUT at any subscription. Unlike the
 * primary this one is a legitimate user PICK (you choose where the replica
 * lands), so it cannot be resolved from the item — it is admitted against the
 * governed subscription scope instead, which is the same Layer 3 control.
 */
export function admitReplicaServer(ref: unknown, provider: SqlProviderKind): AdmittedServer {
  const admitted = admitGovernedServer(ref, provider);
  if (!admitted.ok && admitted.code === 'no_bound_connection') {
    return refuse(400, 'replica_server_required', 'replicaServer is required');
  }
  return admitted;
}

/** `/subscriptions/<sub>/resourceGroups/<rg>/providers/<ns>/<type>/<server>/<childType>/<child>` */
const SERVER_CHILD_ID_RE =
  /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/([^/]+\/[^/]+)\/([^/]+)\/([^/]+)\/([^/]+)$/i;

export type AdmittedChild = { ok: true; id: string } | ScopeRefusal;

/**
 * Admit a CHILD-resource ARM id against the item's bound server.
 *
 * Needed because a route can carry a second ARM-id coordinate that is not the
 * server itself. The live case is `restore`'s `restorableDroppedDatabaseId`,
 * which `startPointInTimeRestore` copies verbatim into `properties.
 * sourceDatabaseId` — so an id from another subscription restored THAT
 * subscription's dropped database into a new database on the (now pinned)
 * server, where the caller could then read it. Pinning the server alone would
 * have left that intact.
 *
 * Pure string validation against the bound coordinates — no ARM round-trip.
 */
export function admitBoundServerChild(
  id: unknown,
  boundServer: string,
  provider: SqlProviderKind,
  childType: string,
): AdmittedChild {
  const raw = typeof id === 'string' ? id.trim() : '';
  if (!raw) return refuse(400, 'child_id_required', `${childType} id is required`);
  const m = SERVER_CHILD_ID_RE.exec(raw);
  if (!m) {
    return refuse(400, 'malformed_child_id', `${childType} id is not a well-formed Azure resource id.`);
  }
  const [, , , providerPath, serverName, child, childName] = m;
  if (
    providerPath.toLowerCase() !== PROVIDER_PATH[provider] ||
    child.toLowerCase() !== childType.toLowerCase()
  ) {
    return refuse(403, 'child_out_of_scope', `That id does not name a ${childType} on this item’s bound server.`);
  }
  if (!SERVER_NAME_RE.test(serverName) || !childName) {
    return refuse(400, 'malformed_child_id', `${childType} id is not a well-formed Azure resource id.`);
  }
  if (!serverRefsMatch(serverName, boundServer)) {
    return refuse(403, 'child_out_of_scope', `That ${childType} is not on this item’s bound server.`);
  }
  // The server segment matched by NAME; re-run the governed-subscription pin on
  // the parent scope so a same-named server in an ungoverned subscription is
  // still refused.
  const parent = raw.replace(new RegExp(`/${child}/[^/]+$`, 'i'), '');
  const admitted = admitGovernedServer(parent, provider);
  if (!admitted.ok) return admitted;
  return { ok: true, id: raw };
}

/** `<scope>/providers/Microsoft.Authorization/roleAssignments/<guid>` */
const ROLE_ASSIGNMENT_ID_RE =
  /^(\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/.+)\/providers\/Microsoft\.Authorization\/roleAssignments\/([^/]+)$/i;

export type AdmittedAssignment = { ok: true; assignmentId: string } | ScopeRefusal;

/**
 * Admit a role-assignment ARM id for revocation, against the item's OWN bound
 * database scope.
 *
 * `revokeDatabaseRoleAssignment` issues a raw `ARM DELETE <id>`, so an
 * unconstrained id deletes ANY role assignment at ANY scope the UAMI can reach —
 * a broader primitive than the grant half it sits next to, and the reason the
 * DELETE handler is scoped here rather than left on session-only.
 *
 * Checked as a STRING against the bound coordinates (no ARM round-trip): the
 * assignment's scope must be the bound server's database scope. Accepts the
 * bound server in either form — when the binding is a bare name the server
 * segment is compared by name, which is exactly as precise as the bare name
 * itself is (it resolves within `LOOM_SUBSCRIPTION_ID`).
 */
export function admitBoundRoleAssignmentId(
  assignmentId: unknown,
  boundServer: string,
  boundDatabase: string,
): AdmittedAssignment {
  const raw = typeof assignmentId === 'string' ? assignmentId.trim() : '';
  if (!raw) return refuse(400, 'assignment_id_required', 'assignmentId query param required');
  const m = ROLE_ASSIGNMENT_ID_RE.exec(raw);
  if (!m) {
    return refuse(400, 'malformed_assignment_id', 'assignmentId is not a well-formed role-assignment resource id.');
  }
  const scope = m[1];
  const dbScope = /\/providers\/Microsoft\.Sql\/servers\/([^/]+)\/databases\/([^/]+)$/i.exec(scope);
  if (!dbScope) {
    return refuse(
      403,
      'assignment_out_of_scope',
      'This surface revokes role assignments on its own database scope only.',
    );
  }
  const [, server, database] = dbScope;
  const sameServer = serverRefsMatch(server, boundServer);
  const sameDatabase = decodeURIComponent(database).toLowerCase() === boundDatabase.trim().toLowerCase();
  if (!sameServer || !sameDatabase) {
    return refuse(
      403,
      'assignment_out_of_scope',
      'That role assignment is not on this item’s bound database.',
    );
  }
  // Belt and braces: the assignment's own subscription must also be governed.
  const admitted = admitGovernedServer(
    scope.replace(/\/databases\/[^/]+$/i, ''),
    'sql',
  );
  if (!admitted.ok) return admitted;
  return { ok: true, assignmentId: raw };
}

/** Turn a {@link ScopeRefusal} into the response a route returns. */
export function scopeRefused(r: ScopeRefusal): NextResponse {
  return apiError(r.error, r.status, { code: r.code });
}
