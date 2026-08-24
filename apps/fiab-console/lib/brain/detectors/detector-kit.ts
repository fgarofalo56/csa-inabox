/**
 * LOOM BRAIN — shared machinery for detectors.
 *
 * A detector is a QUERY over the graph (PRP §0), not a bespoke rule. What is
 * shared between them is not the query — it is the DISCIPLINE around the query:
 * the population, the disposition ledger, the vacuity check, the ownership
 * scoping, and the fact that every remediation is a proposal.
 *
 * Three of those are enforced at RUNTIME by {@link finalizeResult}, which is the
 * only sanctioned way to return a `DetectorResult`. It throws rather than hand
 * back a result it cannot vouch for — see the disposition section at the bottom
 * of this file for the measurements that made that necessary.
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
  type DetectorResult,
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
 * `'owned'` is the ONE verdict that authorizes acting. It may only ever be
 * reached with an `owns` edge in hand.
 *
 * ── WHY THIS IS A RUNTIME ASSERT AND NOT A COMMENT ─────────────────────────
 * Measured in review of this PR: a mutation that made {@link ownership} return
 * `'owned'` instead of `'not-established'` whenever `graph.nodes.length > 20`
 * passed the entire suite — RC=0, 19 files, 261/261 green — because every
 * fixture is 7-9 nodes and the estate is 63 container apps. The effect on the
 * real graph would have been that EVERY proposal reads *"OWNERSHIP: this
 * resource carries the `loom-estate-id` tag"*, which is the sentence a human
 * acts on, against an estate where 12 of the 13 container environments are not
 * Loom's. A fixture cannot catch a bypass keyed to a cardinality no fixture
 * reaches; a post-condition on the value can, on the first real run.
 *
 * Exported separately from {@link ownership} so the guard has an EMBEDDED
 * CONTROL: `detector-kit.test.ts` calls it with `('owned', 0)` and asserts it
 * throws, so a guard that stopped firing is distinguishable from an estate that
 * never violates it.
 */
export function assertOwnedImpliesOwnsEdge(
  verdict: Ownership,
  ownsEdgeCount: number,
  id: string,
): void {
  if (verdict === 'owned' && ownsEdgeCount === 0) {
    throw new Error(
      `LOOM BRAIN — OWNERSHIP FAIL-CLOSED: ownership('${id}') resolved to 'owned' with ZERO inbound ` +
        "resolved 'owns' edges. 'owned' is the verdict that authorizes acting on a resource. This " +
        'establishes that the ownership computation is wrong, not that the resource is unowned — ' +
        'refusing to emit a proposal that would read as authorized.',
    );
  }
}

/**
 * Ownership of a node, from `owns` edges ONLY.
 *
 * `not-established` is returned when the graph holds no resolved `owns` edges at
 * all — which is the state of this estate today. It is NOT the same as
 * `not-owned`, and collapsing them is how a cleanup recommendation ends up
 * pointed at someone else's production.
 *
 * The verdict is computed once and then CHECKED against the edge count it
 * claims to rest on (see {@link assertOwnedImpliesOwnsEdge}), so there is no
 * branch that can hand back `'owned'` without an `owns` edge.
 */
