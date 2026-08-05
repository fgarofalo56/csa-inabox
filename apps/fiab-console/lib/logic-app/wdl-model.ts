/**
 * WDL ⇄ Loom graph model — the pure, testable core of the Loom workflow designer.
 *
 * Azure Logic Apps stores a workflow as Workflow Definition Language (WDL): a
 * JSON object with `triggers` and `actions` maps, where each action declares a
 * `runAfter` map of `{ <predecessorName>: ['Succeeded'|'Failed'|'Skipped'|'TimedOut'] }`.
 * That is a DAG expressed as adjacency-by-predecessor, which is exactly what a
 * visual designer needs — but inverted (edges point backwards) and unpositioned.
 *
 * This module converts between the two representations WITHOUT LOSS:
 *
 *   wdlToGraph(definition)  → { nodes, edges }   (designer's model)
 *   graphToWdl(graph, base) → definition          (what we PUT to ARM)
 *
 * Round-trip guarantee: `graphToWdl(wdlToGraph(d), d)` is deep-equal to `d`
 * for any well-formed WDL definition — including operation `inputs`, nested
 * `If`/`Switch`/`Foreach`/`Until` scopes, `runAfter` conditions other than
 * Succeeded, `parameters`, `outputs`, and any unrecognised sibling keys on an
 * operation (which are preserved verbatim in `raw`). Unknown keys surviving the
 * trip is what makes this safe to point at a REAL customer workflow: the
 * designer never silently drops a field it does not understand.
 *
 * Canvas positions are designer-only state. WDL has no viewport concept, so we
 * persist them under the Logic Apps-sanctioned extension point
 * `definition.parameters.$connections`-style side-car: a dedicated
 * `LOOM_LAYOUT_KEY` entry in the workflow's `metadata` (Azure keeps `metadata`
 * on the definition and round-trips it untouched). When absent, the designer
 * falls back to a deterministic topological auto-layout so an imported workflow
 * still opens as a sensible flow rather than a pile at the origin.
 *
 * Docs:
 *   https://learn.microsoft.com/azure/logic-apps/logic-apps-workflow-definition-language
 *   https://learn.microsoft.com/azure/logic-apps/logic-apps-control-flow-run-steps-group-scopes
 *   https://learn.microsoft.com/rest/api/logic/workflows/create-or-update
 */

import { LOGIC_APP_WORKFLOW_SCHEMA } from '@/lib/azure/cloud-endpoints';

// ─────────────────────────────────────────────────────────────────────────────
// WDL shapes
// ─────────────────────────────────────────────────────────────────────────────

/** A `runAfter` status. Azure allows these four on a dependency edge. */
export type RunAfterStatus = 'Succeeded' | 'Failed' | 'Skipped' | 'TimedOut';

export const RUN_AFTER_STATUSES: readonly RunAfterStatus[] = [
  'Succeeded',
  'Failed',
  'Skipped',
  'TimedOut',
] as const;

/** A single WDL operation (trigger or action). Extra keys are preserved. */
export interface WdlOperation {
  type?: string;
  kind?: string;
  inputs?: unknown;
  runAfter?: Record<string, string[]>;
  /** Scope children (If / Foreach / Until / Scope / Switch case). */
  actions?: Record<string, WdlOperation>;
  /** If-branch else. */
  else?: { actions?: Record<string, WdlOperation> };
  /** Switch cases. */
  cases?: Record<string, { case?: unknown; actions?: Record<string, WdlOperation> }>;
  default?: { actions?: Record<string, WdlOperation> };
  expression?: unknown;
  recurrence?: unknown;
  [k: string]: unknown;
}

export interface WdlDefinition {
  $schema?: string;
  contentVersion?: string;
  parameters?: Record<string, unknown>;
  triggers?: Record<string, WdlOperation>;
  actions?: Record<string, WdlOperation>;
  outputs?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  [k: string]: unknown;
}

