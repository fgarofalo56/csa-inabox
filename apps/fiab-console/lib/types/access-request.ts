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
  /** Optional free-text justification typed by the requester. */
  justification?: string;
  status: AccessRequestStatus;
  createdAt: string;
  updatedAt: string;
  reviewedBy?: string;
  reviewedAt?: string;
  reviewComment?: string;
}
