/**
 * Item-level permissions & sharing (F6) — pure model + decision logic.
 *
 * This module is intentionally free of any `@azure/*` runtime imports so the
 * permission-type math (ACL bit mapping, RBAC role selection, the Fabric
 * opt-in gate) is unit-testable without the Azure SDK. The
 * `item-permissions-client` wires this logic to the real Cosmos / ADLS / ARM /
 * Fabric backends.
 */

import { isGovCloud } from './cloud-endpoints';

// ============================================================
// Permission-type model (Fabric one-for-one)
// ============================================================

export type ItemPermissionType =
  | 'Read'
  | 'Edit'
  | 'Reshare'
  | 'ReadData' // SQL analytics endpoint (TDS) read
  | 'ReadAllSQL' // ReadAll via SQL analytics endpoint
  | 'ReadAllSpark' // ReadAll via Apache Spark / OneLake APIs
  | 'SubscribeOneLakeEvents'
  | 'Execute'
  | 'Build';

export const ALL_PERMISSION_TYPES: ItemPermissionType[] = [
  'Read',
  'Edit',
  'Reshare',
  'ReadData',
  'ReadAllSQL',
  'ReadAllSpark',
  'SubscribeOneLakeEvents',
  'Execute',
  'Build',
];

/** rwx POSIX permission bits (matches AclItem['permissions'] in adls-client). */
export interface AclPermissionBits {
  read: boolean;
  write: boolean;
  execute: boolean;
}

/**
 * Permission types that carry an ADLS POSIX-ACL side-effect on the item's
 * storage path, mapped to the rwx bits granted to the principal. Types not in
 * this map (Reshare, SubscribeOneLakeEvents, Execute, Build) are metadata-only
 * on the Azure-native path — they govern Loom-side capability, not file ACLs.
 *
 * Read / ReadData / ReadAll* → r-x (read + traverse). Edit → rwx.
 */
export const PERMISSION_TYPE_ACL_BITS: Partial<Record<ItemPermissionType, AclPermissionBits>> = {
  Read: { read: true, write: false, execute: true },
  Edit: { read: true, write: true, execute: true },
  ReadData: { read: true, write: false, execute: true },
  ReadAllSQL: { read: true, write: false, execute: true },
  ReadAllSpark: { read: true, write: false, execute: true },
};

/** Storage data-plane RBAC role warranted by a permission set (or null). */
export function rbacRoleFor(
  types: ItemPermissionType[],
): 'Storage Blob Data Reader' | 'Storage Blob Data Contributor' | null {
  if (types.includes('Edit')) return 'Storage Blob Data Contributor';
  if (
    types.includes('Read') ||
    types.includes('ReadData') ||
    types.includes('ReadAllSQL') ||
    types.includes('ReadAllSpark')
  ) {
    return 'Storage Blob Data Reader';
  }
  return null;
}

/** Union the rwx bits across a set of permission types (most-permissive wins). */
export function unionAclBits(types: ItemPermissionType[]): AclPermissionBits | null {
  let acc: AclPermissionBits | null = null;
  for (const t of types) {
    const bits = PERMISSION_TYPE_ACL_BITS[t];
    if (!bits) continue;
    acc = acc
      ? {
          read: acc.read || bits.read,
          write: acc.write || bits.write,
          execute: acc.execute || bits.execute,
        }
      : { ...bits };
  }
  return acc;
}

/**
 * The Fabric /share mirror is OPT-IN ONLY and never reached in a Gov boundary
 * (no Fabric API in GCC-High / IL5). Default deployments run 100% Azure-native.
 */
export function fabricPermissionsEnabled(): boolean {
  return process.env.LOOM_FABRIC_PERMISSIONS_ENABLED === 'true' && !isGovCloud();
}
