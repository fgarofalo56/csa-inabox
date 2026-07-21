/**
 * WS-8 (BTB-3/BTB-5) — the estate **plan-model**: a DAG of Weave actions.
 *
 * This is the shared plan structure the NL-to-Full-Estate planner (8.1) emits
 * and the One-Canvas surface (8.2) compiles to. It is NOT the EPM budgeting
 * cube in `lib/editors/_plan-model.ts` (same word, different domain) — this is a
 * directed acyclic graph where:
 *
 *   • a NODE either CREATES a root item (`op:'create'`, e.g. a lakehouse) or
 *     runs a real Weave bridge (`op:'weave'`, a ThreadAction) from an upstream
 *     node's produced item;
 *   • an EDGE is a ThreadAction (a Weave "Thread action") connecting the source
 *     node's item to the produced node's item.
 *
 * The whole module is PURE + side-effect-free (no React, no Azure): topo-order,
 * validation, dry-run diff, and the canvas→plan compile are all unit-testable.
 * The REAL execution (which actually creates items via the 13 Weave bridges)
 * lives in `estate-executor.ts` behind an injected dispatch, so the diff a user
 * approves and the chain that runs share this one model (no-vaporware.md).
 */

import { bridgeById, bridgeAcceptsSource, nodeKind } from './weave-catalog';

export type EstateNodeOp = 'create' | 'weave';

export type EstateNodeStatus =
  | 'pending'
  | 'running'
  | 'created'
  | 'skipped'
  | 'failed';

/** One node in the estate plan DAG. */
export interface EstatePlanNode {
  /** Plan-local node id (stable within a plan; NOT a Cosmos item id). */
  id: string;
  /** create = root item made directly; weave = produced by a ThreadAction. */
  op: EstateNodeOp;
  /** The Loom item type this node yields. */
  itemType: string;
  /** Display name for the created item. */
  title: string;
  /** weave: the ThreadAction (Weave bridge) id that produces this node. */
  action?: string;
  /** weave: the upstream plan node whose produced item is the bridge's source. */
  fromNodeId?: string;
  /** weave: guided field values POSTed to the bridge route (dropdown-only). */
  values?: Record<string, unknown>;
  /** Free-form one-line rationale from the planner (shown in the diff). */
  rationale?: string;
  /** Execution outcome (filled by the executor; absent in a dry-run plan). */
  status?: EstateNodeStatus;
  /** The real Cosmos item id created for this node (post-execute). */
  resultItemId?: string;
  /** The real item type created (post-execute; usually === itemType). */
  resultType?: string;
  /** Deep link to open the created item (post-execute). */
  resultLink?: string;
  /** Error message when status === 'failed'. */
  error?: string;
}

/** A ThreadAction edge in the DAG (derived from weave nodes' fromNodeId). */
export interface EstatePlanEdge {
  from: string;
  to: string;
  /** ThreadAction id (the Weave bridge on the edge). */
  action: string;
}

/** The estate plan-model: an ordered DAG of Weave actions from one intent. */
export interface EstatePlan {
  id: string;
  /** The NL prompt the plan was generated from (8.1) or a canvas label (8.2). */
  prompt?: string;
  /** A short human title for the estate the plan builds. */
  title?: string;
  nodes: EstatePlanNode[];
  edges: EstatePlanEdge[];
  createdAt?: string;
}

