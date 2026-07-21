/**
 * WS-8.1 — NL-to-Full-Estate planner.
 *
 * Turns ONE natural-language prompt ("Build me a sales analytics estate:
 * lakehouse → medallion → semantic model → report → API → data agent →
 * governance") into a reviewable {@link EstatePlan} — a DAG of REAL Weave
 * bridge calls. The planner is routed to the REASONING tier (WS-1.1
 * `model-tier-router`, `tier:'strong'` / `taskClass:'reasoning'`) because
 * composing a whole estate is a hard, multi-step design turn.
 *
 * Split like the data-agent planner: a PURE half (`buildEstatePlanPrompt`,
 * `parseEstatePlan`) that is unit-testable without a model, and a runtime half
 * (`planEstateFromPrompt`) that calls Azure OpenAI. The runtime surfaces the
 * honest 503 gate (NoAoaiDeploymentError from `resolveAoaiTarget`) when no
 * reasoning model is deployed — the route renders the Fix-it, no vaporware.
 *
 * The plan CREATES NOTHING — it is a dry-run artifact. Only `estate-executor`
 * (after explicit approve) runs the chain via the actual thread routes.
 */

import { aoaiChatJson } from '@/lib/azure/aoai-chat-client';
import type { TenantCopilotConfig } from '@/lib/types/copilot-config';
import {
  type EstatePlan,
  type EstatePlanNode,
  type EstateNodeOp,
  deriveEdges,
  newEstateId,
} from './estate-plan-model';
import { WEAVE_BRIDGES, ESTATE_NODE_KINDS, bridgeById } from './weave-catalog';

/** Cap on planned nodes so one prompt can't emit an unbounded estate. */
export const MAX_ESTATE_NODES = 16;

/**
 * The system prompt that teaches the model the REAL Weave bridge vocabulary and
 * the strict JSON schema to emit. Built from the live `WEAVE_BRIDGES` +
 * `ESTATE_NODE_KINDS` registries so it can never advertise a bridge that does
 * not exist (the executor would reject it anyway — this keeps the model honest).
 */
export function buildEstatePlanPrompt(): string {
  const roots = ESTATE_NODE_KINDS.filter((k) => k.root)
    .map((k) => `  - ${k.itemType}: ${k.hint}`)
    .join('\n');
  const bridges = WEAVE_BRIDGES.map((b) => {
    const from = b.fromTypes === '*' ? 'any item' : b.fromTypes.join(' | ');
    const fields = b.fieldNames.length ? ` [values: ${b.fieldNames.join(', ')}]` : '';
    return `  - action "${b.id}" — "${b.label}": FROM (${from}) → creates ${b.producesType}${fields}`;
  }).join('\n');

  return [
    'You are the CSA Loom estate architect. Given a user goal, design a DAG that',
    'builds a full Azure-native data estate by chaining Loom "Weave" bridges.',
    '',
    'Two node kinds:',
    '  • op="create" — a ROOT item made directly (a data store the chain starts from).',
    '  • op="weave"  — an item PRODUCED by running a real Weave bridge (an "action")',
    '    from an upstream node. "from" is the upstream node id; "action" is the bridge.',
    '',
    'ROOT item types you may create:',
    roots,
    '',
    'WEAVE bridges you may use (action → produced type). Only these exist:',
    bridges,
    '',
    'Rules:',
    `  • Emit at most ${MAX_ESTATE_NODES} nodes. Start with one or more create roots.`,
    '  • Every weave node MUST reference a valid "action" and a "from" node whose',
    '    item type is in that action\'s FROM list. Do not invent actions or types.',
    '  • The node "itemType" of a weave node MUST equal the bridge\'s produced type.',
    '  • For "values", use ONLY the listed field names for that action; pick sensible',
    '    dropdown-style values (e.g. targetLayer:"silver", transform:"clean-dedup",',
    '    sourceMode:"table"). Use "__new__" when a field asks for a new child item.',
    '  • Give each node a short human "title" and a one-line "rationale".',
    '',
    'Return STRICT JSON only, no prose:',
    '{ "title": string, "nodes": [ { "id": string, "op": "create"|"weave",',
    '  "itemType": string, "title": string, "action"?: string, "from"?: string,',
    '  "values"?: object, "rationale"?: string } ] }',
  ].join('\n');
}

