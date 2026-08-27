/**
 * LOOM BRAIN — THE SYNAPSE MODEL. Pure, no React, no DOM.
 *
 * The operator's framing for this surface, verbatim:
 *
 *   "like how the human brain works to prune and clean and grow synapses — so
 *    there is no waste, but also no security concerns for customers as they use
 *    and evolve their work."
 *
 * Four layers over ONE picture: PRUNE (a node nothing reaches), RISK (an edge
 * that should not exist), HOT (an edge carrying real traffic) and NEW (an edge
 * that formed since the last graph version). Waste and risk in the same picture
 * as the wiring — not a separate report page.
 *
 * ── THIS MODULE DECIDES HOW THINGS LOOK. IT DECIDES NOTHING ELSE. ────────
 *
 * Every verdict it reads is computed elsewhere and arrives as data:
 *
 *   prune   `nodeVisual(node, coverage)` from ./model, which reads the SERVER's
 *           `unreachableConfigured` / `alwaysOn` and applies the coverage and
 *           external-ingress gates. Not recomputed here — a second
 *           implementation of reachability is the one that drifts, and it drifts
 *           toward "this node looks fine", because that is the branch nobody
 *           writes a fixture for.
 *   risk    `lib/brain/security/**` via `/api/admin/brain/synapses`. This module
 *           joins finding ids to node ids and paints. It runs no predicate over
 *           authorization, and #3934 forbids it from having one.
 *   hot     `WireEdge.provenance`, which is P1 data on the wire.
 *   new     a diff against a stored previous graph version (W9, #3935).
 *
 * ── THE VISUAL DISTINCTION IS THE PRODUCT, SO IT IS A RETURN VALUE ───────
 *
 * The acceptance criteria for #3934 are "an unreachable node is visually
 * distinguishable from a healthy one" and "a risk edge is distinguishable from a
 * benign one". Those are not styling polish, they are the finding rendered. Kept
 * inline in JSX they could be flattened by an unrelated layout edit with nothing
 * failing; here they are functions with return values, and
 * `__tests__/ui/synapse-distinction.test.ts` asserts the marks are PAIRWISE
 * DISTINCT rather than asserting today's constants. Pinning constants would pass
 * a refactor that made two layers identical. Pinning distinctness cannot.
 *
 * ── THE ID-SPACE GAP, STATED UP FRONT ────────────────────────────────────
 *
 * A `SecurityGraph` node id is a SOURCE location — `lib/api/route-toolkit.ts
 * #withTenantAdmin`. An estate node id is `azure:/subscriptions/...`. The two id
 * spaces are DISJOINT, so a security finding will not name an estate node unless
 * a producer deliberately mints joinable ids. {@link buildSynapseOverlay}
 * therefore reports `painted` and `unjoined` counts, and the surface renders the
 * unjoined findings in their own lane instead of dropping them. Dropping them is
 * the obvious implementation — the join finds nothing, so the loop body never
 * runs — and it would silently discard every risk finding the Brain ever
 * produces.
 */

import type { BrainSnapshot, WireEdge, WireNode } from '@/app/api/admin/brain/_lib/wire';
import type {
  EdgeHistory,
  RiskLayer,
  WireRiskFinding,
} from '@/app/api/admin/brain/_lib/synapse-wire';
import { costByNode, nodeVisual } from './model';

// ---------------------------------------------------------------------------
// §Node marks — the PRUNE and RISK layers
// ---------------------------------------------------------------------------

export type SynapseNodeLayer =
  /** Named by a risk finding. Outranks prune: a live vulnerability beats a bill. */
  | 'risk'
  /** Nothing in the running deployment reaches it, and it bills every second. */
  | 'prune-costly'
  /** Nothing reaches it, but it scales to zero. Real, not urgent. */
  | 'prune-idle'
  /** Reachability could not be evaluated for this node — neither cleared nor flagged. */
  | 'unevaluated'
  /** Reached, and carrying observed traffic. */
  | 'hot'
  /** Reached. Nothing to say about it. */
  | 'quiet';

