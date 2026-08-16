/**
 * GHSA-v2g8-gp3r-rg4r — ITEM-SCOPED binding for the `items/<type>/[id]/**`
 * routes that reach the SHARED Synapse SQL estate.
 *
 * THE HOLE THIS CLOSES. `warehouse`, `synapse-dedicated-sql-pool` and
 * `synapse-serverless-sql-pool` are ALL backed by ONE Synapse workspace and ONE
 * env-pinned dedicated pool (`synapse-sql-client.dedicatedTarget()` reads
 * `LOOM_SYNAPSE_WORKSPACE` + `LOOM_SYNAPSE_DEDICATED_POOL`). Every workspace in
 * every tenant provisions INTO THAT SAME DATABASE — the warehouse provisioner
 * even carries `makeCreateTableIdempotent`, whose comment says so out loud: "On
 * a SHARED dedicated pool the table may already exist pool-wide from a prior
 * install." The TDS connection is opened with the Console's own UAMI, which is
 * AAD admin on the workspace; there is no OBO anywhere on the dedicated path, so
 * the caller's own SQL RBAC is never consulted.
 *
 * On top of that estate the tabled routes ran `getSession()` and nothing else:
 *
 *   • `[id]/clone` (warehouse + dedicated pool) — `CREATE TABLE … AS SELECT * FROM
 *     [srcSchema].[srcTable]` / `SELECT * INTO …`. The source is CALLER-NAMED, so
 *     the statement copies any table in the shared pool into a table the same
 *     caller can read back through `[id]/query`. That is the advisory's headline
 *     shape — materialize-then-read — on a second backend.
 *   • `[id]/copy-into` — `COPY INTO [tgt] FROM '<storage url>'`, i.e. a WRITE to a
 *     caller-named table.
 *   • `[id]/query` — arbitrary T-SQL, AND a caller-supplied `body.database` that
 *     re-points the TDS connection at any other database on the shared Synapse
 *     SQL server.
 *   • `[id]/schema`, `[id]/script-out`, `[id]/objects` — enumeration of every
 *     schema/table/row-count in the shared pool and the full `OBJECT_DEFINITION`
 *     body of any view/procedure/function in it.
 *
 * WHY THE EXISTING CONTROLS DID NOT SEE IT — identical to the ADX family. These
 * handlers do not consume `[id]` (several do not even accept `ctx`), and
 * `scripts/ci/check-route-guards.mjs` CHECK 3 filters to handlers that resolve
 * `[id]` as an owned item, so the strictly worse shape is outside its population
 * by construction.
 *
 * TWO LAYERS, the same contract `_lib/adx-item-scope.ts` established:
 *
 *   LAYER 1 — AUTHORIZE THE CALLER against the route item.
 *     {@link guardSynapseItemRequest} runs the canonical `authorizeItemWorkspace`
 *     ladder (owner → tenant-admin → shared-ACL), resolving the workspace FROM
 *     THE ITEM so authorization cannot be skipped by dropping a parameter, and
 *     FAILS CLOSED when the id names no item — `authorizeItemWorkspace`'s one
 *     permissive case (`return null` for an unresolvable id) is closed here
 *     rather than inherited, exactly as `_lib/adx-item-scope.ts` and
 *     `_lib/notebook-exec-scope.ts` close it.
 *
 *   LAYER 2 — BIND THE DATABASE to that item. {@link scopeSynapseDatabase}
 *     admits a caller-supplied `database` only when it is bound to an item in
 *     THIS ITEM'S OWN WORKSPACE; blank resolves to the item's own bound database.
 *     Refused (403), never silently substituted.
 *
 * ══ WHAT THIS MODULE DELIBERATELY DOES **NOT** DO — read this before assuming ══
 *
 * There is NO `schema.table` binding here, and its absence is the honest state of
 * the tree, not an oversight:
 *
 *   The dedicated pool database name is ENV-PINNED and identical for every
 *   workspace, and NOTHING in the estate records which SCHEMA or TABLE inside it
 *   belongs to which Loom item. `warehouseProvisioner` returns
 *   `secondaryIds: { backend, database: target.database }` — the shared pool —
 *   and the schemas it creates come from bundle DDL that two tenants installing
 *   the same bundle share by name. So an item-derived answer to "may this caller
 *   name `[gold].[fact_sales]`" does not exist to be read.
 *
 *   Consequence, stated plainly so no reader mistakes adoption for closure:
 *   **on the dedicated-pool routes Layer 1 is a FLOOR, not a BOUND.** It converts
 *   "any signed-in user, owning nothing, in any tenant" into "a caller with write
 *   access to a warehouse/pool item" — and creating such an item is self-service.
 *   The cross-tenant table read/write inside the one shared database SURVIVES
 *   this module. Closing it needs a per-item schema ownership model plus a
 *   backfill for every existing install; that is a design decision with a
 *   brownfield migration, which the advisory's own remediation note warns must
 *   not be improvised ("a scope-narrowing fix is only as strong as the write path
 *   into the scope").
 *
 * Layer 2 IS a real bound for the `database` coordinate specifically: the
 * cross-database re-point on `[id]/query` reaches OTHER databases on the same
 * Synapse SQL server, which are not the shared pool and are not this workspace's.
 */
