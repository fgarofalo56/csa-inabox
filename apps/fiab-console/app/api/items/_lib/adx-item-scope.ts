/**
 * GHSA-v2g8-gp3r-rg4r — ITEM-SCOPED ADX binding for the `items/<type>/[id]/**`
 * routes that reach Azure Data Explorer.
 *
 * THE HOLE THIS CLOSES. Four routes accepted a caller-supplied `database` (and,
 * on `graph-model/[id]/materialize`, a caller-supplied SOURCE database + table)
 * and acted on the ONE shared ADX cluster as the Console's managed identity.
 * There is no OBO fallback anywhere in the Kusto client — every command runs as
 * the Console, so the caller's own ADX RBAC is never consulted. Two of the
 * routes composed into a complete read primitive: `.set-or-append <t> <|
 * database('<any db>').['<any table>']` copied rows out of any database the
 * UAMI could reach into a table the same caller could then read back through
 * `[id]/query`, which also took `body.database`. A third permanently DELETED
 * rows (`.purge`) in any database named in the body.
 *
 * WHY THE EXISTING CONTROLS DID NOT SEE IT. `scripts/ci/check-route-guards.mjs`
 * classifies a route by whether it authorizes the caller against the URL `[id]`.
 * These handlers did not consume `[id]` AT ALL — `graph-model/[id]/materialize`
 * did not even bind `session`, and `lakehouse/[id]/query` took `_ctx` and
 * ignored it — so they read as the "shared backend, no per-tenant ownership to
 * scope" class and sat on the allowlist under a premise that was true only
 * because the handler never looked. The strictly worse shape was the invisible
 * one.
 *
 * THE FIX IS THE CONVENTION ALREADY IN THE REPO, not a new one:
 * `app/api/adx/_shared.ts::guardAdxRequest` — used by thirteen `/api/adx/*`
 * routes — resolves the target database FROM AN OWNER-CHECKED ITEM
 * (`loadKustoItem(itemId, 'kql-database', oid)` → `resolveDatabase(item)`).
 * This module is the same contract for the `items/<type>/[id]/**` family, where
 * the item id arrives as a route param rather than `?id=`:
 *
 *   LAYER 1 — AUTHORIZE THE CALLER against the route item.
 *     {@link guardAdxItemRequest} runs the canonical `authorizeItemWorkspace`
 *     ladder (owner → tenant-admin → shared-ACL), resolving the workspace FROM
 *     THE ITEM so authorization cannot be skipped by dropping a parameter, and
 *     then FAILS CLOSED when the id names no item — `authorizeItemWorkspace`'s
 *     one permissive case (`return null` for an unresolvable id, which is
 *     deliberate and load-bearing for raw Power BI GUIDs) is closed here rather
 *     than inherited, exactly as `_lib/notebook-exec-scope.ts` closes it.
 *
 *   LAYER 2 — BIND THE DATABASE to that item. Authorizing the caller alone is
 *     NOT sufficient: a caller authorized for their OWN graph model could still
 *     name another tenant's database in the body. The target database is
 *     therefore resolved from the item ({@link resolveItemDatabase}) and the
 *     body value is never used; where a route legitimately lets the user pick a
 *     database (the eventhouse purge dialog), the pick is validated against
 *     {@link workspaceAdxScope} — the databases BOUND TO LOOM ITEMS IN THAT
 *     ITEM'S OWN WORKSPACE — and refused otherwise. Never silently substituted:
 *     silently purging a different database than the one the operator selected
 *     would be worse than refusing.
 *
 * Both layers are required and neither is sufficient, the same rule
 * `_lib/notebook-path-scope.ts` and `_lib/notebook-exec-scope.ts` state for the
 * Databricks family.
 *
 * KNOWN RESIDUAL, recorded rather than implied fixed: `resolveItemDatabase`
 * falls back to `defaultDatabase()` (LOOM_KUSTO_DEFAULT_DB) for an item that
 * declares no database, so the shared default database is inside every
 * workspace's scope. That is the pre-existing default-path behaviour of every
 * ADX route in the console (including `guardAdxRequest` itself) and is NOT
 * changed here; separating per-tenant data out of the shared default database
 * is a different piece of work.
 */
import { NextResponse } from 'next/server';
import { getSession, type SessionPayload } from '@/lib/auth/session';
import { authorizeItemWorkspace } from '@/lib/auth/workspace-guard';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { cosmosIdFromLoomId } from '@/app/api/items/_lib/loom-content-id';
import { defaultDatabase } from '@/lib/azure/kusto-client';
import type { WorkspaceItem } from '@/lib/types/workspace';

