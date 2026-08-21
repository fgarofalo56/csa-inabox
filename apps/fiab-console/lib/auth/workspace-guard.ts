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
 *
 * #3825 — THERE IS EXACTLY ONE IMPLEMENTATION OF "MAY THIS CALLER TOUCH THIS
 * WORKSPACE", AND IT IS `resolveWorkspaceAccessByOid`. Every guard in this
 * module delegates the decision to it. Do not re-add a tenant-admin
 * short-circuit here, in any form.
 *
 * What that replaced: `authorizeWorkspace` opened with
 *
 *     if (isTenantAdmin(session)) return null;   // null == AUTHORIZED
 *
 * — returning BEFORE any Cosmos read, so for a tenant admin there was no
 * workspace document, no `tid`, and nothing to compare. That is strictly worse
 * than the hole #3824 closed in the resolver's step 6: that one at least
 * performed a comparison (which merely skipped itself when a `tid` was absent);
 * this performed none at all. Measured on the tree WITH #3824 applied, with both
 * tids present and DIFFERENT — the case the repaired resolver correctly refuses:
 *
 *     authorizeWorkspace     -> ALLOWED (null) | resolver consulted = 0
 *     resolveAdminWorkspace  -> ALLOWED via=admin tid=<the OTHER tenant>
 *     CONTROL: a NON-admin is refused by both
 *
 * `resolveAdminWorkspace` had the same shape one level down (`isTenantAdmin`
 * then an unfiltered cross-partition `SELECT *` via `loadWorkspaceAdmin`), and
 * `authorizeWorkspace` never passed `tenantAdmin` into the resolver at all — so
 * the plumbing that lets the repaired boundary decide was only half-wired.
 *
 * WHY DELEGATION AND NOT AN INLINE FAST PATH. Keeping a short-circuit "for
 * performance" would require the same POSITIVE match inline
 * (`callerTid && wsDoc.tid && wsDoc.tid === callerTid`), which means loading the
 * workspace doc — i.e. most of the cost of simply calling the resolver, in
 * exchange for a second copy of the tenant decision that can drift from the
 * first. Four copies of this decision is how #3823 and #3825 both happened.
 *
 * THE TRADE THIS MAKES, STATED PLAINLY. A tenant admin acting on a LEGACY
 * `tid`-less workspace doc (or holding a session minted without a `tid` claim)
 * is now REFUSED where they previously succeeded. That refusal is deliberate,
 * and it is not silent: the resolver's `diag` channel carries an honest reason +
 * the `scripts/csa-loom/backfill-workspace-tid.mjs` remediation, which these
 * guards render as a 409 `tenant_unconfirmed` (see `workspaceDenialResponse`)
 * instead of a bare 404 that would read as "you have nothing". OWNER and ACL
 * access are untouched by all of this — neither depends on the tenant bypass,
 * and both still resolve with no `tid` on either side.
 */
import { NextResponse } from 'next/server';
import { getSession, type SessionPayload } from '@/lib/auth/session';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { workspacesContainer, itemsContainer } from '@/lib/azure/cosmos-client';
import {
  resolveWorkspaceAccessByOid,
  type WorkspaceAccessDiagnostics,
} from '@/lib/auth/workspace-access';
import { workspaceDenialResponse } from '@/lib/auth/workspace-denial';
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
  // #3825 — keep the ROUTE's own 404 wording for an ORDINARY refusal (that is
  // what the editors already handle), but never flatten a tenancy REFUSAL into
  // it: "semantic model not found" would be a false statement about a workspace
  // Loom read and an admin who really is an admin. `diag` distinguishes the two;
  // it is populated only when the resolver refused a grant worth explaining.
  const diag: WorkspaceAccessDiagnostics = {};
  const denied = await authorizeWorkspace(
    session,
    workspaceId,
    { allowReadRoles: opts.allowReadRoles },
    diag,
  );
  if (!denied) return null;
  return (
    workspaceDenialResponse(diag) ??
    NextResponse.json({ ok: false, error: opts.notFound }, { status: 404 })
  );
}