/**
 * Node width bounds.
 *
 * `ux-baseline.md` node compactness: "canvas nodes ~160-190px wide". #3934 asks
 * for prune candidates "sized by derived cost", so cost maps onto that band and
 * cannot leave it. A cost-proportional node that grew without a ceiling would
 * satisfy the issue and violate the die-hard rule.
 */
export const SYNAPSE_NODE_MIN_WIDTH = 160;
export const SYNAPSE_NODE_MAX_WIDTH = 190;
/** Every non-prune node. Sits between the bounds so a prune node reads as sized. */
export const SYNAPSE_NODE_BASE_WIDTH = 170;

export interface SynapseNodeMark {
  readonly layer: SynapseNodeLayer;
  /** CSS colour token. Distinct per layer — asserted pairwise, not pinned. */
  readonly accent: string;
  /** The SINGLE on-node badge. `ux-baseline` allows at most one. */
  readonly badge: string | null;
  /** Heavy outline ring. Reserved for the two layers worth interrupting for. */
  readonly ring: boolean;
  /** Within [MIN, MAX]. Prune candidates scale with derived cost. */
  readonly widthPx: number;
  /** Derived 30-day cost attributed to this node, or null when nothing priced it. */
  readonly derivedCostUsd: number | null;
  /** One line, shown in the tooltip and the inspector. States what was ESTABLISHED. */
  readonly reason: string;
}

/**
 * Scale a prune candidate by its derived cost.
 *
 * Linear against the LARGEST derived cost in the current view, so the widest node
 * on screen is always the most expensive one being wasted. Against a fixed dollar
 * scale, an estate whose worst offender is $8/month would render every node at
 * the minimum and the layer would carry no information at all.
 *
 * `maxUsd <= 0` (nothing priced) returns the minimum rather than dividing — an
 * unpriced prune candidate must not read as an expensive one.
 */
export function pruneWidth(costUsd: number | null, maxUsd: number): number {
  if (costUsd === null || costUsd <= 0 || maxUsd <= 0) return SYNAPSE_NODE_MIN_WIDTH;
  const ratio = Math.min(1, costUsd / maxUsd);
  return Math.round(
    SYNAPSE_NODE_MIN_WIDTH + (SYNAPSE_NODE_MAX_WIDTH - SYNAPSE_NODE_MIN_WIDTH) * ratio,
  );
}

export interface NodeMarkInputs {
  /** True iff `configured` edges were collected. False ⇒ prune is not evaluable. */
  readonly coverageConfigured: boolean;
  /** Derived 30-day cost per node id, from the findings in the same snapshot. */
  readonly costByNodeId: ReadonlyMap<string, number>;
  /** Largest derived cost in the current view, for the width scale. */
  readonly maxCostUsd: number;
  /** Node ids a risk finding names. Usually empty — see the id-space note above. */
  readonly riskNodeIds: ReadonlySet<string>;
  /** Node ids with at least one inbound `observed` edge in the current view. */
  readonly hotNodeIds: ReadonlySet<string>;
}

/**
 * Decide one node's synapse mark.
 *
 * ORDER IS THE POLICY: risk, then prune-costly, then prune-idle, then
 * unevaluated, then hot, then quiet. A node that is BOTH unreachable and named by
 * a risk finding renders as risk — an attacker-reachable path is a worse fact
 * about a resource than its bill, and rendering it as waste would file it under
 * "clean up when convenient".
 */
