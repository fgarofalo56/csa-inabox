/**
 * Resolve a user's effective role on a Loom workspace.
 *
 * Mirrors the model in app/api/workspaces/[id]/permissions/route.ts:
 *   • The workspace creator (`createdBy`) is the implicit `admin` (owner).
 *   • Otherwise the role comes from a row in the `workspace-permissions`
 *     container: admin | contributor | viewer.
 *   • No row + not the owner → null (no access).
 *
 * Used by the workspace data-agent config route and by the admin-plane
 * "Workspace access" roster so only OWNERS/CONTRIBUTORS (admin or contributor)
 * — or, at the ROUTE level, a tenant admin / owning-domain admin — may act.
 *
 * ---------------------------------------------------------------------------
 * #3751 / #3753 — FINDING THE WORKSPACE IS NOT THE SAME AS AUTHORIZING ON IT
 * ---------------------------------------------------------------------------
 * This function used to take a `tenantId` parameter that every one of its call
 * sites filled with `session.claims.oid`, and point-read
 *
 *     workspacesContainer().item(workspaceId, tenantId)
 *
 * The `workspaces` container is partitioned on `/tenantId`, and
 * `Workspace.tenantId` stores the CREATOR's Entra oid (see
 * `lib/auth/workspace-access.ts`, and the note at `tenantScopeId()` in
 * `lib/auth/session.ts` which says outright that the tenant scope is NOT valid
 * for this container). So that read could only ever answer
 *
 *     "did THIS caller create this workspace?"
 *
 * and Cosmos 404s for everyone else — before the function reached its own
 * `resource.tenantId === tenantId` check. The routes then reported
 * "workspace not found", which is FALSE: the workspace exists and is listed
 * tenant-wide by `listAllWorkspacesAdmin()`. Reproduced 2/2 on a 108-workspace
 * tenant. This is the #2941/#2942/#2947 owner-only-point-read class, reached
 * through a shared helper rather than an inline read.
 *
 * ---------------------------------------------------------------------------
 * #3840 — THE TENANT DECISION IS NO LONGER THIS MODULE'S TO MAKE
 * ---------------------------------------------------------------------------
 * The #3753 fix left a PRIVATE copy of the cross-tenant boundary here: a
 * `readWorkspaceById()` followed by
 *
 *     const callerTid = session.claims.tid;
 *     const docTid = (doc as { tid?: string }).tid;
 *     if (callerTid && docTid && docTid !== callerTid) return null;
 *
 * — the fourth copy of the decision that caused #3823 and #3825, and the same
 * truthiness-guarded shape both of those were filed against. It decides NOTHING
 * when either tid is absent, and BOTH absences are supported states (a
 * pre-rel-T11 workspace doc carries no `tid`; `UserClaims.tid` is optional by
 * design). The spec that shipped with #3753 recorded exactly that as a
 * "documented limit" and argued it was contained by `msal.ts` building a
 * single-tenant authority — a DEPLOYMENT property, not a property of this
 * function, and not one that survives a multi-tenant authority, a PAT minted
 * without `createdByTid`, or a session minted before rel-T11.
 *
 * What made it load-bearing rather than theoretical is what sits ABOVE it: every
 * caller runs the ladder `role || isTenantAdmin(s) || callerIsOwningDomainAdmin`
 * (role-assignments GET/POST/DELETE, agent-config GET/PUT, item access-mode). So
 * a `tid`-less workspace document reached this function, fell straight through
 * the comparison, was returned, and the ROUTE then granted full member
 * management on it to any tenant admin — with no tenant ever established. That
 * is #3823's hole with the admin grant moved one frame up the stack.
 *
 * WHAT IT DOES NOW, and why it is shaped this way:
 *
 *   1. IT DELEGATES. `resolveWorkspaceAccessByOid` is the canonical answer to
 *      "may this caller touch this workspace" (#3825), and it is asked FIRST,
 *      with `tenantAdmin` passed down so its repaired step 6 — which grants only
 *      on a POSITIVE tenant match — is the thing that decides the admin case.
 *      No comparison is written here.
 *
 *   2. IT KEEPS THE SECOND ACL, because this module owns one the resolver cannot
 *      see. `workspace-permissions` (PK `/workspaceId`, id `<wsId>:<upn>`) is a
 *      SEPARATE container from the `workspace-roles` ACL the resolver reads, it
 *      is actively written by `/api/workspaces/[id]/permissions`, and a member
 *      added there holds no `workspace-roles` row. Delegating and stopping would
 *      have silently 404'd every one of them — the #3751 defect again, from the
 *      other side. So a refusal from the resolver falls through to that explicit
 *      grant, exactly as `item-access.ts` falls through to the item-level share.
 *
 *   3. THAT SECOND PATH FAILS CLOSED. It is admitted only on a POSITIVELY
 *      CONFIRMED tenant match (`sameTenantConfirmed`, the one implementation of
 *      this comparison — `lib/auth/tenant-boundary.ts`), which is STRICTER than
 *      the resolver's step 4: an absent `tid` on either side is a refusal, not a
 *      fall-through. And being visible still requires an EXPLICIT grant — the
 *      creator, or a permissions row.
 *
 * THE RESIDUAL ON THE DELEGATED PATH, NAMED RATHER THAN ASSERTED AWAY. An earlier
 * draft of this header said "a caller with neither gets `null`, so the routes'
 * ladder never sees a document whose tenancy Loom could not confirm." That is
 * FALSE, and it is false in exactly the way this whole change exists to stop —
 * a header that overstates its invariant. Point 3 governs the SECOND path only.
 * On the FIRST (delegated) path the boundary is `resolveWorkspaceAccessByOid`
 * step 4, which is still truthiness-guarded: a legacy `tid`-less workspace doc
 * plus ANY `workspace-roles` row for the caller resolves at step 5 as
 * `via: 'acl'`, this function returns `{ workspace: <doc>, role: null }` (no
 * `workspace-permissions` row, not the creator), and `role-assignments/route.ts`
 * then grants a TENANT ADMIN full member add/remove on a workspace whose tenancy
 * was never established. Same at `role-assignments/[principalId]/route.ts`.
 *
 * That is strictly NARROWER than what shipped before #3840 — it now additionally
 * requires the caller to hold a real ACL grant on that workspace, where
 * previously the bare `readWorkspaceById` result was enough — so it is a
 * residual, not a regression. Closing it means tightening step 4 itself, which
 * is the resolver's call to make and affects all ~270 of its call sites. It is
 * pinned by a spec (`__tests__/workspace-role-lookup.test.ts`, "the DELEGATED
 * path's step-4 residual") so it cannot widen unnoticed.
 *
 * THE TRADE, STATED PLAINLY (it is a real behaviour change, not a no-op). On a
 * LEGACY workspace document with no `tid`, a tenant admin who neither owns it
 * nor holds a role on it is now REFUSED where they previously succeeded — and
 * so is a `workspace-permissions` member. The remediation is the same one
 * `workspace-guard.ts` names: `scripts/csa-loom/backfill-workspace-tid.mjs`
 * stamps the tenant onto legacy records. Owner access is untouched (the
 * resolver's owner fast-path is partition-scoped to the caller and needs no
 * `tid` at all), and so is any `workspace-roles` share.
 *
 * Pinned by `scripts/ci/check-tid-boundary-chokepoint.mjs`: section 8 checks
 * this function's delegation and pins the second grant path in
 * POST_DELEGATION_PINS, and section 10 fails the build on a private tenant
 * comparison reappearing anywhere in the console.
 */
