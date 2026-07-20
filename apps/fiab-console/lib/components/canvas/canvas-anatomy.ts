/**
 * canvas-anatomy — the PURE (no-JSX, no-DOM) logic layer under canvas-node-kit
 * v2. It owns the decisions the kit's node/edge/ghost rendering depends on so
 * they can be unit-tested without React Flow or a DOM:
 *
 *   • typed-port semantics — the success/fail/skip/complete port conditions,
 *     their semantic colour KEY (mapped to a Loom token in the .tsx), and the
 *     circle↔square handle geometry;
 *   • ghost next-step anchor geometry — where the trailing "add the next thing"
 *     placeholder node sits relative to the current graph;
 *   • ghost edge id derivation — the deterministic id linking the last real
 *     node to the ghost so hosts can render + drop it without id collisions.
 *
 * No Fluent import here on purpose: this module must stay import-light so the
 * vitest harness runs it in the node env with zero React/DOM cost. The kit
 * (.tsx) maps the semantic colour KEYS below onto `tokens.*` / `--loom-accent-*`
 * values — this file never emits a colour string.
 */

// ── Node geometry tokens ─────────────────────────────────────────────────────

/**
 * The DEFAULT compact node width (px) — the ONE sanctioned raw-px width
 * constant for kit nodes (v4 "compact" anatomy, modelled on ADF / Fabric
 * pipeline node sizing). Every canvas that renders `CanvasNode` should derive
 * its width (and any layout math — ELK sizing, ghost anchors, drop offsets)
 * from this constant instead of a per-canvas magic number, so all canvases
 * stay in lock-step when the standard changes.
 */
export const CANVAS_NODE_WIDTH = 180;

// ── Typed ports ──────────────────────────────────────────────────────────────

/** Conditional output-port kinds a host may expose on a node's right edge. */
export type PortConditionKind = 'success' | 'fail' | 'skip' | 'complete';

/** Plain in/out ports (non-conditional hosts) + the four typed conditions. */
export type PortKind = 'in' | 'out' | PortConditionKind;

/** Handle shape. Fabric uses small colored squares for typed conditional ports. */
export type PortShape = 'circle' | 'square';

/**
 * Semantic colour KEY per port kind. The kit (.tsx) resolves each key to a
 * theme-aware Loom token — this module never emits a raw colour so it stays
 * DOM/Fluent-free and unit-testable.
 *   green   → success        red → fail
 *   neutral → skip           brand → complete / plain out
 *   stroke  → plain in (target)
 */
export type PortColorKey = 'green' | 'red' | 'neutral' | 'brand' | 'stroke';

export const PORT_COLOR_KEY: Record<PortKind, PortColorKey> = {
  in: 'stroke',
  out: 'brand',
  success: 'green',
  fail: 'red',
  skip: 'neutral',
  complete: 'brand',
};

/** True when the port kind is one of the four typed conditional outputs. */
export function isConditionalPort(kind: PortKind): kind is PortConditionKind {
  return kind === 'success' || kind === 'fail' || kind === 'skip' || kind === 'complete';
}

/**
 * Resolve the handle shape for a port. Typed conditional ports default to
 * Fabric-style squares; plain in/out default to circles. An explicit
 * `override` always wins so a host can opt a surface fully into one shape.
 */
export function resolvePortShape(kind: PortKind, override?: PortShape): PortShape {
  if (override) return override;
  return isConditionalPort(kind) ? 'square' : 'circle';
}

/**
 * Handle box geometry in px. React Flow needs concrete pixel handle geometry
 * (it hit-tests the DOM box), so — like the original `portStyle` — this is the
 * one place raw px are intentional. Squares are a touch smaller with a small
 * corner radius; circles keep the established 11px hit target.
 */
export function portGeometry(shape: PortShape): { size: number; borderRadius: string } {
  return shape === 'square'
    ? { size: 10, borderRadius: '2px' }
    : { size: 11, borderRadius: '50%' };
}

// ── Ghost next-step node geometry ────────────────────────────────────────────

/** Minimal node shape the anchor math needs (matches a React Flow node). */
export interface AnchorNode {
  id: string;
  position: { x: number; y: number };
  /** Measured or nominal width; falls back to `nodeWidth` opt when absent. */
  width?: number;
  height?: number;
}

