/**
 * LOOM BRAIN VISUALIZER — the pure model behind the canvas.
 *
 * Every decision the canvas makes about how a node or an edge LOOKS is made
 * here, as a pure function of the snapshot, with no React and no DOM. Two
 * reasons, and the second is the load-bearing one:
 *
 *   1. It is testable without mounting anything.
 *   2. THE VISUAL DISTINCTION IS THE PRODUCT. PRP §3.6 asks that "unreachable
 *      nodes and dangling edges are visually distinct" — that is not styling
 *      polish, it is the finding, rendered. A distinction that lives inline in
 *      JSX can be weakened by an unrelated layout edit and nothing would fail.
 *      Here it is a function with a return value, and
 *      `__tests__/ui/visual-distinction.test.ts` pins each state to a DIFFERENT
 *      accent, a DIFFERENT status and a DIFFERENT badge — asserting they are
 *      pairwise distinct rather than merely asserting today's constants.
 *
 * ── THE CLIENT NEVER RECOMPUTES A VERDICT ──────────────────────────────────
 * `unreachableConfigured`, `alwaysOn` and `ownershipConfirmed` arrive as data on
 * the wire. Nothing here recounts edges to second-guess them. A client-side
 * recount would have to re-implement the resolved/dangling exclusion (P2) in a
 * second place, and the second implementation is the one that drifts — always
 * toward "this node looks fine", because that is the branch nobody tests.
 */

import type { BrainSnapshot, WireEdge, WireFinding, WireNode } from '@/app/api/admin/brain/_lib/wire';
import type { EdgeProvenance } from '@/lib/brain/graph';

/**
 * What a node IS, for display. Ordered by how much it should alarm the operator.
 *
 * The three "bad" states are kept SEPARATE rather than collapsed into one
 * "problem" flag, because they have different fixes and different costs:
 *
 *   `unreachable-always-on`  billing every second, nothing points at it. THE finding.
 *   `unreachable-idle`       nothing points at it, but minReplicas 0 — costs
 *                            (nearly) nothing. Real, but not urgent, and
 *                            rendering it as loudly as the one above would
 *                            train the operator to ignore both.
 *   `scale-unknown`          scale could NOT be read. NOT the same as "scales to
 *                            zero", and never shown as safe.
 */
export type NodeVisualState =
  | 'unreachable-always-on'
  | 'unreachable-idle'
  | 'scale-unknown'
  | 'reachability-not-evaluable'
  | 'reachable-always-on'
  | 'reachable'
  | 'non-resource';

export interface NodeVisual {
  readonly state: NodeVisualState;
  /** CSS colour token/var. Distinct per state — asserted pairwise in tests. */
  readonly accent: string;
  /** Maps onto `CanvasNode`'s status dot. */
  readonly status: 'succeeded' | 'warning' | 'failed' | 'idle';
  /**
   * `true` draws the red outline ring on `CanvasNode`. Reserved for the state
   * that costs money AND has no consumer — the one worth interrupting for.
   */
  readonly error: boolean;
  /**
   * The SINGLE on-node badge. `ux-baseline.md` node-compactness allows at most
   * one; everything else belongs in the tooltip and the details panel.
   */
  readonly badge: string | null;
  /** One-line reason, shown in the node tooltip and the details header. */
  readonly reason: string;
}

/**
 * Decide a node's visual state.
 *
 * `coverageConfigured` is REQUIRED, not optional, and that is deliberate. Over a
 * graph with zero `configured` edges, `unreachableConfigured` is vacuously true
 * of EVERY node — so painting the canvas red would be a screenful of confident
 * nonsense. When the provenance was not collected this function refuses to
 * report unreachability at all and returns the neutral state; the coverage
 * banner explains why. Making the parameter required means a caller cannot
 * forget to pass it.
 */
