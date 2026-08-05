/**
 * Shared workspace-scoped authorization guard for admin/workspaces/[id]/* BFF
 * routes.
 *
 * Many sibling routes (connections/route.ts, git/route.ts, networking/_gate.ts)
 * each re-implemented the same owner-or-admin check locally; several sub-routes
 * (connections/adls-accounts, connections/log-analytics-workspaces,
 * connections/[connId], spark/jobs, spark/runtime, task-flows,
 * task-flows/[flowId]) shipped with ONLY a bare `getSession()` check — so any
 * signed-in user could read/mutate another tenant's workspace resources by id.
 * This module is the single canonical guard.
 *
 * `authorizeWorkspace` allows the caller when they OWN the workspace
 * (self-service) OR are a tenant admin (org-wide management), and otherwise
 * returns a 404 (same not-found shape as the sibling git route — we do not leak
 * existence of workspaces the caller can't see). Use `requireWorkspace` to fold
 * in the 401 unauthenticated check in one call.
 */
import { NextResponse } from 'next/server';
import { getSession, type SessionPayload } from '@/lib/auth/session';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { workspacesContainer, itemsContainer } from '@/lib/azure/cosmos-client';
import { resolveWorkspaceAccessByOid } from '@/lib/auth/workspace-access';
import { loadWorkspaceAdmin } from '@/lib/clients/workspaces-client';
import { cosmosIdFromLoomId } from '@/app/api/items/_lib/loom-content-id';
import type { Workspace } from '@/lib/types/workspace';

/**
 * #2947 — `assertOwner(workspaceId, oid)` USED TO LIVE HERE AND IS DELIBERATELY
 * GONE. Do not re-add it, and do not re-inline its body.
 *
 * It was a partition point-read `workspacesContainer().item(workspaceId, oid)`.
 * The `workspaces` container is partitioned on `/tenantId` and `Workspace.tenantId`
 * stores the CREATOR's Entra oid, so a workspace document exists ONLY in its
 * creator's partition. The function could therefore only ever answer "did this
 * caller CREATE this workspace" — never "may this caller ACCESS it". A tenant
 * admin, a shared-ACL member, or any non-creator was refused, which is how two
 * live editors shipped broken (#2941 semantic-model, #2942 pipeline canvas).
 *
 * Use instead:
 *   {@link authorizeItemWorkspace} — item-scoped BFF routes (resolves the
 *      workspace FROM THE ITEM when the caller omits the param, so authorization
 *      cannot be skipped, and keeps the route's own 404 wording).
 *   {@link authorizeWorkspace}     — workspace-scoped routes.
 *   {@link resolveAdminWorkspace}  — when the handler needs the workspace DOC.
 * All three are read/write scoped: pass `{ allowReadRoles: true }` ONLY from a
 * strictly read-only handler.
 *
 * Guarded by scripts/ci/check-owner-only-workspace-guard.mjs, which fails on a
 * re-inlined owner-only workspace point-read anywhere in the console.
 */

/**
 * Resolve the OWNING WORKSPACE of an item by (id, itemType) — no authorization,
 * this only answers "which workspace does this item live in".
 *
 * Deliberately implemented here rather than reusing `_lib/item-crud.loadItemRaw`:
 * `item-crud` imports {@link authorizeWorkspace} from THIS module, so importing
 * it back would be a cycle. `cosmosIdFromLoomId` is a zero-dependency string
 * function (see `_lib/loom-content-id`), so applying it costs nothing and lets a
 * synthetic `loom:<cosmosItemId>` route id resolve like every other Cosmos
 * chokepoint (#2830).
 */
async function workspaceIdOfItem(itemId: string, itemType: string): Promise<string | null> {
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<{ workspaceId?: string }>({
      query: 'SELECT c.workspaceId FROM c WHERE c.id = @id AND c.itemType = @t',
      parameters: [
        { name: '@id', value: cosmosIdFromLoomId(itemId) },
        { name: '@t', value: itemType },
      ],
    })
    .fetchAll();
  return resources[0]?.workspaceId || null;
}

