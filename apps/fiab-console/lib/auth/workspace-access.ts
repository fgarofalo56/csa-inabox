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
 *   4. tid BOUNDARY — the workspace must be POSITIVELY CONFIRMED to be in the
 *      caller's own Entra tenant (`sameTenantConfirmed`, the one implementation
 *      of this comparison — `lib/auth/tenant-boundary.ts`). An absent tid on
 *      EITHER side is `unconfirmed`, and unconfirmed is a REFUSAL, not a
 *      fall-through. This blocks any cross-tenant read and, since #3840, any
 *      unconfirmed one.
 *
 *      #3840 — WHAT THIS REPLACED, AND WHY IT HAD TO GO. Step 4 used to read
 *      `if (callerTid && wsDoc.tid && wsDoc.tid !== callerTid) return null`,
 *      truthiness-guarded on BOTH sides, so it decided NOTHING whenever either
 *      tid was absent. The comment that used to sit here argued the ACL grant
 *      below was itself the tenant boundary for legacy docs — "a foreign
 *      principal can only get a workspace-role row if a workspace admin in the
 *      owning tenant explicitly added their oid". That is an argument about how
 *      rows are USUALLY created, not an invariant the code enforces, and it
 *      says nothing at all about step 6, which has no grant underneath it.
 *
 *      #3845 IS WHY THIS WAS NOT THEORETICAL. Both absences are documented,
 *      supported states — a workspace doc created before rel-T11 carries no
 *      `tid` (`lib/types/workspace.ts`; the
 *      `scripts/csa-loom/backfill-workspace-tid.mjs` backfill is manual and
 *      dry-run-by-default), and `UserClaims.tid` is optional by design
 *      (`lib/auth/msal.ts`, `lib/auth/pat.ts`) — but the caller-side absence
 *      also had a LIVE GENERATOR: the CLI's service-principal login minted
 *      EVERY session with no `tid` while its device-code sibling stamped one.
 *      So the population of tid-less callers was not a shrinking legacy tail,
 *      it was being refilled on every CI login. Fixing this boundary without
 *      fixing that generator would have left it refilling; fixing the generator
 *      without fixing this boundary would have left every pre-existing session
 *      exploitable. They land together.
 *
 *      #2703 — step 4 USED TO BE OPT-IN, which is a different failure of the
 *      same boundary and is why it is recorded here rather than in a changelog.
 *      `opts` was optional and `callerTid` was
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
 *
 *   5. ACL — `resolveEffectiveRole` returns the caller's highest workspace role
 *      via direct + (nested) group membership. Non-null → access at that role.
 *   6. ADMIN-OPEN bypass — a tenant admin may open a workspace they neither own
 *      nor hold a role on. Requires the same positive match (#3823), which
 *      step 4 now guarantees before this line is reached.
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
import { logSafe } from '@/lib/util/log-safe';
import { sameTenantConfirmed, tenantUnconfirmedCause } from './tenant-boundary';

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
      /**
       * Explicit, reviewed opt-out — this call site genuinely has no caller
       * tenant.
       *
       * #3840 — IT NO LONGER GRANTS ANYTHING ON THE SHARED-READ PATH. It
       * suppresses the ambient-session recovery, so no caller tid is available,
       * so `sameTenantConfirmed` cannot be true and step 4 REFUSES. Under the
       * old truthiness-guarded boundary this fell THROUGH to the ACL and admin
       * grants, which is precisely the shape #3823/#3840 exist to delete: "I
       * have no caller tenant" must not also mean "grant as if I did". Nothing
       * regresses today — `SKIP_ALLOWLIST` in
       * `scripts/ci/check-tid-boundary-chokepoint.mjs` is EMPTY, so there is no
       * production caller, and adding one is already a security review. Read
       * this arm as "do not go looking for an ambient tenant", NOT as "skip the
       * boundary".
       */
      skipTidBoundary: true;
      /** WHY there is no caller tenant here. Required so the opt-out is justified in code. */
      skipTidBoundaryReason: string;
      groups?: string[];
      tenantAdmin?: boolean;
      callerTid?: never;
    };

/**
 * The reason the resolver REFUSED a grant it would otherwise have made.
 *
 * #3823 — a denial must not read as "you have nothing". `resolveWorkspaceAccessByOid`
 * returns `null` for two very different situations: the ordinary "this caller
 * holds no role here" (no denial is recorded — nothing to explain), and the
 * tenant-admin bypass being refused because the workspace's tenant could not be
 * CONFIRMED. The second one is a state the operator can act on, and per
 * `deploy-integrity.md` R7 the message must state what was actually
 * established — that the tenancy is unconfirmed — never that the workspace is
 * missing or that the admin lacks rights.
 */