export interface GhostAnchorOpts {
  /** Horizontal gap from the trailing node's right edge to the ghost. */
  gapX?: number;
  /** Fallback node width when a node hasn't been measured yet. */
  nodeWidth?: number;
}

/**
 * Where the ghost "add next step" node should sit. It trails the graph's
 * right-most node (max right edge) at that node's vertical position, offset by
 * `gapX`. Returns `null` for an empty graph — hosts show a guided empty-state
 * launcher instead of a ghost when there is nothing to trail.
 *
 * Deterministic tie-break: when two nodes share the same right edge, the one
 * with the larger `y` wins so the ghost lands beside the lowest of a stacked
 * column (stable, matches Fabric placing the ghost off the last-added row).
 */
export function ghostAnchorPosition(
  nodes: readonly AnchorNode[],
  opts: GhostAnchorOpts = {},
): { x: number; y: number } | null {
  if (nodes.length === 0) return null;
  const gapX = opts.gapX ?? 80;
  const nodeWidth = opts.nodeWidth ?? CANVAS_NODE_WIDTH;

  let best: AnchorNode | null = null;
  let bestRight = -Infinity;
  for (const n of nodes) {
    const right = n.position.x + (n.width ?? nodeWidth);
    if (right > bestRight || (right === bestRight && best !== null && n.position.y > best.position.y)) {
      bestRight = right;
      best = n;
    }
  }
  if (!best) return null;
  return { x: bestRight + gapX, y: best.position.y };
}

/** Deterministic id for the edge that links a real source node to the ghost. */
export function ghostEdgeId(sourceId: string): string {
  return `ghost-edge-${sourceId}`;
}

/** Deterministic id for the ghost placeholder node itself. */
export const GHOST_NODE_ID = '__ghost_next_step__';

// ── v3: operator-node category resolution (pure) ─────────────────────────────
//
// The five canvas categories, kept here (Fluent-free) so the operator→category
// decision is unit-testable without React. The kit (.tsx) owns the accent + the
// glyph per category; this module only decides the CATEGORY a generic operator
// role falls into. Its string literals are identical to the kit's exported
// `CanvasNodeCategory`, so the two are structurally interchangeable.

export type CanvasNodeCategoryName =
  | 'move' | 'transform' | 'control' | 'external' | 'iteration';

/**
 * Generic operator roles used by canvases whose nodes are NOT catalog item types
 * (eventstream source/transform/sink, mapping-data-flow verbs, agent/task nodes).
 * A source moves data in, a sink is the controlled endpoint, verbs reshape, and
 * branching/routing is control-flow. Unknown roles fall through to `transform`.
 */
export const OPERATOR_CATEGORY: Record<string, CanvasNodeCategoryName> = {
  source: 'move',
  input: 'move',
  ingest: 'move',
  copy: 'move',
  lookup: 'move',
  read: 'move',
  transform: 'transform',
  derive: 'transform',
  select: 'transform',
  aggregate: 'transform',
  join: 'transform',
  union: 'transform',
  pivot: 'transform',
  unpivot: 'transform',
  window: 'transform',
  rank: 'transform',
  sort: 'transform',
  filter: 'control',
  conditionalsplit: 'control',
  route: 'control',
  branch: 'control',
  gate: 'control',
  sink: 'control',
  destination: 'control',
  output: 'control',
  write: 'control',
  external: 'external',
  webhook: 'external',
  notify: 'external',
  foreach: 'iteration',
  loop: 'iteration',
  until: 'iteration',
};

/** Resolve the canvas category for a generic operator role (case-insensitive). */
export function operatorCategory(role: string | undefined): CanvasNodeCategoryName {
  return (role && OPERATOR_CATEGORY[role.toLowerCase().trim()]) || 'transform';
}

// ── v3: typed port labels (pure placement) ───────────────────────────────────

/** Which node edge a port sits on. */
export type PortSide = 'left' | 'right' | 'top' | 'bottom';

/**
 * A typed port label (e.g. "rows", "events", "model") sits just INSIDE the node
 * on the same edge as its handle so it never overlaps the incoming/outgoing
 * bezier edge (Fabric renders typed labels inside the node body). Returns the
 * edge the label anchors to; hosts feed this into the kit's token-driven style.
 */
export function portLabelAnchorEdge(side: PortSide): 'left' | 'right' {
  // Vertical ports (top/bottom) still read best flush to the left inner edge.
  return side === 'right' ? 'right' : 'left';
}