/**
 * Item types whose Cosmos `state` names an ADX database this workspace owns.
 * Used to build {@link workspaceAdxScope}. Kept explicit (rather than "every
 * item") so an unrelated item type cannot widen a workspace's ADX scope by
 * happening to carry a `database` field.
 */
const ADX_BACKED_ITEM_TYPES = [
  'kql-database',
  'eventhouse',
  'kql-dashboard',
  'graph-model',
  'digital-twin',
] as const;

/**
 * Resolve the ADX database an item is bound to — the item's OWN declaration,
 * never a request body.
 *
 * The key differs per family because the editors persist it differently:
 *   `state.database`      — graph-model (the "Target ADX database" field)
 *   `state.databaseName`  — the kql-database family (what `resolveDatabase` reads)
 *   `state.provisioning.secondaryIds.database` / `.resourceId`
 *                         — an app-install provisioned dedicated database
 * Falls back to the env-pinned default DB, which is what every ADX route in the
 * console already does when an item declares nothing.
 */
export function resolveItemDatabase(item: Pick<WorkspaceItem, 'state'> | null | undefined): string {
  const state = (item?.state || {}) as Record<string, unknown>;
  for (const key of ['database', 'databaseName'] as const) {
    const v = state[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  const prov = state.provisioning as Record<string, any> | undefined;
  if (prov && (prov.status === 'created' || prov.status === 'exists')) {
    const provDb = prov.secondaryIds?.database || prov.resourceId;
    if (typeof provDb === 'string' && provDb.trim()) return provDb.trim();
  }
  return defaultDatabase();
}

/** Additional database names an item explicitly records (eventhouse `state.databases`). */
function declaredDatabases(item: Pick<WorkspaceItem, 'state'>): string[] {
  const raw = (item.state as Record<string, unknown> | undefined)?.databases;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string' && entry.trim()) out.push(entry.trim());
    else if (entry && typeof entry === 'object') {
      const n = (entry as Record<string, unknown>).name;
      if (typeof n === 'string' && n.trim()) out.push(n.trim());
    }
  }
  return out;
}

/**
 * The set of ADX databases reachable from `item`'s OWN WORKSPACE — its own
 * bound database plus every database bound to an ADX-backed sibling item there.
 *
 * This is the scope a caller who is authorized for `item` may name. It is
 * resolved from Cosmos, so it is not caller-influenced beyond the items that
 * workspace already owns, and it is a single partition-scoped query — the same
 * shape `kusto-client.resolveDashboardDatabase` already uses to find a
 * dashboard's sibling kql-database.
 *
 * FAILS CLOSED: if the sibling query throws, the scope degrades to the item's
 * own database rather than widening. An unverifiable database is not an
 * authorized one.
 */
export async function workspaceAdxScope(item: WorkspaceItem): Promise<Set<string>> {
  const scope = new Set<string>([resolveItemDatabase(item)]);
  for (const d of declaredDatabases(item)) scope.add(d);
  try {
    const items = await itemsContainer();
    const { resources } = await items.items
      .query<WorkspaceItem>(
        {
          query:
            'SELECT * FROM c WHERE c.workspaceId = @w AND ARRAY_CONTAINS(@types, c.itemType)',
          parameters: [
            { name: '@w', value: item.workspaceId },
            { name: '@types', value: [...ADX_BACKED_ITEM_TYPES] },
          ],
        },
        { partitionKey: item.workspaceId },
      )
      .fetchAll();
    for (const sibling of resources) {
      scope.add(resolveItemDatabase(sibling));
      for (const d of declaredDatabases(sibling)) scope.add(d);
    }
  } catch {
    /* fail closed — the item's own database only */
  }
  return scope;
}

/** Result of {@link guardAdxItemRequest}: a ready context or the response to return. */
export type AdxItemGuardResult =
  | { ctx: AdxItemContext; res?: undefined }
  | { ctx?: undefined; res: NextResponse };

export interface AdxItemContext {
  session: SessionPayload;
  /** The authorized route item. */
  item: WorkspaceItem;
  /** The database resolved FROM THE ITEM. Never a request-body value. */
  database: string;
}

/**
 * Load the route item by (id, itemType) WITHOUT authorizing — answers only
 * "which item is this". Cross-partition by design: a foreign item must still be
 * FOUND, otherwise it would resolve to "no item" and fall through unscoped.
 * `cosmosIdFromLoomId` resolves the synthetic `loom:<cosmosItemId>` form the
 * bundle-install list route hands the editor (#2830).
 */
export async function loadAdxItemRaw(itemId: string, itemType: string): Promise<WorkspaceItem | null> {
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

export interface AdxItemGuardOpts {
  /** Route `[id]`. */
  itemId: string;
  /** Cosmos `itemType` of the route's item family. */
  itemType: string;
  /** The route's existing not-found wording, so editor handling is unchanged. */
  notFound: string;
  /** Read-only handlers opt in; anything that mutates ADX must NOT pass it. */
  allowReadRoles?: boolean;
  /** A caller-supplied workspace id, when the route accepts one. */
  workspaceId?: string | null;
}

/**
 * Session → workspace authorization → the item → its bound database.
 *
 * Returns either `{ ctx }` (proceed) or `{ res }` (return this response
 * verbatim) — the same two-shape contract `app/api/adx/_shared.ts` uses, so the
 * call site reads identically to the thirteen `/api/adx/*` routes.
 *
 * The CONFIG GATE is deliberately NOT folded in here: the four routes this
 * module serves each return their own ADX gate envelope (HTTP 200 with
 * `gate.remediation` for the graph surfaces, 503 for lakehouse) and their
 * editors read those exact shapes. Moving the gate would change wire contracts
 * that have nothing to do with the authorization defect.
 */
export async function guardAdxItemRequest(opts: AdxItemGuardOpts): Promise<AdxItemGuardResult> {
  const session = getSession();
  if (!session) {
    return { res: NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 }) };
  }
  const denied = await authorizeItemWorkspace(session, {
    workspaceId: opts.workspaceId ?? null,
    itemId: opts.itemId,
    itemType: opts.itemType,
    ...(opts.allowReadRoles ? { allowReadRoles: true } : {}),
    notFound: opts.notFound,
  });
  if (denied) return { res: denied };

  const item = await loadAdxItemRaw(opts.itemId, opts.itemType);
  if (!item) {
    // FAIL CLOSED. `authorizeItemWorkspace` returns null (= allow) for an id
    // naming no item of this type; with no item there is no scope to bind a
    // database to, so proceeding would run unbound on the shared cluster.
    return { res: NextResponse.json({ ok: false, error: opts.notFound }, { status: 404 }) };
  }
  return { ctx: { session, item, database: resolveItemDatabase(item) } };
}