export function synapseNodeMark(
  node: WireNode,
  inputs: NodeMarkInputs,
): SynapseNodeMark {
  const cost = inputs.costByNodeId.get(node.id) ?? null;

  if (inputs.riskNodeIds.has(node.id)) {
    return {
      layer: 'risk',
      accent: 'var(--loom-accent-magenta)',
      badge: 'Risk',
      ring: true,
      widthPx: SYNAPSE_NODE_BASE_WIDTH,
      derivedCostUsd: cost,
      reason:
        'a security detector named this node in its evidence chain — an inbound edge reaches it ' +
        'that the detector could not prove is authorized',
    };
  }

  const visual = nodeVisual(node, inputs.coverageConfigured);

  if (visual.state === 'unreachable-always-on') {
    return {
      layer: 'prune-costly',
      accent: 'var(--loom-accent-red)',
      badge: 'Prune',
      ring: true,
      widthPx: pruneWidth(cost, inputs.maxCostUsd),
      derivedCostUsd: cost,
      reason: visual.reason,
    };
  }

  if (visual.state === 'unreachable-idle') {
    return {
      layer: 'prune-idle',
      accent: 'var(--loom-accent-amber)',
      badge: 'No consumer',
      ring: false,
      widthPx: pruneWidth(cost, inputs.maxCostUsd),
      derivedCostUsd: cost,
      reason: visual.reason,
    };
  }

  // `scale-unknown` and `reachability-not-evaluable` are both "the code does not
  // know", and both are kept OUT of the prune layer. A prune recommendation over
  // an unmeasured subject is a guess wearing a verdict's clothes.
  if (visual.state === 'scale-unknown' || visual.state === 'reachability-not-evaluable') {
    return {
      layer: 'unevaluated',
      accent: 'var(--loom-accent-orange)',
      badge: 'Not evaluated',
      ring: false,
      widthPx: SYNAPSE_NODE_BASE_WIDTH,
      derivedCostUsd: cost,
      reason: visual.reason,
    };
  }

  if (inputs.hotNodeIds.has(node.id)) {
    return {
      layer: 'hot',
      accent: 'var(--loom-accent-green)',
      badge: 'Hot',
      ring: false,
      widthPx: SYNAPSE_NODE_BASE_WIDTH,
      derivedCostUsd: cost,
      reason: 'reached, and carrying observed traffic in this snapshot',
    };
  }

  return {
    layer: 'quiet',
    accent: 'var(--loom-accent-blue)',
    badge: null,
    ring: false,
    widthPx: SYNAPSE_NODE_BASE_WIDTH,
    derivedCostUsd: cost,
    reason: visual.reason,
  };
}

// ---------------------------------------------------------------------------
// §Edge marks — the RISK, HOT and NEW layers
// ---------------------------------------------------------------------------

export type SynapseEdgeLayer =
  /** Named by a risk finding: an inbound edge that should not exist. */
  | 'risk'
  /** Formed since the last graph version. Requires history (#3935). */
  | 'new'
  /** `observed`: real traffic. */
  | 'hot'
  /** The wire exists and points at nothing. The founding evidence shape. */
  | 'broken'
  /** `configured`: the live deployment connects these. */
  | 'wired'
  /** `declared`: the TEMPLATE says these are connected. Says nothing about the deployment. */
  | 'declared-only'
  /** `imports` / `owns`: structural, not traffic. */
  | 'structural';

export interface SynapseEdgeMark {
  readonly layer: SynapseEdgeLayer;
  readonly stroke: string;
  readonly width: number;
  /** SVG dash array, or null for solid. A colour-only distinction fails a colour-blind operator. */
  readonly dash: string | null;
  readonly animated: boolean;
  readonly label: string | null;
  readonly reason: string;
}

export interface EdgeMarkInputs {
  readonly riskEdgeIds: ReadonlySet<string>;
  /** Edge ids absent from the previous graph version. Empty when history is unavailable. */
  readonly newEdgeIds: ReadonlySet<string>;
}

/**
 * Decide one edge's synapse mark.
 *
 * Every layer differs on AT LEAST TWO channels (colour plus width, dash or
 * animation). One channel is one CSS regression away from disappearing, and
 * colour alone is invisible to a colour-blind operator — the same argument
 * `edgeVisual` in ./model makes for the dangling edge, applied to the whole set.
 *
 * `risk` outranks `new` outranks `hot`: a risk edge that is also new and also
 * carrying traffic is drawn as a risk edge, because that is the fact that should
 * interrupt someone.
 */