import { NextResponse } from 'next/server';
import { getSession, type SessionPayload } from '@/lib/auth/session';
import { authorizeItemWorkspace } from '@/lib/auth/workspace-guard';
import { apiServerError } from '@/lib/api/respond';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { cosmosIdFromLoomId } from '@/app/api/items/_lib/loom-content-id';
import type { WorkspaceItem } from '@/lib/types/workspace';

/**
 * A Synapse database name RESOLVED FROM AN ITEM or admitted by
 * {@link scopeSynapseDatabase} — never a raw request value.
 *
 * The brand's bound is the SAME one `_lib/adx-item-scope.ts` records against
 * itself and it is repeated here rather than assumed known: it catches a
 * re-point that KEEPS the annotation (`const db: SynapseScopedDatabase = raw` →
 * `tsc` exit 2) and does NOT catch one that drops it (`const db = raw` → exit 0),
 * because the inferred type is plain `string`. Both are the same defect. The
 * route tests are the control that actually holds; this raises the cost of the
 * cheapest edit and nothing more.
 */
export type SynapseScopedDatabase = string & { readonly __synapseScoped: unique symbol };

/** The single trusted construction point for {@link SynapseScopedDatabase}. */
function scoped(name: string): SynapseScopedDatabase {
  return name as SynapseScopedDatabase;
}

/**
 * Item types whose Cosmos `state` names a Synapse SQL database this workspace
 * owns. Kept explicit (rather than "every item") so an unrelated item type
 * cannot widen a workspace's Synapse scope by happening to carry a `database`
 * field — the same rule `ADX_BACKED_ITEM_TYPES` states for ADX.
 */
const SYNAPSE_BACKED_ITEM_TYPES = [
  'warehouse',
  'synapse-dedicated-sql-pool',
  'synapse-serverless-sql-pool',
  'lakehouse',
  'semantic-model',
] as const;

/**
 * The env-pinned dedicated pool database, read WITHOUT throwing.
 *
 * `synapse-sql-client.dedicatedTarget()` throws when `LOOM_SYNAPSE_DEDICATED_POOL`
 * is unset, and this module is on the authorization path: a config gap must not
 * turn into an unhandled 500 that a caller can distinguish from a denial. An
 * unset pool yields `''`, which {@link scopeSynapseDatabase} treats as "the item
 * declares no database", so a blank request still falls through to the route's
 * own `dedicatedTarget()` call and that route's own honest error.
 */
function envPoolDatabase(): string {
  return (process.env.LOOM_SYNAPSE_DEDICATED_POOL || '').trim();
}

