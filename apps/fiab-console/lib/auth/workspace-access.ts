/**
 * rel-T11 / B4 — multi-user workspace access resolver (the single chokepoint).
 *
 * BEFORE this module, "ownership" everywhere was `workspace.tenantId === oid`
 * where `tenantId` is the individual user's Entra `oid`. That made NOTHING
 * shareable: a second user in the SAME Entra tenant could not open a workspace
 * another user shared with them, because the workspace doc lives in the owner's
 * `oid` partition and every read compared against the caller's own `oid`.
 *
 * The `workspace-roles` container (system of record for the "Manage Access"
 * sharing UI, resolved by `resolveEffectiveRole`) already recorded who a
 * workspace is shared with — but no READ guard consulted it. This module wires
 * that ACL into the read path so a shared user resolves.
 *
 * ACCESS-RESOLUTION ALGORITHM (owner → ACL → tid boundary):
 *   1. OWNER fast-path — point-read the workspace on (id, callerOid). A hit
 *      means the caller owns it. This is byte-identical to the legacy check and
 *      runs FIRST, so the single-operator estate does ZERO new work (no ACL
 *      lookup, no Graph call) and behaves exactly as before.
 *   2. If `LOOM_MULTIUSER_ACL` is off, stop here (owner-only — legacy behavior,
 *      a one-env-flip kill switch).
 *   3. Resolve the workspace doc cross-partition (the caller is not its owner,
 *      so it is in a different partition). Missing → no access.
 *   4. tid BOUNDARY — when the caller's Entra tenant id (`callerTid`) is known
 *      AND the workspace doc records its owning `tid` (written going forward),
 *      they MUST match. This blocks any cross-tenant read. Legacy workspace docs
 *      predate the `tid` field; for those the explicit ACL grant below is itself
 *      the tenant boundary (a foreign principal can only get a workspace-role
 *      row if a workspace admin in the owning tenant explicitly added their oid,
 *      and the sharing UI's principal search is tenant-scoped).
 *
 *      #2703 — step 4 USED TO BE OPT-IN. `opts` was optional and `callerTid` was
 *      an optional field on it, so EVERY call site that did not hand the resolver
 *      a session silently skipped the boundary: the four `item-crud` calls that
 *      back `loadOwnedItem` / `listOwnedItems` / `listAllOwnedItems` (the Copilot
 *      `item_list` tool), and `ontology-resolver`. A security control that does
 *      nothing when an optional input is absent reads as enforced and is not —
 *      the same shape as #2683 / #2691 / #2607 / #2652. Two changes fix it:
 *        (a) {@link WorkspaceAccessOpts} is now REQUIRED and a discriminated
 *            union, so a call site must either supply `callerTid` or declare
 *            `skipTidBoundary: true` with a written reason. `tsc` — not review —
 *            is what stops the next caller from forgetting.
 *        (b) when `callerTid` is absent the resolver recovers it from the
 *            AMBIENT request session ({@link ambientCallerTid}) — the very same
 *            cookie the route already read — but ONLY when that session's `oid`
 *            equals the `oid` being resolved, so a helper resolving access on
 *            behalf of a different principal can never borrow the wrong tenant.
 *            That turns the boundary ON for every session-backed request through
 *            the session-less helpers, with no change at their 263 call sites.
 *   5. ACL — `resolveEffectiveRole` returns the caller's highest workspace role
 *      via direct + (nested) group membership. Non-null → access at that role.
 *
 * WRITE vs READ: `canWrite` is true only for Owner/Admin/Member (the roles that
 * map to Azure RBAC Contributor). Contributor/Viewer are read-only. Callers that
 * gate mutations MUST check `canWrite` (see loadOwnedItem + authorizeWorkspace),
 * so sharing can never escalate a read-only member into a writer.
 */
import { workspacesContainer, workspaceRolesContainer } from '@/lib/azure/cosmos-client';
import { resolveEffectiveRole } from '@/lib/azure/workspace-roles-client';
import type { WorkspaceRoleName } from '@/lib/azure/workspace-role-model';
import type { Workspace } from '@/lib/types/workspace';