export interface WorkspaceAccessDenial {
  /** Stable code for routes/UI to branch on. */
  code: 'tenant_unconfirmed';
  /** WHAT WAS ESTABLISHED — true as written, no inferred cause (R7). */
  reason: string;
  /** The concrete action that resolves it. */
  remediation: string;
  /** The workspace whose tenancy could not be confirmed. */
  workspaceId: string;
}

/**
 * OPTIONAL out-channel for {@link resolveWorkspaceAccessByOid}.
 *
 * WHY AN OUT-PARAM AND NOT A UNION RETURN. `resolveWorkspaceAccessByOid` has
 * ~270 call sites reached through `loadOwnedItem` / `listOwnedItems` /
 * `authorizeWorkspaceList` / `resolveItemAccessByOid`; widening its return type
 * would touch every one of them for a signal almost none of them surface. A
 * fourth, optional argument keeps ONE decision path (so the explanation can
 * never drift from the verdict — there is no second function re-deriving it)
 * while leaving every existing call site byte-identical. Routes that render a
 * user-facing refusal pass a `{}` and read `denial` after a null.
 *
 * The refusal is ALSO logged server-side, so it is never silent even for the
 * call sites that pass nothing.
 */
export interface WorkspaceAccessDiagnostics {
  /** Populated ONLY when a grant was refused for a reason worth explaining. */
  denial?: WorkspaceAccessDenial;
}

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
 * `Admin` (via `'admin'`) — but ONLY when the workspace is POSITIVELY CONFIRMED
 * to be in the admin's own tenant (#3823; see step 6). Callers compute the flag
 * with `isTenantAdmin(session)` so this module stays free of session/feature-gate
 * imports. The owner and ACL fast-paths still run FIRST, so a non-admin caller
 * is unaffected and an admin who happens to own/member a workspace keeps their
 * real role — neither of those paths is affected by the #3823 tightening.
 *
 * Pass `diag` ({@link WorkspaceAccessDiagnostics}) to receive the REASON for a
 * refusal the caller should explain to the user rather than render as "not
 * found". Optional: the refusal is logged server-side either way.
 */