/**
 * Validate a caller-chosen database against an item's workspace scope.
 * Returns the safe database name, or the response the route should return.
 *
 * Used ONLY where the user legitimately picks a database in the UI (the
 * eventhouse purge dialog, the graph-model source-table binding). Everywhere
 * else the database comes from {@link resolveItemDatabase} and the body value
 * is not read at all.
 */
export type ScopedDatabase =
  | { ok: true; database: string }
  | { ok: false; status: number; error: string };

const DB_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_\-. ]{0,126}$/;

export async function scopeAdxDatabase(
  item: WorkspaceItem,
  requested: unknown,
  scope?: Set<string>,
): Promise<ScopedDatabase> {
  const asked = typeof requested === 'string' ? requested.trim() : '';
  if (!asked) return { ok: true, database: resolveItemDatabase(item) };
  if (!DB_NAME_RE.test(asked)) {
    return { ok: false, status: 400, error: 'database is not a valid Azure Data Explorer database name.' };
  }
  const allowed = scope ?? (await workspaceAdxScope(item));
  if (!allowed.has(asked)) {
    return {
      ok: false,
      status: 403,
      error:
        `database "${asked}" is not bound to any item in this workspace. ` +
        `This workspace can address: ${[...allowed].sort().join(', ')}. ` +
        'Create the KQL database through this item (or bind it as a kql-database item) first.',
    };
  }
  return { ok: true, database: asked };
}

/**
 * Refuse KQL that reaches OUT of the database it is executed against.
 *
 * Pinning the `database` argument of `executeQuery` is NOT sufficient on its
 * own: KQL's `database('X')` and `cluster('Y').database('X')` qualifiers let a
 * query body address any database the connection's identity can reach — which,
 * for the Console UAMI on the shared cluster, is all of them. Any route that
 * runs caller-authored KQL must call this.
 *
 * Deliberately a REFUSAL, not a rewrite: silently stripping a qualifier would
 * change what the user asked for and hand back results for a different table.
 */
export function crossDatabaseReference(kql: string): string | null {
  const m = /\b(?:database|cluster)\s*\(/i.exec(kql);
  return m ? m[0].replace(/\s*\($/, '') : null;
}

/** The 403 a route returns when caller-authored KQL reaches another database. */
export function crossDatabaseRefused(qualifier: string, database: string): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      error:
        `KQL '${qualifier}(...)' qualifiers are not allowed here — this surface runs against ` +
        `the database bound to this item ("${database}") only. Remove the ${qualifier}() reference, ` +
        'or open the KQL database item that owns the other database and query it there.',
    },
    { status: 403 },
  );
}
