/**
 * Sign-in-boundary access request (onboarding queue).
 *
 * DISTINCT from the two data-plane access-request systems:
 *   - `access-requests` (PK /dataProductId) — marketplace data-product access
 *   - `access-request-workflow` (PK /tenantId) — the F16 multi-tier approval
 * Those grant a KNOWN, already-signed-in user access to a specific asset. THIS
 * one is the front-door onboarding queue: a person who cannot get INTO Loom at
 * all (not in the admin Entra group, no workspace) fills in their Microsoft
 * identity so a tenant admin can set them up as a new user.
 *
 * One document per submission, stored in the `signin-access-requests` Cosmos
 * container (PK `/tenantId`, the deployment tenant bucket — these submissions
 * are unauthenticated so there is no per-user partition to key on). Lifecycle:
 *   pending → approved | denied.
 */
export type SigninAccessRequestStatus = 'pending' | 'approved' | 'denied';

export interface SigninAccessRequest {
  id: string;
  /** Partition key — the deployment tenant bucket (hashed AZURE_TENANT_ID). */
  tenantId: string;
  /** Requester's stated full name. */
  displayName: string;
  /** Requester's work email / UPN (lower-cased, the dedupe + notify key). */
  email: string;
  /** Requester's organization / company (optional but encouraged). */
  organization?: string;
  /** Why they need access — free text, capped at 500 chars. */
  reason: string;
  /** Optional Entra object id the requester supplied (if they know it). */
  aadObjectId?: string;
  /** Optional Entra tenant id the requester supplied. */
  aadTenantId?: string;
  status: SigninAccessRequestStatus;
  /** Always 'signin' for now — reserved for future request origins. */
  source: 'signin';
  createdAt: string;
  updatedAt: string;
  /** SHA-256 (first 12 chars) of the submitting IP — audit without storing PII. */
  clientIpHash?: string;
  /** Admin UPN who actioned the request. */
  reviewedBy?: string;
  /** Admin Entra oid who actioned the request. */
  reviewedByOid?: string;
  reviewedAt?: string;
  /** Admin note recorded with the decision (required on deny). */
  decisionNote?: string;
}