export async function resolveWorkspaceAccessByOid(
  oid: string,
  workspaceId: string,
  opts: WorkspaceAccessOpts,
  diag?: WorkspaceAccessDiagnostics,
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

  // 4) tid boundary — a POSITIVE tenant match, not merely a non-contradiction.
  // The caller tid is the one the call site passed, or (when it had no session
  // to pass) the ambient request session's, for the SAME principal (#2703).
  //
  // #3840 — THIS USED TO BE `callerTid && wsDoc.tid && wsDoc.tid !== callerTid`,
  // the truthiness-guarded shape this whole module's header condemns. It is a
  // NON-CONTRADICTION test: it decides NOTHING when either side is absent and
  // falls through to step 5 (the ACL) and step 6 (the admin bypass). Both
  // absences are documented, supported states, and #3845 proved the caller-side
  // one had a LIVE GENERATOR — `app/api/auth/cli-session/route.ts` minted every
  // service-principal session with no `tid` at all, while its device-code
  // sibling stamped one. So a tid-less session plus ANY `workspace-roles` row
  // resolved here as `via:'acl'` on a workspace whose tenancy Loom had never
  // established, and `role-assignments/route.ts` then granted a tenant admin
  // full member management on it (#3826). Step 6 was tightened by #3823; this
  // is the same tightening applied to the shared boundary that guards BOTH the
  // ACL path and the admin path.
  //
  // THE COMPARISON IS NOT WRITTEN HERE. `sameTenantConfirmed` is the one
  // implementation (`lib/auth/tenant-boundary.ts`); a fifth private copy is
  // exactly what produced #3823, #3825, #3840 and #3843.
  //
  // `skipTidBoundary` NOW FAILS CLOSED, and that is a deliberate, stated change.
  // It suppresses the ambient-session recovery, so the caller tid is absent, so
  // no positive match is possible and this refuses. Under the old truthiness
  // shape it fell THROUGH instead. Nothing regresses today — the guard's
  // SKIP_ALLOWLIST is empty and adding an entry is already a security review —
  // and the new reading is the consistent one: "I have no caller tenant" cannot
  // also mean "grant as if I did". See {@link WorkspaceAccessOpts}.
  const callerTid = await effectiveCallerTid(oid, opts);
  if (!sameTenantConfirmed(callerTid, wsDoc.tid)) {
    // A refusal, not an absence — and the two causes are NOT the same event.
    // `tenantUnconfirmedCause` is non-null ONLY for `unconfirmed`; a positively
    // measured DIFFERENT tenant returns null here and is reported by the caller
    // in its own words, never by leaking which other tenant owns the record.
    // No operator is written on either side: the discrimination is a CALL into
    // the shared module, so this cannot drift from the verdict above it.
    //
    // THE DIAGNOSTIC IS SCOPED TO TENANT ADMINS, AND THAT IS A DISCLOSURE
    // BOUNDARY, NOT A STYLE CHOICE. `tenant_unconfirmed` is a statement that a
    // workspace with this id EXISTS and is unstamped; to a caller with no claim
    // on it that is an existence oracle over a caller-supplied id. Step 6 has
    // always recorded its denial only on the admin path for this reason, and
    // `bulk-delete/__tests__/bulk-delete-tenant-boundary.test.ts` ("never leaks
    // tenant_unconfirmed to a NON-admin") pins it. An earlier draft of this
    // change recorded the denial for EVERY caller and that spec failed it —
    // a real regression, caught by an existing test rather than by review.
    // Everyone else gets a silent `null`, which the routes render as 404.
    // The operator still sees the cause: the server-side warn is unconditional.
    const cause = tenantUnconfirmedCause(callerTid, wsDoc.tid);
    if (cause) {
      const denial = tenantUnconfirmedDenial(workspaceId, callerTid, wsDoc.tid);
      if (diag && opts.tenantAdmin) diag.denial = denial;
      console.warn(
        '[workspace-access] access REFUSED at the tid boundary — workspace tenancy unconfirmed (#3840).',
        {
          workspaceId: logSafe(workspaceId),
          callerTidPresent: Boolean(callerTid),
          workspaceTidPresent: Boolean(wsDoc.tid),
          tenantAdmin: Boolean(opts.tenantAdmin),
          remediation: denial.remediation,
        },
      );
    }
    return null;
  }

  // 5) ACL — highest workspace role via direct + (nested) group membership.
  const role = await resolveEffectiveRole(oid, workspaceId, { userGroupIds: opts.groups });
  if (role) return { workspace: wsDoc, role, via: 'acl', canWrite: WRITE_ROLES.has(role) };

  // 6) ADMIN-OPEN bypass — no ownership, no ACL role, but the caller is a tenant
  // admin: grant access so an admin can open every workspace in the tenant.
  // Placed AFTER the ACL lookup so an admin who is also an explicit member keeps
  // that (possibly higher-fidelity) role; only a pure non-member admin lands here.
  //
  // #3823 — THIS REQUIRES A POSITIVE TENANT MATCH, NOT MERELY A NON-CONTRADICTION.
  // Step 4 above is the shared boundary and is truthiness-guarded on both sides,
  // which is correct for the ACL path (an explicit workspace-role row IS the
  // tenant boundary there — a foreign principal only gets one if an admin in the
  // owning tenant added their oid). Step 6 has no such grant underneath it: it
  // manufactures `role:'Admin', canWrite:true` out of the admin flag alone. So a
  // boundary that decides NOTHING when either tid is absent left this open in
  // two documented, supported states — a pre-rel-T11 workspace doc with no
  // `tid`, and a pre-rel-T11 session (or PAT) with no `tid` claim. Both are
  // reachable today. The admin bypass therefore fires ONLY when Loom can show
  // the workspace is in the admin's OWN tenant.
  // #3840 — SINCE STEP 4 NOW REQUIRES A POSITIVE MATCH, THIS CHECK IS REDUNDANT
  // BY CONSTRUCTION: reaching this line already means `sameTenantConfirmed` was
  // true, so the condition below cannot be false and the refusal branch under it
  // is currently unreachable. It is KEPT, deliberately, as a fail-closed
  // backstop — this is the single grant in the resolver that manufactures
  // `role:'Admin', canWrite:true` out of a flag rather than out of a stored
  // grant, and #3823 is what it looks like when the only thing in front of it
  // stops deciding. If step 4 is ever loosened again, this line is what keeps
  // the admin bypass shut, and its `else` becomes live again rather than the
  // bypass becoming silent. Retained also because it is pinned by expression
  // text in `scripts/ci/check-tid-boundary-chokepoint.mjs`.
  if (opts.tenantAdmin) {
    if (callerTid && wsDoc.tid && wsDoc.tid === callerTid) {
      return { workspace: wsDoc, role: 'Admin', via: 'admin', canWrite: true };
    }
    // A refusal, not an absence. Say what was actually established (R7).
    const denial = tenantUnconfirmedDenial(workspaceId, callerTid, wsDoc.tid);
    if (diag) diag.denial = denial;
    console.warn(
      '[workspace-access] tenant-admin grant REFUSED — workspace tenancy unconfirmed (#3823).',
      {
        workspaceId: logSafe(workspaceId),
        callerTidPresent: Boolean(callerTid),
        workspaceTidPresent: Boolean(wsDoc.tid),
        remediation: denial.remediation,
      },
    );
    return null;
  }

  return null;
}

