/**
 * Data-product access-policy model (F8 — "Manage policies").
 *
 * Stored as `state.accessPolicy` on the `data-product` WorkspaceItem in the
 * Cosmos `items` container — no separate container. Mirrors Microsoft Purview's
 * data-product "Manage access" surface: allowed purposes, a manager-approval
 * tier, a privacy/compliance-review tier, named approvers, and an access
 * provider. The ordered tier sequence (manager → privacy → approver → provider)
 * drives the access-request workflow (T13/T14).
 */

export type PrincipalKind = 'User' | 'Group';

export interface PolicyPrincipal {
  /** Entra object id (OID for users, group id for groups). */
  id: string;
  /** User principal name (UPN) for users; falls back to mail / displayName for groups. */
  upn: string;
  displayName: string;
  type: PrincipalKind;
}

export interface AllowedPurpose {
  name: string;
  description: string;
}

export interface DataProductAccessPolicy {
  allowedPurposes: AllowedPurpose[];
  requireManagerApproval: boolean;
  requirePrivacyReview: boolean;
  approvers: PolicyPrincipal[];
  accessProvider: PolicyPrincipal | null;
  updatedAt?: string;
  updatedBy?: string;
}

/** Purview's default permitted-use purposes, seeded on first open. */
export const DEFAULT_PURPOSES: AllowedPurpose[] = [
  { name: 'Analytics', description: 'Use for internal analytics and reporting.' },
  { name: 'Machine learning', description: 'Training and evaluation of ML models.' },
  { name: 'Product development', description: 'Informing product features and roadmap.' },
];

export function defaultAccessPolicy(): DataProductAccessPolicy {
  return {
    allowedPurposes: [],
    requireManagerApproval: false,
    requirePrivacyReview: false,
    approvers: [],
    accessProvider: null,
  };
}

/** Coerce arbitrary stored JSON into a well-formed policy (defensive read path). */
export function normalizeAccessPolicy(raw: unknown): DataProductAccessPolicy {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const purposes = Array.isArray(p.allowedPurposes) ? (p.allowedPurposes as any[]) : [];
  const approvers = Array.isArray(p.approvers) ? (p.approvers as any[]) : [];
  const provider = p.accessProvider && typeof p.accessProvider === 'object' ? (p.accessProvider as any) : null;
  const cleanPrincipal = (x: any): PolicyPrincipal | null => {
    if (!x || typeof x !== 'object' || !x.id) return null;
    return {
      id: String(x.id),
      upn: String(x.upn || x.mail || x.displayName || x.id),
      displayName: String(x.displayName || x.upn || x.id),
      type: x.type === 'Group' ? 'Group' : 'User',
    };
  };
  return {
    allowedPurposes: purposes
      .filter((x) => x && typeof x === 'object' && typeof x.name === 'string')
      .map((x) => ({ name: String(x.name).trim(), description: String(x.description || '').trim() }))
      .filter((x) => x.name.length > 0),
    requireManagerApproval: !!p.requireManagerApproval,
    requirePrivacyReview: !!p.requirePrivacyReview,
    approvers: approvers.map(cleanPrincipal).filter((x): x is PolicyPrincipal => x !== null),
    accessProvider: cleanPrincipal(provider),
    updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : undefined,
    updatedBy: typeof p.updatedBy === 'string' ? p.updatedBy : undefined,
  };
}

/**
 * Ordered approval tiers derived from the policy. Empty list means access
 * requests auto-approve. Used by both the dialog preview and the
 * access-request workflow.
 */
export interface PolicyTier {
  key: 'manager' | 'privacy' | 'approver' | 'provider';
  label: string;
  detail?: string;
}

export function policyTiers(p: DataProductAccessPolicy): PolicyTier[] {
  const tiers: PolicyTier[] = [];
  if (p.requireManagerApproval) tiers.push({ key: 'manager', label: 'Manager approval' });
  if (p.requirePrivacyReview) tiers.push({ key: 'privacy', label: 'Privacy & compliance review' });
  if (p.approvers.length > 0) {
    tiers.push({ key: 'approver', label: 'Approver', detail: p.approvers.map((a) => a.upn).join(', ') });
  }
  if (p.accessProvider) {
    tiers.push({ key: 'provider', label: 'Access provider', detail: p.accessProvider.upn });
  }
  return tiers;
}
