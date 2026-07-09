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
  const nodeWidth = opts.nodeWidth ?? 200;

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
