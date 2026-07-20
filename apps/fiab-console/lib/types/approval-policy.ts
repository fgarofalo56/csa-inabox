/**
 * Configurable approval policies (access-governance Wave-2).
 *
 * Replaces the hard-coded TIER_SEQUENCE with a per-scope policy. A policy
 * selects an ORDERED SUBSET of the four canonical approval stages
 * (manager → privacy → approver → access-provider) and binds named approvers to
 * each. Keeping the canonical stage KEYS (rather than free-form stages) means
 * the request doc's `tier` stays one of the four legacy values, so the F16 inbox
 * — which renders the four fixed tiers — keeps working unchanged. The DEFAULT
 * policy enables all four stages, i.e. behaviour identical to the legacy
 * sequence. Stored in the `approval-policies` Cosmos container (PK /tenantId).
 */
import type { ApprovalTier } from './access-request-workflow';

/** Canonical stage keys — the same four the F16 inbox renders. */
export type ApprovalStageKey = ApprovalTier;

export interface ApproverBinding {
  type: 'user' | 'group';
  id: string;
  name?: string;
}

export interface PolicyStage {
  key: ApprovalStageKey;
  enabled: boolean;
  /** Named approvers for this stage (optional; empty = anyone in the inbox). */
  approvers?: ApproverBinding[];
}

export type PolicyScopeKind = 'default' | 'resource-type' | 'package';

export interface ApprovalPolicy {
  id: string;
  tenantId: string;
  kind: 'approval-policy';
  name: string;
  description?: string;
  /** default (fallback) | resource-type (ref=itemType) | package (ref=packageId). */
  scope: { kind: PolicyScopeKind; ref?: string };
  /** Canonical order; a subset may be disabled. */
  stages: PolicyStage[];
  /** When true, only a stage's named approvers (or a tenant admin) may act. */
  enforceApprovers?: boolean;
  enabled: boolean;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Immutable snapshot stamped onto a workflow doc at request time so a mid-flight
 * request is stable even if the policy changes later.
 */
export interface ApprovalPlan {
  policyId?: string;
  /** Ordered, enabled stage keys (always ends at 'access-provider'). */
  stages: ApprovalStageKey[];
  /** Named approvers per stage (only stages that declare any). */
  approvers?: Partial<Record<ApprovalStageKey, ApproverBinding[]>>;
  enforceApprovers?: boolean;
}
