/**
 * C9 — THE DUPLICATED DECISION (the class that is not a path at all).
 *
 * Taxonomy §10, and §11.4: THE REACHABILITY THESIS DOES NOT DESCRIBE THIS CLASS
 * AT ALL, AND IT IS THE REPO'S MOST PRODUCTIVE ONE.
 *
 * ── WHY A CLEAN REACHABILITY QUERY IS THE WRONG ANSWER HERE ──────────────
 *
 * Measured live 2026-08-23 by running `check-tid-boundary-chokepoint.mjs`:
 *
 *     tenant comparisons found by NAME outside the chokepoint:
 *       11 in 3 file(s), all pinned (#3843)
 *
 * Eleven comparisons, three files, ALL PINNED, ALL PRESENT, ALL ON-PATH. Every
 * one of them IS an authorization edge. Every path through them has one. The
 * reachability query returns clean and IS RIGHT TO. The defect is a property of
 * the SET: two edges that should be the same predicate and are not, where one was
 * repaired and the others were not.
 *
 * `lib/auth/workspace-guard.ts:75-81` states the causal claim directly: "Copies
 * of this decision are how #3823 and #3825 both happened."
 *
 * The open issues confirm the drift is not theoretical: #3843 (`items/by-type`
 * re-derives the boundary in the pre-#3824 shape, so a tid-less session
 * enumerates every tenant's items), #3826 (three more admin paths carry the same
 * tid fall-through, one a write-side escalation AROUND the #3824 fix), #3840 (a
 * fourth independent copy).
 *
 * ── THE DETECTOR IS CLUSTERING PLUS DIFFERENTIAL SEMANTICS ───────────────
 *
 * Cluster all implementations of a security predicate by the `owns` relation they
 * compare, then assert BOTH:
 *
 *   (a) THE CLUSTER SIZE against a DECLARED expected count. This is the cheap
 *       form and it is `check-tid-boundary-chokepoint.mjs` section 9, which
 *       exists because "every finding of the round-5 review showed up first as
 *       that list quietly getting shorter while the guard printed OK." Note the
 *       direction: a SHRINKING list was the tell, so the assertion is EQUALITY,
 *       not a ceiling.
 *
 *   (b) SEMANTIC EQUIVALENCE across the cluster — each member's truth table over
 *       `{callerTid present/absent} x {docTid present/absent} x {equal/unequal}`
 *       must match the canonical's. A member that answers ALLOW where the
 *       canonical answers DENY on ANY row is the finding.
 *
 * The row that matters most is `caller-absent`, and it is why `bfd67ed1` (#3859)
 * was necessary:
 *
 *     if (callerTid && wsDoc.tid && wsDoc.tid !== callerTid) return null;   // step 4
 *     if (callerTid && wsDoc.tid && wsDoc.tid === callerTid) { ... }        // step 6
 *
 * The first is a NON-CONTRADICTION test — a session with no `tid`, or a doc with
 * no `tid`, short-circuits and PASSES. AN EDGE THAT FAILS TO FIRE ON MISSING DATA
 * IS NOT AN EDGE.
 *
 * ── THE NEGATIVE CONTROL THAT KEEPS THIS DETECTOR ALIVE ──────────────────
 *
 * Two members whose truth tables MATCH EXACTLY must NOT fire merely for being
 * duplicates. Duplication with equivalence is a MAINTAINABILITY issue, not a
 * security one, and a detector that conflates them will be turned off — which is
 * the worst outcome available, since this is the class with the most open issues
 * attached to it.
 *
 * ── THE TWO NARROW BYPASSES ──────────────────────────────────────────────
 *
 * (a) ADD COPY N+1 IN A FILE THE CLUSTERING DOES NOT SCAN.
 *     `check-guard-logical-lines.mjs` has the mirror-image problem, recorded in
 *     #3438 (OPEN): it scans only `check-*.mjs`, so a guard that factors its
 *     scanner into a `_`-module is invisible to it. Same evasion, one level up.
 *     -> caught by (a) above, the cluster-size equality assertion, PROVIDED the
 *     expected count is declared. That is why `SecurityAnnotations` carries it.
 *
 * (b) KEEP THE TRUTH TABLES IDENTICAL AND LET THE INPUTS DIFFER.
 *     #3843's shape: the comparison is right and the tid it reads is DERIVED
 *     DIFFERENTLY. A truth-table diff over `{present, absent, equal, unequal}`
 *     cannot see it, because the table is a function of the inputs and the inputs
 *     are what changed. -> reported separately, at MEDIUM, from
 *     `inputsDerivedFrom`. It is a genuinely weaker signal and is graded as one.
 */

