/**
 * Item scope for `POST /api/items/synapse-serverless-sql-pool/[id]/query`.
 *
 * The serverless SQL pool editor runs on the shared Synapse Serverless endpoint
 * as the console's identity, so the query TEXT decides what it reads. This
 * module holds the two checks the route applies before it runs anything:
 *
 *   1. THE CALLER is authorized on the route ITEM ({@link guardSqlPoolQueryItem})
 *      through `_lib/synapse-item-scope.ts::guardSynapseItemRequest`: owner,
 *      tenant admin, or shared-ACL member of the item's workspace, with the
 *      workspace resolved from the item and a 404 for an id naming no item.
 *      Read roles are accepted, for the same reason the lakehouse SQL tab
 *      accepts them: for a caller who is not a tenant admin the route only
 *      runs text the classifier accepted, and that text is SELECT-only.
 *
 *   2. THE TEXT, for a caller who is not a tenant admin
 *      ({@link confineToWorkspaceLakehouses}), passes the lakehouse SQL tab's
 *      classifier (`../../lakehouse/_lib/query-scope.ts`), worded for this
 *      editor, with every `OPENROWSET(BULK …)` location confined to the storage
 *      root of a lakehouse in the route item's own workspace. Those roots are
 *      resolved here with `resolveLakehouseStorage`; nothing in the request
 *      names or widens them.
 *
 * WHICH LAKEHOUSES. "The caller's lakehouses" is read as the lakehouses in the
 * route item's workspace: the guard in (1) has already authorized the caller on
 * that workspace, at the same role level the lakehouse query route uses to
 * authorize a lakehouse there. A lakehouse in another workspace is queried from
 * its own SQL tab, and the refusal says so. Recycled lakehouses are not listed.
 *
 * THAT SET IS RIGHT ONLY BECAUSE THE GUARD IS WORKSPACE-ROLE BASED. Every
 * caller the guard admits holds a role on the item's WORKSPACE (owner, tenant
 * admin or shared-ACL member, through `authorizeItemWorkspace`), and a
 * workspace role already reads every lakehouse in it through the lakehouse
 * routes. An item-level share (`resolveItemAccessByOid`'s item-grant step) is
 * NOT admitted here, so a caller whose only access is a share of the SQL pool,
 * endpoint or geo item gets 404. If the guard ever admits item-level grantees,
 * this set must shrink to the lakehouses that caller can read. Two tests fail
 * first: the route test "an item-level share alone does not admit the caller",
 * and, against the real guard and the real item-grant resolver with a grant
 * the resolver is shown to accept, "an item-level grant with no workspace role
 * does not admit the caller" in `lib/auth/__tests__/authorize-item-workspace.test.ts`.
 *
 * WHY FOUR ITEM TYPES. Three other editors reach this handler with their OWN
 * item id, so the guard accepts those item types too and the same classifier
 * applies to them:
 *   - the SQL analytics endpoint: `app/api/items/sql-analytics-endpoint/[id]/query/route.ts`
 *     re-exports this route's POST, and its editor posts there with the
 *     endpoint item's id (`lib/editors/sql-analytics-endpoint-editor.tsx`);
 *   - geo-dataset and geo-query: their editors post to this route directly
 *     (`lib/editors/geo-editors.tsx`).
 * Because four editors share the handler, the refusal wording says "This
 * editor" rather than naming one of them.
 *
 * WHAT THIS DOES NOT COVER, stated rather than implied: views and external
 * tables already defined in `master` run as whatever they were defined to read,
 * and built-in functions are not restricted. A per-item serverless database
 * with an external data source rooted at the item root (#4821) is the durable
 * form of this boundary and lifts these restrictions.
 */
import { NextResponse } from 'next/server';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { resolveLakehouseStorage } from '@/lib/azure/lakehouse-abfss';
import { apiServerError } from '@/lib/api/respond';
import { mapWithConcurrency } from '@/lib/util/concurrency';
import type { WorkspaceItem } from '@/lib/types/workspace';
import type { SqlCancelKey } from '@/lib/azure/synapse-sql-client';
import {
  guardSynapseItemRequest,
  type SynapseItemGuardResult,
} from '@/app/api/items/_lib/synapse-item-scope';
import {
  analyzeLakehouseQuery,
  confineQueryLocationToRoots,
  type ItemStorageLocation,
  type QueryRefusal,
  type QueryScopeSurface,
} from '@/app/api/items/lakehouse/_lib/query-scope';

