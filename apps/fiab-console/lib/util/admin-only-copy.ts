/**
 * The pre-emptive "tenant admins only" text each surface shows BEFORE a
 * non-admin clicks a control whose route is tenant-admin gated (#4619).
 *
 * The route's 403 envelope is the authority and carries its own
 * `reason` / `remediation`; these strings are what a surface renders when
 * `useIsTenantAdmin()` is already false, so the user learns why the control is
 * disabled without a round trip. Keep each one describing the verb the user is
 * looking at, not the generic label / DLP / Purview policy wording.
 *
 * Pure (no React) so surfaces and their tests share one copy.
 */

export interface AdminOnlyCopy {
  reason: string;
  remediation: string;
}

/** DLP "Restrict access" (POST /api/governance/dlp/restrict). */
export const DLP_RESTRICT_ADMIN_ONLY: AdminOnlyCopy = {
  reason:
    'Restricting access revokes role assignments, ACL entries and database grants on the '
    + 'deployment\'s shared storage, warehouses and databases, so only a tenant admin can apply it.',
  remediation: 'Ask a tenant admin to apply the restriction. The findings stay visible to you.',
};

/** OneLake Secure tab (GET/POST/DELETE /api/onelake/security). */
export const SECURE_TAB_ADMIN_ONLY: AdminOnlyCopy = {
  reason:
    'The Secure tab lists, grants and revokes Azure RBAC on the deployment\'s shared lake '
    + 'containers. Those assignments cover the whole container, not one item, so only a tenant '
    + 'admin can use it.',
  remediation: 'Ask a tenant admin to review or change access on these containers.',
};

/** Lifecycle rules on a SHARED storage account (PUT /api/onelake/lifecycle). */
export const SHARED_LIFECYCLE_ADMIN_ONLY: AdminOnlyCopy = {
  reason:
    'This workspace has no storage account of its own, so these rules apply to a storage account other '
    + 'workspaces share. Rules on a shared account can only be changed by a tenant admin.',
  remediation:
    'Ask a tenant admin to change these rules, or bind this workspace to a storage account of its own in '
    + 'workspace settings and manage its rules there.',
};
