/**
 * Shared promotion engine for the Loom-native deployment pipelines.
 *
 * Extracted from the deploy route so BOTH entry points that can execute a
 * promotion — the direct `POST .../deploy` (no approval gate) and the
 * `POST .../approvals/[requestId]` route (final required approval, BR-APPROVAL)
 * — run the exact same, single implementation.
 *
 * What a promotion does, per chosen source item:
 *   1. resolve the item's `{{var:NAME}}` placeholder tokens against the TARGET
 *      stage's Variable Library value set (FGC-24) — stage-appropriate values
 *      (connection strings / ids / env values) are substituted into the
 *      definition BEFORE it is written to the destination workspace;
 *   2. apply that stage's deployment rules (data-source / parameter overrides)
 *      to the base ProvisionTarget;
 *   3. promote the (rebound) definition into the target workspace — updating the
 *      paired item or creating a new one, and WRITING the definition onto that
 *      item BEFORE step 4 (see the note at the write: a provisioner that
 *      verifies its own content must not be shown the previous promotion's);
 *   4. re-run the SAME real provisioner the install path uses against the
 *      patched target, so the model/report/etc. is materialized in Test/Prod;
 *   5. persist the provision receipt and write a history record.
 *
 * Cosmos + the Azure-native provisioner backends only — no Fabric / Power BI.
 */
import crypto from 'node:crypto';
import { listAllOwnedItems, createOwnedItem, updateOwnedItem } from '@/app/api/items/_lib/item-crud';
import { PROVISIONERS, resolveTarget } from '@/lib/install/provisioning-engine';
import { applyStageRules } from '@/lib/install/pipeline-deploy';
import { computePipelineDiff, pairKey } from '@/lib/install/pipeline-compare';
import {
  stageValueSet, collectStageVariableValues, rebindContent,
} from '@/lib/install/pipeline-variables';
import { pipelineHistoryContainer } from '@/lib/azure/cosmos-client';
import type { ProvisionResult } from '@/lib/install/provisioners/types';
import type { VarDef } from '@/lib/variables/resolve';
import type { LoomPipeline, LoomPipelineStage, LoomPipelineHistoryRecord } from '@/lib/types/loom-pipeline';
import type { WorkspaceItem } from '@/lib/types/workspace';
import type { SessionPayload } from '@/lib/auth/session';
import { loadStageRules, stageWorkspaceId } from './pipeline-store';

const VARIABLE_LIBRARY_TYPE = 'variable-library';

export interface StageResolveError {
  error: string;
  status: number;
  code: string;
}

/**
 * Validate the source/target stage pair for a promotion: both must exist and be
 * bound to DISTINCT workspaces (a shared workspace can never promote, since the
 * deploy would modify its own source). Returns the resolved workspace ids or a
 * typed error the route surfaces verbatim.
 */
export function resolvePromotionStages(
  pipeline: LoomPipeline,
  sourceStageId: string,
  targetStageId: string,
): { srcWs: string; tgtWs: string; targetStage: LoomPipelineStage } | StageResolveError {
  const srcWs = stageWorkspaceId(pipeline, sourceStageId);
  const tgtWs = stageWorkspaceId(pipeline, targetStageId);
  const targetStage = pipeline.stages.find((s) => s.id === targetStageId);
  if (!srcWs) return { error: 'source stage not found in pipeline', status: 400, code: 'bad_request' };
  if (!tgtWs || !targetStage) return { error: 'target stage not found in pipeline', status: 400, code: 'bad_request' };
  if (srcWs === tgtWs) {
    const srcName = pipeline.stages.find((st) => st.id === sourceStageId)?.displayName || 'source';
    const tgtName = targetStage.displayName || 'target';
    return {
      error: `Stages "${srcName}" and "${tgtName}" are bound to the same workspace, so content can't be promoted between them. Re-bind one stage to a distinct workspace, then deploy again.`,
      status: 400,
      code: 'duplicate_workspace',
    };
  }
  return { srcWs, tgtWs, targetStage };
}

/** Extract the `state.variables[]` arrays from every variable-library item in a list. */
function variableSetsFrom(items: WorkspaceItem[]): VarDef[][] {
  const out: VarDef[][] = [];
  for (const it of items) {
    if (it.itemType !== VARIABLE_LIBRARY_TYPE) continue;
    const vars = (it.state as any)?.variables;
    if (Array.isArray(vars)) out.push(vars as VarDef[]);
  }
  return out;
}

