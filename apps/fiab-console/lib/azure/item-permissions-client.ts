/**
 * Item-level permissions & sharing (F6) — Azure-native client.
 *
 * Fabric parity: in Fabric you "Share" an item and grant permission types
 * (Read, Edit, Reshare, ReadData, ReadAll-SQL, ReadAll-Spark,
 * SubscribeOneLakeEvents, Execute, Build). Loom implements the SAME surface
 * with NO dependency on a real Fabric tenant:
 *
 *   • Source of truth  → Cosmos `item-permissions` container (one row per
 *                         (item, principal), partitioned by /itemId).
 *   • Data-plane grant → ADLS Gen2 POSIX ACL entry for the principal's Entra
 *                         OID on the item's storage path (for data-plane
 *                         permission types — Read / Edit / ReadData /
 *                         ReadAll-SQL / ReadAll-Spark).
 *   • Control-plane    → ARM Storage data-plane RBAC (Storage Blob Data
 *                         Reader / Contributor) at the container scope so the
 *                         principal can reach the data via SQL/Spark engines.
 *   • Fabric (opt-in)  → when LOOM_FABRIC_PERMISSIONS_ENABLED=true AND not a
 *                         Gov boundary, ALSO POST the grant to the Fabric item
 *                         /share endpoint. This is strictly additive — the
 *                         Azure-native write is already committed; a Fabric
 *                         failure is surfaced as a hint, never a hard error.
 *
 * Per .claude/rules/no-fabric-dependency.md — the DEFAULT path NEVER reaches
 * api.fabric.microsoft.com and NEVER gates on a Fabric workspace. Per
 * .claude/rules/no-vaporware.md — every read/write here hits a real backend;
 * there is no mock list.
 */

import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
  type TokenCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { itemPermissionsContainer } from './cosmos-client';
import {
  getAcl,
  setAcl,
  grantContainerRole,
  revokeContainerRoleAssignment,
  type AclItem,
} from './adls-client';
import {
  ALL_PERMISSION_TYPES,
  PERMISSION_TYPE_ACL_BITS,
  rbacRoleFor,
  unionAclBits,
  fabricPermissionsEnabled,
  type ItemPermissionType,
} from './item-permissions-model';

// Re-export the model surface so existing import sites can keep importing from
// the client. The pure logic lives in item-permissions-model (no @azure/* deps).
export {
  ALL_PERMISSION_TYPES,
  PERMISSION_TYPE_ACL_BITS,
  type ItemPermissionType,
};

// ============================================================
// Permission-type model (Fabric one-for-one) — see item-permissions-model.ts
// ============================================================

// ============================================================
// Stored shape
// ============================================================

export interface ItemPermission {
  /** Stable id: `${principalType}::${principalId}` — idempotent upsert key. */
  id: string;
  itemId: string; // partition key
  itemType: string;
  workspaceId: string;
  tenantId: string;
  principalId: string; // Entra object id
  principalType: 'user' | 'group';
  principalDisplayName?: string;
  principalUpn?: string;
  permissionTypes: ItemPermissionType[];
  grantedBy: string; // UPN of granting user
  grantedAt: string; // ISO timestamp
  // Side-effect tracking (populated on successful mirror)
  aclGranted?: boolean;
  aclContainer?: string;
  aclPath?: string;
  rbacGranted?: boolean;
  rbacRoleName?: string;
  rbacRoleAssignmentId?: string;
  /** Non-fatal notes from the mirror (e.g. "no ADLS path resolved for item"). */
  mirrorNotes?: string[];
  /** Opt-in Fabric /share outcome, when LOOM_FABRIC_PERMISSIONS_ENABLED=true. */
  fabricShared?: boolean;
  fabricHint?: string;
}

// ============================================================
// Reads
// ============================================================

/** List all permission grants for an item from Cosmos (live rows, no mock). */
export async function listItemPermissions(itemId: string): Promise<ItemPermission[]> {
  const c = await itemPermissionsContainer();
  const { resources } = await c.items
    .query<ItemPermission>(
      {
        query: 'SELECT * FROM c WHERE c.itemId = @i ORDER BY c.grantedAt DESC',
        parameters: [{ name: '@i', value: itemId }],
      },
      { partitionKey: itemId },
    )
    .fetchAll();
  return resources;
}

// ============================================================
// ADLS ACL mirroring (merge, never replace)
// ============================================================

/**
 * Add/replace a single principal's POSIX ACL entry on a path WITHOUT clobbering
 * the rest of the ACL: read the current ACL, drop any prior entry for the same
 * (type, entityId), append the new one, write back. Returns the merged ACL.
 */
async function upsertAclEntry(
  container: string,
  path: string,
  entityId: string,
  principalType: 'user' | 'group',
  permissions: AclItem['permissions'],
): Promise<void> {
  const current = await getAcl(container, path);
  const filtered = current.filter(
    (a) => !(a.scope === 'access' && a.type === principalType && a.entityId === entityId),
  );
  filtered.push({ scope: 'access', type: principalType, entityId, permissions });
  await setAcl(container, path, filtered);
}