export function ownership(graph: BrainGraphView, id: NodeId): Ownership {
  const owns = graph.inboundEdges(id, 'owns').result.length;
  const verdict: Ownership =
    resolvedEdgeCount(graph, 'owns') === 0 ? 'not-established' : owns > 0 ? 'owned' : 'not-owned';
  assertOwnedImpliesOwnsEdge(verdict, owns, id);
  return verdict;
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

// ---------------------------------------------------------------------------
// DISPOSITION ACCOUNTING — a verdict LOST inside a predicate must be visible
// ---------------------------------------------------------------------------

/**
 * ── WHY A POPULATION COUNT IS NOT ENOUGH ───────────────────────────────────
 * `Population.examined` says how many candidates the detector RANGED OVER. It
 * says nothing about what happened to each one. Measured in review of this PR:
 * inserting `if (graph.nodes.length > 20) continue;` immediately AFTER the
 * predicate — in `unreachable-service`, `declared-but-dead` and `orphan` alike —
 * left the reported population reading `examined=3, findings=0, skipped=2`,
 * i.e. *"3 nodes checked, all clean"*, and the whole suite stayed green at
 * 261/261. A silently dropped candidate was indistinguishable from a candidate
 * that legitimately passed.
 *
 * The cure is not a bigger fixture — it is an explicit disposition. Every
 * candidate in the detector's declared universe lands in EXACTLY ONE of
 * `finding` / `cleared` / `skipped`, and {@link finalizeResult} refuses to
 * return a result when they do not add up. That invariant breaks on the REAL
 * graph, on the first run, no matter what the fixtures look like.
 *
 * `cleared` is deliberately the awkward one: it takes a REASON, so the pass
 * branch has to be named out loud. A `continue` with nothing attached no longer
 * compiles into a balanced ledger.
 */
export type DispositionKind = 'finding' | 'cleared' | 'skipped';

export interface Ledger {
  /** This candidate produced a finding. */
  finding(subject: string): void;
  /** This candidate was evaluated and PASSED. `why` names the pass branch. */
  cleared(subject: string, why: string): void;
  /** This candidate was NOT evaluated. Pair it with a {@link SkippedSubject}. */
  skipped(subject: string): void;
  /** Everything still undispositioned. Empty is the only acceptable state. */
  unaccounted(): readonly string[];
  counts(): Readonly<Record<DispositionKind, number>> & { readonly universe: number };
  /** Distinct pass-branch reasons, so a test can assert the branches are named. */
  clearedReasons(): readonly string[];
}

/**
 * A ledger over the candidate ids a detector must account for.
 *
 * Both error paths below are hard failures rather than warnings: a candidate
 * dispositioned twice means one of the two dispositions is a lie about what the
 * detector did, and a disposition outside the universe means the universe is not
 * what the population claims it is.
 */
export function makeLedger(detector: string, universe: readonly string[]): Ledger {
  const declared = new Set(universe);
  const seen = new Map<string, DispositionKind>();
  const reasons = new Set<string>();

  const put = (subject: string, kind: DispositionKind): void => {
    if (!declared.has(subject)) {
      throw new Error(
        `LOOM BRAIN — LEDGER: '${detector}' dispositioned '${subject}' as '${kind}', and that subject is ` +
          `not in the ${declared.size}-member universe it declared. The population and the loop disagree ` +
          'about what was examined.',
      );
    }
    const prev = seen.get(subject);
    if (prev !== undefined) {
      throw new Error(
        `LOOM BRAIN — LEDGER: '${detector}' dispositioned '${subject}' twice ('${prev}' then '${kind}'). ` +
          'One of those two statements about what the detector did is false.',
      );
    }
    seen.set(subject, kind);
  };

  return {
    finding: (s) => put(s, 'finding'),
    cleared: (s, why) => {
      put(s, 'cleared');
      reasons.add(why);
    },
    skipped: (s) => put(s, 'skipped'),
    unaccounted: () => [...declared].filter((s) => !seen.has(s)),
    counts: () => {
      let finding = 0;
      let cleared = 0;
      let skipped = 0;
      for (const k of seen.values()) {
        if (k === 'finding') finding += 1;
        else if (k === 'cleared') cleared += 1;
        else skipped += 1;
      }
      return { finding, cleared, skipped, universe: declared.size };
    },
    clearedReasons: () => [...reasons],
  };
}

/** How many members of the subject set a population actually ranged over. */
export function subjectCount(p: Population): number {
  return p.subject === 'nodes' ? p.examined : p.edgesExamined;
}

/**
 * The three ways a detector result can be a confident lie, checked before it is
 * allowed out of the function. Exported individually so each has an embedded
 * control in `detector-kit.test.ts` — a guard with no control is a guard that
 * cannot be distinguished from a clean estate.
 */
export function assertNotGreenAndBlind(
  detector: string,
  findings: readonly Finding[],
  population: Population,
): void {
  if (findings.length === 0) return;
  const n = subjectCount(population);
  if (population.blind || n === 0) {
    throw new Error(
      `LOOM BRAIN — BLIND VERDICT: '${detector}' emitted ${findings.length} finding(s) while reporting a ` +
        `population of ${n} ${population.subject} (blind=${population.blind}). A verdict over an empty ` +
        'population establishes nothing, and a confident finding beside one is the exact green-and-blind ' +
        'failure the population contract exists to prevent.',
    );
  }
}

export function assertLedgerBalances(detector: string, ledger: Ledger): void {
  const missing = ledger.unaccounted();
  if (missing.length === 0) return;
  const c = ledger.counts();
  throw new Error(
    `LOOM BRAIN — LOST VERDICT: '${detector}' declared a universe of ${c.universe} candidate(s) and ` +
      `dispositioned ${c.finding + c.cleared + c.skipped} of them ` +
      `(finding=${c.finding}, cleared=${c.cleared}, skipped=${c.skipped}). ` +
      `${missing.length} candidate(s) fell out of the loop with no verdict and no reason, starting with ` +
      `'${missing[0]}'. A dropped candidate is NOT a candidate that passed.`,
  );
}

export function assertNotVacuous(
  detector: string,
  graph: BrainGraphView,
  findings: readonly Finding[],
  requiresResolved: readonly EdgeProvenance[],
): void {
  if (findings.length === 0) return;
  for (const p of requiresResolved) {
    if (resolvedEdgeCount(graph, p) === 0) {
      throw new Error(
        `LOOM BRAIN — VACUOUS VERDICT: '${detector}' emitted ${findings.length} finding(s) while the graph ` +
          `holds ZERO RESOLVED '${p}' edges. Its predicate depends on that provenance, so the verdict is ` +
          'true of every node for an uninteresting reason. This is an extractor gap being reported as a ' +
          'defect in the estate.',
      );
    }
  }
}

/**
 * The only sanctioned way to return a {@link DetectorResult}.
 *
 * FAILS CLOSED — it throws rather than returning a result it cannot vouch for.
 * `runDetectors` deliberately does not catch, so a detector that has lost track
 * of its own population takes the pass down instead of quietly shrinking it.
 * That is the intended trade: no output at all is recoverable, a confident
 * partial one is not.
 */
export function finalizeResult(args: {
  readonly detector: string;
  readonly graph: BrainGraphView;
  readonly findings: readonly Finding[];
  readonly population: Population;
  readonly skipped: readonly SkippedSubject[];
  readonly ledger: Ledger;
  /**
   * Provenances this detector's verdict DEPENDS on. A finding emitted while one
   * of them has zero resolved edges is vacuous — see {@link vacuityReason}.
   */
  readonly requiresResolved?: readonly EdgeProvenance[];
}): DetectorResult {
  assertLedgerBalances(args.detector, args.ledger);
  assertNotGreenAndBlind(args.detector, args.findings, args.population);
  assertNotVacuous(args.detector, args.graph, args.findings, args.requiresResolved ?? []);
  return {
    detector: args.detector,
    findings: [...args.findings].sort(bySeverity),
    population: args.population,
    skipped: args.skipped,
  };
}