/**
 * Master switch for the multi-user ACL read path. Default ON. Flip to `off` to
 * revert every read guard to owner-only (byte-identical legacy behavior) — the
 * owner fast-path is unaffected either way, so the single-operator estate is
 * safe regardless of the flag.
 */
export function multiUserAclEnabled(): boolean {
  return (process.env.LOOM_MULTIUSER_ACL ?? 'on').toLowerCase() !== 'off';
}

export type AccessRole = 'Owner' | WorkspaceRoleName;

/** Roles that may MUTATE workspace/item state (map to Azure RBAC Contributor). */
const WRITE_ROLES = new Set<AccessRole>(['Owner', 'Admin', 'Member']);

export function roleCanWrite(role: AccessRole): boolean {
  return WRITE_ROLES.has(role);
}

export interface WorkspaceAccess {
  /** The resolved workspace doc. */
  workspace: Workspace;
  /** How the caller is authorized. */
  role: AccessRole;
  /**
   * 'owner' = direct ownership; 'acl' = shared via a workspace-roles grant;
   * 'admin' = tenant admin opening a workspace they neither own nor are a
   * member of (the admin-open bypass — see `opts.tenantAdmin`).
   */
  via: 'owner' | 'acl' | 'admin';
  /** True when `role` may write (Owner/Admin/Member). */
  canWrite: boolean;
}

/** Cross-partition point-lookup of a workspace by id (bounded — single id). */
export async function readWorkspaceById(workspaceId: string): Promise<Workspace | null> {
  const ws = await workspacesContainer();
  const { resources } = await ws.items
    .query<Workspace>({
      query: 'SELECT * FROM c WHERE c.id = @id',
      parameters: [{ name: '@id', value: workspaceId }],
    })
    .fetchAll();
  return resources[0] ?? null;
}

/**
 * Options for {@link resolveWorkspaceAccessByOid} / {@link listAccessibleWorkspaces}.
 *
 * REQUIRED, and a DISCRIMINATED UNION, on purpose (#2703): the cross-tenant tid
 * boundary must not be skippable by omission. A caller either
 *
 *   - supplies `callerTid` (normally `session.claims.tid`) — the boundary is
 *     enforced. `undefined` is accepted because `UserClaims.tid` is optional;
 *     the resolver then recovers the tid from the ambient request session, so
 *     "I passed what the session had" still ends up enforcing; or
 *   - declares `skipTidBoundary: true` WITH a written `skipTidBoundaryReason`.
 *     That is the only way to switch the boundary off, it is greppable, and
 *     `scripts/ci/check-tid-boundary-chokepoint.mjs` pins the set of files
 *     allowed to use it.
 *
 * There is deliberately no default `{}` — adding a new call site that forgets
 * the tenant boundary is a COMPILE ERROR, not a silent hole.
 */
export type WorkspaceAccessOpts =
  | {
      /** The caller's Entra tenant id (`session.claims.tid`). */
      callerTid: string | undefined;
      /** Caller's transitive group ids — short-circuits the Graph membership probes. */
      groups?: string[];
      /** Admin-open bypass (see step 6). Callers compute it with `isTenantAdmin(session)`. */
      tenantAdmin?: boolean;
      skipTidBoundary?: never;
      skipTidBoundaryReason?: never;
    }
  | {
      /** Explicit, reviewed opt-out — this call site genuinely has no caller tenant. */
      skipTidBoundary: true;
      /** WHY there is no caller tenant here. Required so the opt-out is justified in code. */
      skipTidBoundaryReason: string;
      groups?: string[];
      tenantAdmin?: boolean;
      callerTid?: never;
    };

/**
 * Recover the caller's Entra tid from the AMBIENT request session when the call
 * site did not pass one (#2703).
 *
 * The session cookie is server-minted and encrypted, so this is not caller-
 * controlled input — it is the same value the route itself read a few frames up
 * the stack, just not threaded through the ~263 `loadOwnedItem` call sites.
 *
 * SAFETY: returns the tid ONLY when the ambient session's `oid` equals the `oid`
 * whose access is being resolved. A helper resolving access on behalf of some
 * other principal (a background reconcile, an admin acting for a user) therefore
 * gets `undefined` and behaves exactly as before, instead of silently
 * attributing the request-scoped tenant to a different principal.
 *
 * Imported lazily and wrapped: `getSession()` reaches for `next/headers`, which
 * throws outside a request scope (jobs, scripts, unit tests). Never throws.
 */