import { buildFinding } from '../finding-builder';
import {
  candidatesOfKind,
  detectorResult,
  type DetectorResult,
  type Population,
  type SecurityDetectorSpec,
} from '../population';
import type {
  Finding,
  PredicateImplFacet,
  SecurityGraph,
  SecurityNode,
  TruthRow,
} from '../substrate';
import { TRUTH_ROWS } from '../substrate';

export const C9_DETECTOR_ID = 'security.c9.duplicated-decision';

interface Divergence {
  readonly row: TruthRow;
  readonly canonical: 'allow' | 'deny';
  readonly member: 'allow' | 'deny';
}

function divergences(canonical: PredicateImplFacet, member: PredicateImplFacet): Divergence[] {
  const out: Divergence[] = [];
  for (const row of TRUTH_ROWS) {
    const c = canonical.truthTable[row];
    const m = member.truthTable[row];
    if (c !== m) out.push({ row, canonical: c, member: m });
  }
  return out;
}

export function detectDuplicatedDecision(graph: SecurityGraph): DetectorResult {
  const nodes = candidatesOfKind(graph, 'predicate-impl');
  const findings: Finding[] = [];
  // C9 judges by CLUSTER, not by node, so `judged` is accumulated as each
  // cluster is processed rather than derived from `nodes`. A cluster skipped for
  // any reason therefore drops its members out of `judged` and
  // `detectorResult()` refuses the result — the same teeth the other detectors
  // get from appending after a per-node verdict.
  const judged: string[] = [];

  // Cluster by the `owns` relation compared.
  const clusters = new Map<string, SecurityNode[]>();
  for (const node of nodes) {
    const facet = node.facet as PredicateImplFacet;
    const bucket = clusters.get(facet.clusterKey);
    if (bucket) bucket.push(node);
    else clusters.set(facet.clusterKey, [node]);
  }

  for (const [clusterKey, members] of clusters) {
    for (const m of members) judged.push(m.id);

    // (a) CLUSTER SIZE vs the DECLARED expected count. Equality, not a ceiling —
    // the round-5 tell was the list getting SHORTER.
    const expected = graph.annotations.expectedPredicateClusterSize[clusterKey];
    if (expected !== undefined && expected !== members.length) {
      findings.push(
        buildFinding({
          id: `${C9_DETECTOR_ID}:${clusterKey}:cluster-size`,
          detectorId: C9_DETECTOR_ID,
          findingClass: 'POP-population-integrity',
          severity: 'high',
          confidence: 'high',
          title:
            `predicate cluster '${clusterKey}' has ${members.length} implementation(s); ` +
            `${expected} declared`,
          nodeIds: members.map((m) => m.id),
          query:
            'cluster predicate-impl by clusterKey; assert size === ' +
            'annotations.expectedPredicateClusterSize[clusterKey]',
          facts: [
            members.length > expected
              ? 'A new copy of a security decision appeared without the declared count moving. ' +
                'The narrow bypass this closes is "add copy N+1 in a file the clustering does ' +
                'not scan" — which only works while nobody asserts the count.'
              : 'The derived implementation list SHRANK. That is the exact tell section 9 of ' +
                'check-tid-boundary-chokepoint.mjs exists for: "every finding of the round-5 ' +
                'review showed up first as that list quietly getting shorter while the guard ' +
                'printed OK."',
          ],
          remediationSummary:
            `Reconcile the declared count for '${clusterKey}' with the implementations that ` +
            'actually exist, in the same change that added or removed one. DRAFT ONLY.',
        }),
      );
    }

    const canonicalNode = members.find((m) => (m.facet as PredicateImplFacet).canonical);
    if (!canonicalNode) {
      if (members.length > 1) {
        findings.push(
          buildFinding({
            id: `${C9_DETECTOR_ID}:${clusterKey}:no-canonical`,
            detectorId: C9_DETECTOR_ID,
            findingClass: 'C9-duplicated-decision',
            severity: 'high',
            confidence: 'medium',
            title: `predicate cluster '${clusterKey}' has ${members.length} implementations and NO canonical one`,
            nodeIds: members.map((m) => m.id),
            query: 'cluster predicate-impl by clusterKey where none is marked canonical',
            facts: [
              'With no canonical member there is nothing to diff against, so drift in this ' +
                'cluster is undetectable rather than merely undetected.',
            ],
            remediationSummary:
              `Nominate one implementation of '${clusterKey}' as canonical and make every other ` +
              'delegate to it. DRAFT ONLY.',
          }),
        );
      }
      continue;
    }

    const canonical = canonicalNode.facet as PredicateImplFacet;

    for (const node of members) {
      if (node.id === canonicalNode.id) continue;
      const member = node.facet as PredicateImplFacet;

      // (b) DIFFERENTIAL SEMANTICS.
      const diffs = divergences(canonical, member);
      const permissiveDiffs = diffs.filter((d) => d.member === 'allow' && d.canonical === 'deny');

      if (permissiveDiffs.length > 0) {
        findings.push(
          buildFinding({
            id: `${C9_DETECTOR_ID}:${node.id}:divergence`,
            detectorId: C9_DETECTOR_ID,
            findingClass: 'C9-duplicated-decision',
            severity: 'critical',
            confidence: 'high',
            title:
              `${member.implId} answers ALLOW where the canonical ${canonical.implId} answers ` +
              `DENY on ${permissiveDiffs.map((d) => d.row).join(', ')}`,
            nodeIds: [node.id, canonicalNode.id],
            query:
              'for each non-canonical member of a predicate cluster, diff its truth table over ' +
              '{callerTid present/absent} x {docTid present/absent} x {equal/unequal} against ' +
              'the canonical; any row where the member allows and the canonical denies is the ' +
              'finding',
            facts: [
              ...permissiveDiffs.map(
                (d) => `row '${d.row}': canonical=${d.canonical}, ${member.implId}=${d.member}`,
              ),
              permissiveDiffs.some((d) => d.row === 'caller-absent' || d.row === 'doc-absent')
                ? 'This is the NON-CONTRADICTION shape: `docTid && callerTid && docTid !== ' +
                  'callerTid` short-circuits and PASSES when either side is missing. An edge ' +
                  'that fails to fire on missing data is not an edge (bfd67ed1 / #3859).'
                : 'The divergence is on a row where both tids are present, so the member is ' +
                  'making a different decision on complete data.',
              'Every implementation in this cluster IS an authorization edge and every path ' +
                'through them has one, so the reachability query returns clean and is right to. ' +
                'The defect is a property of the SET.',
            ],
            remediationSummary:
              `Consolidate ${member.implId} onto ${canonical.implId} rather than repairing it in ` +
              'place. Copies of this decision are how #3823 and #3825 both happened. DRAFT ONLY.',
            proposedPatchDescription: `Delegate ${member.implId} to ${canonical.implId}.`,
          }),
        );
      }

      // NEGATIVE CONTROL boundary: identical truth tables do NOT fire. But if the
      // INPUTS differ, that is #3843's shape and is reported separately, at
      // MEDIUM, because it is a genuinely weaker signal than a table divergence.
      if (diffs.length === 0 && member.inputsDerivedFrom !== canonical.inputsDerivedFrom) {
        findings.push(
          buildFinding({
            id: `${C9_DETECTOR_ID}:${node.id}:input-provenance`,
            detectorId: C9_DETECTOR_ID,
            findingClass: 'C9-duplicated-decision',
            severity: 'medium',
            confidence: 'medium',
            title:
              `${member.implId}'s truth table matches canonical exactly, but it derives its ` +
              'inputs differently',
            nodeIds: [node.id, canonicalNode.id],
            query:
              'cluster members whose truth tables are identical but whose inputsDerivedFrom differ',
            facts: [
              `canonical reads: ${canonical.inputsDerivedFrom}`,
              `${member.implId} reads: ${member.inputsDerivedFrom}`,
              'NARROW: a truth-table diff cannot see this, because the table is a function of ' +
                'the inputs and the inputs are what changed. #3843 is this shape — the ' +
                'comparison is right and the tid it reads is derived differently.',
              'Reported at MEDIUM deliberately: it is weaker evidence than a table divergence ' +
                'and must not be graded as if it were the same finding.',
            ],
            remediationSummary:
              `Have ${member.implId} obtain its comparands from the same source as ` +
              `${canonical.implId}, or delegate outright. DRAFT ONLY.`,
          }),
        );
      }
    }
  }

  const population: Population = {
    detectorId: C9_DETECTOR_ID,
    candidates: nodes.map((n) => n.id),
    judged,
    unjudged: [],
    emptyIsExpected: false,
  };

  return detectorResult(findings, population);
}

export const c9Spec: SecurityDetectorSpec = {
  id: C9_DETECTOR_ID,
  taxonomyClass: 'C9',
  title: 'Duplicated decision (a property of a SET, not of a path)',
  run: detectDuplicatedDecision,
};
