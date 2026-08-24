/**
 * Workspace role assignments — F5 Manage Access (Azure-native workspace RBAC).
 *
 *   GET  /api/workspaces/[id]/role-assignments
 *     → { ok, roleAssignments, rbacAdminGate?, fabricMode, callerRole }
 *   POST /api/workspaces/[id]/role-assignments     (workspace Admin / owner)
 *     body { principalId, principalType, displayName, role } →
 *       201 { ok, roleAssignment, rbac, fabric? }
 *
 * Backend: Cosmos `workspace-roles` (system of record) MIRRORED to a real Azure
 * RBAC role assignment on the DLZ resource group via the ARM control plane
 * (Admin/Member → Contributor; Contributor/Viewer → Reader). Fabric mirror is
 * strictly opt-in (LOOM_WORKSPACE_ROLES_FABRIC=1) — UNSET by default, so the
 * Azure-native path runs with LOOM_DEFAULT_FABRIC_WORKSPACE unset.
 *
 * Authz: same model as the data-agent + permissions routes — workspace owner
 * (creator) or an `admin` row may manage access. Honest 403 otherwise. When the
 * UAMI lacks RBAC-admin on the DLZ RG, the Cosmos row is still written and the
 * `rbac` side-effect carries status 'pending' + a precise remediation string
 * (also surfaced via `rbacAdminGate` on GET). See no-vaporware.md.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession, tenantScopeId } from '@/lib/auth/session';
import { resolveWorkspaceRole } from '@/lib/auth/workspace-role';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { resolveDomainTier, isAtLeastDomainAdmin } from '@/lib/auth/domain-role';
import { loadTenantDomains } from '@/lib/auth/load-domains';
import {
  listWorkspaceRoles,
  addWorkspaceRole,
  checkRbacAdminCapability,
  isWorkspaceRoleName,
  type PrincipalType,
} from '@/lib/azure/workspace-roles-client';
import { apiServerError } from '@/lib/api/respond';
import { recordAssignment } from '@/lib/access/assignment-ledger';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PRINCIPAL_TYPES: PrincipalType[] = ['User', 'Group', 'ServicePrincipal'];

/**
 * WHY THE `isTenantAdmin` ARM OF THIS LADDER IS SAFE, AND WHERE THAT IS DECIDED.
 *
 * #3826 — every handler in this file (and its `[principalId]` sibling) runs the
 * ladder `role === 'admin' || isTenantAdmin(s) || owningDomainAdmin`. The middle
 * arm has NO stored grant behind it: `isTenantAdmin` reads
 * `LOOM_TENANT_ADMIN_OID` / `_GROUP_ID` and never looks at the workspace, so it
 * establishes that the caller is AN admin and never WHICH tenant they
 * administer. Before #3840 that meant a workspace whose tenancy Loom had never
 * established could reach this ladder and be handed full member add/remove.
 *
 * IT IS CLOSED UPSTREAM, NOT HERE, AND THAT IS DELIBERATE. `resolveWorkspaceRole`
 * delegates to `resolveWorkspaceAccessByOid`, whose step 4 now requires a
 * POSITIVE tenant match (`sameTenantConfirmed`). So a non-null `workspace` below
 * already means one of exactly two things: the caller OWNS it (step 1, a
 * point-read into the caller's own partition, which cannot return another
 * tenant's record), or its tenancy was positively CONFIRMED against the
 * caller's. There is no third way to obtain a document here.
 *
 * A FIRST DRAFT OF THIS CHANGE ADDED A LOCAL `tenantAdminMayActHere()` HELPER
 * that re-derived the tenant match at this route as defence in depth. That was
 * wrong, and the repo's own guard is what said so —
 * `scripts/ci/check-tid-boundary-chokepoint.mjs` failed it with "#3825 …
 * grants access on isTenantAdmin ALONE in a workspace-scoped function … route
 * the decision through resolveWorkspaceAccessByOid". It was right. A
 * route-local tenant decision is a FIFTH copy of a comparison whose four
 * predecessors are #3823, #3825, #3840 and #3843 — the exact defect this change
 * exists to delete — and "mine is correct today" is what each of those four also
 * believed. Defence in depth assembled out of duplicated security logic is not
 * depth; it is one more thing that can drift out of agreement with the others.
 * The depth here is that the chokepoint is SINGLE, enforced by CI, and pinned by
 * specs on both sides of it.
 */

/**
 * D2: a DOMAIN ADMIN of the domain that owns this workspace may manage its
 * members (full control of their domain's workspaces), in addition to the
 * workspace owner / workspace Admin / tenant admin. Returns false (never throws)
 * when the workspace has no domain or the domains doc is unreachable.
 */