export function synapseEdgeMark(edge: WireEdge, inputs: EdgeMarkInputs): SynapseEdgeMark {
  if (inputs.riskEdgeIds.has(edge.id)) {
    return {
      layer: 'risk',
      stroke: 'var(--loom-accent-magenta)',
      width: 3.5,
      dash: null,
      animated: true,
      label: 'risk',
      reason:
        'a security detector named this edge: a path from an untrusted origin to a privileged ' +
        'sink with no authorization edge it could prove is consumed',
    };
  }

  if (inputs.newEdgeIds.has(edge.id)) {
    return {
      layer: 'new',
      stroke: 'var(--loom-accent-violet)',
      width: 2.5,
      dash: '2 3',
      animated: true,
      label: 'new',
      reason: 'this edge is absent from the previous graph version — it formed since',
    };
  }

  if (edge.resolution === 'dangling') {
    return {
      layer: 'broken',
      stroke: 'var(--loom-accent-red)',
      width: 2,
      dash: '6 4',
      animated: false,
      label:
        edge.danglingReason === 'empty-value'
          ? `${edge.evidence.symbol ?? 'wire'} = ''`
          : edge.danglingReason === 'missing-resource'
            ? `${edge.evidence.symbol ?? 'wire'} -> missing`
            : `${edge.evidence.symbol ?? 'wire'} -> unresolved`,
      reason:
        'the wire EXISTS and resolves to nothing, so it does NOT make its intended target ' +
        'reachable — this is the evidence that something tried to connect a service and shipped ' +
        'a broken value',
    };
  }

  if (edge.provenance === 'observed') {
    return {
      layer: 'hot',
      stroke: 'var(--loom-accent-green)',
      width: 3,
      dash: null,
      animated: true,
      label: null,
      reason: 'observed traffic — this path is not merely wired, it is being used',
    };
  }

  if (edge.provenance === 'configured') {
    return {
      layer: 'wired',
      stroke: 'var(--loom-accent-blue)',
      width: 1.5,
      dash: null,
      animated: false,
      label: null,
      reason:
        'a live env var on the running app points at this target — the DEPLOYMENT connects them. ' +
        'Whether anything travels it is a different question, answered by the observed layer.',
    };
  }

  if (edge.provenance === 'declared') {
    return {
      layer: 'declared-only',
      stroke: 'var(--loom-accent-violet)',
      width: 1,
      dash: '1 4',
      animated: false,
      label: null,
      reason:
        'the TEMPLATE says these are connected. That is not a claim about the deployment: ' +
        'declared without configured is wired in bicep and dead in the running estate.',
    };
  }

  return {
    layer: 'structural',
    stroke: 'var(--loom-accent-cyan)',
    width: 1,
    dash: '4 2',
    animated: false,
    label: null,
    reason: `${edge.provenance} edge — a structural relation, not traffic`,
  };
}

// ---------------------------------------------------------------------------
// §The overlay — marks plus the populations behind them
// ---------------------------------------------------------------------------

/** A risk finding whose evidence names no node in the estate graph. */
export interface UnjoinedRiskFinding {
  readonly finding: WireRiskFinding;
  readonly reason: string;
}

export interface PruneLane {
  readonly evaluated: boolean;
  /** Why not, when `evaluated` is false. Always the coverage note, never a guess. */
  readonly reason: string;
  readonly nodesExamined: number;
  readonly costly: number;
  readonly idle: number;
  readonly unevaluated: number;
  /** Sum of the derived figures attributed to prune candidates. NEVER a bill. */
  readonly derivedMonthlyUsd: number;
  /** How many prune candidates carry a derived figure at all. */
  readonly priced: number;
}

export interface RiskLane {
  readonly evaluated: boolean;
  readonly reason: string;
  readonly findings: readonly WireRiskFinding[];
  /** Findings whose evidence intersects the estate node set — i.e. paintable. */
  readonly painted: number;
  /** Findings that could not be joined to the estate graph. Reported, never dropped. */
  readonly unjoined: readonly UnjoinedRiskFinding[];
  readonly judged: number;
  readonly candidates: number;
  readonly ratio: number;
  readonly incompleteDetectors: readonly string[];
  readonly detectorsRegistered: number;
}

export interface HotLane {
  /** True iff `observed` edges were collected at all. False ⇒ silence proves nothing. */
  readonly collected: boolean;
  readonly note: string;
  readonly observed: number;
  readonly wired: number;
  readonly declaredOnly: number;
  readonly broken: number;
  readonly edgesExamined: number;
}