export function nodeVisual(node: WireNode, coverageConfigured: boolean): NodeVisual {
  if (node.kind !== 'azure-resource') {
    return {
      state: 'non-resource',
      accent: 'var(--loom-accent-violet)',
      status: 'idle',
      error: false,
      badge: null,
      reason: `${node.kind} node`,
    };
  }

  if (!coverageConfigured) {
    return {
      state: 'reachable',
      accent: 'var(--loom-accent-blue)',
      status: 'idle',
      error: false,
      badge: null,
      reason:
        "reachability NOT EVALUATED — no 'configured' edges were collected, so calling this " +
        'node unreachable would be vacuously true of every node in the graph',
    };
  }

  // ── EXTERNAL INGRESS: THE CANVAS MUST AGREE WITH THE DETECTOR ────────────
  // An app addressable from the public internet is reached by callers that are
  // not edges in this graph — a browser, Front Door, a partner, a webhook. So
  // "zero inbound configured edges" establishes nothing about it, and
  // `unreachableAlwaysOn` skips it for exactly that reason.
  //
  // This branch exists so the PICTURE says the same thing as the ANALYSIS. Omit
  // it and the canvas paints the console red as unreachable while the
  // recommendations list — correctly — does not flag it, which is precisely the
  // disagreement PRP §3.6's single-payload design exists to make impossible.
  // Sharing a payload is necessary but not sufficient; the two renderings have
  // to apply the same predicate to it.
  if (node.ingress?.external === true && node.unreachableConfigured) {
    return {
      state: 'reachability-not-evaluable',
      accent: 'var(--loom-accent-teal)',
      status: 'idle',
      error: false,
      badge: 'External',
      reason:
        'no inbound configured edge, but this app has EXTERNAL ingress — its callers (browser, ' +
        'Front Door, partner, webhook) are not edges in this graph, so reachability cannot be ' +
        'evaluated here. Neither cleared nor flagged.',
    };
  }

  if (!node.scaleMeasured && node.unreachableConfigured) {
    return {
      state: 'scale-unknown',
      // NOT amber — `unreachable-idle` is amber, and the two must never share a
      // colour. They mean opposite things: amber says "measured, and it costs
      // nearly nothing"; this says "NOT MEASURED, so no cost claim is possible".
      // Rendering them alike would let an unmeasured resource read as a cleared
      // one. (Caught by the pairwise-distinctness assertion in
      // `visual-distinction.test.tsx`, not by review.)
      accent: 'var(--loom-accent-orange)',
      status: 'warning',
      error: false,
      badge: 'Scale unknown',
      reason:
        'no inbound configured edge, and its scale could NOT be read — this is indeterminate, ' +
        'not "scales to zero", and it is neither cleared nor flagged as waste',
    };
  }

  if (node.unreachableConfigured && node.alwaysOn) {
    return {
      state: 'unreachable-always-on',
      accent: 'var(--loom-accent-red)',
      status: 'failed',
      error: true,
      badge: 'Unreachable',
      reason:
        `always-on (minReplicas ${node.scale?.minReplicas ?? '?'}) with ZERO inbound configured ` +
        'edges — it bills every second and nothing in the live deployment points at it',
    };
  }

  if (node.unreachableConfigured) {
    return {
      state: 'unreachable-idle',
      accent: 'var(--loom-accent-amber)',
      status: 'warning',
      error: false,
      badge: 'No consumer',
      reason:
        'no inbound configured edge, but minReplicas is 0 — it scales to zero, so the cost is ' +
        'near nil. Worth knowing, not worth interrupting for.',
    };
  }

  if (node.alwaysOn) {
    return {
      state: 'reachable-always-on',
      accent: 'var(--loom-accent-cyan)',
      status: 'succeeded',
      error: false,
      badge: 'Always-on',
      reason: `wired (${node.inboundByProvenance.configured} inbound configured) and always-on`,
    };
  }

  return {
    state: 'reachable',
    accent: 'var(--loom-accent-blue)',
    status: 'succeeded',
    error: false,
    badge: null,
    reason: `wired: ${node.inboundByProvenance.configured} inbound configured edge(s)`,
  };
}

export interface EdgeVisual {
  readonly stroke: string;
  readonly dashed: boolean;
  readonly width: number;
  readonly label: string | null;
}

/** Per-provenance stroke. Distinct so the legend is readable at a glance. */
export const PROVENANCE_COLOR: Record<EdgeProvenance, string> = {
  configured: 'var(--loom-accent-blue)',
  declared: 'var(--loom-accent-violet)',
  imports: 'var(--loom-accent-cyan)',
  observed: 'var(--loom-accent-green)',
  owns: 'var(--loom-accent-amber)',
};

/**
 * Decide an edge's appearance.
 *
 * A DANGLING EDGE IS DRAWN DIFFERENTLY FROM A RESOLVED ONE IN THREE WAYS AT
 * ONCE — red, dashed, and labelled with its reason. Redundant on purpose: this
 * is the distinction the whole surface exists to make, and one channel is one
 * CSS regression away from disappearing. (A colour-only distinction also fails
 * for a colour-blind operator, which the dash pattern covers.)
 */
