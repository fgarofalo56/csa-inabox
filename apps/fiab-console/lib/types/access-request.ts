/**
 * F15 — Data-product access request.
 *
 * One document per consumer "Request access" submission, stored in the
 * `access-requests` Cosmos container (partition key `/dataProductId`). The
 * request is bound to a permitted *purpose* — an `Access`-kind governance
 * policy the owner defined for this data product (scope `data-product:<id>`).
 *
 * Lifecycle mirrors the Purview Unified Catalog request states:
 *   pending → approved | rejected, and approved → completed once provisioned.
 */
export type AccessRequestStatus = 'pending' | 'approved' | 'rejected' | 'completed';

/** DP-10 — attestations the requester accepts on submission. */
export interface AccessRequestAttestations {
  /** No-copy: the consumer will not extract/copy the data outside the grant. */
  noCopy?: boolean;
  /** Accepts the product's terms of use. */
  termsOfUse?: boolean;
  /** A custom owner-defined attestation. */
  custom?: boolean;
}

/** DP-10 — a single resolved+granted target captured on fulfillment. */
export interface ProvisionedTarget {
  scopeType: string;
  scopeRef: string;
  roleName?: string;
  roleAssignmentId?: string;
  status: 'active' | 'pending' | 'error';
  detail?: string;
  source?: string;
}

export interface AccessRequest {
  id: string;
  /** Partition key — the data product item id this request targets. */
  dataProductId: string;
  /** Human-readable data product name captured at request time. */
  dataProductName?: string;
  /** Requester Entra object id (session.claims.oid). */
  requesterId: string;
  /** Requester UPN/email captured for the approver inbox. */
  requesterUpn: string;
  /** The owner's Access-policy id the request is bound to. */
  policyId: string;
  /** Human-readable purpose label from the policy (its `name`). */
  purposeName: string;
  /** DP-10 — the usage purpose the requester selected (may equal purposeName). */
  usagePurpose?: string;
  /** DP-10 — attestations the requester accepted. */
  attestations?: AccessRequestAttestations;
  /** Optional free-text justification typed by the requester. */
  justification?: string;
  status: AccessRequestStatus;
  createdAt: string;
  updatedAt: string;
  reviewedBy?: string;
  reviewedAt?: string;
  reviewComment?: string;
  /** DP-10 — zero-touch fulfillment outcome (set when the owner approves). */
  provisioned?: boolean;
  provisionedAt?: string;
  provisionedTargets?: ProvisionedTarget[];
  /** DP-10 — honest-gate note when fulfillment couldn't fully grant. */
  fulfillmentNote?: string;
}