let _seq = 0;
/** Short collision-resistant plan/node id. */
export function newEstateId(prefix: string): string {
  _seq = (_seq + 1) % 1_000_000;
  return `${prefix}_${Date.now().toString(36)}${_seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Derive the DAG edges from the nodes' `fromNodeId` links. A `weave` node whose
 * `fromNodeId` + `action` resolve becomes one edge (source → this node). Pure —
 * so a plan built from nodes alone always has a consistent edge set.
 */
export function deriveEdges(nodes: EstatePlanNode[]): EstatePlanEdge[] {
  const ids = new Set(nodes.map((n) => n.id));
  const edges: EstatePlanEdge[] = [];
  for (const n of nodes) {
    if (n.op === 'weave' && n.fromNodeId && n.action && ids.has(n.fromNodeId)) {
      edges.push({ from: n.fromNodeId, to: n.id, action: n.action });
    }
  }
  return edges;
}

export interface EstateTopoOrder {
  /** Node ids ordered so each node follows every node it depends on. */
  order: string[];
  /** True when a dependency cycle was detected (order still returned). */
  cycle: boolean;
}

/**
 * Topologically order the plan nodes (a create/upstream node comes before every
 * node that weaves from it), so the executor runs the chain in one deterministic
 * dependency-respecting pass. On a cycle it degrades gracefully: `cycle:true`
 * and any unresolved nodes appended in declared order. Pure — vitest-covered.
 */
export function topoOrderNodes(plan: EstatePlan): EstateTopoOrder {
  const nodes = plan.nodes || [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const deps = new Map<string, string[]>();
  for (const n of nodes) {
    const d: string[] = [];
    if (n.op === 'weave' && n.fromNodeId && byId.has(n.fromNodeId) && n.fromNodeId !== n.id) {
      d.push(n.fromNodeId);
    }
    deps.set(n.id, d);
  }
  const order: string[] = [];
  const state = new Map<string, 1 | 2>(); // 1 = visiting, 2 = done
  let cycle = false;
  const visit = (id: string) => {
    const st = state.get(id);
    if (st === 2) return;
    if (st === 1) { cycle = true; return; }
    state.set(id, 1);
    for (const d of deps.get(id) || []) visit(d);
    state.set(id, 2);
    order.push(id);
  };
  for (const n of nodes) visit(n.id);
  const placed = new Set(order);
  for (const n of nodes) if (!placed.has(n.id)) order.push(n.id);
  return { order, cycle };
}

export interface EstateIssue { level: 'error' | 'warning'; nodeId?: string; message: string }
export interface EstateValidation { ok: boolean; issues: EstateIssue[] }

/**
 * Validate an estate plan against the REAL Weave bridge registry:
 *   • every node has a title + a known item type;
 *   • create nodes root a topology (a root-capable kind);
 *   • weave nodes name a real ThreadAction whose `fromTypes` includes the source
 *     node's item type, and their produced type matches the bridge;
 *   • fromNodeId resolves; no dependency cycles.
 * Pure — the plan is checkable before a single item is created (dry-run gate).
 */
export function validatePlan(plan: EstatePlan): EstateValidation {
  const issues: EstateIssue[] = [];
  const nodes = plan.nodes || [];
  if (nodes.length === 0) {
    return { ok: false, issues: [{ level: 'error', message: 'Plan has no steps.' }] };
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));

  for (const n of nodes) {
    if (!n.title || !n.title.trim()) {
      issues.push({ level: 'error', nodeId: n.id, message: `Node "${n.id}" has no title.` });
    }
    if (!n.itemType || !n.itemType.trim()) {
      issues.push({ level: 'error', nodeId: n.id, message: `Node "${n.id}" has no item type.` });
      continue;
    }
    if (n.op === 'create') {
      const kind = nodeKind(n.itemType);
      if (kind && !kind.root) {
        issues.push({
          level: 'warning',
          nodeId: n.id,
          message: `"${n.title}" (${n.itemType}) is usually produced by a Weave bridge, not created as a root.`,
        });
      }
    } else {
      // weave node
      if (!n.action) {
        issues.push({ level: 'error', nodeId: n.id, message: `Weave node "${n.title}" names no action.` });
        continue;
      }
      const bridge = bridgeById(n.action);
      if (!bridge) {
        issues.push({ level: 'error', nodeId: n.id, message: `Unknown Weave action "${n.action}" on "${n.title}".` });
        continue;
      }
      if (!n.fromNodeId || !byId.has(n.fromNodeId)) {
        issues.push({ level: 'error', nodeId: n.id, message: `Weave node "${n.title}" has no resolvable source node.` });
        continue;
      }
      const src = byId.get(n.fromNodeId)!;
      if (!bridgeAcceptsSource(bridge, src.itemType)) {
        issues.push({
          level: 'error',
          nodeId: n.id,
          message: `"${bridge.label}" cannot run from a ${src.itemType} — check the topology.`,
        });
      }
      if (bridge.producesType !== n.itemType) {
        issues.push({
          level: 'warning',
          nodeId: n.id,
          message: `"${bridge.label}" produces a ${bridge.producesType}, but the node is typed ${n.itemType}.`,
        });
      }
    }
  }

  const { cycle } = topoOrderNodes(plan);
  if (cycle) issues.push({ level: 'error', message: 'The plan has a dependency cycle.' });

  return { ok: issues.every((i) => i.level !== 'error'), issues };
}

/** One reviewable operation in the dry-run diff. */
export interface EstateDiffOp {
  nodeId: string;
  op: EstateNodeOp;
  itemType: string;
  /** The new item's name (`after`). Nothing exists before (`before` is null). */
  title: string;
  /** For weave ops: the Weave bridge label + the upstream item it runs from. */
  action?: string;
  actionLabel?: string;
  fromTitle?: string;
  rationale?: string;
}

/** The dry-run diff: an ordered set of create/weave ops (before → after). */
export interface EstateDiff {
  ops: EstateDiffOp[];
  /** Count of new items the plan will create. */
  createCount: number;
  /** Count of Weave bridges the plan will run. */
  weaveCount: number;
  /** A one-line human summary of the whole chain. */
  summary: string;
}

/**
 * Build the reviewable dry-run diff for a plan: the ordered list of items the
 * plan CREATES and the Weave bridges it RUNS (before = nothing exists). This is
 * exactly what the approve UI renders and what the executor then runs — one
 * model, so the diff can never drift from the execution (no-vaporware.md).
 */
export function planDiff(plan: EstatePlan): EstateDiff {
  const { order } = topoOrderNodes(plan);
  const byId = new Map((plan.nodes || []).map((n) => [n.id, n]));
  const ops: EstateDiffOp[] = [];
  for (const id of order) {
    const n = byId.get(id);
    if (!n) continue;
    const bridge = n.op === 'weave' && n.action ? bridgeById(n.action) : undefined;
    const from = n.fromNodeId ? byId.get(n.fromNodeId) : undefined;
    ops.push({
      nodeId: n.id,
      op: n.op,
      itemType: n.itemType,
      title: n.title,
      action: n.action,
      actionLabel: bridge?.label,
      fromTitle: from?.title,
      rationale: n.rationale,
    });
  }
  const createCount = ops.filter((o) => o.op === 'create').length;
  const weaveCount = ops.filter((o) => o.op === 'weave').length;
  const summary =
    ops.length === 0
      ? 'Empty plan — nothing to build.'
      : `Creates ${createCount} item${createCount === 1 ? '' : 's'} and runs ${weaveCount} Weave bridge${weaveCount === 1 ? '' : 's'} across ${ops.length} step${ops.length === 1 ? '' : 's'}.`;
  return { ops, createCount, weaveCount, summary };
}

// ── One-Canvas → plan-model compile (8.2) ────────────────────────────────────

/** A typed node placed on the One-Canvas surface. */
export interface CanvasEstateNode {
  id: string;
  itemType: string;
  title: string;
  /** Guided field values for the incoming Weave bridge (weave nodes only). */
  values?: Record<string, unknown>;
}

/** A ThreadAction edge drawn between two canvas nodes. */
export interface CanvasEstateEdge {
  from: string;
  to: string;
  /** ThreadAction id chosen for the edge. */
  action: string;
}

/**
 * Compile a One-Canvas topology (typed nodes + ThreadAction edges) into an
 * estate plan-model (8.2's "publish = a plan-model"): a node with an INCOMING
 * edge becomes a `weave` node (its action + upstream from that edge); a node
 * with no incoming edge becomes a `create` root. When a node has multiple
 * incoming edges the first (by declared order) wins as its producing bridge and
 * a warning is left to validation. Pure — the same plan the NL planner emits, so
 * both 8.1 and 8.2 run the identical executor.
 */
export function compilePlanFromCanvas(
  canvasNodes: CanvasEstateNode[],
  canvasEdges: CanvasEstateEdge[],
  opts: { title?: string } = {},
): EstatePlan {
  const incoming = new Map<string, CanvasEstateEdge>();
  for (const e of canvasEdges) {
    if (!incoming.has(e.to)) incoming.set(e.to, e);
  }
  const nodes: EstatePlanNode[] = canvasNodes.map((cn) => {
    const inc = incoming.get(cn.id);
    if (inc) {
      return {
        id: cn.id,
        op: 'weave',
        itemType: cn.itemType,
        title: cn.title,
        action: inc.action,
        fromNodeId: inc.from,
        values: cn.values || {},
      };
    }
    return { id: cn.id, op: 'create', itemType: cn.itemType, title: cn.title };
  });
  return {
    id: newEstateId('plan'),
    title: opts.title || 'One-Canvas topology',
    nodes,
    edges: deriveEdges(nodes),
    createdAt: new Date().toISOString(),
  };
}
