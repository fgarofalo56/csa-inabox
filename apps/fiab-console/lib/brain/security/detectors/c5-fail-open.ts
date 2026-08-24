/**
 * C5 — FAIL-OPEN: UNKNOWN REPORTED AS A DEFINITE ANSWER.
 *
 * Taxonomy §6, and §11.3: THE REACHABILITY THESIS DOES NOT DESCRIBE THIS CLASS AT
 * ALL. `graphUserInGroup` HAS an authorization edge; it IS on the path; it IS
 * consumed. It answers ALLOW on 2 of 9 failure modes. No reachability query over
 * any edge set detects that, because the edge is present and consumed and the
 * path is guarded. The property is "the verdict function is TOTAL and FAILS
 * CLOSED" — a property of a NODE'S IMPLEMENTATION, not of the graph's shape.
 *
 * That is why this detector reads `failureModes` and nothing about edges.
 *
 * ── THE MEASURED INSTANCES ───────────────────────────────────────────────
 *
 * (a) FAIL-OPEN ON A GRAPH 2xx — FIXED; kept because the SHAPE is the lesson.
 *     Until `bfd67ed1` (#3859, the first half of #3834), `graphUserInGroup` read
 *     a BARE `res.ok` as membership without inspecting the body, so any 2xx from
 *     something sitting in front of Graph — a proxy, a WAF, a captive portal, a
 *     wrong-national-cloud host — GRANTED the group's role and silently defeated
 *     the `tenant_unconfirmed` refusal the function exists to produce.
 *     `lib/auth/workspace-guard.ts` disclosed it as a residual for as long as it
 *     was open. The point-read now requires the returned directoryObject to
 *     identify the principal that was asked about, and the rest of #3834 closed
 *     the walk's other non-answers: an enumeration transport failure resolves
 *     `'unknown'` instead of throwing out of the authorization boundary, a 429
 *     aborts instead of falling through into a second throttled call, and the
 *     group loop runs under one walk-wide clock.
 *
 *     STATED IN THE PAST TENSE RATHER THAN DELETED. This detector's granularity
 *     was derived from this instance, and per the rule quoted below, adoption of
 *     a fix must not erase the evidence that the fix was needed. Restating it as
 *     live would be its own C5 — asserting as fact something no longer measured.
 *
 *     NOTE THE SHAPE, because it decides the detector's granularity: the other 7
 *     modes answered `'unknown'` and refused correctly. The class is NOT "this
 *     code fails open". It is "THIS CODE'S UNKNOWN HANDLING IS NON-UNIFORM ACROSS
 *     9 PATHS AND 2 OF THEM INVERT". A detector that samples one failure path —
 *     or that merely asserts "there is a catch" — passes. So the predicate is
 *     PER-MODE and the finding count reflects the inverted modes.
 *
 * (b) FAIL-OPEN AT THE SHELL. `deploy-integrity.md` R7 exists because a
 *     `2>/dev/null` converted a permission denial into an empty string, and the
 *     empty string into the claim "the tag does not exist" — a message that sent
 *     two separate investigations down the wrong path.
 *
 * (c) FAIL-OPEN IN THE UI. `scripts/ci/check-empty-claim-read-evidence.mjs`
 *     (#3281) generalises it: "if the render path that emits 'there is nothing
 *     here' is still reachable when the read FAILED, the surface asserts as fact
 *     something it never established." The live example was `app/catalog/domains`:
 *     an honest "could not reach the route" banner rendered three DOM nodes above
 *     a grid asserting "No business domains defined for this tenant yet."
 *
 * ── POPULATION MEMBERSHIP IS INDEPENDENT OF THE FIX ──────────────────────
 *
 * The single most transferable idea in this repo's guard corpus, quoted from
 * `check-empty-claim-read-evidence.mjs:36-38`. A token rule keyed to the UNSAFE
 * pattern goes quiet on exactly the files that adopt the fix: adoption removes
 * the file from the population, so COVERAGE AND COMPLIANCE BECOME
 * INDISTINGUISHABLE, and a file that never had the pattern scores identical to
 * one that fixed it.
 *
 * Membership here is `performsRead && rendersEmptyStateClaim` (or: the node
 * enumerates failure modes at all). ADOPTING THE FIX REMOVES NEITHER.
 * `c5-population.test.ts` asserts a node with `adoptedFix: true` stays in
 * `judged` with a clean verdict — a fixed node must be VISIBLY clean, never
 * absent.
 *
 * ── WHY A SINGLE ENUMERATED MODE IS ITSELF REPORTED ──────────────────────
 *
 * "One uninverted sample is not coverage" (§6.5). A node that enumerates exactly
 * one failure mode and answers it correctly is not demonstrably total — it is
 * under-examined. That produces a LOW-severity, LOW-confidence coverage finding,
 * deliberately distinct in severity from an actual inversion so it can be
 * triaged separately and does not train a reviewer to ignore the class.
 *
 * `bash -e` truncation (§6.4, third bypass) is NOT modelled here: the taxonomy
 * marks it UNCONFIRMED on that tree and this lane did not re-measure it. Naming
 * the omission is the point — an unmodelled bypass stated is worth more than one
 * silently absent.
 */

import { buildFinding } from '../finding-builder';
import {
  candidatesOfKind,
  detectorResult,
  type DetectorResult,
  type Population,
  type SecurityDetectorSpec,
} from '../population';
import type { Finding, SecurityGraph, VerdictTotalityFacet } from '../substrate';

export const C5_DETECTOR_ID = 'security.c5.fail-open';

