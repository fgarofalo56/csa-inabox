/**
 * THE POPULATION DISCIPLINE — `judged / candidates`, enforced structurally.
 *
 * ── WHY THIS IS THE MOST IMPORTANT FILE IN THIS LANE ──────────────────────
 *
 * `docs/fiab/brain/security-taxonomy.md` §11.5, after nine classes of analysis,
 * reaches a conclusion that is NOT about any of them:
 *
 *   "This repo's dominant, measured, repeatedly-successful evasion is NOT to add
 *    an unguarded edge — it is to FALL OUTSIDE THE POPULATION BEING EXAMINED,
 *    and it is invisible in every artifact except a population count."
 *
 * Six measured instances, none of which any inverted edge predicate would find,
 * because the query never ran on them:
 *
 *   - `check-tid-boundary-chokepoint.mjs` — 15 candidates, 1 JUDGED, RC=0, with a
 *     live shape-1 defect in the tree. Measured 2026-08-23. The discriminant is a
 *     regex on PARAMETER NAMES at `:2662`.
 *   - `_publication-surfaces.mjs` — 3 of the 4 bypasses in #3876 drive the write
 *     count to ZERO by aliasing, destructuring or bracket access.
 *   - `check-route-guards.mjs` — 119 route files with a data surface are outside
 *     the remit; a previous revision of its own header asserted the number was 1.
 *   - `check-guard-logical-lines.mjs` — scans only `check-*.mjs` (#3438).
 *   - the placeholder-oid check — 8 copies, 1 under test (#3818).
 *   - `ALLOWLIST_PREFIXES` — never premise-tested, load-bearing for 12 routes (#3607).
 *
 * So the mandate (PRP §3.2, §3.7, §5) is that a detector reports the population
 * it examined. This file makes that STRUCTURAL rather than a log line, in three
 * ways, because a log line is exactly what `check-tid-boundary-chokepoint.mjs`
 * already prints and it did not stop the RC=0.
 *
 *   1. A detector returns `DetectorResult`, not `Finding[]`. There is no way to
 *      return findings WITHOUT a population — the factory requires both. A bare
 *      `Finding[]` cannot express "zero over zero", which is the precise failure
 *      the mandate exists to prevent.
 *   2. `detectorResult()` THROWS if `judged` is not a subset of `candidates`.
 *      A detector that judges something it never enumerated has a broken
 *      population model and should not ship a verdict at all.
 *   3. `detectorResult()` SYNTHESISES findings for the two silent states:
 *      an EMPTY candidate set, and any candidate left UNJUDGED. Both are
 *      `POP-population-integrity`, so a consumer reading only findings — never
 *      the population — still sees them. That is deliberate: the whole class of
 *      failure above is "the consumer read the verdict and not the population".
 *   4. `detectorResult()` RECOMPUTES the population from the graph, over the
 *      kinds the detector declares, by a traversal that does NOT call
 *      `candidatesOfKind` — and throws when the two disagree. Points 1-3 all
 *      compare `judged` against `candidates`, and both of those descend from the
 *      array `candidatesOfKind` returns, so none of them can see a narrowing
 *      applied while that array is being BUILT. Measured during review
 *      2026-08-23: three such narrowings, each gated one node above the largest
 *      fixture, passed the full suite at `100 passed (100)` and reported
 *      `ratio: 1.0` / `incompleteDetectors: []` while a live C1 defect vanished
 *      from the findings. Point 4 is the answer to that, and it is the only one
 *      of the four whose denominator is independent of the numerator.
 *
 * ── WHY THE RETURN TYPE DEVIATES FROM `graph -> Finding[]` ────────────────
 *
 * The commission asked for `graph -> Finding[]` sharing one findings model. The
 * findings model IS shared (`Finding` in `./substrate.ts`, unchanged, usable by
 * the waste detectors verbatim). What changed is the ENVELOPE, and only because
 * `Finding[]` and `[]` are indistinguishable — a detector that examined 0 nodes
 * and a detector that examined 4,000 and found nothing return the same value.
 * `findingsOf()` below recovers the array for any caller that wants it, so this
 * is additive rather than a fork. `DetectorResult` is deliberately generic over
 * nothing so a waste detector can adopt it without importing anything security.
 */

import type { Finding, SecurityGraph, SecurityNode, SecurityNodeKind } from './substrate';

/**
 * What a detector examined.
 *
 * `candidates` is MEMBERSHIP IN THE CLASS and must be computed INDEPENDENTLY OF
 * WHETHER THE FIX WAS ADOPTED. Quoting `check-empty-claim-read-evidence.mjs:36-38`:
 * a rule keyed to the unsafe pattern goes quiet on exactly the files that adopt
 * the fix, so coverage and compliance become indistinguishable and a file that
 * never had the pattern scores identical to one that fixed it.
 *
 * `judged` is what the detector actually evaluated. In a compliant detector
 * these are EQUAL. `unjudged` exists so that when they are not, the reason is
 * carried in the data rather than in a comment nobody reads — and so the gap
 * itself becomes a finding.
 */
