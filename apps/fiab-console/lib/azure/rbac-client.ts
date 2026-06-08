/**
 * rbac-client — thin re-export surface for access-request role provisioning.
 *
 * F16's approval workflow provisions a REAL Azure RBAC grant on the backing
 * data store when the final (access-provider) tier approves. The grant logic
 * already exists and is sovereign-cloud aware:
 *
 *   - enforceAccessGrant / revokeAccessGrant  (access-policy-client) — dispatch
 *     by scope to Storage RBAC / Synapse SQL / ADX data-plane grants.
 *   - grantContainerRole / revokeContainerRoleAssignment (adls-client) — the
 *     ARM PUT/DELETE roleAssignments primitives for ADLS containers.
 *
 * This module intentionally adds NO new ARM logic — it re-exports the existing,
 * tested functions so the access-request routes import a single named surface.
 */

export {
  enforceAccessGrant,
  revokeAccessGrant,
  revokeStructuredGrant,
  PERMISSION_ROLE,
  type AccessGrantInput,
  type AccessGrantResult,
  type AccessPermission,
  type AccessScopeType,
  type PrincipalType,
} from './access-policy-client';

export {
  grantContainerRole,
  revokeContainerRoleAssignment,
  listContainerRoleAssignments,
  listKnownBlobDataRoles,
  type ContainerRoleAssignment,
} from './adls-client';
