import { NextResponse } from 'next/server';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';
import type { SessionPayload } from '@/lib/auth/session';
import { authorizeItemWorkspace } from '@/lib/auth/workspace-guard';

/**
 * loadAuthorizedItem — ONE loader for the generic `items/[type]/[id]` family.
 *
 * ── WHAT THIS REPLACES (#3941) ─────────────────────────────────────────────
 * Ten routes under `items/[type]/[id]/**` each carried a byte-identical private
 * `loadItem(itemId, type, tenantId)` whose second half was
 *
 *     const { resource } = await ws.item(item.workspaceId, tenantId).read<Workspace>();
 *     if (!resource || resource.tenantId !== tenantId) return null;
 *
 * with `tenantId` filled from `session.claims.oid`. The `workspaces` container
 * is partitioned on `/tenantId`, which stores the workspace CREATOR's oid, so
 * that pair answers "did this caller CREATE this workspace?" — never "may this
 * caller ACCESS it?". It is the #2941/#2942/#2947 defect, and
 * `check-owner-only-workspace-guard` baselined all ten occurrences plus two
 * TOUCH_EXEMPT deferrals rather than let them regress silently.
 *
 * ── THIS IS AN AUTHORIZATION CHANGE, AND IT WIDENS ─────────────────────────
 * Stated plainly because it is the whole reason #3611 and #3753 deferred it.
 * `authorizeItemWorkspace` runs the canonical ladder — owner → tenant admin →
 * shared-ACL member — so after this migration a tenant admin and an ACL member
 * with a sufficient role reach GET, PATCH, PUT, POST and DELETE on every item
 * type that has no dedicated `[id]/route.ts`, where before only the workspace's
 * creator did. That is deliberate: the old check failed CLOSED, which is why
 * deferring leaked nothing, but "closed" here meant an admin could not read
 * their own tenant's item and a shared workspace's members could not touch what
 * was shared with them.
 *
 * ── READ vs WRITE, AND WHY THE KEY IS ABSENT RATHER THAN FALSE ─────────────
 * `write: false` passes `allowReadRoles: true` (any workspace role may read);
 * `write: true` omits the key ENTIRELY, so the guard stays write-scoped
 * (Owner/Admin/Member) and a read-only Viewer can never mutate through a route
 * that only "made the read work". The key is spread in rather than set to
 * `false` so a spec can assert the exact options object by deep equality and a
 * one-word `allowReadRoles: true` added to a mutating call site fails it — the
 * idiom `items/data-pipeline/[id]/__tests__/workspace-authz.test.ts` documents.
 *
 * EVERY non-GET handler in this family passes `write: true`, including the two
 * POSTs (`export-check`, `business-metadata`) whose bodies are arguably reads.
 * Write-scoping them is the conservative direction: it is still strictly wider
 * than the owner-only check they had, so it regresses nobody, and it does not
 * hand a Viewer a verb on the strength of a guess about the handler's intent.
 *
 * ── WHY `workspaceId` IS PASSED IN ────────────────────────────────────────
 * `authorizeItemWorkspace` resolves the workspace from the item when the caller
 * supplies none, which would re-issue a second cross-partition query for a
 * document this function has already read. The id passed here comes from THE
 * ITEM DOCUMENT, never from the request — so this is not the "skippable
 * authorization" shape that helper's header warns about, where a caller could
 * omit a query parameter and skip the check: there is no request-controlled
 * path into this argument.
 */
export interface AuthorizedItemResult {
  /** The item — present only when it exists AND the caller is authorized. */
  item: WorkspaceItem | null;
  /** Non-null when authorization REFUSED. Return it verbatim. */
  denied: NextResponse | null;
}

export async function loadAuthorizedItem(
  session: SessionPayload,
  opts: {
    /** Route `[id]`. */
    itemId: string;
    /** Route `[type]` — the Cosmos `itemType`. */
    itemType: string;
    /** TRUE for any mutating handler (PATCH/PUT/POST/DELETE). */
    write: boolean;
    /** The route's own not-found wording, preserved for an ordinary refusal. */
    notFound: string;
  },
): Promise<AuthorizedItemResult> {
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<WorkspaceItem>({
      query: 'SELECT * FROM c WHERE c.id = @id AND c.itemType = @t',
      parameters: [
        { name: '@id', value: opts.itemId },
        { name: '@t', value: opts.itemType },
      ],
    })
    .fetchAll();
  const item = resources[0];
  // No such item of this type anywhere in the estate — there is no other
  // tenant's resource to gate, and the route renders its own 404.
  if (!item) return { item: null, denied: null };
  // An item carrying no workspace cannot be authorized against one. FAIL CLOSED
  // rather than authorize against `undefined`, which the previous point read did
  // implicitly (`ws.item(undefined, oid)` 404s) and which must not become an
  // allow when the guard is asked instead.
  if (!item.workspaceId) return { item: null, denied: null };

  const denied = await authorizeItemWorkspace(session, {
    workspaceId: item.workspaceId,
    itemId: opts.itemId,
    itemType: opts.itemType,
    ...(opts.write ? {} : { allowReadRoles: true }),
    notFound: opts.notFound,
  });
  if (denied) return { item: null, denied };
  return { item, denied: null };
}
