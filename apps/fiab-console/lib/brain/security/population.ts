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

import type { Finding, SecurityGraph, SecurityNode } from './substrate';

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
 * Build a `DetectorResult`, enforcing the population contract.
 *
 * Throws on an incoherent population (judged outside candidates) because that is
 * a defect in the DETECTOR, not a finding about the graph, and shipping a
 * verdict from a broken population model is how RC=0 gets believed.
 *
 * Appends `POP-population-integrity` findings for the two silent states.
 */
export function detectorResult(
  findings: readonly Finding[],
  population: Population,
): DetectorResult {
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
 * Every detector calls this — and NOTHING ELSE — to build `candidates`, so a
 * narrowing filter can only ever be applied when producing `unjudged`, where it
 * is visible. That is the structural answer to the parameter-name filter at
 * `check-tid-boundary-chokepoint.mjs:2662`: a detector CAN still narrow, but it
 * cannot narrow SILENTLY.
 */
export function candidatesOfKind(
  graph: SecurityGraph,
  kind: SecurityNode['kind'],
): readonly SecurityNode[] {
  return graph.nodes.filter((n) => n.kind === kind);
}