import { workspacePermissionsContainer } from '../azure/cosmos-client';
import { readWorkspaceById, resolveWorkspaceAccessByOid } from './workspace-access';
import { sameTenantConfirmed } from './tenant-boundary';
import { isTenantAdmin } from './feature-gate';
import type { SessionPayload } from './session';

export type WorkspaceRole = 'admin' | 'contributor' | 'viewer';

export interface WorkspaceRoleResult {
  /** The workspace doc (null when not found / outside the caller's tenant). */
  workspace: any | null;
  /** The caller's effective role, or null when they have no per-workspace role. */
  role: WorkspaceRole | null;
}

const ROLE_NAMES: WorkspaceRole[] = ['admin', 'contributor', 'viewer'];

/**
 * The caller's EXPLICIT role on an already-resolved workspace document: the
 * creator is the implicit `admin`, otherwise a `workspace-permissions` row.
 *
 * Byte-identical in outcome to what `resolveWorkspaceRole` used to inline —
 * `createdBy` still means owner/`admin`, and every other role still comes from a
 * row. It is factored out only so the two resolution paths below cannot drift.
 * It decides NOTHING about tenancy and reads no tenant field; both callers have
 * already established the tenant, one by delegation and one by a positive match.
 */
async function explicitRole(
  workspace: any,
  workspaceId: string,
  session: SessionPayload,
): Promise<WorkspaceRole | null> {
  const me = (session.claims.upn || session.claims.email || '').toLowerCase();
  if (me && (workspace?.createdBy || '').toLowerCase() === me) return 'admin';
  if (!me) return null;

  const perms = await workspacePermissionsContainer();
  try {
    const { resource } = await perms.item(`${workspaceId}:${me}`, workspaceId).read<any>();
    if (resource?.role && ROLE_NAMES.includes(resource.role)) return resource.role as WorkspaceRole;
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }
  return null;
}