export interface FreshLane {
  readonly available: boolean;
  readonly reason: string;
  readonly newEdges: number;
}

export interface SynapseOverlay {
  readonly nodeMarks: ReadonlyMap<string, SynapseNodeMark>;
  readonly edgeMarks: ReadonlyMap<string, SynapseEdgeMark>;
  readonly prune: PruneLane;
  readonly risk: RiskLane;
  readonly hot: HotLane;
  readonly fresh: FreshLane;
}

const PRUNE_LAYERS: ReadonlySet<SynapseNodeLayer> = new Set<SynapseNodeLayer>([
  'prune-costly',
  'prune-idle',
]);

/**
 * Build the whole overlay for a filtered view of one snapshot.
 *
 * `nodes` / `edges` are the FILTERED view, not the raw snapshot, so the marks
 * describe what is on screen. The lane populations count the same filtered set —
 * a lane reporting estate-wide totals next to a filtered canvas is the "showing 3
 * of 63" failure in a different place.
 */
export function buildSynapseOverlay(args: {
  readonly snapshot: BrainSnapshot;
  readonly nodes: readonly WireNode[];
  readonly edges: readonly WireEdge[];
  readonly risk: RiskLayer | null;
  readonly history: EdgeHistory | null;
}): SynapseOverlay {
  const { snapshot, nodes, edges } = args;
  const coverageConfigured = snapshot.coverage.configured.collected;
  const costByNodeId = costByNode(snapshot.findings);

  // ── the risk join ────────────────────────────────────────────────────────
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edgeIds = new Set(edges.map((e) => e.id));
  const riskNodeIds = new Set<string>();
  const riskEdgeIds = new Set<string>();
  const unjoined: UnjoinedRiskFinding[] = [];
  let painted = 0;

  const riskFindings = args.risk?.evaluated === true ? args.risk.findings : [];
  for (const f of riskFindings) {
    let joined = false;
    for (const id of f.evidence.nodeIds) {
      if (nodeIds.has(id)) {
        riskNodeIds.add(id);
        joined = true;
      }
    }
    for (const id of f.evidence.edgeIds) {
      if (edgeIds.has(id)) {
        riskEdgeIds.add(id);
        joined = true;
      }
    }
    if (joined) painted += 1;
    else {
      unjoined.push({
        finding: f,
        reason:
          'the evidence names ' +
          `${f.evidence.nodeIds.length} node(s) and ${f.evidence.edgeIds.length} edge(s) in the ` +
          'SECURITY graph (source locations), none of which is a node or edge in the estate ' +
          'graph. The two id spaces are disjoint, so this finding is reported in its own lane ' +
          'rather than dropped.',
      });
    }
  }

  // ── the history diff ─────────────────────────────────────────────────────
  const newEdgeIds = new Set<string>();
  if (args.history?.available === true) {
    const previous = new Set(args.history.previousEdgeIds);
    for (const e of edges) if (!previous.has(e.id)) newEdgeIds.add(e.id);
  }

  // ── the hot join ─────────────────────────────────────────────────────────
  const hotNodeIds = new Set<string>();
  for (const e of edges) {
    if (e.provenance === 'observed' && e.resolution === 'resolved' && e.to !== null) {
      hotNodeIds.add(e.to);
    }
  }

  let maxCostUsd = 0;
  for (const n of nodes) maxCostUsd = Math.max(maxCostUsd, costByNodeId.get(n.id) ?? 0);

  const nodeMarks = new Map<string, SynapseNodeMark>();
  let costly = 0;
  let idle = 0;
  let unevaluated = 0;
  let derivedMonthlyUsd = 0;
  let priced = 0;
  for (const n of nodes) {
    const mark = synapseNodeMark(n, {
      coverageConfigured,
      costByNodeId,
      maxCostUsd,
      riskNodeIds,
      hotNodeIds,
    });
    nodeMarks.set(n.id, mark);
    if (mark.layer === 'prune-costly') costly += 1;
    if (mark.layer === 'prune-idle') idle += 1;
    if (mark.layer === 'unevaluated') unevaluated += 1;
    if (PRUNE_LAYERS.has(mark.layer) && mark.derivedCostUsd !== null) {
      derivedMonthlyUsd += mark.derivedCostUsd;
      priced += 1;
    }
  }

  const edgeMarks = new Map<string, SynapseEdgeMark>();
  let observed = 0;
  let wired = 0;
  let declaredOnly = 0;
  let broken = 0;
  for (const e of edges) {
    const mark = synapseEdgeMark(e, { riskEdgeIds, newEdgeIds });
    edgeMarks.set(e.id, mark);
    if (mark.layer === 'hot') observed += 1;
    if (mark.layer === 'wired') wired += 1;
    if (mark.layer === 'declared-only') declaredOnly += 1;
    if (mark.layer === 'broken') broken += 1;
  }

  return {
    nodeMarks,
    edgeMarks,
    prune: {
      evaluated: coverageConfigured,
      reason: coverageConfigured
        ? snapshot.coverage.configured.note
        : `PRUNE NOT EVALUATED. ${snapshot.coverage.configured.note} Over a graph with zero ` +
          "'configured' edges, 'nothing reaches this node' is vacuously true of EVERY node, so " +
          'painting the canvas would be a screenful of confident nonsense.',
      nodesExamined: nodes.length,
      costly,
      idle,
      unevaluated,
      derivedMonthlyUsd,
      priced,
    },
    risk: {
      evaluated: args.risk?.evaluated === true,
      reason:
        args.risk === null
          ? 'The risk lane has not been loaded yet.'
          : args.risk.evaluated
            ? `Security graph source: ${args.risk.graphSource}.`
            : args.risk.reason,
      findings: riskFindings,
      painted,
      unjoined,
      judged: args.risk?.evaluated === true ? args.risk.coverage.judged : 0,
      candidates: args.risk?.evaluated === true ? args.risk.coverage.candidates : 0,
      ratio: args.risk?.evaluated === true ? args.risk.coverage.ratio : 0,
      incompleteDetectors:
        args.risk?.evaluated === true ? args.risk.coverage.incompleteDetectors : [],
      detectorsRegistered:
        args.risk === null
          ? 0
          : args.risk.evaluated
            ? args.risk.detectors.length
            : args.risk.registry.length,
    },
    hot: {
      collected: snapshot.coverage.observed.collected,
      note: snapshot.coverage.observed.collected
        ? snapshot.coverage.observed.note
        : `HOT PATHS NOT EVALUATED. ${snapshot.coverage.observed.note} Zero observed edges is ` +
          'what "no telemetry extractor ran" looks like, and it is indistinguishable from "no ' +
          'traffic" unless the collection state is stated — so it is stated.',
      observed,
      wired,
      declaredOnly,
      broken,
      edgesExamined: edges.length,
    },
    fresh: {
      available: args.history?.available === true,
      reason:
        args.history === null
          ? 'The edge history has not been loaded yet.'
          : args.history.available
            ? `Diffed against the graph version taken at ${args.history.previousGeneratedAt}.`
            : args.history.reason,
      newEdges: newEdgeIds.size,
    },
  };
}

// ---------------------------------------------------------------------------
// §Labels
// ---------------------------------------------------------------------------

export const SYNAPSE_NODE_LABEL: Record<SynapseNodeLayer, string> = {
  risk: 'Risk — an edge reaches it that should not',
  'prune-costly': 'Prune — unreachable and billing',
  'prune-idle': 'Prune — unreachable, scales to zero',
  unevaluated: 'Not evaluated',
  hot: 'Hot — carrying observed traffic',
  quiet: 'Wired',
};

export const SYNAPSE_EDGE_LABEL: Record<SynapseEdgeLayer, string> = {
  risk: 'risk edge (should not exist)',
  new: 'new since the last graph version',
  hot: 'hot path (observed traffic)',
  broken: 'broken wire (points at nothing)',
  wired: 'wired (live configuration)',
  'declared-only': 'declared only (template, not deployment)',
  structural: 'structural (imports / owns)',
};
