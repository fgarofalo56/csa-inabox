/**
 * OneLake Security (F7) — Azure-native data-access roles for Lakehouse /
 * Mirrored-Database / Mirrored-Catalog items.
 *
 * Fabric's "Manage OneLake security" surface lets you create named roles that
 * grant Read / ReadWrite on chosen folders + tables to chosen members. The
 * Azure-native 1:1 (per no-fabric-dependency.md) is:
 *
 *   - Role DEFINITION  → a Cosmos doc (the `onelake-security-roles` container).
 *   - Real ENFORCEMENT → ADLS Gen2 POSIX ACLs on the Delta folders/tables, set
 *     recursively for every member of the role via the DFS data-plane
 *     (`DataLakeDirectoryClient.updateAccessControlRecursive`). ADLS Gen2
 *     enforces these ACLs for every access method (DFS REST, Synapse OPENROWSET,
 *     Spark abfss, SFTP), so the grant is real and verifiable by reading the
 *     ACL back.
 *
 * NO Fabric dependency on this path. The opt-in Fabric `dataAccessRoles` REST is
 * wired in the BFF route (behind LOOM_FABRIC_SECURITY_ENABLED), never here.
 *
 * Setting ACLs on behalf of other principals requires the Console UAMI to hold
 * **Storage Blob Data Owner** on the storage account (the only built-in role
 * with the ACL-modify "superuser" bit). The Bicep grant is gated behind
 * `loomOnelakeSecurityEnabled` — see synapse-storage-rbac.bicep.
 */

import {
  getServiceClient,
  getServiceClientFor,
  getAccountName,
  getAcl,
  type AclItem,
} from './adls-client';
import type {
  PathAccessControlItem,
  RemovePathAccessControlItem,
  DataLakeDirectoryClient,
} from '@azure/storage-file-datalake';
import { onelakeSecurityRolesContainer } from './cosmos-client';
import {
  type OneLakeSecurityItemType,
  type OneLakePermission,
  type SecurityRoleMemberType,
  type RowLevelRule,
  type ColumnLevelRule,
} from './onelake-security-rules';
// Type-only import of the reconciler's receipt shape. Type-only so there is NO
// runtime cycle (the reconciler imports this module's role type, also type-only).
import type { ReconcileReceipt } from './onelake-rls-reconciler';

export {
  ROLE_NAME_RE,
  isValidRolePath,
  allowedPermissions,
  roleDocId,
  isValidRlsPredicate,
  isValidColumnList,
} from './onelake-security-rules';
export type {
  OneLakeSecurityItemType,
  OneLakePermission,
  SecurityRoleMemberType,
  RowLevelRule,
  ColumnLevelRule,
} from './onelake-security-rules';

// ============================================================
// Types
// ============================================================

export type SecurityRoleMember = {
  /** Entra object id of the principal. */
  objectId: string;
  objectType: SecurityRoleMemberType;
  /** Home tenant id (used by the opt-in Fabric sync; ADLS ACLs don't need it). */
  tenantId?: string;
  /** Enriched display name / UPN (best-effort, via Microsoft Graph). */
  upn?: string;
  displayName?: string;
}

export interface OneLakeSecurityRole {
  /** cosmosId = `${itemId}:${roleName.toLowerCase()}` — one doc per role per item. */
  id: string;
  itemId: string;
  itemType: OneLakeSecurityItemType;
  /** Medallion container the item's Delta data lives in (bronze/silver/gold/landing). */
  container: string;
  roleName: string;
  permissions: OneLakePermission[];
  /** '*' for all folders, or paths like '/Tables/sales', '/Files/raw'. */
  paths: string[];
  members: SecurityRoleMember[];
  /** True for the synthetic DefaultReader / DefaultReadWriter roles. */
  isDefault?: boolean;
  /**
   * Row-Level Security predicates this role narrows by (ADDITIVE; the OLS
   * paths/permissions/members above are unchanged). Persisted by the
   * onelake-security/[role]/rls route and materialized to the source engine by
   * `reconcileRoleRlsCls` (Synapse SECURITY POLICY + inline TVF, or ADX
   * row_level_security policy). The PDP (lib/auth/pdp) also reads these as
   * obligations — so a Delta-on-ADLS item with no SQL engine is still enforced.
   */
  rls?: RowLevelRule[];
  /** Column-Level Security allow-lists this role narrows by (ADDITIVE). */
  cls?: ColumnLevelRule[];
  /** Last reconcile receipt (informational; written by the rls/cls routes). */
  lastReceipt?: ReconcileReceipt;
  createdBy: string;
  createdAt: string;
  updatedAt?: string;
}

