/**
 * LOOM BRAIN — shared machinery for detectors.
 *
 * A detector is a QUERY over the graph (PRP §0), not a bespoke rule. What is
 * shared between them is not the query — it is the DISCIPLINE around the query:
 * the population, the vacuity check, the ownership scoping, and the fact that
 * every remediation is a proposal.
 *
 * ── THE VACUITY CHECK IS SHARPER HERE THAN IN THE SUBSTRATE ────────────────
 * `types.ts` documents `population.byProvenance[p] === 0` as the vacuous-truth
 * check for "no inbound edge of provenance p". That is right as far as it goes,
 * but it counts DANGLING edges too — and a dangling edge, by P2, has `to: null`
 * and can never make anything reachable.
 *
 * So a graph holding 898 `configured` edges of which every single one is dangling
 * would report `byProvenance.configured = 898`, pass that check, and return EVERY
 * node as unreachable. Loud, confident, and vacuous. {@link resolvedEdgeCount}
 * counts only the edges that can actually confer reachability, which is the
 * count the verdict depends on. Detectors here use that one.
 *
 * Measured on the real graph 2026-08-23 for scale: 9,409 edges, 7,668 resolved,
 * 1,741 dangling — so the two counts genuinely differ and the distinction is not
 * theoretical.
 *
 * ── OWNERSHIP: REPORT EVERYTHING, RECOMMEND NOTHING UNOWNED ────────────────
 * PRP §1 decision 4 — reports cover ALL six subscriptions; cleanup
 * recommendations are scoped by ownership. Decision 1 gives the measured reason:
 * of the 13 Container App environments visible, ONE is Loom's. The other 12 are
 * the operator's blog, Sentinel, two Atlas estates and more.
 *
 * And ownership is currently UNESTABLISHABLE: a read-only pull across all six
 * subscriptions on 2026-08-23 found ZERO resources carrying `loom-estate-id`, so
 * the graph holds zero `owns` edges. {@link ownership} therefore returns
 * `'not-established'` today for everything, and every proposal it feeds says so
 * in the text. That is the honest state, and it is deliberately NOT cured by
 * widening the tag key — the fix is the deploy stamping the tag.
 */

import {
  makePopulation,
  proposal,
  type AzureResourceNode,
  type BrainEdge,
  type BrainGraphView,
  type BrainNode,
  type Confidence,
  type DanglingEdge,
  type EdgeProvenance,
  type EvidenceChain,
  type Finding,
  type FindingSeverity,
  type NodeId,
  type Population,
  type RemediationProposal,
  type ResolvedEdge,
  type SkippedSubject,
} from '../graph';

/**
 * Edges of `provenance` that are RESOLVED — i.e. that can actually confer
 * reachability. See the module header: this is a strictly stronger vacuity check
 * than `population.byProvenance[p]`, which counts dangling edges too.
 */
export function resolvedEdgeCount(graph: BrainGraphView, provenance: EdgeProvenance): number {
  return graph.edges.filter((e) => e.resolution === 'resolved' && e.provenance === provenance).length;
}

/**
 * Why a "no inbound X" verdict cannot be trusted, or `null` when it can.
 *
 * Returning a REASON rather than a boolean is the point: a detector that shortcuts
 * on vacuity has to put the reason in `skipped`, so the operator sees "this
 * detector could not establish anything" instead of a green tick.
 */
export function vacuityReason(graph: BrainGraphView, provenance: EdgeProvenance): string | null {
  const resolved = resolvedEdgeCount(graph, provenance);
  if (resolved > 0) return null;
  const total = graph.report.edgesByProvenance[provenance];
  return (
    `the graph holds ZERO RESOLVED '${provenance}' edges (${total} edge(s) of that provenance exist, ` +
    `all dangling or none extracted). "No inbound '${provenance}' edge" is therefore vacuously true of ` +
    'EVERY node and establishes nothing. This is not a clean estate — it is an extractor that produced ' +
    'no usable edges of this provenance.'
  );
}

/** Whether the Brain can say who owns a resource. */
export type Ownership = 'owned' | 'not-owned' | 'not-established';

/**
 * Ownership of a node, from `owns` edges ONLY.
 *
 * `not-established` is returned when the graph holds no resolved `owns` edges at
 * all — which is the state of this estate today. It is NOT the same as
 * `not-owned`, and collapsing them is how a cleanup recommendation ends up
 * pointed at someone else's production.
 */
export function ownership(graph: BrainGraphView, id: NodeId): Ownership {
  if (resolvedEdgeCount(graph, 'owns') === 0) return 'not-established';
  return graph.inboundEdges(id, 'owns').result.length > 0 ? 'owned' : 'not-owned';
}

/**
 * The sentence every proposal carries about whether it may be acted on.
 *
 * Recommend-only is enforced in the TYPE system by `RemediationProposal`'s literal
 * `mutatesAzure: false`. This is the human-facing half: even an approved change
 * must not be applied to a resource whose ownership was never established.
 */