export interface Population {
  readonly detectorId: string;
  /**
   * The node kinds this detector's CLASS covers.
   *
   * This is the DENOMINATOR's source, and it is declared by the detector rather
   * than derived from the nodes it selected — deliberately, because a
   * denominator derived from the same filter as the numerator cannot disagree
   * with it. `detectorResult()` recomputes the population from the graph over
   * these kinds, by a different traversal than {@link candidatesOfKind}, and
   * refuses a `candidates` array that does not match.
   *
   * Measured reason this field exists (review of this PR, 2026-08-23): three
   * separate narrowing mutations injected INTO `candidatesOfKind` and gated on
   * `graph.nodes.length > 13` — one node above the largest fixture — passed the
   * entire suite at `100 passed (100)` and reported `ratio: 1.0`,
   * `incompleteDetectors: []`, `unjudged: 0`, while a live C1 defect vanished
   * from the findings. `candidates` and `judged` were both derived from the same
   * filtered array, so they agreed by construction. Their agreement confirmed
   * the METHOD, not the population.
   */
  readonly declaredKinds: readonly SecurityNodeKind[];
  /** Every node the detector's CLASS applies to. */
  readonly candidates: readonly string[];
  /** The subset actually evaluated. Equal to `candidates` in a compliant detector. */
  readonly judged: readonly string[];
  /** Any candidate not judged, with why. MUST be empty for a compliant detector. */
  readonly unjudged: readonly UnjudgedCandidate[];
  /**
   * Whether an empty candidate set is legitimate for this graph.
   *
   * Set true ONLY when the graph provably contains no node of the class (e.g. a
   * python-free graph for C6). It suppresses the empty-population finding and
   * nothing else. Defaults false, so silence is loud by default.
   */
  readonly emptyIsExpected: boolean;
}

export interface UnjudgedCandidate {
  readonly nodeId: string;
  readonly reason: string;
}

/** A detector's complete answer: what it found AND what it looked at. */
export interface DetectorResult {
  readonly findings: readonly Finding[];
  readonly population: Population;
}

/** Every security detector has this shape. Pure: graph in, result out, no I/O. */
export type SecurityDetector = (graph: SecurityGraph) => DetectorResult;

export interface SecurityDetectorSpec {
  readonly id: string;
  /** The taxonomy section this implements, e.g. `'C1'`. */
  readonly taxonomyClass: string;
  readonly title: string;
  readonly run: SecurityDetector;
}

/**
 * An INDEPENDENT census of the graph's nodes, by kind.
 *
 * The word that matters is "independent". This does NOT call
 * {@link candidatesOfKind} and does not use `Array.prototype.filter` — it walks
 * `graph.nodes` once by index and accumulates. That is not stylistic: a census
 * that shares a traversal with the thing it is auditing moves WITH its subject,
 * so a mutation injected into the subject appears in the census too and the two
 * still agree. Two counts sharing a method confirm the method, not the number.
 *
 * `kindById` is carried alongside the counts so a candidate can be checked for
 * EXISTENCE and for CLASS MEMBERSHIP, not merely counted. Counting alone is
 * defeated by padding — return the same node twice and the length still matches.
 */
export interface KindCensus {
  /** kind -> how many nodes of that kind the graph actually holds. */
  readonly countsByKind: ReadonlyMap<SecurityNodeKind, number>;
  /** node id -> its kind, for every node in the graph. */
  readonly kindById: ReadonlyMap<string, SecurityNodeKind>;
}

export function nodeKindCensus(graph: SecurityGraph): KindCensus {
  const countsByKind = new Map<SecurityNodeKind, number>();
  const kindById = new Map<string, SecurityNodeKind>();
  for (let i = 0; i < graph.nodes.length; i += 1) {
    const node = graph.nodes[i];
    countsByKind.set(node.kind, (countsByKind.get(node.kind) ?? 0) + 1);
    kindById.set(node.id, node.kind);
  }
  return { countsByKind, kindById };
}

/**
 * Refuse a `candidates` array that disagrees with the graph.
 *
 * Three failures, each of which a length-only comparison misses:
 *
 *   1. DUPLICATES — the same node returned N times pads the count back up to the
 *      census while the distinct set is narrower.
 *   2. FOREIGN or MISCLASSIFIED ids — a candidate that is not in the graph, or
 *      is of a kind the detector did not declare, means the denominator is not
 *      describing the class it claims to.
 *   3. NARROWING — the distinct, in-class candidate count is below what the
 *      graph holds for the declared kinds. This is the case a
 *      `judged`-vs-`candidates` comparison provably cannot see.
 */
