/**
 * C4 — THE UNBOUNDED PUBLICATION EDGE (a public repo has five sinks, and one has
 * no `write()`).
 *
 * Taxonomy §5. #3829 was filed against ONE leak: `decision.reason` reaching a
 * public issue body unredacted from `scripts/ci/deploy-retry.mjs`. Each round of
 * fixing it found the population larger than the round before — three
 * GUID-carrying fields, all fed by an ARM leaf's `resourceName`, reaching:
 *
 *   1. the auto-issue-poster -> a public issue BODY ... AND THE TITLE, built
 *      separately by `buildIssueTitle` and not covered by the body fix;
 *   2. `ghAnnotate(...)` -> Actions annotations;
 *   3. RAW `process.stderr` -> in an Actions `run:` step this IS the public run
 *      log, and it is A DIFFERENT PATH from `ghAnnotate`. Guarding the annotation
 *      does not cover it. `deploy-retry.mjs` runs from 10 workflows, including
 *      all four Gov/GCC/GCCH/IL5 lanes;
 *   4. the `deploy-failure.json` artifact write;
 *   5. THE INHERITED FILE DESCRIPTOR — see below.
 *
 * ── THE FIFTH SINK HAS NO `write()` IN SOURCE ────────────────────────────
 *
 * `scripts/ci/deploy-retry.mjs:800`:
 *
 *     stdio: ['inherit', 'inherit', 'pipe'],
 *
 * This hands the child THE PARENT'S STDOUT FILE DESCRIPTOR. The child's bytes
 * land on the public Actions run log with NO `write` call anywhere in the
 * parent's source. Every assertion of the shape "grep the source for
 * `process.stdout.write` and prove each one goes through the boundary" is
 * therefore STRUCTURALLY BLIND to it.
 *
 * PR #3835 went four rounds hardening publication surfaces and none of them could
 * have seen this one; it was found only when a fifth pass enumerated `stdio:`
 * spawn configs INSTEAD OF write calls. The known open gap is
 * `scripts/csa-loom/converge-role-assignment.mjs` (#3861, OPEN, labelled
 * `security`), which reaches the log this way with a raw `e.message`.
 *
 * So `accessPath: 'spawn-stdio'` is a first-class member of the enumerated
 * population here, and `c4-narrow.test.ts` asserts a sink with ZERO writes in its
 * file still fires.
 *
 * ── THE FOUR MEASURED BYPASSES (#3876, OPEN) ─────────────────────────────
 *
 * The enumerator at `scripts/ci/__tests__/_publication-surfaces.mjs:147` matches
 * only the literal member expression, and the classifier at `:173-174` is
 * PREFIX-ONLY:
 *
 *     return streamWrites(src).filter((w) => !allowed.some((fn) => w.arg.startsWith(`${fn}(`)));
 *
 *   1. `process.stdout.write(formatStdout(a) + raw)` — the argument STARTS WITH an
 *      allowed boundary call; `raw` is never examined.  -> `wholeExpressionBounded`
 *   2. `const out = process.stdout; out.write(raw)`     -> `accessPath: 'alias'`
 *   3. `const { stdout } = process; stdout.write(raw)`  -> `accessPath: 'destructured'`
 *   4. `process['stdout'].write(raw)`                   -> `accessPath: 'bracket'`
 *
 * THREE OF THE FOUR ARE ZERO-POPULATION BYPASSES: the checker reports clean not
 * because the write is safe but BECAUSE IT COUNTED NO WRITES AT ALL. That is the
 * signature to look for, and it generalises — a detector whose population can be
 * driven to zero by renaming is not a detector.
 *
 * ── THE COUNT ASSERTION IS PART OF THE DETECTOR, NOT A TEST ──────────────
 *
 * Taxonomy §5.4: "COUNT the enumerated sinks and assert the count, so a new one
 * cannot appear silently." `declaredSinkCount !== sinks.length` therefore
 * produces a `POP-population-integrity` finding from inside the detector. That is
 * the difference between a guard that watches and one that merely ran.
 *
 * ── THE ANTI-FIXTURE, STATED BECAUSE THIS REPO TRIPPED ON IT ─────────────
 *
 * Do NOT key a non-degeneracy control to the leaked value itself. A test
 * asserting "the raw stderr MUST still carry the id, or this test proves
 * nothing" turns CLOSING THE LEAK into a test failure. The specs for this
 * detector key their controls to a non-secret token (`FIXTURE-TOKEN-A`), never to
 * anything shaped like an estate identifier — this repo is public.
 */

import { buildFinding } from '../finding-builder';
import {
  candidatesOfKind,
  detectorResult,
  type DetectorResult,
  type Population,
  type SecurityDetectorSpec,
  type UnjudgedCandidate,
} from '../population';
import type { Finding, PublicationFacet, PublicationSink, SecurityGraph } from '../substrate';

export const C4_DETECTOR_ID = 'security.c4.unbounded-publication';

/** Access paths a lexical `process.stdout.write` enumerator cannot see. */
const INVISIBLE_TO_LEXICAL_ENUMERATION = new Set(['alias', 'destructured', 'bracket', 'spawn-stdio']);

function sinkFindingId(nodeId: string, sink: PublicationSink): string {
  return `${C4_DETECTOR_ID}:${nodeId}:${sink.id}`;
}

