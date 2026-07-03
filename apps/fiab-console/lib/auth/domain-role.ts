/**
 * Domain RBAC tier resolver — the single source of truth for the D2 identity
 * hierarchy (tenant admin → domain admin → domain contributor → workspace
 * roles). Mirrors Microsoft Fabric's Domains role model one-for-one
 * (learn.microsoft.com/fabric/governance/domains):
 *
 *   • Tenant admin   — global. Tenant settings, ALL domains/workspaces, deploy
 *                      landing zones. = the existing tenant-bootstrap Admin role
 *                      (LOOM_TENANT_ADMIN_OID / LOOM_TENANT_ADMIN_GROUP_ID).
 *   • Domain admin   — full control SCOPED to their domain's workspaces, DLZ
 *                      panes, member management + attach-workspaces. No tenant
 *                      settings, no other domains. Backed by the domain's Entra
 *                      `adminGroupId` (plus the legacy `admins[]` UPN list for
 *                      back-compat).
 *   • Domain contributor — may create/assign workspaces within the domain (no
 *                      domain-admin powers). Backed by the domain's Entra
 *                      `contributorGroupId` (plus the legacy
 *                      `contributors.scope` model).
 *   • Workspace roles (Admin/Member/Contributor/Viewer) sit BENEATH this tier —
 *                      resolved by lib/azure/workspace-roles-client.
 *
 * CACHING: the 8h encrypted session cookie carries `claims.groups` (the user's
 * Entra group object-ids at sign-in) — that IS the cache for the group-membership
 * check ("Entra group check, cached" in the brief). A Microsoft Graph fallback
 * (`userIsTransitiveGroupMember`) is consulted ONLY when the `groups` claim is
 * empty/absent, which is exactly the Entra >200-group overage case where the
 * inline claim is replaced by a `_claim_sources` pointer. We never hit Graph on
 * the hot path for the common (claim-present) case.
 *
 * Per .claude/rules: real Entra/Cosmos backing (no-vaporware), no Fabric
 * dependency (Graph + Cosmos only), structured fields not free text
 * (loom-no-freeform-config).
 */
import type { SessionPayload } from './session';
import { isTenantAdmin } from './feature-gate';
import { userIsTransitiveGroupMember } from '@/lib/azure/workspace-roles-client';

export type DomainTier = 'tenant-admin' | 'domain-admin' | 'domain-contributor' | null;

/** Subset of the stored DomainItem that tier resolution needs (decoupled from
 * the route's full shape so this module has no Cosmos import). */
export interface DomainTierDomain {
  id: string;
  /** Entra security-group object id whose members are domain ADMINS. */
  adminGroupId?: string;
  /** Entra security-group object id whose members are domain CONTRIBUTORS. */
  contributorGroupId?: string;
  /** Registry/topology alias for the contributor group (domain-registry stores
   * the contributor/member Entra group as `memberGroupId`). Honored as an
   * equivalent source for the domain-contributor tier. */
  memberGroupId?: string;
  /** Legacy free-text admin list (UPNs) — honored for back-compat. */
  admins?: string[];
  /** Legacy contributor model (Fabric scope semantics). */
  contributors?: { scope: 'AllTenant' | 'AdminsOnly' | 'SpecificUsersAndGroups'; users?: string[] };
}

/** The two deploy params that bind the tenant-admin principal. Named in every
 *  fail-closed honest gate so an unconfigured deploy shows the exact fix. */
export const TENANT_ADMIN_BOOTSTRAP_ENV = {
  oid: 'LOOM_TENANT_ADMIN_OID',
  group: 'LOOM_TENANT_ADMIN_GROUP_ID',
} as const;

/** Honest remediation for a fail-closed tier denial. Surfaced (with
 *  {@link TENANT_ADMIN_BOOTSTRAP_ENV}) whenever `isTenantAdminTier` /
 *  `canAccessDlzPanes` denies, so the org-wide DLZ/capacity/cost/spark-warm
 *  panes name the exact env var to set instead of rendering empty. */
export const TENANT_ADMIN_TIER_REMEDIATION =
  'No tenant admin is configured for this deployment (or your account is not one). ' +
  'Set LOOM_TENANT_ADMIN_OID to your Entra user object id (oid), or add yourself to the ' +
  'LOOM_TENANT_ADMIN_GROUP_ID group — both are deploy params wired into the Console app env ' +
  '(loomTenantAdminOid / loomTenantAdminGroupId). Until one is set, no session is treated as a ' +
  'tenant admin (fail-closed). A tenant admin can also grant domain-admin access at /admin/permissions.';

/**
 * Tenant-admin determination for the scoped tiers.
 *
 * Covers BOTH group-based and bootstrap-oid tenant admins via feature-gate's
 * `isTenantAdmin` (the existing domains route's `isDomainTenantAdmin` only
 * checked the oid and so MISSED group-based tenant admins).
 *
 * FAILS CLOSED (rel-T14): when NEITHER LOOM_TENANT_ADMIN_OID nor
 * LOOM_TENANT_ADMIN_GROUP_ID is configured this returns FALSE — matching the
 * stricter `isTenantAdmin`. The prior default-ALLOW granted every authenticated
 * session tenant-admin tier on an unconfigured deploy, exposing the org-wide DLZ
 * capacity / cost / utilization / spark-warm panes to anyone. Binding the admin
 * principal via the deploy params is the (documented) way in — see
 * TENANT_ADMIN_TIER_REMEDIATION.
 */
export function isTenantAdminTier(session: SessionPayload): boolean {
  return isTenantAdmin(session);
}