/**
 * Authorize an ITEM-scoped BFF route whose workspace arrives as an OPTIONAL
 * query/body param. Returns the route's own 404 response when denied, else null.
 *
 * THE TWO DEFECTS THIS CLOSES (#2941). Several per-item sub-routes shipped the
 * shape
 *
 *     if (workspaceId && !(await assertOwner(workspaceId, session.claims.oid)))
 *       return NextResponse.json({ ok:false, error:'<x> not found' }, { status:404 });
 *
 * which is wrong twice over:
 *
 *  1. WRONG GUARD — it breaks the feature. {@link assertOwner} is a partition
 *     point-read on the CALLER's own partition (the `workspaces` container is
 *     partitioned by `/tenantId`, and `Workspace.tenantId` stores the CREATOR's
 *     oid). It therefore answers "did this caller CREATE this workspace", not
 *     "may this caller ACCESS it". A tenant admin — or an ACL-shared member —
 *     who did not personally create the workspace is refused on a READ, so the
 *     semantic-model editor showed "Column metadata load failed — semantic model
 *     not found" for every model while `/api/cosmos-items/...` (which uses the
 *     ACL-aware resolver) returned 200 for the same caller.
 *     {@link authorizeWorkspace} is the canonical ladder: owner → tenant admin →
 *     shared-ACL member.
 *
 *  2. SKIPPABLE AUTHORIZATION — the `workspaceId &&` prefix made the check
 *     optional AT THE CALLER'S DISCRETION: drop the query param and no
 *     authorization ran at all. Same class as the #2723 broken-access-control
 *     fix. Here the workspace is instead resolved FROM THE ITEM when the param
 *     is absent, so authorization cannot be skipped by omitting a parameter.
 *
 * READ vs WRITE. Pass `{ allowReadRoles: true }` from a strictly read-only GET
 * so any workspace role admits the caller. Mutating handlers must NOT pass it —
 * they stay write-scoped (Owner/Admin/Member) so a read-only Viewer can never
 * mutate through a route that only "made the read work".
 *
 * 404-NOT-403 is preserved, using the ROUTE's own `notFound` wording, so this
 * neither leaks the existence of resources the caller can't see nor changes the
 * error string the editor already handles.
 *
 * The one path that proceeds unauthorized is `id` naming NO item of that type
 * anywhere in the estate: there is then no other tenant's resource to authorize,
 * and every remaining read/write in those handlers is partition-scoped to the
 * caller's own oid. That case is unreachable for any id that names a real item —
 * the lookup is a cross-partition query, not an owner-scoped one, so an item
 * belonging to a DIFFERENT tenant is still found and still refused.
 */
export async function authorizeItemWorkspace(
  session: SessionPayload,
  opts: {
    /** The caller-supplied workspace id (query param / body field), if any. */
    workspaceId?: string | null;
    /** Route `[id]` — used to resolve the workspace when the param is absent. */
    itemId: string;
    /** Cosmos `itemType` of the route's item family. */
    itemType: string;
    /** Read-only GET surfaces opt in; mutating handlers must not. */
    allowReadRoles?: boolean;
    /** The route's existing not-found wording (e.g. 'semantic model not found'). */
    notFound: string;
  },
): Promise<NextResponse | null> {
  let workspaceId = (opts.workspaceId || '').trim();
  if (!workspaceId) {
    workspaceId = (await workspaceIdOfItem(opts.itemId, opts.itemType)) || '';
    if (!workspaceId) return null; // no such item — nothing of another tenant's to gate
  }
  const denied = await authorizeWorkspace(session, workspaceId, {
    allowReadRoles: opts.allowReadRoles,
  });
  if (!denied) return null;
  return NextResponse.json({ ok: false, error: opts.notFound }, { status: 404 });
}

/**
 * Authorize a workspace-scoped request: OWNER (self-service) OR tenant ADMIN
 * (org-wide) OR a shared ACL member (rel-T11). Returns a 404 NextResponse when
 * none holds, else null.
 *
 * By DEFAULT this gates to WRITE-capable access (Owner/Admin/Member) because the
 * workspace sub-routes it protects are overwhelmingly config MUTATIONS — a
 * read-only Viewer/Contributor must never pass a mutation guard. Read-only
 * surfaces opt in via `{ allowReadRoles: true }`, which admits any workspace
 * role. The owner + tenant-admin fast-paths are unchanged, so the
 * single-operator estate behaves exactly as before.
 */
export async function authorizeWorkspace(
  session: SessionPayload,
  workspaceId: string,
  opts: { allowReadRoles?: boolean } = {},
): Promise<NextResponse | null> {
  if (isTenantAdmin(session)) return null;
  const access = await resolveWorkspaceAccessByOid(session.claims.oid, workspaceId, {
    groups: session.claims.groups,
    callerTid: session.claims.tid,
  });
  if (access && (opts.allowReadRoles || access.canWrite)) return null;
  return NextResponse.json({ ok: false, error: 'workspace not found' }, { status: 404 });
}