/**
 * Resolve the caller's `role` on `workspaceId`. `session` supplies both the
 * identity the role is resolved for and the tenant boundary for the lookup.
 *
 * Returns `{ workspace: null, role: null }` for every refusal — "not found",
 * "not your tenant" and "tenancy unconfirmed" are deliberately indistinguishable
 * to the caller, because these routes already render a 404 for all three and
 * distinguishing them here would leak the existence of workspaces in other
 * tenants. The honest cause IS available to the operator: the resolver logs its
 * `tenant_unconfirmed` refusal server-side (`workspace-access.ts`).
 */
export async function resolveWorkspaceRole(
  workspaceId: string,
  session: SessionPayload,
): Promise<WorkspaceRoleResult> {
  // 1) THE CANONICAL DECISION. Owner fast-path → `workspace-roles` ACL → tid
  //    boundary → admin-open (which grants only on a POSITIVE tenant match).
  //    `tenantAdmin` is COMPUTED here and DECIDED there — never acted on here.
  const access = await resolveWorkspaceAccessByOid(
    session.claims.oid,
    workspaceId,
    {
      callerTid: session.claims.tid,
      groups: session.claims.groups,
      tenantAdmin: isTenantAdmin(session),
    },
  );
  if (access) return { workspace: access.workspace, role: await explicitRole(access.workspace, workspaceId, session) };

  // 2) SECOND GRANT PATH — this module's own `workspace-permissions` ACL, which
  //    the resolver cannot see (different container). Reached only after the
  //    resolver has REFUSED, so it can never be the delegated verdict; it is a
  //    second, explicit grant carrying its own tenant boundary, and that boundary
  //    is a POSITIVE match. An absent `tid` on either side refuses here.
  const doc = await readWorkspaceById(workspaceId);
  if (!doc) return { workspace: null, role: null };
  if (!sameTenantConfirmed(session.claims.tid, (doc as { tid?: string }).tid)) return { workspace: null, role: null };
  const role = await explicitRole(doc, workspaceId, session);
  if (!role) return { workspace: null, role: null };
  return { workspace: doc, role };
}

/** True when the role may EDIT workspace config (owner/contributor). */
export function canEditWorkspaceConfig(role: WorkspaceRole | null): boolean {
  return role === 'admin' || role === 'contributor';
}