/**
 * Resolve the Synapse database an item is bound to — the item's OWN
 * declaration, never a request body.
 *
 * Resolution order mirrors what the PLATFORM itself writes and reads:
 *   `state.provisioning.secondaryIds.database` — what `warehouseProvisioner`
 *       records on a successful install (`{ backend, database: target.database }`).
 *   `state.database` / `state.databaseName` — what the editors persist.
 *   the env-pinned pool — the unchanged default every Synapse route already uses
 *       when an item declares nothing.
 */
export function resolveItemSynapseDatabase(
  item: Pick<WorkspaceItem, 'state'> | null | undefined,
): SynapseScopedDatabase {
  const state = (item?.state || {}) as Record<string, unknown>;
  const prov = state.provisioning as Record<string, any> | undefined;
  if (prov && (prov.status === 'created' || prov.status === 'exists')) {
    const provDb = prov.secondaryIds?.database;
    if (typeof provDb === 'string' && provDb.trim()) return scoped(provDb.trim());
  }
  for (const key of ['database', 'databaseName'] as const) {
    const v = state[key];
    if (typeof v === 'string' && v.trim()) return scoped(v.trim());
  }
  return scoped(envPoolDatabase());
}

/**
 * The set of Synapse databases reachable from `item`'s OWN WORKSPACE — its own
 * bound database plus every database bound to a Synapse-backed sibling there.
 *
 * FAILS CLOSED: if the sibling query throws, the scope degrades to the item's own
 * database rather than widening. An unverifiable database is not an authorized
 * one.
 */
export async function workspaceSynapseScope(item: WorkspaceItem): Promise<Set<string>> {
  const scope = new Set<string>();
  const own = resolveItemSynapseDatabase(item);
  if (own) scope.add(own);
  try {
    const items = await itemsContainer();
    const { resources } = await items.items
      .query<WorkspaceItem>(
        {
          query:
            'SELECT * FROM c WHERE c.workspaceId = @w AND ARRAY_CONTAINS(@types, c.itemType)',
          parameters: [
            { name: '@w', value: item.workspaceId },
            { name: '@types', value: [...SYNAPSE_BACKED_ITEM_TYPES] },
          ],
        },
        { partitionKey: item.workspaceId },
      )
      .fetchAll();
    for (const sibling of resources) {
      const db = resolveItemSynapseDatabase(sibling);
      if (db) scope.add(db);
    }
  } catch {
    /* fail closed — the item's own database only */
  }
  return scope;
}

/** Result of {@link guardSynapseItemRequest}: a ready context or the response to return. */
export type SynapseItemGuardResult =
  | { ctx: SynapseItemContext; res?: undefined }
  | { ctx?: undefined; res: NextResponse };

export interface SynapseItemContext {
  session: SessionPayload;
  /** The authorized route item. */
  item: WorkspaceItem;
  /** The database resolved FROM THE ITEM. Never a request-body value. */
  database: SynapseScopedDatabase;
}

/**
 * Load the route item by (id, itemType) WITHOUT authorizing — answers only
 * "which item is this". Cross-partition by design: a foreign item must still be
 * FOUND, otherwise it would resolve to "no item" and fall through unscoped.
 */
export async function loadSynapseItemRaw(itemId: string, itemType: string): Promise<WorkspaceItem | null> {
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<WorkspaceItem>({
      query: 'SELECT * FROM c WHERE c.id = @id AND c.itemType = @t',
      parameters: [
        { name: '@id', value: cosmosIdFromLoomId(itemId) },
        { name: '@t', value: itemType },
      ],
    })
    .fetchAll();
  return resources[0] ?? null;
}

export interface SynapseItemGuardOpts {
  /** Route `[id]`. */
  itemId: string;
  /** Cosmos `itemType` of the route's item family. */
  itemType: string;
  /** The route's existing not-found wording, so editor handling is unchanged. */
  notFound: string;
  /** Read-only handlers opt in; anything that mutates Synapse must NOT pass it. */
  allowReadRoles?: boolean;
  /** A caller-supplied workspace id, when the route accepts one. */
  workspaceId?: string | null;
}

