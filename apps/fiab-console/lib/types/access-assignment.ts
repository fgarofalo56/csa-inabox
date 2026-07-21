/**
 * Access-governance entitlement ledger (Wave-1).
 *
 * One document per effective access grant, in the `access-assignments` Cosmos
 * container (partition key `/principalId` so "what can principal X reach" is a
 * single-partition read). Every grant path in Loom — the F16 governed approval
 * workflow, F15 data-product fulfillment, and workspace ACL changes — appends a
 * row here so the unified "who has access" report has one authoritative source
 * instead of scraping the audit log. See PRPs/active/access-governance/PRP.md.
 *
 * The row's `id` is DETERMINISTIC (a hash of principal + resource + source) so a
 * re-grant upserts the same row rather than duplicating it, and a revoke can
 * target it without a lookup. `expiresAt` is nullable now and populated by W3
 * (time-bound / PIM).
 */

/** Which grant track wrote the assignment. `package:`/`group:` are W2/W4. */
export type AssignmentSource =
  | 'direct'          // F16 governed multi-tier approval → real RBAC
  | 'data-product'    // F15 marketplace subscribe → zero-touch fulfillment
  | 'marketplace'     // WS-10.4 Living Marketplace subscribe (unified 5-type product entitlement)
  | 'workspace-acl'   // F5 Manage-access workspace role (mirrored to Azure RBAC)
  | 'self-serve'      // self-serve immediate grant
  | `package:${string}`
  | `group:${string}`;

/**
 * active   — granted and in force (real RBAC provisioned).
 * eligible — assigned but NOT active (PIM-style): no RBAC yet; the principal must
 *            activate it to receive a time-bounded grant (W3).
 * expired  — was active, past its expiresAt; swept + revoked.
 * revoked  — explicitly revoked.
 */
export type AssignmentState = 'active' | 'eligible' | 'expired' | 'revoked';

export type AssignmentPrincipalType = 'User' | 'Group' | 'ServicePrincipal';

export interface AccessAssignment {
  /** Deterministic id — hash of principalId|resourceType|resourceRef|source. */
  id: string;
  /** Partition key — the Entra object id of the granted principal (or group). */
  principalId: string;
  principalUpn?: string;
  principalType: AssignmentPrincipalType;
  /** Deployment tenant bucket, for the admin tenant-wide report filter. */
  tenantId: string;
  /** Grant scope type (adls-container | warehouse | kql-database | workspace | item | data-product | collection). */
  resourceType: string;
  /** The concrete backing resource the grant binds to (container/db/workspaceId/itemId). */
  resourceRef: string;
  resourceName?: string;
  /** The role conferred (Viewer / db_datareader / Storage Blob Data Reader / ADX viewer …). */
  role: string;
  /** Logical permission (read | write | admin), where the source tracks one. */
  permission?: string;
  source: AssignmentSource;
  /** Originating request/role id (F15/F16 request id, workspace-role id). */
  sourceRef?: string;
  /** UPN of the approver/actor who granted it. */
  grantedBy?: string;
  grantedAt: string;
  /** Real ARM role-assignment id, where the grant produced one. */
  roleAssignmentId?: string;
  /** W3 — populated by time-bound/PIM; null = permanent. */
  expiresAt?: string | null;
  /** W3 — activation window (hours) carried on an eligible row for activation. */
  activationWindowHours?: number | null;
  state: AssignmentState;
  revokedAt?: string;
  revokedBy?: string;
  updatedAt: string;
}

/** Input to record a grant — the ledger fills id/state/timestamps. */
export interface RecordAssignmentInput {
  principalId: string;
  principalUpn?: string;
  principalType?: AssignmentPrincipalType;
  tenantId: string;
  resourceType: string;
  resourceRef: string;
  resourceName?: string;
  role: string;
  permission?: string;
  source: AssignmentSource;
  sourceRef?: string;
  grantedBy?: string;
  roleAssignmentId?: string;
  expiresAt?: string | null;
  activationWindowHours?: number | null;
  /** W3 — initial state; 'active' (default) or 'eligible' (PIM assign-not-active). */
  state?: AssignmentState;
}