async function ambientCallerTid(oid: string): Promise<string | undefined> {
  try {
    const { getSession } = await import('@/lib/auth/session');
    const s = getSession();
    if (!s || s.claims.oid !== oid) return undefined;
    return s.claims.tid;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the effective caller tid for the boundary check: explicit → ambient.
 * Returns `undefined` when the call site explicitly opted out.
 */
async function effectiveCallerTid(oid: string, opts: WorkspaceAccessOpts): Promise<string | undefined> {
  if (opts.skipTidBoundary) return undefined;
  return opts.callerTid ?? (await ambientCallerTid(oid));
}

/**
 * Build the FULL access options — `callerTid` + `groups` + the tenant-admin
 * bypass — from the AMBIENT request session, for a helper that was handed only
 * an `oid` (#2941 / #2942).
 *
 * WHY THIS EXISTS. `ambientCallerTid` already recovers the tid for the ~263
 * oid-only call sites, but `tenantAdmin` had no equivalent — so any helper that
 * takes an oid instead of a session silently ran WITHOUT the admin-open bypass
 * (step 6). That is what broke the pipeline binder for a tenant admin
 * (`loadPipelineItem`, ~30 oid-only call sites): the admin resolved to no
 * access and the item read "not found in this tenant" even though the very same
 * item opened fine through `/api/cosmos-items`, which DOES pass a session.
 *
 * SAFETY: identical rule to {@link ambientCallerTid} — the ambient session is
 * used ONLY when its `oid` equals the `oid` whose access is being resolved, so
 * a helper resolving access on behalf of a different principal can never borrow
 * this request's admin status. Off-request (jobs, scripts, tests) `getSession()`
 * throws and we degrade to `{ callerTid: undefined }`, i.e. exactly the previous
 * behavior. Imports are dynamic so this module keeps its static dependency
 * graph (no session / feature-gate edge).
 */
export async function ambientAccessOptsFor(oid: string): Promise<WorkspaceAccessOpts> {
  try {
    const { getSession } = await import('@/lib/auth/session');
    const s = getSession();
    if (!s || s.claims.oid !== oid) return { callerTid: undefined };
    const { isTenantAdmin } = await import('@/lib/auth/feature-gate');
    return { callerTid: s.claims.tid, groups: s.claims.groups, tenantAdmin: isTenantAdmin(s) };
  } catch {
    return { callerTid: undefined };
  }
}

/**
 * Resolve the caller's access to a workspace from their Entra `oid` (the value
 * legacy code calls `tenantId`). Returns null when the caller neither owns the
 * workspace nor holds any ACL role on it (or the tid boundary rejects it).
 *
 * `opts.groups` short-circuits the per-group Graph membership checks when the
 * caller's transitive group set is already known (from the session claims).
 * `opts` is REQUIRED — see {@link WorkspaceAccessOpts}. The tid boundary (step 4)
 * runs against `opts.callerTid`, falling back to the ambient request session's
 * tid for the same principal, and is skipped ONLY when the call site declared
 * `skipTidBoundary`.
 *
 * `opts.tenantAdmin` is the ADMIN-OPEN bypass: a tenant admin (per
 * `isTenantAdmin`) must be able to open EVERY workspace in the tenant — the
 * /admin/workspaces inventory lists them all, so the open path must not 404 on
 * a workspace the admin neither owns nor is a member of. When set, and the
 * caller is neither owner nor ACL-member, the admin still resolves at role
 * `Admin` (via `'admin'`). Callers compute the flag with `isTenantAdmin(session)`
 * so this module stays free of session/feature-gate imports. The owner and ACL
 * fast-paths still run FIRST, so a non-admin caller is unaffected and an admin
 * who happens to own/member a workspace keeps their real role.
 */
export async function resolveWorkspaceAccessByOid(
  oid: string,
  workspaceId: string,
  opts: WorkspaceAccessOpts,
): Promise<WorkspaceAccess | null> {
  const ws = await workspacesContainer();

  // 1) OWNER fast-path — identical to the legacy owner check; no ACL/Graph work.
  try {
    const { resource } = await ws.item(workspaceId, oid).read<Workspace>();
    if (resource && resource.tenantId === oid) {
      return { workspace: resource, role: 'Owner', via: 'owner', canWrite: true };
    }
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }

  // 2) Flag off → owner-only (legacy). Kill switch for the ACL read path.
  if (!multiUserAclEnabled()) return null;

  // 3) The caller is not the owner — locate the workspace in its own partition.
  const wsDoc = await readWorkspaceById(workspaceId);
  if (!wsDoc) return null;

  // 4) tid boundary — reject a cross-tenant read when both sides record a tid.
  // The caller tid is the one the call site passed, or (when it had no session
  // to pass) the ambient request session's, for the SAME principal (#2703).
  const callerTid = await effectiveCallerTid(oid, opts);
  if (callerTid && wsDoc.tid && wsDoc.tid !== callerTid) return null;

  // 5) ACL — highest workspace role via direct + (nested) group membership.
  const role = await resolveEffectiveRole(oid, workspaceId, { userGroupIds: opts.groups });
  if (role) return { workspace: wsDoc, role, via: 'acl', canWrite: WRITE_ROLES.has(role) };

  // 6) ADMIN-OPEN bypass — no ownership, no ACL role, but the caller is a tenant
  // admin: grant access so an admin can open every workspace in the tenant. The
  // tid boundary above already scoped this to the admin's own tenant. Placed
  // AFTER the ACL lookup so an admin who is also an explicit member keeps that
  // (possibly higher-fidelity) role; only a pure non-member admin lands here.
  if (opts.tenantAdmin) {
    return { workspace: wsDoc, role: 'Admin', via: 'admin', canWrite: true };
  }

  return null;
}

/**
 * List the workspaces a user can see: the ones they OWN (partition read) PLUS
 * the ones directly shared with them via a `workspace-roles` grant (rel-T11).
 * Feeds the "my workspaces" list so a shared workspace is discoverable, not just
 * reachable by deep link.
 *
 * Shared discovery uses DIRECT user assignments only (a user added by the
 * sharing UI). Group-shared workspaces still resolve on open (guard /
 * loadOwnedItem run `resolveEffectiveRole` with the caller's groups) but are not
 * enumerated here — surfacing every group-shared workspace in the list would
 * cost a Graph membership probe per group per request. With the ACL flag off
 * this returns owned-only (byte-identical legacy behavior).
 *
 * `opts` is REQUIRED for the same reason as {@link resolveWorkspaceAccessByOid}
 * (#2703): this list applies the identical tid boundary to each shared doc, and
 * an omitted `callerTid` used to switch it off silently.
 */
export async function listAccessibleWorkspaces(
  oid: string,
  opts: WorkspaceAccessOpts,
): Promise<Workspace[]> {
  const ws = await workspacesContainer();
  const { resources: owned } = await ws.items
    .query<Workspace>(
      {
        query: 'SELECT * FROM c WHERE c.tenantId = @t ORDER BY c.createdAt DESC',
        parameters: [{ name: '@t', value: oid }],
      },
      { partitionKey: oid },
    )
    .fetchAll();

  if (!multiUserAclEnabled()) return owned;

  // Direct (non-group) workspace-role assignments for this user (cross-partition).
  const roles = await workspaceRolesContainer();
  const { resources: assignments } = await roles.items
    .query<{ workspaceId: string }>({
      query: "SELECT c.workspaceId FROM c WHERE c.principalId = @p AND c.principalType != 'Group'",
      parameters: [{ name: '@p', value: oid }],
    })
    .fetchAll();

  const ownedIds = new Set(owned.map((w) => w.id));
  const sharedIds = [...new Set(assignments.map((a) => a.workspaceId))].filter((id) => !ownedIds.has(id));
  if (sharedIds.length === 0) return owned;
  const callerTid = await effectiveCallerTid(oid, opts);
  const shared: Workspace[] = [];
  for (const id of sharedIds) {
    const doc = await readWorkspaceById(id);
    if (!doc) continue;
    if (callerTid && doc.tid && doc.tid !== callerTid) continue; // tid boundary
    shared.push(doc);
  }
  return [...owned, ...shared];
}