/** True when the session cookie's `groups` claim is empty/absent — the Entra
 * >200-group overage case where the inline claim is dropped and we must fall
 * back to Graph for an authoritative membership answer. */
function groupsClaimUnavailable(session: SessionPayload): boolean {
  return !session.claims.groups || session.claims.groups.length === 0;
}

function inGroupClaim(session: SessionPayload, groupId?: string): boolean {
  if (!groupId) return false;
  return (session.claims.groups || []).includes(groupId);
}

function inLegacyAdmins(session: SessionPayload, domain: DomainTierDomain): boolean {
  const upn = (session.claims.upn || '').toLowerCase();
  if (!upn) return false;
  return (domain.admins || []).some((a) => a.toLowerCase() === upn);
}

/**
 * Resolve the caller's tier on ONE domain. Async because the Graph fallback may
 * run for the group-overage case; the common path (claim present) is fully
 * synchronous in spirit (no Graph round-trip).
 */
export async function resolveDomainTier(
  session: SessionPayload,
  domain: DomainTierDomain,
): Promise<DomainTier> {
  if (isTenantAdminTier(session)) return 'tenant-admin';

  // Cached (session-claim) group checks + legacy UPN list.
  if (inGroupClaim(session, domain.adminGroupId) || inLegacyAdmins(session, domain)) {
    return 'domain-admin';
  }
  if (inGroupClaim(session, domain.contributorGroupId) || inGroupClaim(session, domain.memberGroupId)) {
    return 'domain-contributor';
  }

  // Graph fallback ONLY for the group-claim-overage case.
  if (groupsClaimUnavailable(session)) {
    if (domain.adminGroupId && (await userIsTransitiveGroupMember(session.claims.oid, domain.adminGroupId))) {
      return 'domain-admin';
    }
    const contributorGroup = domain.contributorGroupId || domain.memberGroupId;
    if (contributorGroup && (await userIsTransitiveGroupMember(session.claims.oid, contributorGroup))) {
      return 'domain-contributor';
    }
  }
  return null;
}

/** Highest-tier comparison helper — true when `tier` is at least domain-admin. */
export function isAtLeastDomainAdmin(tier: DomainTier): boolean {
  return tier === 'tenant-admin' || tier === 'domain-admin';
}

/** True when `tier` grants any administered access to the domain (any of the
 * three tiers). */
export function hasDomainAccess(tier: DomainTier): boolean {
  return tier !== null;
}

/**
 * Whether the caller may ASSIGN/attach the given workspace to `domain`, applying
 * the Fabric semantics:
 *   • tenant-admin / domain-admin  → always.
 *   • domain-contributor           → yes, but Fabric requires they hold the
 *     workspace Admin role on the workspace being assigned (they assign THEIR
 *     OWN workspaces). The caller passes a `callerIsWorkspaceAdmin` flag it
 *     computes via resolveEffectiveRole so this module stays Cosmos-free.
 *   • else                         → honor the legacy contributors.scope:
 *       - AllTenant → any authenticated user may assign their own workspace.
 *       - AdminsOnly → only domain admins (already handled above).
 *       - SpecificUsersAndGroups → caller UPN/oid/group in users[].
 */
export function canAssignWorkspaceToDomain(
  session: SessionPayload,
  domain: DomainTierDomain,
  tier: DomainTier,
  callerIsWorkspaceAdmin: boolean,
): boolean {
  if (isAtLeastDomainAdmin(tier)) return true;
  if (tier === 'domain-contributor') return callerIsWorkspaceAdmin;

  const scope = domain.contributors?.scope;
  if (scope === 'AllTenant') return callerIsWorkspaceAdmin;
  if (scope === 'SpecificUsersAndGroups') {
    const upn = (session.claims.upn || '').toLowerCase();
    const oid = (session.claims.oid || '').toLowerCase();
    const groups = (session.claims.groups || []).map((g) => g.toLowerCase());
    const allowed = (domain.contributors?.users || []).map((u) => u.toLowerCase());
    const matched = allowed.some((a) => a === upn || a === oid || groups.includes(a));
    return matched && callerIsWorkspaceAdmin;
  }
  return false;
}

/**
 * The set of domain ids the caller administers at any tier. Tenant admins get
 * ALL ids. Used to filter domain pickers + scope the DLZ panes. Resolves each
 * domain with `resolveDomainTier` — the Graph fallback only fires for the
 * group-overage case, so for the common (claim-present) caller this is a pure
 * in-memory pass over the domain list.
 */
export async function administeredDomainIds(
  session: SessionPayload,
  domains: DomainTierDomain[],
): Promise<string[]> {
  if (isTenantAdminTier(session)) return domains.map((d) => d.id);
  const out: string[] = [];
  for (const d of domains) {
    const tier = await resolveDomainTier(session, d);
    if (tier) out.push(d.id);
  }
  return out;
}

/**
 * Whether the caller may open the DLZ panes (scale / cost / monitor). Per D2:
 * tenant admins (global) and DOMAIN ADMINS (their domain's workspaces) get the
 * DLZ panes; domain contributors and everyone else do NOT. Returns true for a
 * tenant admin OR a domain admin of at least one domain. Used to gate the
 * /api/admin/capacity/* routes (previously any authenticated user could read).
 */
export async function canAccessDlzPanes(
  session: SessionPayload,
  domains: DomainTierDomain[],
): Promise<boolean> {
  if (isTenantAdminTier(session)) return true;
  for (const d of domains) {
    const tier = await resolveDomainTier(session, d);
    if (tier === 'domain-admin') return true;
  }
  return false;
}