export function edgeVisual(edge: WireEdge): EdgeVisual {
  if (edge.resolution === 'dangling') {
    return {
      stroke: 'var(--loom-accent-red)',
      dashed: true,
      width: 2,
      label:
        edge.danglingReason === 'empty-value'
          ? `${edge.evidence.symbol ?? 'wire'} = ''`
          : edge.danglingReason === 'missing-resource'
            ? `${edge.evidence.symbol ?? 'wire'} -> missing`
            : `${edge.evidence.symbol ?? 'wire'} -> unresolved`,
    };
  }
  return {
    stroke: PROVENANCE_COLOR[edge.provenance],
    dashed: false,
    width: 1.5,
    label: null,
  };
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

export interface BrainFilters {
  readonly subscriptionId: string | 'all';
  /** 'all' | 'owned' | 'unowned' — ownership as MEASURED, never inferred. */
  readonly ownership: 'all' | 'owned' | 'unowned';
  /** Which provenances to draw. Empty set draws none. */
  readonly provenances: ReadonlySet<EdgeProvenance>;
  /** Only nodes with a derived cost above this. 0 disables. */
  readonly minCostUsd: number;
  /** Only nodes carrying at least one finding. */
  readonly findingsOnly: boolean;
  readonly search: string;
}

export const DEFAULT_FILTERS: BrainFilters = {
  subscriptionId: 'all',
  ownership: 'all',
  // `observed` is included so that, once telemetry lands, it draws by default
  // rather than being invisible until someone finds a checkbox.
  provenances: new Set<EdgeProvenance>(['configured', 'declared', 'imports', 'observed', 'owns']),
  minCostUsd: 0,
  findingsOnly: false,
  search: '',
};

/** Derived cost per node id, summed across the findings that name it. */
export function costByNode(findings: readonly WireFinding[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const f of findings) {
    if (!f.cost) continue;
    for (const s of f.subjects) m.set(s, (m.get(s) ?? 0) + f.cost.amountUsd);
  }
  return m;
}

/** Finding count per node id. */
export function findingsByNode(findings: readonly WireFinding[]): Map<string, WireFinding[]> {
  const m = new Map<string, WireFinding[]>();
  for (const f of findings) {
    for (const s of f.subjects) {
      const list = m.get(s);
      if (list) list.push(f);
      else m.set(s, [f]);
    }
  }
  return m;
}

export interface FilteredView {
  readonly nodes: readonly WireNode[];
  readonly edges: readonly WireEdge[];
  /**
   * WHAT THE FILTER RANGED OVER, and what it removed. Rendered next to the
   * canvas rather than left implicit: an operator looking at 3 nodes must be
   * able to tell "the estate has 3" from "you are hiding 60", and PRP §3.2's
   * population rule applies to a view just as much as to a detector.
   */
  readonly population: {
    readonly nodesTotal: number;
    readonly nodesShown: number;
    readonly edgesTotal: number;
    readonly edgesShown: number;
    readonly hiddenBy: readonly string[];
  };
}

/**
 * Apply the filters.
 *
 * An edge is drawn only when BOTH endpoints survive — a half-attached edge
 * would render as a wire into empty space, which reads exactly like a dangling
 * edge and would forge the finding this surface reports. A DANGLING edge has no
 * `to` by construction, so it is kept whenever its SOURCE survives, and is drawn
 * against a synthetic terminus.
 */
export function applyFilters(
  snapshot: BrainSnapshot,
  filters: BrainFilters,
): FilteredView {
  const cost = costByNode(snapshot.findings);
  const findings = findingsByNode(snapshot.findings);
  const hiddenBy: string[] = [];

  const q = filters.search.trim().toLowerCase();

  const nodes = snapshot.nodes.filter((n) => {
    if (filters.subscriptionId !== 'all' && n.subscriptionId !== filters.subscriptionId) return false;
    if (filters.ownership === 'owned' && !n.ownershipConfirmed) return false;
    if (filters.ownership === 'unowned' && n.ownershipConfirmed) return false;
    if (filters.minCostUsd > 0 && (cost.get(n.id) ?? 0) < filters.minCostUsd) return false;
    if (filters.findingsOnly && !findings.has(n.id)) return false;
    if (q !== '') {
      const hay = `${n.displayName} ${n.resourceType ?? ''} ${n.resourceGroup ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  if (filters.subscriptionId !== 'all') hiddenBy.push(`subscription = ${filters.subscriptionId}`);
  if (filters.ownership !== 'all') hiddenBy.push(`ownership = ${filters.ownership}`);
  if (filters.minCostUsd > 0) hiddenBy.push(`derived cost >= $${filters.minCostUsd}`);
  if (filters.findingsOnly) hiddenBy.push('nodes with >= 1 finding');
  if (q !== '') hiddenBy.push(`name/type contains "${filters.search.trim()}"`);
  if (filters.provenances.size < 5) {
    hiddenBy.push(`edge provenance in {${[...filters.provenances].sort().join(', ')}}`);
  }

  const visible = new Set(nodes.map((n) => n.id));
  const edges = snapshot.edges.filter((e) => {
    if (!filters.provenances.has(e.provenance)) return false;
    if (!visible.has(e.from)) return false;
    // A dangling edge has `to: null` BY CONSTRUCTION (P2). Requiring a visible
    // target would delete exactly the edges this surface exists to show.
    if (e.resolution === 'dangling') return true;
    return e.to !== null && visible.has(e.to);
  });

  return {
    nodes,
    edges,
    population: {
      nodesTotal: snapshot.nodes.length,
      nodesShown: nodes.length,
      edgesTotal: snapshot.edges.length,
      edgesShown: edges.length,
      hiddenBy,
    },
  };
}

/** Subscriptions present in the snapshot, for the filter dropdown. */
export function subscriptionsIn(snapshot: BrainSnapshot): string[] {
  const s = new Set<string>();
  for (const n of snapshot.nodes) if (n.subscriptionId) s.add(n.subscriptionId);
  return [...s].sort();
}

/**
 * Short, non-identifying label for a subscription.
 *
 * A subscription GUID is a tenant-identifying value and this is a PUBLIC repo,
 * so the filter shows a truncated form. The full value is never rendered into
 * anything copyable-by-accident, and never logged.
 */
export function subscriptionLabel(id: string): string {
  return id.length > 8 ? `sub ...${id.slice(-8)}` : `sub ${id}`;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export interface Positioned {
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

/**
 * Deterministic column layout, keyed on the visual state.
 *
 * Not a force simulation: a force layout moves every node whenever any node
 * changes, so the operator loses their place on every refresh, and — worse —
 * two screenshots of the SAME estate look different, which makes visual
 * comparison useless. Columns are stable, and grouping by state puts every
 * unreachable always-on node in one column where they can be counted by eye.
 */
export function layoutNodes(
  nodes: readonly WireNode[],
  coverageConfigured: boolean,
  opts?: { readonly columnWidth?: number; readonly rowHeight?: number },
): Positioned[] {
  const columnWidth = opts?.columnWidth ?? 260;
  const rowHeight = opts?.rowHeight ?? 96;
  const order: NodeVisualState[] = [
    'unreachable-always-on',
    'unreachable-idle',
    'scale-unknown',
    'reachability-not-evaluable',
    'reachable-always-on',
    'reachable',
    'non-resource',
  ];
  const buckets = new Map<NodeVisualState, WireNode[]>();
  for (const s of order) buckets.set(s, []);
  for (const n of nodes) {
    const v = nodeVisual(n, coverageConfigured);
    buckets.get(v.state)!.push(n);
  }
  const out: Positioned[] = [];
  let column = 0;
  for (const s of order) {
    const bucket = buckets.get(s)!;
    if (bucket.length === 0) continue;
    // Stable within a column: sort by name so a re-fetch does not reshuffle.
    bucket.sort((a, b) => a.displayName.localeCompare(b.displayName));
    bucket.forEach((n, i) => {
      out.push({ id: n.id, x: column * columnWidth, y: i * rowHeight });
    });
    column += 1;
  }
  return out;
}

/** Column headings for the layout above, in the same order. */
export const STATE_LABEL: Record<NodeVisualState, string> = {
  'unreachable-always-on': 'Unreachable + always-on',
  'unreachable-idle': 'Unreachable (scales to zero)',
  'scale-unknown': 'Scale not measured',
  'reachability-not-evaluable': 'External ingress (not evaluable)',
  'reachable-always-on': 'Wired + always-on',
  reachable: 'Wired',
  'non-resource': 'Other',
};