export interface PromotionInput {
  tenantId: string;
  session: SessionPayload;
  /** Audit string for the history record (startedBy). */
  actor: string;
  pipeline: LoomPipeline;
  srcWs: string;
  tgtWs: string;
  sourceStageId: string;
  targetStageId: string;
  targetStage: LoomPipelineStage;
  /** Selective-deploy list; undefined = deploy every source item. */
  chosen?: Array<{ sourceItemId: string; itemType: string }>;
  note?: string;
}

export interface PromotionResult {
  operationId: string;
  status: LoomPipelineHistoryRecord['status'];
  diff: ReturnType<typeof computePipelineDiff>['pairs'];
  summary: ReturnType<typeof computePipelineDiff>['summary'];
  deployedItemIds: string[];
  steps: string[];
}

/**
 * Execute a promotion end-to-end and persist its history record. Assumes the
 * stage pair was already validated with {@link resolvePromotionStages}.
 */
export async function runPromotion(input: PromotionInput): Promise<PromotionResult> {
  const { tenantId, session: s, actor, pipeline, srcWs, tgtWs, sourceStageId, targetStageId, targetStage, chosen, note } = input;

  const [sourceItemsAll, targetItemsBefore, rules] = await Promise.all([
    listAllOwnedItems(tenantId, srcWs),
    listAllOwnedItems(tenantId, tgtWs),
    loadStageRules(pipeline.id, targetStageId),
  ]);

  // The receipt diff is the source-vs-target comparison that motivated the deploy.
  const { pairs, summary } = computePipelineDiff(sourceItemsAll, targetItemsBefore);

  // FGC-24 — resolve the target stage's Variable Library value set once. Target-
  // workspace libraries win over source-workspace ones (same name), matching
  // Fabric's per-workspace active value set. Secret-ref vars are NOT inlined.
  const valueSet = stageValueSet(targetStage);
  const variableSets = [...variableSetsFrom(sourceItemsAll), ...variableSetsFrom(targetItemsBefore)];
  const { values: varValues, secretNames } = collectStageVariableValues(variableSets, valueSet);
  const hasVariables = Object.keys(varValues).length > 0 || secretNames.size > 0;

  // Resolve the set of source items to deploy.
  let toDeploy = sourceItemsAll;
  if (chosen) {
    const wanted = new Set(chosen.map((c) => c.sourceItemId));
    toDeploy = sourceItemsAll.filter((it) => wanted.has(it.id));
  }

  const targetByKey = new Map<string, WorkspaceItem>();
  for (const it of targetItemsBefore) targetByKey.set(pairKey(it), it);

  const baseTarget = resolveTarget('shared');
  const steps: string[] = [];
  const deployedItemIds: string[] = [];
  let anyCreated = false;
  let anyFailed = false;

  for (const src of toDeploy) {
    const rawContent = (src.state as any)?.content ?? null;

    // 1) FGC-24 rebind — swap `{{var:NAME}}` tokens for this stage's values.
    let content = rawContent;
    if (hasVariables && rawContent != null) {
      const rebind = rebindContent(rawContent, varValues, secretNames);
      content = rebind.content;
      if (rebind.substitutions.length) {
        steps.push(`[${src.displayName}] rebound ${rebind.substitutions.length} variable(s) for ${valueSet}: ${rebind.substitutions.map((x) => `${x.name}=${x.value}`).join(', ')}.`);
      }
      if (rebind.skippedSecrets.length) {
        steps.push(`[${src.displayName}] left ${rebind.skippedSecrets.length} secret-ref token(s) for runtime Key Vault resolution: ${rebind.skippedSecrets.join(', ')}.`);
      }
      if (rebind.unresolved.length) {
        steps.push(`[${src.displayName}] ${rebind.unresolved.length} unresolved variable token(s) left verbatim: ${rebind.unresolved.join(', ')}.`);
      }
    }

    // 2) apply the target stage's data-source / parameter rules.
    const { target: patched, applied } = applyStageRules(baseTarget, rules, src.itemType, src.displayName);
    if (applied.length) steps.push(`[${src.displayName}] ${applied.join('; ')}`);

    // Locate or create the paired item in the target workspace (carrying the rebound content).
    const existing = targetByKey.get(pairKey(src));
    let targetItemId: string;
    if (existing) {
      targetItemId = existing.id;
    } else {
      const created = await createOwnedItem(s, src.itemType, {
        workspaceId: tgtWs,
        displayName: src.displayName,
        description: src.description,
        state: { ...(src.state || {}), ...(content !== rawContent ? { content } : {}) },
      });
      if (!created.ok) {
        anyFailed = true;
        steps.push(`[${src.displayName}] target item create failed (${created.status}): ${created.error}`);
        continue;
      }
      targetItemId = created.item.id;
      steps.push(`[${src.displayName}] created target item ${targetItemId} in ${targetStageId}.`);
    }

    // 3) PERSIST THE PROMOTED DEFINITION BEFORE PROVISIONING.
    //
    // #3549/#3551 — ORDERING IS LOAD-BEARING. This write used to happen only
    // AFTER the provisioner ran (it was step 4). For a target item that already
    // existed, that meant the provisioner saw the target's PREVIOUS content —
    // whatever the last promotion left there, or nothing at all for an item
    // created outside this path. A provisioner that verifies its content landed
    // on the item (semantic-model's read-back) therefore compared the SOURCE
    // stage's shape against the TARGET's stale document and reported
    // `remediation`, flipping `anyFailed` and recording the stage as
    // failed/partial — while the write below then landed the correct content,
    // so the promotion had actually SUCCEEDED and a re-run came back green.
    //
    // Writing the definition first makes the item the provisioner inspects the
    // item the promotion is actually creating, which is what every provisioner
    // has always assumed. The provision receipt is a SEPARATE, later write
    // (step 5) because it is a genuinely later fact.
    const promotedState: Record<string, unknown> = {
      ...(src.state || {}),
      ...(content !== rawContent ? { content } : {}),
      deployedFrom: src.id,
      deployedFromStage: sourceStageId,
      deployedAt: new Date().toISOString(),
    };
    await updateOwnedItem(targetItemId, src.itemType, tenantId, { state: promotedState });

    // 4) re-run the real provisioner against the patched (rule-applied) target with the rebound content.
    let result: ProvisionResult | undefined;
    const provisioner = PROVISIONERS[src.itemType];
    if (provisioner) {
      try {
        result = await provisioner({
          session: s,
          target: patched,
          cosmosItemId: targetItemId,
          workspaceId: tgtWs,
          displayName: src.displayName,
          content,
          appId: 'loom-pipeline-deploy',
        });
      } catch (e: any) {
        result = { status: 'failed', error: e?.message || String(e), steps: ['provisioner threw'] };
      }
      steps.push(`[${src.displayName}] provisioner(${src.itemType}) → ${result.status}.`);
      if (result.status === 'created' || result.status === 'exists') anyCreated = true;
      else if (result.status === 'failed' || result.status === 'remediation') anyFailed = true;
    } else {
      steps.push(`[${src.displayName}] ${src.itemType} is Cosmos-only — definition promoted, no backend re-provision.`);
      anyCreated = true;
    }

    // 5) record the provision receipt onto the target item. Only when a
    // provisioner ran — for a Cosmos-only type step 3 already IS the promotion
    // and a second identical write would add nothing but a version-history row.
    if (result) {
      await updateOwnedItem(targetItemId, src.itemType, tenantId, {
        state: { ...promotedState, provisionResult: result },
      });
    }
    deployedItemIds.push(targetItemId);
  }

  const status: LoomPipelineHistoryRecord['status'] =
    deployedItemIds.length === 0 ? 'failed' : anyFailed && anyCreated ? 'partial' : anyFailed ? 'failed' : 'succeeded';

  const now = new Date().toISOString();
  const record: LoomPipelineHistoryRecord = {
    id: crypto.randomUUID(),
    pipelineId: pipeline.id,
    sourceStageId,
    targetStageId,
    status,
    note,
    diff: pairs,
    deployedItemIds,
    steps,
    startedAt: now,
    completedAt: now,
    startedBy: actor,
  };
  try {
    const hist = await pipelineHistoryContainer();
    await hist.items.create(record);
  } catch (e) {
    steps.push(`History write failed (non-fatal): ${(e as Error).message}`);
  }

  return { operationId: record.id, status, diff: pairs, summary, deployedItemIds, steps };
}