function assertCandidatesMatchCensus(population: Population, graph: SecurityGraph): void {
  const { countsByKind, kindById } = nodeKindCensus(graph);
  const declared = new Set(population.declaredKinds);

  const distinct = new Set(population.candidates);
  if (distinct.size !== population.candidates.length) {
    throw new Error(
      `[${population.detectorId}] incoherent population: candidates contains ` +
        `${population.candidates.length - distinct.size} duplicate id(s). A padded candidate ` +
        'list restores the count while narrowing the set actually examined.',
    );
  }

  const foreign: string[] = [];
  for (const id of distinct) {
    const kind = kindById.get(id);
    if (kind === undefined || !declared.has(kind)) foreign.push(id);
  }
  if (foreign.length > 0) {
    throw new Error(
      `[${population.detectorId}] incoherent population: ${foreign.length} candidate(s) are ` +
        `absent from the graph or outside the declared kinds ` +
        `[${population.declaredKinds.join(', ')}] (${foreign.slice(0, 5).join(', ')}).`,
    );
  }

  let expected = 0;
  for (const kind of declared) expected += countsByKind.get(kind) ?? 0;

  if (distinct.size !== expected) {
    throw new Error(
      `[${population.detectorId}] SILENT NARROWING: the graph holds ${expected} node(s) of ` +
        `kind [${population.declaredKinds.join(', ')}] but the detector enumerated ` +
        `${distinct.size} as candidates. A narrowing applied while BUILDING the candidate set ` +
        'is invisible to judged/candidates — both descend from the narrowed array, so they ' +
        'agree at ratio 1.0 while the sweep is blind. Narrow via `unjudged`, where it is ' +
        'reported, or widen the candidate set.',
    );
  }
}

/**
 * Build a `DetectorResult`, enforcing the population contract.
 *
 * Throws on an incoherent population (judged outside candidates) because that is
 * a defect in the DETECTOR, not a finding about the graph, and shipping a
 * verdict from a broken population model is how RC=0 gets believed.
 *
 * Also throws when `candidates` disagrees with an independently recomputed
 * census over `population.declaredKinds`. That check is what makes the promise
 * on {@link candidatesOfKind} true rather than merely stated: a narrowing
 * applied while PRODUCING candidates — as opposed to while producing `judged` —
 * is invisible to `judged`/`candidates` comparison, because both sides descend
 * from the narrowed array. The census does not.
 *
 * Appends `POP-population-integrity` findings for the two silent states.
 */
export function detectorResult(
  findings: readonly Finding[],
  population: Population,
  graph: SecurityGraph,
): DetectorResult {
  assertCandidatesMatchCensus(population, graph);

  const candidateSet = new Set(population.candidates);
  const strays = population.judged.filter((id) => !candidateSet.has(id));
  if (strays.length > 0) {
    throw new Error(
      `[${population.detectorId}] incoherent population: judged ${strays.length} node(s) ` +
        `that are not candidates (${strays.slice(0, 5).join(', ')}). A detector that judges ` +
        'what it never enumerated cannot report a trustworthy verdict.',
    );
  }

  const judgedSet = new Set(population.judged);
  const declaredUnjudged = new Set(population.unjudged.map((u) => u.nodeId));
  const silentlyDropped = population.candidates.filter(
    (id) => !judgedSet.has(id) && !declaredUnjudged.has(id),
  );
  if (silentlyDropped.length > 0) {
    throw new Error(
      `[${population.detectorId}] incoherent population: ${silentlyDropped.length} candidate(s) ` +
        `were neither judged nor declared unjudged (${silentlyDropped.slice(0, 5).join(', ')}). ` +
        'A candidate must be judged or its exclusion must be stated.',
    );
  }

  const synthesized: Finding[] = [];

  if (population.candidates.length === 0 && !population.emptyIsExpected) {
    synthesized.push({
      id: `${population.detectorId}:population:empty`,
      detectorId: population.detectorId,
      findingClass: 'POP-population-integrity',
      severity: 'high',
      confidence: 'high',
      title: `${population.detectorId} examined an EMPTY population — green and blind`,
      evidence: {
        nodeIds: [],
        edgeIds: [],
        query: 'population.candidates.length === 0 && !population.emptyIsExpected',
        facts: [
          'A detector reporting zero findings over zero nodes is indistinguishable from a ' +
            'detector that found nothing over the whole estate.',
          'Measured precedent: _publication-surfaces.mjs reports clean on 3 of the 4 #3876 ' +
            'bypasses not because the write is safe but because it counted no writes at all.',
        ],
      },
      remediation: {
        summary:
          'Establish why the candidate set is empty before trusting this detector. Either the ' +
          'graph genuinely carries no node of this class (then set emptyIsExpected with the ' +
          'reason) or the extraction is not producing them.',
        proposedCommands: [],
        proposedPatchDescription: null,
        requiresHumanApproval: true,
      },
    });
  }

  if (population.unjudged.length > 0) {
    synthesized.push({
      id: `${population.detectorId}:population:unjudged`,
      detectorId: population.detectorId,
      findingClass: 'POP-population-integrity',
      severity: 'high',
      confidence: 'high',
      title:
        `${population.detectorId} judged ${population.judged.length} of ` +
        `${population.candidates.length} candidates — ${population.unjudged.length} unexamined`,
      evidence: {
        nodeIds: population.unjudged.map((u) => u.nodeId),
        edgeIds: [],
        query: 'population.unjudged.length > 0',
        facts: population.unjudged.map((u) => `${u.nodeId}: ${u.reason}`),
      },
      remediation: {
        summary:
          'A shrinking judged set is a P0 signal, not a footnote. Measured precedent: ' +
          'check-tid-boundary-chokepoint.mjs finds 15 functions carrying the admin-bypass ' +
          'shape and judges 1 — printing OK, RC=0, with a live defect in the tree.',
        proposedCommands: [],
        proposedPatchDescription: null,
        requiresHumanApproval: true,
      },
    });
  }

  return { findings: [...findings, ...synthesized], population };
}

