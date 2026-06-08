/**
 * OneLake Security (F7) — pure validation + naming helpers, with NO Azure SDK
 * imports so they can be unit-tested in isolation (the Azure clients pull in
 * @azure/identity, which the symlinked pnpm store can't resolve under vitest).
 * `onelake-security-client.ts` re-exports everything here.
 */

export type OneLakeSecurityItemType = 'lakehouse' | 'mirrored-database' | 'mirrored-catalog';
export type OneLakePermission = 'Read' | 'ReadWrite';
export type SecurityRoleMemberType = 'User' | 'Group' | 'ServicePrincipal';

/** cosmosId = `${itemId}:${roleName.toLowerCase()}` — one doc per role per item. */
export function roleDocId(itemId: string, roleName: string): string {
  return `${itemId}:${roleName.toLowerCase()}`;
}

/** Fabric's documented role-name rule: starts with a letter, alphanumeric,
 *  max 128 chars. We enforce the same so an opt-in Fabric sync never rejects. */
export const ROLE_NAME_RE = /^[A-Za-z][A-Za-z0-9]{0,127}$/;

/** A path is valid when it's '*' or starts with /Tables/ or /Files/. */
export function isValidRolePath(p: string): boolean {
  if (p === '*') return true;
  return /^\/(Tables|Files)\/.+/.test(p) || /^\/(Tables|Files)$/.test(p);
}

/** Mirrored items are read-only mirrors — only Read is a valid permission. */
export function allowedPermissions(itemType: OneLakeSecurityItemType): OneLakePermission[] {
  return itemType === 'lakehouse' ? ['Read', 'ReadWrite'] : ['Read'];
}
