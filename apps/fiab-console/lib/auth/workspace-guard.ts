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
 * #3825 — `resolveWorkspaceAccessByOid` IS THE CANONICAL IMPLEMENTATION OF "MAY
 * THIS CALLER TOUCH THIS WORKSPACE", AND EVERY GUARD IN THIS MODULE DELEGATES THE
 * DECISION TO IT. Do not re-add a tenant-admin short-circuit here, in any form.
 *
 * THAT IS NOT THE SAME AS "there is exactly one implementation", which is what
 * this header used to claim and what an independent review counted wrong on
 * 2026-08-21. Six places in the console still answer some form of the question;
 * naming them is the point, because a header that overstates the invariant is
 * worse than no header — the next reader stops looking.
 *
 *   1. `workspace-access.ts` `resolveWorkspaceAccessByOid` — CANONICAL. Owner
 *      fast-path → workspace-roles ACL → `wsDoc.tid !== callerTid` → admin-open.
 *      Everything in THIS module routes through it.
 *   2. `workspace-access.ts` `listAccessibleWorkspaces` — the LIST shape, with its
 *      own `doc.tid !== callerTid` filter in the same module. Same author, same
 *      file, but a second copy of the comparison nonetheless.
 *   3. `workspace-role.ts` `resolveWorkspaceRole` / `findWorkspace` — an older,
 *      independent lookup carrying its OWN tid comparison rather than delegating.
 *      Tracked as **#3840**; also the cause of #3751.
 *   4. `item-access.ts` `resolveItemAccessByOid` — the ITEM-GRANT path is reached
 *      only after the resolver has denied, so it is a second grant with its own
 *      `wsDoc.tid !== tid` boundary. Pinned (condition, return AND the region
 *      between them) in `check-tid-boundary-chokepoint.mjs`.
 *   5. `resolveAdminWorkspace` below — the OWNER fast-path point-read
 *      (`resource.tenantId === session.claims.oid`) decides before the resolver
 *      runs. Sound because the read is partition-scoped to the caller, and pinned
 *      by position so that stays true.
 *   6. `authorizeItemWorkspace` below — `if (!workspaceId) return null` is an
 *      ALLOW the resolver never sees. Sound only because the id names no item
 *      anywhere in the estate; likewise pinned by position.
 *
 * 5 and 6 are pre-delegation ALLOWs inside this module and are held by
 * PROLOGUE_PINS; 4 is held by POST_DELEGATION_PINS; 2 and 3 are outside the
 * guard's model and are findings, not clearances. Consolidating 3 onto the
 * canonical resolver is #3840.
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
 * first. Copies of this decision are how #3823 and #3825 both happened; the six
 * that remain are enumerated above, each with what holds it.
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
 *
 * THAT `return null` IS THE ONLY ALLOW THIS FUNCTION IS PERMITTED TO DECIDE, and
 * `scripts/ci/check-tid-boundary-chokepoint.mjs` pins it BY POSITION: its entry
 * in PROLOGUE_PINS carries the whole prologue text — both assignments to
 * `workspaceId` and the ALLOW itself — so any edit above this line is a red
 * build until it is re-reviewed. Pinning the CONDITION text was not enough, and
 * that is measured, not anticipated: a review left `!workspaceId` byte-identical
 * and forged its INPUT one line up
 * (`workspaceId = opts.itemType === 'x' ? '' : (await workspaceIdOfItem(…)) || '';`),
 * producing a live cross-tenant ALLOW that never read a document at all, and a
 * SECOND `if (!workspaceId) return null;` elsewhere in the function inherited the
 * same exemption because the allowlist key was `<fn>:<condition>`.
 *
 * Every OTHER allow here must be IMPOSSIBLE while `authorizeWorkspace` refused —
 * the guard proves that by boolean implication over the path condition, not by
 * checking that the condition mentions `denied`. Mentioning it is not reading it:
 * on 2026-08-21 an independent review inserted ONE line at the top of this
 * function —
 *
 *     if (opts.itemType === 'lakehouse' && isTenantAdmin(session)) return null;
 *
 * — and it passed the ENTIRE verification stack (guard exit 0, the 27-test
 * #3825 spec green, the 259-test wide suite green) while granting a real
 * cross-tenant ALLOW for that one item type; the round-2 fix for it was then
 * defeated by `if (!denied || opts.itemType === 'lakehouse') return null;`,
 * which mentions the verdict and discards it. This is the 85-importer entry
 * point, and a bypass scoped to one `itemType` is invisible to a spec suite that
 * exercises a different one.
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
 * ONE SIDE EFFECT WORTH KNOWING, and the route inventory records it: because the
 * resolver's step 5 is `resolveEffectiveRole`, these admin-plane routes can now
 * transitively reach MICROSOFT GRAPH where before they touched Cosmos only.
 * `authorizeWorkspace` and `authorizeWorkspaceList` have always had this edge;
 * `resolveAdminWorkspace` now shares it, which is the cost of there being one
 * implementation. Regenerate `docs/fiab/route-inventory.md` when this changes.
 *
 * WHAT THAT EDGE IS AND IS NOT — stated to the precision it was MEASURED (R7).
 * Graph is consulted only when the workspace carries GROUP role assignments AND
 * the session supplied no `groups` claim (per #3175 that claim is frequently
 * absent, so this path is genuinely reachable).
 *
 *   NEVER ADMITTED, measured per cause. The MECHANISM is not uniform, and an
 *   earlier revision here — "a Graph token failure, a transport failure, a
 *   timeout, a 429, a 5xx, and a truncated membership walk all resolve to
 *   `'unknown'`" — was wrong for two of those six. Branches are named rather
 *   than cited by line number, because the line numbers this list used to carry
 *   went stale the first time the file was touched. What the code does:
 *     - a DIRECT-PROBE transport failure, the per-request timeout, and a
 *       truncated membership walk each answer `'unknown'`, which contributes no
 *       role (`graphUserInGroup`'s point-read catch; its `budget.truncatedBy`
 *       return);
 *     - a 429 on the direct probe answers `'unknown'` AND STOPS THERE. It used
 *       to fall THROUGH into the paged enumeration, which throttles too —
 *       measured `graphCalls=2` for one throttled probe, so these routes
 *       amplified a throttle instead of backing off, and no `Retry-After` was
 *       honoured anywhere. #3834 made the abort 429-only (a 403/5xx must still
 *       fall through — that is what the enumeration fallback exists for) and put
 *       the `Retry-After` interval in the log line;
 *     - a 5xx or other non-404 on the direct probe still falls through to the
 *       paged enumeration, and a non-ok enumeration page answers `'unknown'`;
 *     - a TRANSPORT failure DURING the paged fallback now answers `'unknown'`
 *       too. It used to ESCAPE: the enumeration loop sat OUTSIDE
 *       `graphUserInGroup`'s try/catch and `PagingBudget.runPage` rethrows
 *       everything that is not its own deadline, so an ECONNRESET on the
 *       fallback propagated out of this function as an uncaught throw — a deny
 *       by crashing, and an opaque 500 rather than the classified outcome
 *       `deploy-integrity.md` R6 wants. #3834 gave that loop its own catch;
 *     - a GRAPH TOKEN failure never reaches `graphUserInGroup` at all.
 *       `resolveEffectiveRole` catches it and returns `pickHighestRole(inherited)`,
 *       where `inherited` holds only the DIRECT (non-group) assignments — so no
 *       group role is granted and the refusal still holds, but it holds for a
 *       different reason than `'unknown'`.
 *   In every one of those the caller is REFUSED — never admitted. THAT is the
 *   property being asserted here; the uniform `'unknown'` mechanism the earlier
 *   sentence asserted is not one the code has, and per `deploy-integrity.md` R7
 *   a message must not state as fact something it did not establish.
 *
 *   THE TWO FAIL-OPEN RESIDUALS THIS COMMENT USED TO LIST ARE CLOSED, both in
 *   `lib/azure/workspace-roles-client.ts` and both #3834: `graphUserInGroup`
 *   reading a BARE `res.ok` as membership without inspecting the body, and a
 *   malformed enumeration page throwing a `TypeError`/`SyntaxError` out of this
 *   function instead of answering. Both were fixed in #3859 — a 2xx must now
 *   return the directoryObject identifying the principal we asked about, and a
 *   page whose `value` is not an array (or whose body is not JSON at all)
 *   resolves `'unknown'`. Noted rather than deleted because the condition behind
 *   them — something in FRONT of Graph answering 2xx, the #3381 shape — is the
 *   one a sovereign boundary is most exposed to.
 *
 * BOUNDED PER REQUEST, AND NOW IN AGGREGATE (#3834). Nothing on this path caches
 * (`cache: 'no-store'`; the only memo is request-scoped, because a module-level
 * one on an authorization path outlives the membership that justified it), so
 * every request pays the walk in full. A single probe is capped at the
 * per-request fetch ceiling and its paged fallback at a `PagingBudget` of 15s /
 * 50 pages. What was missing was the ceiling ABOVE those: `resolveEffectiveRole`
 * walked the GROUP assignments SEQUENTIALLY with no walk-wide clock, so the
 * worst case was `N_groups x ~45s` WITH NO ROUTE CEILING ABOVE IT — not one of
 * the 13 route files that call this function declares `export const
 * maxDuration`, while 69 other console routes do. (An earlier revision here
 * named "a route `maxDuration` of 60", a bound the code does not establish; it
 * UNDERSTATED the exposure, which is the direction `deploy-integrity.md` R7
 * exists to catch, and that statement about the 13 route files remains true
 * today.) The loop now runs under ONE `PagingBudget` whose default ceiling is
 * the single-request ceiling — so however many groups a workspace grants to,
 * resolving all of them can never out-live one Graph call — with each probe
 * handed the walk's REMAINING clock rather than a fresh one, and the paged
 * fallback taking the smaller of its own budget and that remainder. Override
 * with `LOOM_GRAPH_GROUP_WALK_BUDGET_MS`. A group the walk never reached
 * contributes no role: fail-closed in the same direction as `'unknown'`, and
 * `warnIfTruncated` names the deadline so a refusal caused by the clock is
 * diagnosable as one rather than read as "not a member".
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