export function ownershipCaveat(o: Ownership): string {
  switch (o) {
    case 'owned':
      return 'OWNERSHIP: this resource carries the `loom-estate-id` tag for the estate under analysis.';
    case 'not-owned':
      return (
        'OWNERSHIP: NOT LOOM-OWNED. The graph resolves `owns` edges for other resources but none for ' +
        'this one. Reported for visibility only (reports cover all subscriptions); DO NOT act on it.'
      );
    case 'not-established':
      return (
        'OWNERSHIP NOT ESTABLISHED: nothing on this estate carries `loom-estate-id`, so the graph holds ' +
        'zero `owns` edges and the Brain cannot tell a Loom resource from the 12 non-Loom container ' +
        'environments in these subscriptions. Confirm ownership by hand before acting. The fix is for ' +
        'the deploy to stamp the tag — not for this check to be widened.'
      );
  }
}

/**
 * Build a {@link RemediationProposal}. A thin wrapper over `proposal()` that
 * forces the ownership caveat into every `proposedChange`, so no rendered
 * remediation can reach an operator without it.
 */
export function scopedProposal(
  summary: string,
  proposedChange: string,
  o: Ownership,
): RemediationProposal {
  return proposal(
    summary,
    `${proposedChange}\n\n${ownershipCaveat(o)}\n` +
      'RECOMMEND-ONLY: nothing in lib/brain executes this. A human applies it.',
  );
}

/**
 * A deterministic finding id.
 *
 * Determinism matters for the same reason it does for edge ids: a finding
 * persisted from one run has to be re-identifiable on the next, or the UI cannot
 * mark one acknowledged and the agent layer cannot correlate across time.
 */
export function findingId(detector: string, ...parts: readonly string[]): string {
  return [detector, ...parts.map((p) => p.trim()).filter(Boolean)].join('#');
}

/** Assemble an {@link EvidenceChain}. `query` must be re-runnable text. */
export function evidence(args: {
  nodes: readonly NodeId[];
  edges: readonly BrainEdge[];
  query: string;
  notes: readonly string[];
}): EvidenceChain {
  return {
    nodes: args.nodes,
    edges: args.edges.map((e) => e.id),
    query: args.query,
    notes: args.notes,
  };
}

/**
 * The population a detector examined.
 *
 * `blind` is derived by `makePopulation` from the subject set, so a detector that
 * ranged over nothing cannot report a confident verdict. Every detector in this
 * directory returns one of these on EVERY path, including the early returns.
 */
export function detectorPopulation(
  graph: BrainGraphView,
  candidates: readonly BrainNode[],
  scope: string,
): Population {
  return makePopulation({ subject: 'nodes', nodes: candidates, edges: graph.edges, scope });
}

/** The population for a detector whose subject is EDGES, not nodes. */
export function edgeDetectorPopulation(
  graph: BrainGraphView,
  candidates: readonly BrainEdge[],
  scope: string,
): Population {
  return makePopulation({ subject: 'edges', nodes: graph.nodes, edges: candidates, scope });
}

/** Narrow a node list to Azure resources. */
export function azureResources(nodes: readonly BrainNode[]): AzureResourceNode[] {
  return nodes.filter((n): n is AzureResourceNode => n.kind === 'azure-resource');
}

/** Every dangling edge whose `intendedTo` names this node. The evidence chain. */
export function danglingFor(graph: BrainGraphView, id: NodeId): readonly DanglingEdge[] {
  return graph.danglingEdgesIntendedFor(id).result;
}

/** Inbound resolved edges of a provenance. Convenience over the QueryResult. */
export function inbound(
  graph: BrainGraphView,
  id: NodeId,
  provenance: EdgeProvenance,
): readonly ResolvedEdge[] {
  return graph.inboundEdges(id, provenance).result;
}

/**
 * Severity from the derived monthly cost.
 *
 * The thresholds are a judgement, stated in one place so it can be argued with
 * rather than being scattered across six detectors. They are deliberately keyed
 * to a MONTHLY figure, because an hourly one makes everything look free.
 */
export function severityForMonthlyUsd(usd: number | null): FindingSeverity {
  if (usd === null) return 'medium';
  if (usd >= 20) return 'high';
  if (usd >= 5) return 'medium';
  return 'low';
}

/**
 * Confidence in an "unreachable" verdict.
 *
 * `high` requires a documented INTENT — a wire that exists and carries `''` —
 * because that removes the main alternative explanation ("nothing points at it
 * because nothing was ever supposed to"). The broker is this case.
 *
 * `low` when NOTHING points at the node by any provenance. That reads like
 * stronger evidence of disuse and is not: it is also exactly what an extraction
 * gap looks like, and the code cannot tell those apart (R7).
 */
export function reachabilityConfidence(args: {
  hasDanglingIntent: boolean;
  hasOtherInbound: boolean;
}): Confidence {
  if (args.hasDanglingIntent) return 'high';
  return args.hasOtherInbound ? 'medium' : 'low';
}

/** A skip with its reason. A subject skipped for lack of data is NOT one that passed. */
export function skip(subject: string, reason: string): SkippedSubject {
  return { subject, reason };
}

/** Sort findings most-severe first, then by id for determinism. */
const SEVERITY_ORDER: Readonly<Record<FindingSeverity, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

export function bySeverity(a: Finding, b: Finding): number {
  const d = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
  return d !== 0 ? d : a.id.localeCompare(b.id);
}