/** The loose shape the model returns (before validation/normalisation). */
interface RawPlanNode {
  id?: unknown;
  op?: unknown;
  itemType?: unknown;
  title?: unknown;
  action?: unknown;
  from?: unknown;
  fromNodeId?: unknown;
  values?: unknown;
  rationale?: unknown;
}
interface RawPlan {
  title?: unknown;
  nodes?: unknown;
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

/**
 * Normalise a model plan JSON into a validated {@link EstatePlan}: assign
 * collision-free plan-local node ids (preserving `from` references via a remap),
 * coerce op/action/itemType, default a weave node's itemType to its bridge's
 * produced type, drop malformed nodes, and cap at {@link MAX_ESTATE_NODES}.
 * Pure — vitest-covered without a model.
 */
export function parseEstatePlan(raw: RawPlan | null | undefined, opts: { prompt?: string } = {}): EstatePlan {
  const rawNodes = Array.isArray(raw?.nodes) ? (raw!.nodes as RawPlanNode[]) : [];
  // First pass: assign a fresh id per node, remembering the model's own id so
  // "from" references (which point at the model's ids) can be remapped.
  const idRemap = new Map<string, string>();
  const staged: { rn: RawPlanNode; newId: string }[] = [];
  for (const rn of rawNodes.slice(0, MAX_ESTATE_NODES)) {
    if (!rn || typeof rn !== 'object') continue;
    const modelId = asString(rn.id).trim();
    const newId = newEstateId('n');
    if (modelId) idRemap.set(modelId, newId);
    staged.push({ rn, newId });
  }

  const nodes: EstatePlanNode[] = [];
  for (const { rn, newId } of staged) {
    const op: EstateNodeOp = asString(rn.op).trim() === 'weave' ? 'weave' : 'create';
    const title = asString(rn.title).trim() || 'Untitled step';
    let itemType = asString(rn.itemType).trim();

    if (op === 'weave') {
      const action = asString(rn.action).trim();
      const bridge = bridgeById(action);
      // Drop weave nodes that name no real bridge — the model hallucinated.
      if (!bridge) continue;
      if (!itemType) itemType = bridge.producesType;
      const fromRef = asString(rn.from ?? rn.fromNodeId).trim();
      const fromNodeId = idRemap.get(fromRef) || fromRef || undefined;
      const values =
        rn.values && typeof rn.values === 'object' && !Array.isArray(rn.values)
          ? (rn.values as Record<string, unknown>)
          : {};
      nodes.push({
        id: newId,
        op: 'weave',
        itemType,
        title,
        action,
        fromNodeId,
        values,
        rationale: asString(rn.rationale).trim() || undefined,
      });
    } else {
      if (!itemType) continue; // a create node with no type is meaningless
      nodes.push({
        id: newId,
        op: 'create',
        itemType,
        title,
        rationale: asString(rn.rationale).trim() || undefined,
      });
    }
  }

  return {
    id: newEstateId('plan'),
    prompt: opts.prompt,
    title: asString(raw?.title).trim() || 'Data estate',
    nodes,
    edges: deriveEdges(nodes),
    createdAt: new Date().toISOString(),
  };
}

export interface PlanEstateOptions {
  cfg?: TenantCopilotConfig | null;
  /** Reserved for future scoping (e.g. workspace-aware defaults). */
  workspaceId?: string;
}

/**
 * Runtime: NL prompt → reasoning-tier model → {@link EstatePlan}. Routes to the
 * STRONG (reasoning) tier via aoaiChatJson (`tier:'strong'`). Throws
 * `NoAoaiDeploymentError` (from resolveAoaiTarget) when no model is deployed —
 * the route surfaces the honest gate. Creates nothing (dry-run only).
 */
export async function planEstateFromPrompt(prompt: string, opts: PlanEstateOptions = {}): Promise<EstatePlan> {
  const clean = (prompt || '').trim();
  if (!clean) return { id: newEstateId('plan'), title: 'Data estate', nodes: [], edges: [], createdAt: new Date().toISOString() };

  const raw = await aoaiChatJson<RawPlan>({
    messages: [
      { role: 'system', content: buildEstatePlanPrompt() },
      { role: 'user', content: clean },
    ],
    // WS-1.1: composing a whole estate is a reasoning turn — pin the strong tier.
    tier: 'strong',
    taskClass: 'reasoning',
    cfg: opts.cfg ?? null,
    maxCompletionTokens: 2500,
  });

  return parseEstatePlan(raw, { prompt: clean });
}