/** Remove a principal's access-scope POSIX ACL entry from a path (merge-safe). */
async function removeAclEntry(
  container: string,
  path: string,
  entityId: string,
  principalType: 'user' | 'group',
): Promise<void> {
  const current = await getAcl(container, path);
  const filtered = current.filter(
    (a) => !(a.scope === 'access' && a.type === principalType && a.entityId === entityId),
  );
  if (filtered.length !== current.length) {
    await setAcl(container, path, filtered);
  }
}

// ============================================================
// Fabric opt-in (strictly additive, never on the default path)
// ============================================================

const FABRIC_BASE = process.env.LOOM_FABRIC_BASE || 'https://api.fabric.microsoft.com/v1';
const FABRIC_SCOPE = 'https://api.fabric.microsoft.com/.default';

let _fabricCred: TokenCredential | null = null;
function fabricCredential(): TokenCredential {
  if (_fabricCred) return _fabricCred;
  const uami = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
  _fabricCred = uami
    ? new ChainedTokenCredential(new AcaManagedIdentityCredential(), new ManagedIdentityCredential({ clientId: uami }), new DefaultAzureCredential())
    : new DefaultAzureCredential();
  return _fabricCred;
}

/**
 * Opt-in mirror of the grant to the Fabric item /share endpoint. Returns a
 * hint string on failure (surfaced to the caller as a non-fatal note); never
 * throws — the Azure-native write is already the source of truth.
 *
 * POST /v1/workspaces/{ws}/items/{id}/users  (Fabric add-item-recipient).
 */
async function maybeFabricShare(opts: {
  fabricWorkspaceId?: string;
  fabricItemId?: string;
  principalId: string;
  principalType: 'user' | 'group';
  permissionTypes: ItemPermissionType[];
}): Promise<{ shared: boolean; hint?: string }> {
  if (!fabricPermissionsEnabled()) return { shared: false };
  if (!opts.fabricWorkspaceId || !opts.fabricItemId) {
    return { shared: false, hint: 'Fabric opt-in enabled but item is not bound to a Fabric workspace/item id — skipped (Azure-native grant is authoritative).' };
  }
  try {
    const t = await fabricCredential().getToken(FABRIC_SCOPE);
    if (!t?.token) return { shared: false, hint: 'Could not acquire a Fabric token for the opt-in /share mirror.' };
    const url = `${FABRIC_BASE}/workspaces/${encodeURIComponent(opts.fabricWorkspaceId)}/items/${encodeURIComponent(opts.fabricItemId)}/users`;
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        principal: { id: opts.principalId, type: opts.principalType === 'group' ? 'Group' : 'User' },
        itemPermissions: opts.permissionTypes,
      }),
      cache: 'no-store',
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { shared: false, hint: `Fabric /share returned ${res.status}: ${body.slice(0, 180)}` };
    }
    return { shared: true };
  } catch (e: any) {
    return { shared: false, hint: `Fabric /share failed: ${e?.message || String(e)}` };
  }
}

// ============================================================
// Grant
// ============================================================

export interface GrantItemPermissionInput {
  itemId: string;
  itemType: string;
  workspaceId: string;
  tenantId: string;
  principalId: string;
  principalType: 'user' | 'group';
  principalDisplayName?: string;
  principalUpn?: string;
  permissionTypes: ItemPermissionType[];
  grantedBy: string;
  /** ADLS container hosting the item's data (e.g. 'bronze'); enables ACL/RBAC mirror. */
  adlsContainer?: string;
  /** Path within the container (e.g. 'lakehouses/sales'); ACL applied here. */
  adlsPath?: string;
  /** Opt-in only: Fabric workspace + item id for the additive /share mirror. */
  fabricWorkspaceId?: string;
  fabricItemId?: string;
}

/**
 * Grant permission types to a principal on an item:
 *   1. Upsert the Cosmos row (source of truth).
 *   2. Mirror an ADLS POSIX ACL entry on the item's path (data-plane types).
 *   3. Grant Storage Blob Data Reader/Contributor at the container scope (ARM).
 *   4. OPT-IN: additively POST to the Fabric item /share endpoint.
 *
 * Steps 2-4 are best-effort: failures are captured as mirrorNotes on the
 * returned row (and a hint), but the Cosmos grant always persists so the
 * "Manage permissions" list reflects the user's intent. Read always implied.
 */
