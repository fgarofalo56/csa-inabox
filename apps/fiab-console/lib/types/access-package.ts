/**
 * Access packages (access-governance Wave-2) — an entitlement bundle.
 *
 * A package is a named, requestable set of {resource, role} grants over
 * workspaces / items / data-products, plus an assignment policy (who governs
 * approval, default lifetime) and optional separation-of-duties conflicts. A
 * consumer requests the PACKAGE; on final approval every grant in it is
 * provisioned through the existing F16 machinery (one workflow doc per grant,
 * tagged with the package id) and recorded in the W1 entitlement ledger.
 *
 * Stored in the `access-packages` Cosmos container (PK /tenantId).
 */

/** One {resource, role} grant inside a package. */
export interface PackageGrant {
  /** adls-container | warehouse | kql-database | workspace | item | data-product | collection */
  resourceType: string;
  resourceRef: string;
  resourceName?: string;
  /** Logical role/permission conferred (Viewer / Reader / read …). */
  role: string;
  permission?: string;
}

export type SodMode = 'block' | 'warn';

export interface AccessPackage {
  id: string;
  tenantId: string;
  kind: 'access-package';
  name: string;
  description?: string;
  grants: PackageGrant[];
  /** Assignment policy: whether users may request this package. */
  requestable: boolean;
  /** Approval policy governing requests for this package (else the default policy). */
  approvalPolicyId?: string;
  /** W3 — default grant lifetime; null = permanent. Sets expiresAt at grant time. */
  defaultLifetimeDays?: number | null;
  /** W3 — PIM: when true, approval yields an ELIGIBLE assignment the user must
   *  activate (rather than an immediately-active grant). */
  activationRequired?: boolean;
  /** W3 — activation window in hours (how long an activated grant lasts). */
  activationWindowHours?: number | null;
  /** Separation-of-duties: package ids incompatible with this one. */
  sodConflictsWith?: string[];
  /** How a SoD conflict is treated at request time. */
  sodMode?: SodMode;
  enabled: boolean;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}