async function callerIsOwningDomainAdmin(
  session: ReturnType<typeof getSession>,
  workspace: any,
): Promise<boolean> {
  if (!session) return false;
  const domainId = (workspace?.domain || '').toString().trim();
  if (!domainId) return false;
  try {
    // Tenant scope, NOT the caller's oid (#3282).
    const domains = await loadTenantDomains(tenantScopeId(session));
    const domain = domains.find((d) => d.id === domainId);
    if (!domain) return false;
    const tier = await resolveDomainTier(session, domain);
    return isAtLeastDomainAdmin(tier);
  } catch {
    return false;
  }
}

export const GET = withSession<{ id: string }>(async (_req: NextRequest, { session: s, params }) => {
  const { id } = params;
  try {
    const { workspace, role } = await resolveWorkspaceRole(id, s);
    if (!workspace) return NextResponse.json({ ok: false, error: 'workspace not found' }, { status: 404 });
    // Tenant admins (admin-plane "Workspace access") and DOMAIN ADMINS of the
    // owning domain may read any workspace's roster even with no per-workspace
    // role. #3826: reaching this line already means the tenancy was CONFIRMED or
    // the caller owns it — see the block comment above PRINCIPAL_TYPES.
    const tenantAdmin = isTenantAdmin(s);
    const owningDomainAdmin = !role && !tenantAdmin ? await callerIsOwningDomainAdmin(s, workspace) : false;
    if (!role && !tenantAdmin && !owningDomainAdmin) return NextResponse.json({ ok: false, error: 'no access to this workspace' }, { status: 403 });

    const roleAssignments = await listWorkspaceRoles(id);
    const gate = await checkRbacAdminCapability();
    return NextResponse.json({
      ok: true,
      roleAssignments,
      rbacAdminGate: gate.ok ? undefined : gate.detail,
      fabricMode: process.env.LOOM_WORKSPACE_ROLES_FABRIC === '1' ? 'fabric+azure' : 'azure-native',
      callerRole: tenantAdmin || owningDomainAdmin ? 'admin' : role,
    });
  } catch (e: any) {
    return apiServerError(e);
  }
});

export const POST = withSession<{ id: string }>(async (req: NextRequest, { session: s, params }) => {
  const { id } = params;
  try {
    const { workspace, role } = await resolveWorkspaceRole(id, s);
    if (!workspace) return NextResponse.json({ ok: false, error: 'workspace not found' }, { status: 404 });
    // #3826 — the WRITE side of the ladder. A non-null `workspace` above already
    // carries a CONFIRMED tenancy (resolver step 4) or is owned by the caller, so
    // the tenant-admin arm can no longer fire on an unconfirmed record.
    if (role !== 'admin' && !isTenantAdmin(s) && !(await callerIsOwningDomainAdmin(s, workspace))) {
      return NextResponse.json(
        { ok: false, error: 'Only the workspace owner, an Admin, a domain admin of the owning domain, or a tenant admin can add members.', role },
        { status: 403 },
      );
    }

    const body = await req.json().catch(() => ({}));
    const principalId = (body?.principalId || '').toString().trim();
    const principalType = (body?.principalType || 'User').toString() as PrincipalType;
    const displayName = (body?.displayName || principalId).toString().trim();
    const wsRole = body?.role;
    if (!principalId) return NextResponse.json({ ok: false, error: 'principalId required' }, { status: 400 });
    if (!PRINCIPAL_TYPES.includes(principalType)) {
      return NextResponse.json({ ok: false, error: `principalType must be one of ${PRINCIPAL_TYPES.join(', ')}` }, { status: 400 });
    }
    if (!isWorkspaceRoleName(wsRole)) {
      return NextResponse.json({ ok: false, error: 'role must be one of Admin, Member, Contributor, Viewer' }, { status: 400 });
    }

    const addedBy = s.claims.upn || s.claims.email || s.claims.oid;
    const result = await addWorkspaceRole(
      { workspaceId: id, principalId, principalType, displayName, role: wsRole, addedBy },
      (workspace as any).fabricWorkspaceId ?? null,
    );
    // Entitlement ledger (access-governance W1): record the workspace-role grant
    // so the who-has-access report reflects it. Best-effort (never throws).
    await recordAssignment({
      principalId,
      principalUpn: displayName,
      principalType,
      tenantId: s.claims.oid,
      resourceType: 'workspace',
      resourceRef: id,
      resourceName: (workspace as any).displayName || (workspace as any).name,
      role: wsRole,
      source: 'workspace-acl',
      sourceRef: `${id}:${principalId}`,
      grantedBy: addedBy,
    });
    return NextResponse.json({ ok: true, ...result }, { status: 201 });
  } catch (e: any) {
    return apiServerError(e);
  }
});