/** Recover the plain findings array for a caller that wants `graph -> Finding[]`. */
export function findingsOf(result: DetectorResult): readonly Finding[] {
  return result.findings;
}

/** Findings excluding the population-integrity class — i.e. the SECURITY findings. */
export function securityFindingsOf(result: DetectorResult): readonly Finding[] {
  return result.findings.filter((f) => f.findingClass !== 'POP-population-integrity');
}

/**
 * `judged / candidates`, for a consumer to render.
 *
 * `ratio` is 1 for a compliant detector. Treat anything less as P0 — that is the
 * taxonomy's §11.5 recommendation stated as a number rather than a paragraph.
 */
export function populationCoverage(population: Population): {
  judged: number;
  candidates: number;
  ratio: number;
} {
  const candidates = population.candidates.length;
  return {
    judged: population.judged.length,
    candidates,
    ratio: candidates === 0 ? 0 : population.judged.length / candidates,
  };
}

/**
 * Select the class's candidates from a graph.
 *
 * Every detector calls this — and NOTHING ELSE — to build `candidates`.
 *
 * ── WHAT THIS FUNCTION DOES NOT GUARANTEE, MEASURED ───────────────────────
 *
 * A previous revision of this docstring claimed that because every detector
 * routes through here, "a narrowing filter can only ever be applied when
 * producing `unjudged`, where it is visible … a detector CAN still narrow, but
 * it cannot narrow SILENTLY." That was FALSE, and it was falsified against this
 * exact code during review on 2026-08-23. Three mutations injected INTO this
 * function, each gated on `graph.nodes.length > 13` (one node above the largest
 * fixture, so no test graph reaches the branch):
 *
 *   - keep only the first node of each kind
 *   - re-apply the `check-tid-boundary-chokepoint.mjs:2662` parameter-name
 *     filter at CANDIDATE level, authorizers only
 *   - drop one authorizer by a substring of its label
 *
 * All three passed the whole suite at `100 passed (100)`, and on a 14-node graph
 * carrying one live C1 defect the sweep reported `ratio: 1.0`,
 * `incompleteDetectors: []`, `unjudged: 0` and ZERO security findings. The
 * defect disappeared and the contract called the result perfect. The reason is
 * structural: `candidates` and `judged` both descend from THIS array, so they
 * cannot disagree about it. Their agreement confirms the method, not the
 * population. It is `check-tid-boundary-chokepoint.mjs`'s own 15-candidates /
 * 1-judged failure moved one step upstream, where it logs 1 / 1 instead.
 *
 * ── WHAT ACTUALLY ENFORCES THE PROMISE ────────────────────────────────────
 *
 * Not this function. {@link detectorResult} recomputes the population from the
 * graph over `Population.declaredKinds`, using {@link nodeKindCensus} — a
 * different traversal that does not call this function — and throws when the
 * two disagree. So the guarantee is: a detector cannot narrow silently BECAUSE
 * AN INDEPENDENT COUNT IS TAKEN, not because narrowing has nowhere else to go.
 * `security/__tests__/population.test.ts` exercises that check with the same
 * cardinality-gated shape that defeated the old claim, and
 * `mutation/mutations.mjs` carries it as `hollow-candidates-of-kind-narrow` so
 * the limit is re-measured rather than re-asserted.
 */
export function candidatesOfKind(
  graph: SecurityGraph,
  kind: SecurityNode['kind'],
): readonly SecurityNode[] {
  return graph.nodes.filter((n) => n.kind === kind);
}
