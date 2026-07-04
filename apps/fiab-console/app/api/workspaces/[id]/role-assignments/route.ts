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
import { getSession } from '@/lib/auth/session';
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

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PRINCIPAL_TYPES: PrincipalType[] = ['User', 'Group', 'ServicePrincipal'];

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
    const domains = await loadTenantDomains(session.claims.oid);
    const domain = domains.find((d) => d.id === domainId);
    if (!domain) return false;
    const tier = await resolveDomainTier(session, domain);
    return isAtLeastDomainAdmin(tier);
  } catch {
    return false;
  }
}

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const { workspace, role } = await resolveWorkspaceRole(id, s.claims.oid, s.claims.upn || s.claims.email);
    if (!workspace) return NextResponse.json({ ok: false, error: 'workspace not found' }, { status: 404 });
    // Tenant admins (admin-plane "Workspace access") and DOMAIN ADMINS of the
    // owning domain may read any workspace's roster even with no per-workspace role.
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
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const { workspace, role } = await resolveWorkspaceRole(id, s.claims.oid, s.claims.upn || s.claims.email);
    if (!workspace) return NextResponse.json({ ok: false, error: 'workspace not found' }, { status: 404 });
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
    return NextResponse.json({ ok: true, ...result }, { status: 201 });
  } catch (e: any) {
    return apiServerError(e);
  }
}