/**
 * The editors that share this route, as the classifier's refusals name them.
 * The lead does not name one editor, because four reach this handler.
 */
export const SQL_POOL_EDITOR: QueryScopeSurface = {
  lead:
    'This editor runs read-only SELECT queries over the files of the lakehouses in this workspace. ',
  name: 'this editor',
  place: 'this editor',
  files: 'the files of the lakehouses in this workspace',
  selectRemediation:
    'Write a SELECT (optionally with a WITH clause) that reads a lakehouse in this workspace through '
    + "OPENROWSET(BULK 'https://<account>.dfs.<suffix>/<container>/<lakehouse root>/…'), or query the "
    + 'INFORMATION_SCHEMA views. A tenant admin can run other statements.',
  dataSource:
    'no external data source is scoped to this workspace; name each file by its full URL under a lakehouse root',
};

/** Pool-key prefix for this editor's non-admin queries; no other target uses it. */
export const SQL_POOL_READER_POOL_PREFIX = 'sql-pool-reader:';

/**
 * The key a running query is registered under in the Synapse client's
 * in-process cancel registry, for the query and cancel routes of this item
 * family. It carries this family's namespace, the caller's oid and the route
 * item's id with the caller-supplied `queryId`, so a cancel reaches only the
 * caller's own query on that item, started through this family's query route
 * (see `SqlCancelKey` in `lib/azure/synapse-sql-client.ts`).
 */
export function sqlPoolQueryKey(oid: string, itemId: string, queryId: string): SqlCancelKey {
  return { family: 'serverless-sql-pool', oid, itemId, queryId };
}

/**
 * Item types whose editors reach this handler with their own id. The first is
 * the route's own type; the others reuse it (see the header).
 */
export const SQL_POOL_QUERY_ITEM_TYPES = [
  'synapse-serverless-sql-pool',
  'sql-analytics-endpoint',
  'geo-dataset',
  'geo-query',
] as const;

/** Most lakehouse roots resolved for one query, and how many at once. */
const MAX_LAKEHOUSES = 100;
const RESOLVE_CONCURRENCY = 6;

/** Roots named in a refusal's remediation. */
const ROOTS_SHOWN = 5;

/**
 * Authorize the caller on the route item. The first item type that names the
 * id wins; a denial other than not-found is returned as it is, so a caller
 * who is refused on an item is never retried as another type.
 */
export async function guardSqlPoolQueryItem(itemId: string): Promise<SynapseItemGuardResult> {
  let last: SynapseItemGuardResult | null = null;
  for (const itemType of SQL_POOL_QUERY_ITEM_TYPES) {
    const guard = await guardSynapseItemRequest({
      itemId,
      itemType,
      notFound: 'item not found',
      allowReadRoles: true,
    });
    if (guard.ctx) return guard;
    if (guard.res.status !== 404) return guard;
    last = guard;
  }
  return last as SynapseItemGuardResult;
}

export function refusalResponse(r: QueryRefusal): NextResponse {
  return NextResponse.json(
    { ok: false, error: r.error, code: r.code, construct: r.construct, remediation: r.remediation },
    { status: r.status },
  );
}

/** The lakehouse storage roots in one workspace, and what could not be confirmed. */
export interface WorkspaceLakehouseRoots {
  bounds: ItemStorageLocation[];
  /** Lakehouses listed. */
  listed: number;
  /** Lakehouses with no storage configured for this deployment. */
  noStorage: number;
  /** Lakehouses whose root is withheld (shared, unverified, or unreadable). */
  unconfirmed: number;
  /** True when more lakehouses exist than were resolved. */
  truncated: boolean;
}

/**
 * Resolve the storage root of every lakehouse in `workspaceId`. A lakehouse
 * whose root cannot be confirmed contributes NO root: a failure never widens
 * what a query may read. Throws only when the listing itself fails.
 */
