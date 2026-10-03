/**
 * The Azure store a Loom item's data lives in, read only from bindings Loom
 * recorded for the item. Shared by label protection (lib/azure/label-protection.ts)
 * and catalog access requests (lib/access/request-asset.ts), which both place a
 * grant on it. Pure and dependency-light on purpose: no Graph or ARM client.
 */
import type { AccessScopeType } from './access-policy-client';
import type { WorkspaceItem } from '../types/workspace';

export type BackingScope =
  | { scopeType: AccessScopeType; scopeRef: string }
  | { pending: string };

/**
 * Resolve the Azure backing-store scope for a Loom workspace item, so F21 can
 * enforce a real RBAC grant on it.
 *
 * The scope is read ONLY from bindings Loom records itself — never from a
 * field a request body may write — and an item with no such binding returns
 * `{ pending }` (an honest gate, per no-vaporware.md) instead of falling back to
 * a guessed store:
 *
 *   lakehouse                 → ADLS container: the installer receipt
 *                               (`state.provisioning.secondaryIds.container`),
 *                               then `state.adlsContainer`, then a single
 *                               `state.ownedContainers` entry. All three are
 *                               server-recorded (`SERVER_DERIVED_SCOPE_KEYS` in
 *                               app/api/items/_lib/server-derived-scope.ts) and
 *                               cleared on create (`LAKEHOUSE_CREATE_CLEARED_STATE_KEYS`).
 *                               This is the same order `items/[type]/[id]/permissions`
 *                               places its grants with.
 *   warehouse                 → the deployment's Synapse dedicated pool
 *                               (`LOOM_SYNAPSE_DEDICATED_POOL`). `enforceAccessGrant`
 *                               always grants on that env-pinned pool; the
 *                               scopeRef only names it.
 *   kql-database / eventhouse → the ADX database in the provisioning receipt
 *                               (`secondaryIds.database`, else `resourceId`) of a
 *                               successful install — the precedence
 *                               `_lib/adx-item-scope.ts` uses.
 */
export function resolveItemBackingScope(item: WorkspaceItem): BackingScope {
  const state = (item.state || {}) as Record<string, unknown>;
  const prov = (state.provisioning && typeof state.provisioning === 'object'
    ? state.provisioning : {}) as Record<string, unknown>;
  const sec = (prov.secondaryIds && typeof prov.secondaryIds === 'object'
    ? prov.secondaryIds : {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  switch (item.itemType) {
    case 'lakehouse': {
      const owned = Array.isArray(state.ownedContainers)
        ? (state.ownedContainers as unknown[]).map(str).filter(Boolean) : [];
      const container = str(sec.container) || str(state.adlsContainer) || (owned.length === 1 ? owned[0] : '');
      if (!container) {
        return {
          pending:
            'This lakehouse has no storage container recorded by Loom yet, so there is no store to apply '
            + 'label protection to. Open the lakehouse once so Loom binds its storage, then apply the label again.',
        };
      }
      return { scopeType: 'adls-container', scopeRef: container };
    }
    case 'warehouse': {
      const pool = str(process.env.LOOM_SYNAPSE_DEDICATED_POOL);
      if (!pool) {
        return {
          pending:
            'The Azure-native warehouse is not configured: set LOOM_SYNAPSE_WORKSPACE and '
            + 'LOOM_SYNAPSE_DEDICATED_POOL to enforce label protection on warehouse items.',
        };
      }
      return { scopeType: 'warehouse', scopeRef: pool };
    }
    case 'kql-database':
    case 'eventhouse': {
      const installed = prov.status === 'created' || prov.status === 'exists';
      const db = installed ? (str(sec.database) || str(prov.resourceId)) : '';
      if (!db) {
        return {
          pending:
            `This ${item.itemType} has no ADX database recorded by a Loom install, so label protection `
            + 'cannot be applied as a database role here. Apply it to the database from a tenant-admin '
            + 'access policy instead.',
        };
      }
      return { scopeType: 'kql-database', scopeRef: db };
    }
    default:
      return {
        pending:
          `Item type "${item.itemType}" has no Azure backing scope for label RBAC enforcement. ` +
          `Scope label protection to a lakehouse, warehouse, or kql-database item.`,
      };
  }
}