/**
 * Authorize a workspace-scoped request: OWNER (self-service) OR tenant ADMIN
 * (org-wide) OR a shared ACL member (rel-T11). Returns a response when none
 * holds, else null.
 *
 * By DEFAULT this gates to WRITE-capable access (Owner/Admin/Member) because the
 * workspace sub-routes it protects are overwhelmingly config MUTATIONS — a
 * read-only Viewer/Contributor must never pass a mutation guard. Read-only
 * surfaces opt in via `{ allowReadRoles: true }`, which admits any workspace
 * role. The owner fast-path is unchanged, so the single-operator estate behaves
 * exactly as before.
 *
 * #3825 — THE TENANT-ADMIN VERDICT IS THE RESOLVER'S, NOT THIS FUNCTION'S. The
 * admin flag is COMPUTED here (`isTenantAdmin`) and PASSED DOWN; it is never
 * acted on here. That is the whole fix: the module header records what the
 * short-circuit above this line used to allow.
 *
 * Two denial shapes, deliberately different:
 *   - 404 `workspace not found` — the ordinary "this caller holds no role on
 *     this workspace" (or holds a read-only one on a write surface). Unchanged,
 *     and it still does not leak the existence of workspaces the caller can't
 *     see.
 *   - 409 `tenant_unconfirmed` — the resolver REFUSED a tenant-admin grant it
 *     would otherwise have made, because it could not confirm the workspace is
 *     in the admin's own tenant. Rendering that as a 404 would be a false
 *     statement (the doc was read, the admin rights are real), which is what
 *     `deploy-integrity.md` R7 forbids.
 *
 * `diag` is an OPTIONAL out-channel for a caller that wants the structured
 * reason as well as the response — `authorizeItemWorkspace` uses it to keep the
 * ROUTE's own 404 wording for an ordinary refusal while still surfacing the
 * honest 409 for a tenancy refusal. Added as a fourth optional parameter so all
 * existing call sites stay byte-identical (the same reason #3823 gave the
 * resolver an out-param instead of widening its return type).
 */
export async function authorizeWorkspace(
  session: SessionPayload,
  workspaceId: string,
  opts: { allowReadRoles?: boolean } = {},
  diag: WorkspaceAccessDiagnostics = {},
): Promise<NextResponse | null> {
  const access = await resolveWorkspaceAccessByOid(
    session.claims.oid,
    workspaceId,
    {
      groups: session.claims.groups,
      callerTid: session.claims.tid,
      // The admin-open bypass. Computed here, DECIDED in the resolver (step 6),
      // which grants only on a POSITIVE tenant match (#3823).
      tenantAdmin: isTenantAdmin(session),
    },
    diag,
  );
  if (access && (opts.allowReadRoles || access.canWrite)) return null;
  return (
    workspaceDenialResponse(diag) ??
    NextResponse.json({ ok: false, error: 'workspace not found' }, { status: 404 })
  );
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
 *   3. Not owned AND isTenantAdmin(session) → the SHARED resolver decides
 *      (#3825). Found → `via: 'admin'`.
 *   4. Otherwise                → 404, or the honest 409 when the resolver
 *      refused a grant because the workspace's tenancy is unconfirmed.
 *
 * #3825 — STEP 3 USED TO BE `isTenantAdmin(session)` FOLLOWED BY AN UNFILTERED
 * CROSS-PARTITION `SELECT *` (`loadWorkspaceAdmin`), with no tenant comparison
 * anywhere between the flag and the document. Measured, both tids present and
 * DIFFERENT: `ALLOWED via=admin tid=<the OTHER tenant>`. It now calls
 * `resolveWorkspaceAccessByOid` — the same chokepoint `authorizeWorkspace` uses
 * — so the tenant decision has ONE implementation. `loadWorkspaceAdmin` is no
 * longer reached from this module (the resolver's own `readWorkspaceById` is the
 * identical query, and its result is now SUBJECTED to the boundary rather than
 * returned past it).
 *
 * THE `isTenantAdmin` GATE STAYS IN FRONT, and that is load-bearing: without it
 * this function would newly admit a shared-ACL Member to the admin plane
 * (`/git`, `/cmk`, `/identity`, `/networking`, `/storage-metrics`), which it has
 * never granted. Inside the gate every non-null verdict is accepted — the caller
 * is a tenant admin either way, so an admin who ALSO holds an explicit ACL role
 * keeps resolving exactly as before. Net effect versus the previous code:
 * strictly TIGHTER (an unconfirmed tenancy is refused), never wider. `via` is
 * reported as `'admin'` for any non-owner verdict, preserving the
 * `via === 'owner'` distinction the 13 call sites branch on.
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

  // 2) Admin-only fallback. The tenant-admin GATE stays here (it decides who may
  //    reach the admin plane at all); the tenant BOUNDARY is the resolver's.
  if (isTenantAdmin(session)) {
    const diag: WorkspaceAccessDiagnostics = {};
    try {
      const access = await resolveWorkspaceAccessByOid(
        session.claims.oid,
        workspaceId,
        {
          groups: session.claims.groups,
          callerTid: session.claims.tid,
          tenantAdmin: true,
        },
        diag,
      );
      // Any non-null verdict: the caller is already known to be a tenant admin,
      // so accepting an owner/ACL resolution here cannot widen who gets in — it
      // only avoids refusing an admin who ALSO holds an explicit role.
      if (access) {
        return { session, ws: access.workspace, via: access.via === 'owner' ? 'owner' : 'admin' };
      }
    } catch (e: any) {
      return {
        resp: NextResponse.json(
          { ok: false, error: e?.message || 'workspace lookup failed' },
          { status: 500 },
        ),
      };
    }
    // A tenancy REFUSAL is not an absence — say which it was (R7).
    const denial = workspaceDenialResponse(diag);
    if (denial) return { resp: denial };
  }

  // 3) Not owned and not an admin (or admin but no such workspace) → 404.
  return { resp: NextResponse.json({ ok: false, error: 'workspace not found' }, { status: 404 }) };
}