export function detectFailOpen(graph: SecurityGraph): DetectorResult {
  const nodes = candidatesOfKind(graph, 'verdict-totality');
  const findings: Finding[] = [];
  const judged: string[] = [];

  for (const node of nodes) {
    const facet = node.facet as VerdictTotalityFacet;

    // PER-MODE, never per-node. 7 correct modes do not offset 2 inverted ones,
    // and a detector that sampled would report this node clean.
    const inverted = facet.failureModes.filter((m) => m.verdict === 'allow');
    for (const mode of inverted) {
      findings.push(
        buildFinding({
          id: `${C5_DETECTOR_ID}:${node.id}:mode:${mode.name}`,
          detectorId: C5_DETECTOR_ID,
          findingClass: 'C5-fail-open',
          severity: 'critical',
          confidence: 'high',
          title: `${facet.subject} answers ALLOW on failure mode '${mode.name}'`,
          nodeIds: [node.id],
          query: 'verdict-totality.failureModes[] where verdict === "allow"',
          facts: [
            `${facet.subject} enumerates ${facet.failureModes.length} failure mode(s); ` +
              `${inverted.length} answer ALLOW and ` +
              `${facet.failureModes.filter((m) => m.verdict === 'deny').length} answer DENY.`,
            'NARROW: the correct modes are the majority. A detector that samples one failure ' +
              'path, or that asserts only "there is a catch", reports this node clean. #3834 was ' +
              'exactly this shape — fail-OPEN in 2 of 9 measured Graph failure modes.',
            'An UNKNOWN reported as a definite answer is the class; the default being permissive ' +
              'is what makes it a security finding rather than a correctness one.',
          ],
          remediationSummary:
            `Map '${mode.name}' explicitly to DENY or to a distinguished UNKNOWN that the caller ` +
            'refuses. Do not read a bare transport-level success (res.ok, exit 0) as a semantic ' +
            'answer without inspecting the body. DRAFT ONLY.',
        }),
      );
    }

    if (facet.unknownMapsTo !== 'deny') {
      findings.push(
        buildFinding({
          id: `${C5_DETECTOR_ID}:${node.id}:unknown`,
          detectorId: C5_DETECTOR_ID,
          findingClass: 'C5-fail-open',
          severity: 'high',
          confidence: 'high',
          title:
            `${facet.subject}'s UNKNOWN verdict is ` +
            (facet.unknownMapsTo === 'unmodelled' ? 'not modelled at all' : 'mapped to ALLOW'),
          nodeIds: [node.id],
          query: 'verdict-totality where unknownMapsTo !== "deny"',
          facts: [
            'An authorization or verification edge has THREE verdicts — ALLOW, DENY, UNKNOWN — ' +
              'and this one models two. UNKNOWN collapses into whichever of the others is the ' +
              'default, and the default here is the permissive one.',
            `unknownMapsTo: ${facet.unknownMapsTo}`,
          ],
          remediationSummary:
            'Model UNKNOWN as a distinguished verdict and have the caller map it to refusal. ' +
            'If the code does not know, the message must say it does not know ' +
            '(deploy-integrity.md R7). DRAFT ONLY.',
        }),
      );
    }

    if (facet.emptyStateReachableOnReadError) {
      findings.push(
        buildFinding({
          id: `${C5_DETECTOR_ID}:${node.id}:empty-claim`,
          detectorId: C5_DETECTOR_ID,
          findingClass: 'C5-fail-open',
          severity: 'high',
          confidence: 'high',
          title: `${facet.subject} renders a "there is nothing here" claim while the read FAILED`,
          nodeIds: [node.id],
          query: 'verdict-totality where emptyStateReachableOnReadError',
          facts: [
            'The surface asserts as fact something it never established (#3281). The live ' +
              'example rendered an honest "could not reach the route" banner three DOM nodes ' +
              'above a grid asserting "No business domains defined for this tenant yet."',
            'Regex proximity cannot express "this failure feeds that claim" — widening by regex ' +
              'was tried and failed (161 candidates -> 35 -> 20 -> 2, both survivors false ' +
              'positives). This is a reachability question over the RENDER graph under an ERROR ' +
              'PRECONDITION, which is model checking a state predicate, not finding an ' +
              'unguarded path.',
          ],
          remediationSummary:
            'Make the empty-state render unreachable while the read\'s error state is set. ' +
            'DRAFT ONLY.',
        }),
      );
    }

    // "One uninverted sample is not coverage." Distinct severity so it triages
    // separately from an actual inversion.
    if (facet.failureModes.length === 1 && inverted.length === 0) {
      findings.push(
        buildFinding({
          id: `${C5_DETECTOR_ID}:${node.id}:coverage`,
          detectorId: C5_DETECTOR_ID,
          findingClass: 'C5-fail-open',
          severity: 'low',
          confidence: 'low',
          title: `${facet.subject} enumerates ONE failure mode — not demonstrably total`,
          nodeIds: [node.id],
          query: 'verdict-totality where failureModes.length === 1 AND none inverted',
          facts: [
            'One correctly-handled failure mode is not evidence that the verdict function is ' +
              'total. #3834 handled 7 of 9 correctly.',
          ],
          remediationSummary:
            'Enumerate the failure modes of this verdict and assert each maps to DENY or to a ' +
            'distinguished UNKNOWN. DRAFT ONLY.',
        }),
      );
    }

    // Appended ONLY after this node was actually evaluated — see c1 for why.
    judged.push(node.id);
  }

  const population: Population = {
    detectorId: C5_DETECTOR_ID,
    declaredKinds: ['verdict-totality'],
    candidates: nodes.map((n) => n.id),
    judged,
    unjudged: [],
    emptyIsExpected: false,
  };

  return detectorResult(findings, population, graph);
}

export const c5Spec: SecurityDetectorSpec = {
  id: C5_DETECTOR_ID,
  taxonomyClass: 'C5',
  title: 'Fail-open (verdict totality of a node, not a property of the graph)',
  run: detectFailOpen,
};