export async function workspaceLakehouseRoots(workspaceId: string): Promise<WorkspaceLakehouseRoots> {
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<{ id: string }>(
      {
        query:
          "SELECT c.id FROM c WHERE c.workspaceId = @w AND c.itemType = 'lakehouse' "
          + 'AND (NOT IS_DEFINED(c.state._recycled) OR c.state._recycled = null)',
        parameters: [{ name: '@w', value: workspaceId }],
      },
      { partitionKey: workspaceId },
    )
    .fetchAll();
  const ids = resources.map((r) => r.id).filter((id): id is string => typeof id === 'string' && id.length > 0);
  const chosen = ids.slice(0, MAX_LAKEHOUSES);
  const resolved = await mapWithConcurrency(chosen, RESOLVE_CONCURRENCY, async (id) => {
    try {
      return await resolveLakehouseStorage(id, workspaceId);
    } catch {
      return null;
    }
  });
  const out: WorkspaceLakehouseRoots = {
    bounds: [],
    listed: ids.length,
    noStorage: 0,
    unconfirmed: 0,
    truncated: ids.length > chosen.length,
  };
  for (const r of resolved) {
    if (r?.ok) out.bounds.push(r.bound);
    else if (r?.reason === 'no-storage') out.noStorage += 1;
    else if (r?.reason !== 'not-found') out.unconfirmed += 1;
  }
  return out;
}

function outsideRemediation(roots: WorkspaceLakehouseRoots, surface: QueryScopeSurface): string {
  const shown = roots.bounds.slice(0, ROOTS_SHOWN).map((b) => b.abfss);
  const more = roots.bounds.length > shown.length ? ` (and ${roots.bounds.length - shown.length} more)` : '';
  const where = shown.length
    ? `Read files under a lakehouse root in this workspace: ${shown.join(', ')}${more}, `
      + 'or the https://<account>.dfs.<suffix>/<container>/<root>/ form of one. '
    : `No lakehouse in this workspace has a storage root ${surface.place} can confirm. `;
  return where + 'To read a lakehouse in another workspace, open that lakehouse and query it from its SQL tab.';
}

function outsideReason(roots: WorkspaceLakehouseRoots, surface: QueryScopeSurface): string {
  const notes: string[] = [];
  if (roots.unconfirmed > 0) {
    notes.push(`${roots.unconfirmed} lakehouse${roots.unconfirmed === 1 ? '' : 's'} in this workspace could not be confirmed and ${roots.unconfirmed === 1 ? 'was' : 'were'} not counted`);
  }
  if (roots.truncated) notes.push(`only the first ${MAX_LAKEHOUSES} lakehouses were checked`);
  const base = `it is not inside the storage root of any lakehouse in this workspace that ${surface.place} could confirm`;
  return notes.length ? `${base} (${notes.join('; ')})` : base;
}

/**
 * Confine a non-admin caller's SQL, or return the response that refuses it.
 * Roots are resolved only when the query names a location, so a metadata
 * query never waits on them. `surface` words the refusals; the Direct Lake
 * raw-SQL path (`app/api/items/semantic-model/_lib/direct-lake-scope.ts`)
 * passes its own, and the rules are the same.
 */
export async function confineToWorkspaceLakehouses(
  sqlText: string,
  item: WorkspaceItem,
  surface: QueryScopeSurface = SQL_POOL_EDITOR,
): Promise<NextResponse | null> {
  const analysis = analyzeLakehouseQuery(sqlText, { database: 'master', surface });
  if (!analysis.ok) return refusalResponse(analysis);
  if (analysis.locations.length === 0) return null;

  let roots: WorkspaceLakehouseRoots;
  try {
    roots = await workspaceLakehouseRoots(item.workspaceId);
  } catch (e) {
    // Fail closed with a structured body: an unread listing confirms nothing.
    return apiServerError(e);
  }
  if (roots.bounds.length === 0 && roots.noStorage > 0 && roots.unconfirmed === 0) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'No lakehouse storage is configured for this deployment, so the files this query names cannot be '
          + 'confirmed as a lakehouse\'s in this workspace.',
        code: 'lakehouse_storage_unbound',
        remediation:
          'The DLZ Bicep deploy sets LOOM_{BRONZE,SILVER,GOLD,LANDING}_URL. Once one is set, Loom resolves and '
          + 'records each lakehouse\'s storage root itself; there is no per-item step.',
      },
      { status: 409 },
    );
  }
  const opts = { surface, outside: outsideReason(roots, surface), remediation: outsideRemediation(roots, surface) };
  for (const location of analysis.locations) {
    const confined = confineQueryLocationToRoots(location, roots.bounds, opts);
    if (!confined.ok) return refusalResponse(confined);
  }
  return null;
}
