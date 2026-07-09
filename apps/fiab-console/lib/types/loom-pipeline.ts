/**
 * Loom-native deployment pipelines — shared types.
 *
 * The Azure-native DEFAULT for Fabric "Deployment pipelines" (no-fabric-dependency.md):
 * a pipeline is an ordered list of stages (Development → Test → Production),
 * each bound to a Loom workspace (Cosmos `workspaces` container). Compare runs
 * a content-level diff over the serialized item definitions (TMSL for semantic
 * models, JSON for reports / paginated reports / scorecards). Selective deploy
 * re-provisions the chosen items into the next stage's workspace through the
 * SAME real provisioners the install path uses, applying that stage's
 * deployment rules (parameter / data-source overrides) first.
 *
 * No Microsoft Fabric or Power BI workspace is required for any of this — the
 * pipeline, stages, rules, and history all live in Cosmos and the deploy calls
 * the Azure-native provisioner backends.
 */

import type { PipelineDiffPair } from '../install/pipeline-compare';

/** One stage in a Loom-native pipeline. */
export interface LoomPipelineStage {
  /** Stable uuid generated at pipeline-create time. */
  id: string;
  displayName: string;
  /** 0-based order — permanent once created (Dev=0, Test=1, Prod=2, …). */
  order: number;
  /** Loom workspace id this stage is bound to (Cosmos `workspaces` container). */
  workspaceId: string;
  /** Cached workspace name for display (best-effort; refreshed on read). */
  workspaceName?: string;
}

/** A Loom-native deployment pipeline document (Cosmos `loom-pipelines`). */
export interface LoomPipeline {
  /** Cosmos document id (uuid). */
  id: string;
  /** Partition key — caller's oid (tenant). */
  tenantId: string;
  displayName: string;
  description?: string;
  stages: LoomPipelineStage[];
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

/** The set of known override keys, grouped by rule kind. Mirrors the Fabric
 * deployment-rule surface (data-source rules + parameter rules) but mapped onto
 * the Azure-native ProvisionTarget fields. */
export const RULE_KINDS = ['datasource', 'parameter'] as const;
export type LoomRuleKind = (typeof RULE_KINDS)[number];

export const DATASOURCE_KEYS = [
  'warehouseServer',
  'warehouseDatabase',
  'adlsAccount',
  'adlsContainer',
  'synapseWorkspace',
  'kustoClusterUri',
  'kustoDatabase',
  'aiSearchService',
] as const;

export const PARAMETER_KEYS = [
  'synapseWorkspace',
  'adlsAccount',
  'warehouseServer',
  'warehouseDatabase',
] as const;

export type LoomRuleKey = (typeof DATASOURCE_KEYS)[number] | (typeof PARAMETER_KEYS)[number];

/** Allowed keys per kind — used by both the route validator and the editor. */
export function allowedKeysForKind(kind: LoomRuleKind): readonly string[] {
  return kind === 'datasource' ? DATASOURCE_KEYS : PARAMETER_KEYS;
}

/** One per-stage deployment rule. On deploy into the stage, the matching
 * ProvisionTarget field is overridden with `value` before the item is
 * re-provisioned (Fabric's "data-source rule" / "parameter rule" parity). */
export interface LoomDeployRule {
  /** Item type the rule applies to, or '*' for every type. */
  itemType: string;
  /** Item display name the rule applies to ('*' / undefined = all of that type). */
  itemDisplayName?: string;
  kind: LoomRuleKind;
  /** Which ProvisionTarget field to override (see DATASOURCE_KEYS / PARAMETER_KEYS). */
  key: string;
  /** The override value applied for the target stage. */
  value: string;
}

/** Cosmos doc holding the rules for one stage (`pipeline-stage-rules`). */
export interface LoomPipelineStageRulesDoc {
  /** id = `rules:<pipelineId>:<stageId>`. */
  id: string;
  /** Partition key. */
  pipelineId: string;
  stageId: string;
  rules: LoomDeployRule[];
  updatedAt: string;
  updatedBy: string;
}

// ---------------------------------------------------------------------------
// BR-APPROVAL — required-reviewer promotion gates.
//
// A stage can require N approvals from named users/groups before a promotion
// INTO it runs. The policy + the request lifecycle live in the SAME Cosmos
// container as the stage rules (`pipeline-stage-rules`, PK /pipelineId) —
// discriminated by `docType` and an id prefix — so no new container / bicep
// param is introduced. The pure state machine is lib/install/pipeline-approvals.
// ---------------------------------------------------------------------------

/** A named reviewer (user or Entra group) permitted to approve a promotion. */
export interface LoomApprover {
  /** Entra object id — a user oid or a group id (matched against session claims). */
  id: string;
  type: 'user' | 'group';
  /** Display name for the reviewer list (UPN / group name). */
  displayName: string;
}

/** Per-stage required-reviewer policy (`approval-policy:<pipelineId>:<stageId>`). */
export interface LoomApprovalPolicyDoc {
  /** id = `approval-policy:<pipelineId>:<stageId>`. */
  id: string;
  docType: 'approval-policy';
  /** Partition key. */
  pipelineId: string;
  stageId: string;
  /** When false the stage promotes without any gate (default / opt-out). */
  enabled: boolean;
  /** How many distinct approvals are required before the promotion runs. */
  requiredApprovals: number;
  approvers: LoomApprover[];
  updatedAt: string;
  updatedBy: string;
}

export type LoomApprovalStatus =
  | 'pending' | 'approved' | 'rejected' | 'cancelled' | 'promoted' | 'promotion-failed';

/** One reviewer's decision on a request. */
export interface LoomApprovalDecision {
  approverOid: string;
  approverName: string;
  decision: 'approve' | 'reject';
  comment?: string;
  at: string;
}

/** A pending/settled promotion approval request (`approval-request:<uuid>`). */
export interface LoomApprovalRequest {
  /** id = `approval-request:<uuid>`. */
  id: string;
  docType: 'approval-request';
  /** Partition key. */
  pipelineId: string;
  /** Owning tenant (oid) — carried for audit scoping. */
  tenantId: string;
  sourceStageId: string;
  targetStageId: string;
  /** Snapshot of the policy at request time (approvers can change later). */
  requiredApprovals: number;
  approvers: LoomApprover[];
  /** Optional selective-deploy item list to promote once approved. */
  items?: Array<{ sourceItemId: string; itemType: string }>;
  note?: string;
  /** A short diff summary the approver sees ("what would promote"). */
  diffSummary: string;
  status: LoomApprovalStatus;
  decisions: LoomApprovalDecision[];
  requestedBy: string;
  requestedByOid: string;
  createdAt: string;
  updatedAt: string;
  /** Set once promoted — the pipeline-history operation id. */
  promotionOperationId?: string;
}

/** A deployment receipt — one row per selective/full deploy (`pipeline-history`). */
export interface LoomPipelineHistoryRecord {
  /** uuid. */
  id: string;
  /** Partition key. */
  pipelineId: string;
  sourceStageId: string;
  targetStageId: string;
  status: 'running' | 'succeeded' | 'partial' | 'failed';
  note?: string;
  /** The diff computed at deploy time (the receipt). */
  diff: PipelineDiffPair[];
  /** Cosmos item ids created/updated in the target workspace (the receipt). */
  deployedItemIds: string[];
  steps: string[];
  startedAt: string;
  completedAt?: string;
  startedBy: string;
}