/**
 * Session → workspace authorization → the item → its bound database.
 *
 * Returns either `{ ctx }` (proceed) or `{ res }` (return this response
 * verbatim) — the same two-shape contract `_lib/adx-item-scope.ts` uses.
 *
 * The FAIL-SAFE ENVELOPE is deliberate and is the lesson #3614's M22/M23 pair
 * recorded: this guard reaches COSMOS, a dependency the handlers adopting it did
 * not previously have, so a Cosmos throw would otherwise surface as Next's
 * generic HTML 500 which the editors' `await r.json()` cannot parse. It can only
 * ever produce a DENIAL — the catch returns the `{ res }` half, never `{ ctx }` —
 * so it is fail-closed by construction and cannot convert an authorization error
 * into an authorization pass.
 */
export async function guardSynapseItemRequest(
  opts: SynapseItemGuardOpts,
): Promise<SynapseItemGuardResult> {
  const session = getSession();
  if (!session) {
    return { res: NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 }) };
  }
  try {
    const denied = await authorizeItemWorkspace(session, {
      workspaceId: opts.workspaceId ?? null,
      itemId: opts.itemId,
      itemType: opts.itemType,
      ...(opts.allowReadRoles ? { allowReadRoles: true } : {}),
      notFound: opts.notFound,
    });
    if (denied) return { res: denied };

    const item = await loadSynapseItemRaw(opts.itemId, opts.itemType);
    if (!item) {
      // FAIL CLOSED. `authorizeItemWorkspace` returns null (= allow) for an id
      // naming no item of this type; with no item there is no scope to bind a
      // database to, so proceeding would run unbound on the shared pool.
      return { res: NextResponse.json({ ok: false, error: opts.notFound }, { status: 404 }) };
    }
    return { ctx: { session, item, database: resolveItemSynapseDatabase(item) } };
  } catch (e) {
    return { res: apiServerError(e) };
  }
}

/** The resolution of a caller-chosen database against an item's workspace scope. */
export type ScopedSynapseDatabase =
  | { ok: true; database: SynapseScopedDatabase }
  | { ok: false; status: number; error: string };

/**
 * T-SQL database identifiers. Deliberately narrower than sysname: a Synapse
 * database name reaches the TDS connection string, so anything outside the
 * documented identifier charset is refused rather than escaped.
 */
const DB_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_\-. ]{0,126}$/;

/**
 * Validate a caller-chosen database against an item's workspace scope.
 * Returns the safe database name, or the response the route should return.
 *
 * Blank resolves to the item's own bound database — the editors send no
 * `database` on the default path, so nothing that worked stops working.
 */
export async function scopeSynapseDatabase(
  item: WorkspaceItem,
  requested: unknown,
  scopeSet?: Set<string>,
): Promise<ScopedSynapseDatabase> {
  const asked = typeof requested === 'string' ? requested.trim() : '';
  if (!asked) return { ok: true, database: resolveItemSynapseDatabase(item) };
  if (!DB_NAME_RE.test(asked)) {
    return { ok: false, status: 400, error: 'database is not a valid Synapse SQL database name.' };
  }
  const allowed = scopeSet ?? (await workspaceSynapseScope(item));
  if (!allowed.has(asked)) {
    return {
      ok: false,
      status: 403,
      error:
        `database "${asked}" is not bound to any item in this workspace. ` +
        `This workspace can address: ${[...allowed].sort().join(', ') || '(none)'}. ` +
        'Open the item that owns the other database and query it there.',
    };
  }
  // Admitted against the workspace's own bound set — the ONLY place a
  // caller-supplied string becomes a SynapseScopedDatabase.
  return { ok: true, database: scoped(asked) };
}