export async function grantItemPermission(input: GrantItemPermissionInput): Promise<ItemPermission> {
  // Read is always implied — Fabric never lets you share without at least Read.
  const types = Array.from(new Set<ItemPermissionType>(['Read', ...input.permissionTypes]));
  const notes: string[] = [];

  const doc: ItemPermission = {
    id: `${input.principalType}::${input.principalId}`,
    itemId: input.itemId,
    itemType: input.itemType,
    workspaceId: input.workspaceId,
    tenantId: input.tenantId,
    principalId: input.principalId,
    principalType: input.principalType,
    principalDisplayName: input.principalDisplayName,
    principalUpn: input.principalUpn,
    permissionTypes: types,
    grantedBy: input.grantedBy,
    grantedAt: new Date().toISOString(),
  };

  // 2. ADLS POSIX ACL mirror (data-plane permission types only).
  const bits = unionAclBits(types);
  if (bits && input.adlsContainer && input.adlsPath) {
    try {
      await upsertAclEntry(input.adlsContainer, input.adlsPath, input.principalId, input.principalType, bits);
      doc.aclGranted = true;
      doc.aclContainer = input.adlsContainer;
      doc.aclPath = input.adlsPath;
    } catch (e: any) {
      notes.push(`ADLS ACL grant failed on ${input.adlsContainer}/${input.adlsPath}: ${e?.message || String(e)}`);
    }
  } else if (bits && !(input.adlsContainer && input.adlsPath)) {
    notes.push('No ADLS storage path resolved for this item — granted Loom-side permission only (no POSIX ACL to mirror).');
  }

  // 3. ARM Storage data-plane RBAC at the container scope.
  const role = rbacRoleFor(types);
  if (role && input.adlsContainer) {
    try {
      const ra = await grantContainerRole(
        input.adlsContainer,
        input.principalId,
        role,
        input.principalType === 'group' ? 'Group' : 'User',
      );
      doc.rbacGranted = true;
      doc.rbacRoleName = ra.roleName || role;
      doc.rbacRoleAssignmentId = ra.id;
    } catch (e: any) {
      // 409 = role already assigned at scope — treat as success (idempotent).
      if (e?.status === 409) {
        doc.rbacGranted = true;
        doc.rbacRoleName = role;
      } else {
        notes.push(`Storage RBAC (${role}) grant failed on container '${input.adlsContainer}': ${e?.message || String(e)}`);
      }
    }
  }

  // 4. Opt-in Fabric /share (additive — never the default path).
  const fab = await maybeFabricShare({
    fabricWorkspaceId: input.fabricWorkspaceId,
    fabricItemId: input.fabricItemId,
    principalId: input.principalId,
    principalType: input.principalType,
    permissionTypes: types,
  });
  if (fab.shared) doc.fabricShared = true;
  if (fab.hint) doc.fabricHint = fab.hint;

  if (notes.length) doc.mirrorNotes = notes;

  // 1. Persist (source of truth) — last so the row reflects mirror outcomes.
  const c = await itemPermissionsContainer();
  const { resource } = await c.items.upsert<ItemPermission>(doc);
  return resource ?? doc;
}

// ============================================================
// Revoke
// ============================================================

/**
 * Revoke a principal's permissions on an item:
 *   1. Remove the principal's ADLS POSIX ACL entry (if one was applied).
 *   2. Revoke the ARM Storage RBAC assignment (if one was recorded).
 *   3. Delete the Cosmos row.
 *
 * RBAC/ACL removal is best-effort; the Cosmos delete always runs so the row
 * disappears from the Manage Permissions list. Note: AAD RBAC and POSIX ACL
 * revocations take effect for the principal on their NEXT sign-in / token
 * refresh (existing tokens live up to ~1h) — the UI surfaces this caveat.
 */
export async function revokeItemPermission(itemId: string, permissionDocId: string): Promise<{ notes: string[] }> {
  const notes: string[] = [];
  const c = await itemPermissionsContainer();

  let existing: ItemPermission | undefined;
  try {
    const { resource } = await c.item(permissionDocId, itemId).read<ItemPermission>();
    existing = resource ?? undefined;
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }

  if (existing) {
    if (existing.aclGranted && existing.aclContainer && existing.aclPath) {
      try {
        await removeAclEntry(existing.aclContainer, existing.aclPath, existing.principalId, existing.principalType);
      } catch (e: any) {
        notes.push(`ADLS ACL revoke failed: ${e?.message || String(e)}`);
      }
    }
    if (existing.rbacGranted && existing.rbacRoleAssignmentId) {
      try {
        await revokeContainerRoleAssignment(existing.rbacRoleAssignmentId);
      } catch (e: any) {
        if (e?.status !== 404) notes.push(`Storage RBAC revoke failed: ${e?.message || String(e)}`);
      }
    }
  }

  try {
    await c.item(permissionDocId, itemId).delete();
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }
  return { notes };
}

// Test-only: expose the client-local helpers. Pure decision logic
// (rbacRoleFor / unionAclBits / fabricPermissionsEnabled) is unit-tested
// directly against item-permissions-model (no @azure/* deps).
export const __testing = {
  maybeFabricShare,
};