export function detectUnboundedPublication(graph: SecurityGraph): DetectorResult {
  const nodes = candidatesOfKind(graph, 'publication');
  const findings: Finding[] = [];
  const judged: string[] = [];
  const unjudged: UnjudgedCandidate[] = [];

  for (const node of nodes) {
    const facet = node.facet as PublicationFacet;

    // §5.4 — assert the enumerated count. A module whose declared sink count has
    // drifted from its actual sinks is exactly the "a new one appeared silently"
    // case, and it is reported as a POPULATION finding rather than a security one
    // so it cannot be triaged as a false positive on the leak.
    if (facet.declaredSinkCount !== facet.sinks.length) {
      findings.push(
        buildFinding({
          id: `${C4_DETECTOR_ID}:${node.id}:sink-count-drift`,
          detectorId: C4_DETECTOR_ID,
          findingClass: 'POP-population-integrity',
          severity: 'high',
          confidence: 'high',
          title:
            `${facet.module} declares ${facet.declaredSinkCount} publication sink(s) and has ` +
            `${facet.sinks.length}`,
          nodeIds: [node.id],
          query: 'publication where declaredSinkCount !== sinks.length',
          facts: [
            'A publication surface that appears without the declared count moving is invisible ' +
              'to every per-sink check, however correct each of those is.',
            '#3829 grew from one leak to five sinks across four rounds of fixing, and the fifth ' +
              'was found only by enumerating spawn configs instead of write calls.',
          ],
          remediationSummary:
            `Re-derive ${facet.module}'s sink inventory and update the declared count in the ` +
            'same change, so a new surface cannot land without a reviewer seeing the number ' +
            'move. DRAFT ONLY.',
        }),
      );
    }

    for (const sink of facet.sinks) {
      // The disclosed, deliberate exception.
      if (sink.unredactedByDesign) continue;

      const isSpawn = sink.accessPath === 'spawn-stdio' || sink.surface === 'inherited-fd';

      // An inherited fd publishes the CHILD's bytes. The parent has nothing to
      // bound, so the only question that means anything is whether the child
      // redacts — and `null`/`false` are both "not proven", never "fine".
      const leaks = isSpawn
        ? sink.childProvenRedacting !== true
        : sink.carriesSensitive && !sink.wholeExpressionBounded;

      if (!leaks) continue;

      const facts: string[] = [
        `${facet.module} publishes to ${sink.surface} via ${sink.accessPath}`,
        `whole emitted expression bounded: ${sink.wholeExpressionBounded} (boundary=${sink.boundary ?? 'none'})`,
      ];

      if (isSpawn) {
        facts.push(
          'INHERITED FD: this sink has NO `write()` in the parent\'s source. The child\'s bytes ' +
            'reach the public run log through a descriptor handed to it by the spawn config. ' +
            'Any check built by grepping for write calls is structurally blind to it — ' +
            'scripts/ci/deploy-retry.mjs:800 is the measured instance.',
          `child proven to redact: ${sink.childProvenRedacting === null ? 'UNKNOWN (never established)' : sink.childProvenRedacting}`,
        );
      }
      if (!isSpawn && sink.boundary !== null && !sink.wholeExpressionBounded) {
        facts.push(
          `NARROW: the expression STARTS WITH the boundary call ${sink.boundary}(...) and then ` +
            'concatenates an unexamined value. The prefix-only classifier at ' +
            '_publication-surfaces.mjs:173-174 passes exactly this (#3876 bypass 1).',
        );
      }
      if (INVISIBLE_TO_LEXICAL_ENUMERATION.has(sink.accessPath)) {
        facts.push(
          `NARROW: access path '${sink.accessPath}' is invisible to an enumerator that matches ` +
            'the literal member expression. Three of the four #3876 bypasses drive the write ' +
            'count to ZERO this way — clean because nothing was counted, not because nothing leaks.',
        );
      }
      if (sink.surface === 'issue-title') {
        facts.push(
          'The issue TITLE is built separately from the body and was not covered by the body ' +
            'fix. Two sinks, one publication act.',
        );
      }

      findings.push(
        buildFinding({
          id: sinkFindingId(node.id, sink),
          detectorId: C4_DETECTOR_ID,
          findingClass: 'C4-unbounded-publication',
          severity: 'critical',
          confidence: sink.childProvenRedacting === null && isSpawn ? 'medium' : 'high',
          title: `${facet.module} -> ${sink.surface} (${sink.accessPath}) is not wholly bounded`,
          nodeIds: [node.id],
          query:
            'publication.sinks[] where NOT unredactedByDesign AND (for spawn-stdio/inherited-fd: ' +
            'childProvenRedacting !== true; otherwise: carriesSensitive AND NOT ' +
            'wholeExpressionBounded) — sinks enumerated structurally across every access path',
          facts,
          remediationSummary: isSpawn
            ? 'Do not hand the child an inherited descriptor unless the child is itself proven ' +
              'to redact. Pipe it and route the bytes through the shared boundary ' +
              '(scripts/ci/_azure-redact.mjs), which is size-independent by contract — a length ' +
              'cap is a reachable leak, not a theoretical one: a 60-leaf dump measures 24,419 ' +
              'bytes. DRAFT ONLY.'
            : 'Redact at the PUBLICATION BOUNDARY, not field by field (afcf3e6b / #3829). The ' +
              'whole emitted expression must be produced by the boundary — a prefix is not ' +
              'enough. DRAFT ONLY.',
          proposedPatchDescription: `Route ${facet.module}'s ${sink.surface} emission through the shared redaction boundary.`,
        }),
      );
    }

    // Appended ONLY after this node was actually evaluated — see c1 for why.
    judged.push(node.id);
  }

  const population: Population = {
    detectorId: C4_DETECTOR_ID,
    declaredKinds: ['publication'],
    candidates: nodes.map((n) => n.id),
    judged,
    unjudged,
    emptyIsExpected: false,
  };

  return detectorResult(findings, population, graph);
}

export const c4Spec: SecurityDetectorSpec = {
  id: C4_DETECTOR_ID,
  taxonomyClass: 'C4',
  title: 'Unbounded publication edge (five surfaces, one with no write())',
  run: detectUnboundedPublication,
};
