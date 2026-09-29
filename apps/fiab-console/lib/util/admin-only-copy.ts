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

/** Lifecycle rules (PUT /api/onelake/lifecycle) — tenant-admin for every account. */
export const LIFECYCLE_ADMIN_ONLY: AdminOnlyCopy = {
  reason:
    'Lifecycle rules replace the whole management policy of a storage account, and Loom cannot yet '
    + 'confirm that the account is used by this workspace alone, so only a tenant admin can change them.',
  remediation: 'Ask a tenant admin to change these rules. You can still review them here.',
};

/** Change storage tier (PUT /api/onelake/tier). */
export const TIER_CHANGE_ADMIN_ONLY: AdminOnlyCopy = {
  reason: 'Changing a file\'s storage tier is limited to tenant admins for now.',
  remediation: 'Ask a tenant admin to change the tier. You can still see the current tier here.',
};

/**
 * A workspace's storage account (`storageAccountId` on POST /api/workspaces
 * and PATCH /api/workspaces/[id]). The binding decides which account the
 * workspace's lifecycle and metrics surfaces act on, so setting or changing it
 * is a tenant-admin action. The route answers with this text.
 */
export const WORKSPACE_STORAGE_ADMIN_ONLY: AdminOnlyCopy = {
  reason: 'Setting or changing a workspace\'s storage account is limited to tenant admins.',
  remediation:
    'Create the workspace on the deployment default storage, then ask a tenant admin to set '
    + 'the storage account.',
};
