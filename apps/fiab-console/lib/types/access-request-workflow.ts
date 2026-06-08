/**
 * Access-request approval workflow types (F16) — shared by the BFF routes and
 * the inbox editor.
 *
 * A data-asset access request advances through four approval tiers, in order:
 *
 *   manager → privacy → approver → access-provider
 *
 * Each tier approves or denies. Approval advances to the next tier; the final
 * (access-provider) approval provisions a REAL Azure RBAC grant on the backing
 * data store via enforceAccessGrant (lib/azure/access-policy-client.ts) and
 * marks the requester a subscriber. A denial at any tier closes the request
 * with the supplied reason. Every decision writes an audit-log entry.
 *
 * No Microsoft Fabric / Power BI dependency — the grant is a pure Azure ARM
 * Storage / Synapse SQL / ADX data-plane assignment (no-fabric-dependency.md).
 */

import type { AccessPermission, AccessScopeType, PrincipalType } from '@/lib/azure/access-policy-client';

export type ApprovalTier = 'manager' | 'privacy' | 'approver' | 'access-provider';
export type ApprovalStatus = 'open' | 'denied' | 'completed';

/** Ordered approval tiers — index drives the state machine. */
export const TIER_SEQUENCE: ApprovalTier[] = ['manager', 'privacy', 'approver', 'access-provider'];

/** Human label per tier for the inbox tab strip. */
export const TIER_LABEL: Record<ApprovalTier, string> = {
  'manager': 'Manager',
  'privacy': 'Privacy reviewer',
  'approver': 'Approver',
  'access-provider': 'Access provider',
};

/** A single tier's recorded decision. */
export interface ApprovalStep {
  decision: 'approved' | 'denied';
  by: string;       // UPN of the approver
  byOid: string;    // approver object id
  at: string;       // ISO-8601
  reason?: string;
}

/** Result of the real RBAC grant performed at the final tier. */
export interface AccessRequestEnforcement {
  status: 'active' | 'pending' | 'error';
  roleName?: string;
  roleAssignmentId?: string;
  detail?: string;
}

/** Cosmos doc for one access request (container `access-request-workflow`, PK /tenantId). */
export interface AccessRequestDoc {
  id: string;
  tenantId: string;          // partition key — requester's s.claims.oid
  kind: 'access-request';
  assetId: string;
  assetName: string;
  itemType: string;
  scopeType: AccessScopeType; // 'adls-container' | 'warehouse' | 'kql-database' | ...
  scopeRef: string;           // container / db name the grant binds to
  permission: AccessPermission;
  justification: string;
  requesterId: string;        // oid
  requesterUpn: string;
  requestedAt: string;
  tier: ApprovalTier;
  status: ApprovalStatus;
  managerApproval?: ApprovalStep;
  privacyApproval?: ApprovalStep;
  approverApproval?: ApprovalStep;
  accessProviderApproval?: ApprovalStep;
  enforcement?: AccessRequestEnforcement;
  subscribedAt?: string;
  deniedAt?: string;
  denialReason?: string;
  /** Tier that issued the denial (for the receipt). */
  deniedAtTier?: ApprovalTier;
}

/** Map a tier to the doc field that records its decision. */
export const TIER_APPROVAL_KEY: Record<ApprovalTier, keyof AccessRequestDoc> = {
  'manager': 'managerApproval',
  'privacy': 'privacyApproval',
  'approver': 'approverApproval',
  'access-provider': 'accessProviderApproval',
};

/**
 * Infer the Azure-native grant scope type from a catalog item type. Lakehouses
 * map to ADLS containers, warehouses to Synapse SQL, KQL/eventhouse to ADX.
 * Everything else defaults to adls-container (the most common data asset);
 * the access provider can override the scope at the final tier.
 */
export function inferScopeType(itemType: string): AccessScopeType {
  const t = (itemType || '').toLowerCase();
  if (t === 'warehouse' || t === 'mirrored-warehouse') return 'warehouse';
  if (t === 'kql-database' || t === 'eventhouse' || t === 'kusto-database') return 'kql-database';
  return 'adls-container';
}