export interface ApplyAclResult {
  changedFilesCount: number;
  changedDirectoriesCount: number;
  failedEntriesCount: number;
  /** The container-relative directories the ACLs were applied to. */
  appliedPaths: string[];
}

export interface VerifyAclResult {
  path: string;
  membersPresent: string[];
  membersMissing: string[];
  /** The raw ACL read back from ADLS (access-scope user entries only). */
  acl: AclItem[];
}

// ============================================================
// Cosmos role-definition persistence
// ============================================================

export async function listRoles(itemId: string): Promise<OneLakeSecurityRole[]> {
  const c = await onelakeSecurityRolesContainer();
  const { resources } = await c.items
    .query<OneLakeSecurityRole>({
      query: 'SELECT * FROM c WHERE c.itemId = @i ORDER BY c.createdAt ASC',
      parameters: [{ name: '@i', value: itemId }],
    })
    .fetchAll();
  return resources;
}

export async function getRole(itemId: string, roleId: string): Promise<OneLakeSecurityRole | null> {
  const c = await onelakeSecurityRolesContainer();
  try {
    const { resource } = await c.item(roleId, itemId).read<OneLakeSecurityRole>();
    return resource ?? null;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}

export async function upsertRole(role: OneLakeSecurityRole): Promise<OneLakeSecurityRole> {
  const c = await onelakeSecurityRolesContainer();
  const { resource } = await c.items.upsert<OneLakeSecurityRole>(role);
  return (resource as OneLakeSecurityRole) ?? role;
}

export async function deleteRole(itemId: string, roleId: string): Promise<void> {
  const c = await onelakeSecurityRolesContainer();
  try {
    await c.item(roleId, itemId).delete();
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }
}

// ============================================================
// ADLS Gen2 ACL enforcement (the REAL grant)
// ============================================================

/** Normalise a role path ('*', '/Tables/foo', 'Files/bar') to a container-
 *  relative directory path. Returns '' for the container root ('*'). */
function normalizePath(p: string): string {
  if (p === '*' || p === '/' || p === '') return '';
  return p.replace(/^\/+|\/+$/g, '');
}

/** Build the POSIX ACL entries for a role's members on one path. We add BOTH an
 *  access-scope entry (governs existing data) AND a default-scope entry (so new
 *  files created under the directory inherit the grant), matching how Fabric's
 *  data-access roles propagate. */
function memberAclEntries(role: OneLakeSecurityRole): PathAccessControlItem[] {
  const write = role.permissions.includes('ReadWrite');
  const out: PathAccessControlItem[] = [];
  for (const m of role.members) {
    if (!m.objectId) continue;
    const perms = { read: true, write, execute: true };
    out.push({ accessControlType: 'user', entityId: m.objectId, defaultScope: false, permissions: perms });
    out.push({ accessControlType: 'user', entityId: m.objectId, defaultScope: true, permissions: perms });
  }
  return out;
}

function dirClient(container: string, path: string, account?: string): DataLakeDirectoryClient {
  const svc = account ? getServiceClientFor(account) : getServiceClient();
  return svc.getFileSystemClient(container).getDirectoryClient(path || '/');
}

/** ADLS Gen2 traversal requires `--x` (execute) on every ANCESTOR directory of
 *  the granted path. Without it the principal cannot reach the data even though
 *  it holds rwx on the leaf. We add an execute-only access entry per member on
 *  each ancestor via read-merge-write (single-path, non-recursive). */
async function grantTraversalOnAncestors(
  container: string,
  cleanPath: string,
  members: SecurityRoleMember[],
  account?: string,
): Promise<void> {
  if (!cleanPath) return;
  const segs = cleanPath.split('/').filter(Boolean);
  // Ancestors: '' (root), seg0, seg0/seg1, … up to (but not including) the leaf.
  const ancestors: string[] = [''];
  for (let i = 0; i < segs.length - 1; i++) ancestors.push(segs.slice(0, i + 1).join('/'));
  for (const anc of ancestors) {
    const dir = dirClient(container, anc, account);
    let current: PathAccessControlItem[] = [];
    try {
      current = (await dir.getAccessControl()).acl;
    } catch {
      // Root may already be reachable; skip ancestors we can't read.
      continue;
    }
    const merged = [...current];
    for (const m of members) {
      if (!m.objectId) continue;
      const existing = merged.find(
        (a) => a.accessControlType === 'user' && a.entityId === m.objectId && !a.defaultScope,
      );
      if (existing) {
        existing.permissions = { ...existing.permissions, execute: true };
      } else {
        merged.push({
          accessControlType: 'user',
          entityId: m.objectId,
          defaultScope: false,
          permissions: { read: false, write: false, execute: true },
        });
      }
    }
    await dir.setAccessControl(merged);
  }
}

/**
 * Apply a role's ADLS Gen2 ACLs for every member on every path. This is the
 * real grant — it calls `updateAccessControlRecursive` (additive; it does NOT
 * wipe other principals' entries) on each target folder/table, then opens the
 * traversal path on the ancestors. Returns the SDK's change counters so the BFF
 * can report what was touched.
 */
export async function applyRoleAcls(
  role: OneLakeSecurityRole,
  account?: string,
): Promise<ApplyAclResult> {
  const acl = memberAclEntries(role);
  const container = role.container;
  const result: ApplyAclResult = {
    changedFilesCount: 0,
    changedDirectoriesCount: 0,
    failedEntriesCount: 0,
    appliedPaths: [],
  };
  if (acl.length === 0) return result;

  for (const raw of role.paths) {
    const cleanPath = normalizePath(raw);
    const dir = dirClient(container, cleanPath, account);
    const res = await dir.updateAccessControlRecursive(acl);
    result.changedFilesCount += res.counters?.changedFilesCount ?? 0;
    result.changedDirectoriesCount += res.counters?.changedDirectoriesCount ?? 0;
    result.failedEntriesCount += res.counters?.failedChangesCount ?? 0;
    result.appliedPaths.push(cleanPath || '/');
    // Open the traversal path so members can actually reach the granted folder.
    await grantTraversalOnAncestors(container, cleanPath, role.members, account);
  }
  return result;
}

/**
 * Revoke a role's ADLS Gen2 ACL entries for every member on every path
 * (recursive). Removes both the access-scope and default-scope user entries.
 * Never touches other principals' entries. Best-effort per path — a missing
 * folder is not fatal (the data may already be gone).
 */
export async function revokeRoleAcls(
  role: OneLakeSecurityRole,
  account?: string,
): Promise<void> {
  const removals: RemovePathAccessControlItem[] = [];
  for (const m of role.members) {
    if (!m.objectId) continue;
    removals.push({ accessControlType: 'user', entityId: m.objectId, defaultScope: false });
    removals.push({ accessControlType: 'user', entityId: m.objectId, defaultScope: true });
  }
  if (removals.length === 0) return;
  for (const raw of role.paths) {
    const cleanPath = normalizePath(raw);
    try {
      const dir = dirClient(role.container, cleanPath, account);
      await dir.removeAccessControlRecursive(removals);
    } catch {
      // Folder may not exist any more — revoke is idempotent.
    }
  }
}

/**
 * Read the live ACL back on a path and report which of the given member object
 * ids are present as access-scope user entries. Drives the Security tab's
 * Verification view (the acceptance-criteria read-back).
 */
export async function verifyRoleAcls(
  container: string,
  path: string,
  memberObjectIds: string[],
): Promise<VerifyAclResult> {
  const cleanPath = normalizePath(path);
  const acl = (await getAcl(container, cleanPath)).filter(
    (a) => a.scope === 'access' && a.type === 'user' && !!a.entityId,
  );
  const present = new Set(acl.map((a) => a.entityId as string));
  const membersPresent = memberObjectIds.filter((oid) => present.has(oid));
  const membersMissing = memberObjectIds.filter((oid) => !present.has(oid));
  return { path: cleanPath || '/', membersPresent, membersMissing, acl };
}