/**
 * One-call guard: resolves the session (401 when absent) then the workspace
 * owner-or-admin-or-ACL authorization (404 when denied). Returns `{ session }`
 * when authorized, else `{ resp }` carrying the response the handler should
 * return. Pass `{ allowReadRoles: true }` on read-only GET routes to admit
 * Viewer/Contributor members.
 */
export async function requireWorkspace(
  workspaceId: string,
  opts: { allowReadRoles?: boolean } = {},
): Promise<{ session: SessionPayload; resp?: undefined } | { session?: undefined; resp: NextResponse }> {
  const session = getSession();
  if (!session) {
    return { resp: NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 }) };
  }
  const denied = await authorizeWorkspace(session, workspaceId, opts);
  if (denied) return { resp: denied };
  return { session };
}

/**
 * Resolve the actual workspace DOCUMENT for an admin/workspaces/[id]/* route
 * that needs the doc (not just a yes/no authorization) — e.g. to PATCH it, read
 * its bound storage account, or cascade-delete it.
 *
 * The bug this fixes: the per-workspace admin routes used to point-read
 * `container.item(id, caller.oid)`, which only hits the CALLER's partition.
 * Because a workspace lives in its creator's partition (`tenantId === creator
 * oid`), a tenant admin opening a workspace they did NOT create got a spurious
 * 404 — the Settings flyout was broken for every workspace the admin didn't
 * personally own.
 *
 * Resolution order (owner-first, then admin fallback — never a blanket
 * cross-partition read):
 *   1. No session               → 401.
 *   2. Owner point-read on the caller's partition. Found → `via: 'owner'`. This
 *      is the UNCHANGED path for a non-admin owner acting on their own
 *      workspace, so no existing owner behavior is weakened.
 *   3. Not owned AND isTenantAdmin(session) → cross-partition `loadWorkspaceAdmin`.
 *      Found → `via: 'admin'`. This is the ONLY code path that reads across
 *      partitions, and it is gated on the tenant-admin check FIRST so a
 *      non-admin can never read/patch a workspace they don't own.
 *   4. Otherwise                → 404 (same not-found shape; we do not leak the
 *      existence of workspaces the caller can't see).
 *
 * Callers that must additionally restrict to admins ONLY (e.g. the networking
 * gate, or a destructive admin DELETE) check `isTenantAdmin(session)` themselves
 * after this resolves — `via` is returned so they can distinguish owner vs admin
 * access cheaply.
 */
export type AdminWorkspaceResolution =
  | { session: SessionPayload; ws: Workspace; via: 'owner' | 'admin'; resp?: undefined }
  | { session?: undefined; ws?: undefined; via?: undefined; resp: NextResponse };

export async function resolveAdminWorkspace(
  workspaceId: string,
): Promise<AdminWorkspaceResolution> {
  const session = getSession();
  if (!session) {
    return { resp: NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 }) };
  }

  // 1) Owner point-read on the caller's own partition (unchanged owner path).
  const c = await workspacesContainer();
  try {
    const { resource } = await c.item(workspaceId, session.claims.oid).read<Workspace>();
    if (resource && resource.tenantId === session.claims.oid) {
      return { session, ws: resource, via: 'owner' };
    }
  } catch (e: any) {
    if (e?.code !== 404) {
      return {
        resp: NextResponse.json(
          { ok: false, error: e?.message || 'workspace lookup failed' },
          { status: 500 },
        ),
      };
    }
    // 404 → not in the caller's partition; fall through to the admin fallback.
  }

  // 2) Admin-only cross-partition fallback (gated on the tenant-admin check).
  if (isTenantAdmin(session)) {
    try {
      const ws = await loadWorkspaceAdmin(workspaceId);
      if (ws) return { session, ws, via: 'admin' };
    } catch (e: any) {
      return {
        resp: NextResponse.json(
          { ok: false, error: e?.message || 'workspace lookup failed' },
          { status: 500 },
        ),
      };
    }
  }

  // 3) Not owned and not an admin (or admin but no such workspace) → 404.
  return { resp: NextResponse.json({ ok: false, error: 'workspace not found' }, { status: 404 }) };
}