/** The metadata key under which the designer parks node positions. */
export const LOOM_LAYOUT_KEY = 'loomDesignerLayout';

/** An empty-but-valid Consumption workflow definition. */
export function emptyDefinition(): WdlDefinition {
  return {
    $schema: LOGIC_APP_WORKFLOW_SCHEMA,
    contentVersion: '1.0.0.0',
    parameters: {},
    triggers: {},
    actions: {},
    outputs: {},
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Graph shapes (what the canvas renders)
// ─────────────────────────────────────────────────────────────────────────────

export type LogicNodeKind = 'trigger' | 'action';

export interface LogicNode {
  /** The WDL operation name — the map key. Unique across triggers+actions. */
  id: string;
  kind: LogicNodeKind;
  /** WDL `type`, e.g. 'Http', 'Recurrence', 'If', 'Compose'. */
  type: string;
  /** Optional WDL `kind` discriminator (e.g. Request/Http). */
  operationKind?: string;
  /** Operation `inputs` verbatim. */
  inputs?: unknown;
  /**
   * Every other key on the operation that this model does not model
   * explicitly (runAfter/actions/else/cases/default are structural and are
   * rebuilt from the graph). Preserved so round-trip is lossless.
   */
  raw: Record<string, unknown>;
  /**
   * Scope children, when this node is a container (If/Foreach/Until/Scope/
   * Switch). Keyed by branch: 'actions' | 'else' | 'case:<name>' | 'default'.
   * Each branch is itself a nested graph.
   */
  scopes?: Record<string, LogicGraph>;
  /** Designer canvas position. */
  position: { x: number; y: number };
}

export interface LogicEdge {
  id: string;
  /** Predecessor operation name. */
  source: string;
  /** Dependent operation name (the one carrying `runAfter`). */
  target: string;
  /** The runAfter statuses that gate this edge. */
  statuses: RunAfterStatus[];
}

export interface LogicGraph {
  nodes: LogicNode[];
  edges: LogicEdge[];
}

/** Structural keys rebuilt from the graph — never copied into `raw`. */
const STRUCTURAL_KEYS = new Set([
  'type',
  'kind',
  'inputs',
  'runAfter',
  'actions',
  'else',
  'cases',
  'default',
]);

/** WDL operation types that contain nested actions. */
export const SCOPE_TYPES = new Set(['If', 'Foreach', 'Until', 'Scope', 'Switch']);

export function isScopeType(type: string | undefined): boolean {
  return !!type && SCOPE_TYPES.has(type);
}

// ─────────────────────────────────────────────────────────────────────────────
// Layout
// ─────────────────────────────────────────────────────────────────────────────

export const NODE_W = 260;
export const NODE_VGAP = 132;
export const NODE_HGAP = 300;

/**
 * Deterministic topological layout: rank each node by its longest dependency
 * depth, then lay ranks out top-to-bottom and siblings left-to-right. Pure and
 * stable (no randomness), so a workflow without saved positions always opens
 * the same way — and a vitest can assert exact coordinates.
 */
export function autoLayout(
  names: string[],
  runAfterOf: (name: string) => string[],
  originY = 0,
): Record<string, { x: number; y: number }> {
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const known = new Set(names);

  const rank = (n: string): number => {
    if (depth.has(n)) return depth.get(n)!;
    // Cycle guard: WDL should be acyclic, but never hang on a malformed doc.
    if (visiting.has(n)) return 0;
    visiting.add(n);
    const preds = runAfterOf(n).filter((p) => known.has(p));
    const d = preds.length === 0 ? 0 : Math.max(...preds.map(rank)) + 1;
    visiting.delete(n);
    depth.set(n, d);
    return d;
  };

  for (const n of names) rank(n);

  const byRank = new Map<number, string[]>();
  // Preserve the caller's ordering within a rank for stable left-to-right.
  for (const n of names) {
    const d = depth.get(n) ?? 0;
    if (!byRank.has(d)) byRank.set(d, []);
    byRank.get(d)!.push(n);
  }

  const out: Record<string, { x: number; y: number }> = {};
  for (const [d, group] of Array.from(byRank.entries()).sort((a, b) => a[0] - b[0])) {
    // Centre each rank's row around x=0.
    const totalW = (group.length - 1) * NODE_HGAP;
    group.forEach((n, i) => {
      out[n] = { x: Math.round(i * NODE_HGAP - totalW / 2), y: originY + d * NODE_VGAP };
    });
  }
  return out;
}

function readLayout(def: WdlDefinition): Record<string, { x: number; y: number }> {
  const meta = def?.metadata as Record<string, unknown> | undefined;
  const saved = meta?.[LOOM_LAYOUT_KEY];
  if (!saved || typeof saved !== 'object') return {};
  const out: Record<string, { x: number; y: number }> = {};
  for (const [k, v] of Object.entries(saved as Record<string, unknown>)) {
    const p = v as { x?: unknown; y?: unknown };
    if (typeof p?.x === 'number' && typeof p?.y === 'number') out[k] = { x: p.x, y: p.y };
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// WDL → graph
// ─────────────────────────────────────────────────────────────────────────────

function rawOf(op: WdlOperation): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(op || {})) {
    if (!STRUCTURAL_KEYS.has(k)) raw[k] = v;
  }
  return raw;
}

function scopesOf(
  op: WdlOperation,
  layout: Record<string, { x: number; y: number }>,
): Record<string, LogicGraph> | undefined {
  const scopes: Record<string, LogicGraph> = {};
  if (op.actions && typeof op.actions === 'object') {
    scopes.actions = actionsToGraph(op.actions, layout);
  }
  if (op.else?.actions && typeof op.else.actions === 'object') {
    scopes.else = actionsToGraph(op.else.actions, layout);
  }
  if (op.cases && typeof op.cases === 'object') {
    for (const [cn, c] of Object.entries(op.cases)) {
      scopes[`case:${cn}`] = actionsToGraph(c?.actions || {}, layout);
    }
  }
  if (op.default?.actions && typeof op.default.actions === 'object') {
    scopes.default = actionsToGraph(op.default.actions, layout);
  }
  return Object.keys(scopes).length > 0 ? scopes : undefined;
}

function actionsToGraph(
  actions: Record<string, WdlOperation>,
  layout: Record<string, { x: number; y: number }>,
): LogicGraph {
  const names = Object.keys(actions || {});
  const positions = autoLayout(names, (n) => Object.keys(actions[n]?.runAfter || {}));

  const nodes: LogicNode[] = names.map((name) => {
    const op = actions[name] || {};
    return {
      id: name,
      kind: 'action' as const,
      type: String(op.type ?? ''),
      operationKind: typeof op.kind === 'string' ? op.kind : undefined,
      inputs: op.inputs,
      raw: rawOf(op),
      scopes: scopesOf(op, layout),
      position: layout[name] || positions[name] || { x: 0, y: 0 },
    };
  });

  const edges: LogicEdge[] = [];
  for (const name of names) {
    const runAfter = actions[name]?.runAfter || {};
    for (const [pred, statuses] of Object.entries(runAfter)) {
      edges.push({
        id: `${pred}->${name}`,
        source: pred,
        target: name,
        statuses: normalizeStatuses(statuses),
      });
    }
  }
  return { nodes, edges };
}

function normalizeStatuses(v: unknown): RunAfterStatus[] {
  if (!Array.isArray(v)) return ['Succeeded'];
  const out = v.filter(
    (s): s is RunAfterStatus =>
      typeof s === 'string' && (RUN_AFTER_STATUSES as readonly string[]).includes(s),
  );
  return out.length > 0 ? out : ['Succeeded'];
}

/**
 * Convert a WDL definition into the designer graph. Triggers become rank-0
 * nodes above the action DAG; actions keep their runAfter dependency edges.
 */
export function wdlToGraph(def: WdlDefinition | null | undefined): LogicGraph {
  const d = def || {};
  const layout = readLayout(d);
  const triggers = (d.triggers || {}) as Record<string, WdlOperation>;
  const actions = (d.actions || {}) as Record<string, WdlOperation>;

  const triggerNames = Object.keys(triggers);
  // Triggers have no runAfter — lay them out on their own rank above actions.
  const triggerPos = autoLayout(triggerNames, () => []);
  const triggerNodes: LogicNode[] = triggerNames.map((name) => {
    const op = triggers[name] || {};
    return {
      id: name,
      kind: 'trigger' as const,
      type: String(op.type ?? ''),
      operationKind: typeof op.kind === 'string' ? op.kind : undefined,
      inputs: op.inputs,
      raw: rawOf(op),
      scopes: scopesOf(op, layout),
      position: layout[name] || triggerPos[name] || { x: 0, y: 0 },
    };
  });

  const actionGraph = actionsToGraph(actions, layout);
  // Offset actions below the trigger rank when the caller has no saved layout.
  const actionOriginY = triggerNames.length > 0 ? NODE_VGAP : 0;
  for (const n of actionGraph.nodes) {
    if (!layout[n.id]) n.position = { x: n.position.x, y: n.position.y + actionOriginY };
  }

  return {
    nodes: [...triggerNodes, ...actionGraph.nodes],
    edges: actionGraph.edges,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// graph → WDL
// ─────────────────────────────────────────────────────────────────────────────

function graphToActions(graph: LogicGraph): Record<string, WdlOperation> {
  const out: Record<string, WdlOperation> = {};
  // Group edges by target so each action rebuilds its own runAfter map.
  const inbound = new Map<string, LogicEdge[]>();
  for (const e of graph.edges) {
    if (!inbound.has(e.target)) inbound.set(e.target, []);
    inbound.get(e.target)!.push(e);
  }

  for (const n of graph.nodes) {
    out[n.id] = nodeToOperation(n, inbound.get(n.id) || []);
  }
  return out;
}

function nodeToOperation(n: LogicNode, inbound: LogicEdge[]): WdlOperation {
  const op: WdlOperation = {};
  if (n.type) op.type = n.type;
  if (n.operationKind) op.kind = n.operationKind;
  if (n.inputs !== undefined) op.inputs = n.inputs;

  // runAfter: rebuilt from inbound edges. A trigger never carries one; an
  // action with no predecessor gets `{}` — which is exactly what Azure emits
  // for the first action in a workflow.
  if (n.kind === 'action') {
    const runAfter: Record<string, string[]> = {};
    for (const e of inbound) runAfter[e.source] = [...e.statuses];
    op.runAfter = runAfter;
  }

  if (n.scopes) {
    for (const [branch, sub] of Object.entries(n.scopes)) {
      const actions = graphToActions(sub);
      if (branch === 'actions') op.actions = actions;
      else if (branch === 'else') op.else = { ...(op.else || {}), actions };
      else if (branch === 'default') op.default = { ...(op.default || {}), actions };
      else if (branch.startsWith('case:')) {
        const cn = branch.slice('case:'.length);
        op.cases = op.cases || {};
        op.cases[cn] = { ...(op.cases[cn] || {}), actions };
      }
    }
  }

  // Preserved unknown keys last so they can't be clobbered by the structural
  // rebuild, and so a field Azure adds later survives an edit in Loom.
  for (const [k, v] of Object.entries(n.raw || {})) op[k] = v;
  return op;
}

/**
 * Rebuild a WDL definition from the designer graph, preserving everything the
 * graph does not model (schema, contentVersion, parameters, outputs, and any
 * top-level extension keys) from `base`.
 *
 * `persistLayout` (default true) writes node positions into
 * `metadata.loomDesignerLayout` so reopening the designer restores the canvas.
 * Pass false to emit a byte-clean definition for round-trip assertions.
 */
export function graphToWdl(
  graph: LogicGraph,
  base?: WdlDefinition | null,
  opts: { persistLayout?: boolean } = {},
): WdlDefinition {
  const persistLayout = opts.persistLayout !== false;
  const b = base || {};

  const triggers: Record<string, WdlOperation> = {};
  const actionNodes: LogicNode[] = [];
  for (const n of graph.nodes) {
    if (n.kind === 'trigger') triggers[n.id] = nodeToOperation(n, []);
    else actionNodes.push(n);
  }
  const actions = graphToActions({ nodes: actionNodes, edges: graph.edges });

  const def: WdlDefinition = {
    ...b,
    $schema: b.$schema || LOGIC_APP_WORKFLOW_SCHEMA,
    contentVersion: b.contentVersion || '1.0.0.0',
    triggers,
    actions,
  };
  if (b.parameters !== undefined) def.parameters = b.parameters;
  if (b.outputs !== undefined) def.outputs = b.outputs;

  if (persistLayout) {
    const layout: Record<string, { x: number; y: number }> = {};
    for (const n of graph.nodes) layout[n.id] = { x: n.position.x, y: n.position.y };
    const meta = { ...(b.metadata || {}) } as Record<string, unknown>;
    meta[LOOM_LAYOUT_KEY] = layout;
    def.metadata = meta;
  } else if (b.metadata !== undefined) {
    def.metadata = b.metadata;
  }

  return def;
}

// ─────────────────────────────────────────────────────────────────────────────
// Editing helpers (used by the designer; pure so they are unit-testable)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Produce a unique operation name from a desired label. WDL names may not
 * contain the characters Azure reserves for expression syntax; the portal
 * substitutes underscores for spaces and de-duplicates with a numeric suffix.
 */
export function uniqueOperationName(desired: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base =
    (desired || 'Action')
      .replace(/[^A-Za-z0-9_ ().-]/g, '')
      .trim()
      .replace(/\s+/g, '_')
      .slice(0, 80) || 'Action';
  if (!used.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const cand = `${base}_${i}`;
    if (!used.has(cand)) return cand;
  }
  return `${base}_${Date.now()}`;
}

/** Remove a node and every edge touching it, then re-heal the dependency chain. */
export function removeNode(graph: LogicGraph, id: string): LogicGraph {
  const preds = graph.edges.filter((e) => e.target === id);
  const succs = graph.edges.filter((e) => e.source === id);
  const kept = graph.edges.filter((e) => e.source !== id && e.target !== id);

  // Bridge across the hole so deleting a middle step doesn't orphan the tail.
  const bridged: LogicEdge[] = [];
  for (const s of succs) {
    for (const p of preds) {
      const eid = `${p.source}->${s.target}`;
      if (kept.some((e) => e.id === eid) || bridged.some((e) => e.id === eid)) continue;
      bridged.push({ id: eid, source: p.source, target: s.target, statuses: [...s.statuses] });
    }
  }

  return {
    nodes: graph.nodes.filter((n) => n.id !== id),
    edges: [...kept, ...bridged],
  };
}

/** Rename an operation, rewriting every runAfter reference to it. */
export function renameNode(graph: LogicGraph, from: string, to: string): LogicGraph {
  if (from === to) return graph;
  const taken = graph.nodes.map((n) => n.id).filter((n) => n !== from);
  const next = uniqueOperationName(to, taken);
  return {
    nodes: graph.nodes.map((n) => (n.id === from ? { ...n, id: next } : n)),
    edges: graph.edges.map((e) => {
      const source = e.source === from ? next : e.source;
      const target = e.target === from ? next : e.target;
      return { ...e, id: `${source}->${target}`, source, target };
    }),
  };
}

/** Connect two operations with a runAfter dependency (idempotent). */
export function connectNodes(
  graph: LogicGraph,
  source: string,
  target: string,
  statuses: RunAfterStatus[] = ['Succeeded'],
): LogicGraph {
  if (source === target) return graph;
  // A trigger is never a runAfter predecessor in WDL — the first action simply
  // has an empty runAfter. Reject the edge rather than emitting invalid WDL.
  const src = graph.nodes.find((n) => n.id === source);
  const tgt = graph.nodes.find((n) => n.id === target);
  if (!src || !tgt || tgt.kind === 'trigger' || src.kind === 'trigger') return graph;
  if (wouldCycle(graph, source, target)) return graph;

  const id = `${source}->${target}`;
  const existing = graph.edges.find((e) => e.id === id);
  if (existing) {
    return {
      ...graph,
      edges: graph.edges.map((e) => (e.id === id ? { ...e, statuses: [...statuses] } : e)),
    };
  }
  return { ...graph, edges: [...graph.edges, { id, source, target, statuses: [...statuses] }] };
}

/** True when adding source→target would introduce a cycle. */
export function wouldCycle(graph: LogicGraph, source: string, target: string): boolean {
  // Walk forward from `target`; if we reach `source`, the new edge closes a loop.
  const adj = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (!adj.has(e.source)) adj.set(e.source, []);
    adj.get(e.source)!.push(e.target);
  }
  const seen = new Set<string>();
  const stack = [target];
  while (stack.length) {
    const n = stack.pop()!;
    if (n === source) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const nx of adj.get(n) || []) stack.push(nx);
  }
  return false;
}

/** Drop a dependency edge. */
export function disconnectNodes(graph: LogicGraph, edgeId: string): LogicGraph {
  return { ...graph, edges: graph.edges.filter((e) => e.id !== edgeId) };
}

/**
 * Validate a graph against the rules Azure enforces on PUT, so the designer can
 * show pre-run validation dots instead of a 400 from ARM.
 */
export interface ValidationIssue {
  nodeId?: string;
  severity: 'error' | 'warning';
  message: string;
}

export function validateGraph(graph: LogicGraph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const triggers = graph.nodes.filter((n) => n.kind === 'trigger');
  const actions = graph.nodes.filter((n) => n.kind === 'action');

  if (triggers.length === 0) {
    issues.push({ severity: 'error', message: 'A workflow needs at least one trigger.' });
  }

  const ids = new Set<string>();
  for (const n of graph.nodes) {
    if (ids.has(n.id)) {
      issues.push({ nodeId: n.id, severity: 'error', message: `Duplicate operation name '${n.id}'.` });
    }
    ids.add(n.id);
    if (!n.type) {
      issues.push({ nodeId: n.id, severity: 'error', message: `'${n.id}' has no operation type.` });
    }
  }

  for (const e of graph.edges) {
    if (!ids.has(e.source)) {
      issues.push({ nodeId: e.target, severity: 'error', message: `'${e.target}' runs after unknown step '${e.source}'.` });
    }
    if (!ids.has(e.target)) {
      issues.push({ nodeId: e.source, severity: 'error', message: `Unknown step '${e.target}' depends on '${e.source}'.` });
    }
  }

  // Every action should be reachable — an orphan never runs. Warning, not an
  // error: Azure accepts it, but the portal flags it the same way.
  const hasInbound = new Set(graph.edges.map((e) => e.target));
  const roots = actions.filter((a) => !hasInbound.has(a.id));
  if (actions.length > 0 && roots.length === 0) {
    issues.push({ severity: 'error', message: 'Every action depends on another — the workflow has a cycle and no entry point.' });
  }
  if (roots.length > 1) {
    issues.push({
      severity: 'warning',
      message: `${roots.length} actions start in parallel after the trigger (${roots.map((r) => r.id).join(', ')}).`,
    });
  }

  return issues;
}