/**
 * Build the honest explanation for a refused tenant-admin grant.
 *
 * Per `deploy-integrity.md` R7 every clause here is something the resolver
 * ESTABLISHED. It never says the workspace is missing (it was read), never says
 * the caller lacks admin (they have it), and never asserts the workspace belongs
 * to another tenant (that is precisely what could not be determined). The two
 * causes are reported independently because they have different fixes and both
 * can hold at once.
 */
function tenantUnconfirmedDenial(
  workspaceId: string,
  callerTid: string | undefined,
  workspaceTid: string | undefined,
): WorkspaceAccessDenial {
  const causes: string[] = [];
  const fixes: string[] = [];
  if (!workspaceTid) {
    causes.push(
      'this workspace record does not record which Entra tenant it belongs to ' +
        '(its `tid` field is absent — workspaces created before rel-T11 were not stamped)',
    );
    fixes.push(
      'Stamp the tenant onto the legacy workspace records: run ' +
        '`node scripts/csa-loom/backfill-workspace-tid.mjs` to see what it would change ' +
        '(it is DRY-RUN by default), then re-run it with `--apply` to write, and reopen ' +
        'this workspace.',
    );
  }
  if (!callerTid) {
    causes.push(
      'your sign-in session does not carry a tenant (`tid`) claim — sessions minted ' +
        'before rel-T11, and personal access tokens issued without `createdByTid`, do not have one',
    );
    fixes.push(
      'Sign out and sign in again to mint a session that carries `tid`. If you are ' +
        'calling with a personal access token, reissue it — tokens created before rel-T11 ' +
        'carry no tenant.',
    );
  }
  if (causes.length === 0) {
    // Both tids present but unequal is caught by step 4 and never reaches here.
    // Keep the branch honest rather than emitting a claim we cannot support.
    causes.push('the workspace could not be confirmed to belong to your Entra tenant');
    fixes.push('Report this with the workspace id — the tenant comparison reached an unexpected state.');
  }
  return {
    code: 'tenant_unconfirmed',
    reason:
      'Your tenant-admin access to this workspace was refused because Loom could not confirm ' +
      `the workspace belongs to your Entra tenant: ${causes.join('; and ')}. ` +
      'This is NOT a statement that the workspace is missing, or that it belongs to someone ' +
      'else — the tenancy is simply unverified, and Loom will not grant tenant-wide admin on ' +
      'an unverified tenancy. Owner access and any explicit share (Manage access) on this ' +
      'workspace are unaffected.',
    remediation: fixes.join(' '),
    workspaceId,
  };
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
    // #3885 — THE SAME POSITIVE MATCH AS STEP 4, and for the same reason. This
    // was the LAST executable copy of the truthiness-guarded shape in the
    // console (`callerTid && doc.tid && doc.tid !== callerTid`), and it is the
    // worst-behaved of the family: the resolver's copy narrowed a decision, but
    // this one FILTERS A SET, so a tid-less caller was not handed a wider
    // answer — they were handed NO FILTERING AT ALL, i.e. every workspace any
    // `workspace-roles` row named them on, across every tenant. It fed
    // `app/api/items/by-type`, `app/api/workspaces`, `running-workloads` and
    // `lib/catalog-search.ts`. It sat in the chokepoint guard's NON_AUTHORIZERS
    // with a reason that is TRUE about this function not being an authorizer
    // and SILENT about whether its filter is sound — the exemption reason that
    // is true of a sibling property, which is why nothing flagged it.
    if (!sameTenantConfirmed(callerTid, doc.tid)) continue; // tid boundary
    shared.push(doc);
  }
  return [...owned, ...shared];
}
