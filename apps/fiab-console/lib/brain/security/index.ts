/**
 * LOOM BRAIN — SECURITY DETECTOR REGISTRY.
 *
 * The security half of the Brain: nine pure detectors, one shared findings model,
 * and a population contract that makes "zero over zero" impossible to report as
 * "clean".
 *
 * ── WHAT THIS IS AND IS NOT ──────────────────────────────────────────────
 *
 * IS: `graph -> { findings, population }`, pure, side-effect free, deterministic,
 * and RECOMMEND-ONLY — every remediation is data and `assertAllInert` proves it.
 *
 * IS NOT: an extractor. Nothing in this package reads a file, walks an AST, calls
 * Azure, or talks to Cosmos. The graph is an input. `lib/brain/graph/**` — the
 * substrate that would BUILD that graph from the estate and from source — did not
 * exist on `origin` when this landed (see `./substrate.ts` for the measurement),
 * so THESE DETECTORS HAVE NEVER RUN AGAINST A GRAPH EXTRACTED FROM THIS REPO.
 * They have run against modelled graphs, which is a different and much weaker
 * claim, and `SecurityGraph.source` carries that distinction in the data so a
 * consumer cannot lose it.
 *
 * ── THE ORDER IS BY REAL-INSTANCE SEVERITY, NOT BY NUMBER ────────────────
 *
 * C1 (authorization bypass — two live OPEN instances granting real ADLS POSIX
 * ACLs and gating four verbs), C2 (cross-tenant leak), C4 (secret publication)
 * come first because those are the classes with shipped, measured, currently-open
 * instances. C3 is fourth only because its instance is fixed — the CLASS defeated
 * three merge-blocking controls simultaneously and is arguably the most dangerous
 * shape in the taxonomy.
 */

import { c1Spec } from './detectors/c1-unauthorized-inbound-edge';
import { c2Spec } from './detectors/c2-aggregate-oracle';
import { c3Spec } from './detectors/c3-discarded-verdict';
import { c4Spec } from './detectors/c4-unbounded-publication';
import { c5Spec } from './detectors/c5-fail-open';
import { c6Spec } from './detectors/c6-credential-unbounded-sink';
import { c7Spec } from './detectors/c7-synthesized-principal';
import { c8Spec } from './detectors/c8-human-executed-command';
import { c9Spec } from './detectors/c9-duplicated-decision';
import { assertAllInert } from './recommend-only';
import {
  populationCoverage,
  type DetectorResult,
  type SecurityDetectorSpec,
} from './population';
import type { Finding, SecurityGraph } from './substrate';

/**
 * Every security detector, in real-instance severity order.
 *
 * The COUNT is asserted by `registry.test.ts`. That is not ceremony: the
 * taxonomy's §11.5 conclusion is that this repo's dominant evasion is falling
 * outside the examined population, and a detector silently dropping out of the
 * registry is that failure applied to the registry itself.
 */
export const SECURITY_DETECTORS: readonly SecurityDetectorSpec[] = [
  c1Spec,
  c2Spec,
  c4Spec,
  c3Spec,
  c5Spec,
  c6Spec,
  c7Spec,
  c8Spec,
  c9Spec,
] as const;

export interface SecuritySweepResult {
  readonly findings: readonly Finding[];
  readonly perDetector: readonly (DetectorResult & { readonly detectorId: string })[];
  /**
   * Aggregate `judged / candidates`.
   *
   * `ratio < 1` on ANY detector is a P0 signal per taxonomy §11.5, and it is
   * surfaced here rather than left to a consumer to compute — computing it is
   * exactly the step that gets skipped.
   */
  readonly coverage: {
    readonly judged: number;
    readonly candidates: number;
    readonly ratio: number;
    readonly incompleteDetectors: readonly string[];
  };
}

/** Run every security detector over one graph. Pure. */
export function runSecuritySweep(graph: SecurityGraph): SecuritySweepResult {
  const perDetector: (DetectorResult & { detectorId: string })[] = [];
  const findings: Finding[] = [];

  for (const spec of SECURITY_DETECTORS) {
    const result = spec.run(graph);
    assertAllInert(result.findings);
    perDetector.push({ ...result, detectorId: spec.id });
    findings.push(...result.findings);
  }

  let judged = 0;
  let candidates = 0;
  const incompleteDetectors: string[] = [];
  for (const r of perDetector) {
    const c = populationCoverage(r.population);
    judged += c.judged;
    candidates += c.candidates;
    if (c.candidates > 0 && c.ratio < 1) incompleteDetectors.push(r.detectorId);
  }

  return {
    findings,
    perDetector,
    coverage: {
      judged,
      candidates,
      ratio: candidates === 0 ? 0 : judged / candidates,
      incompleteDetectors,
    },
  };
}

export { assertAllInert, assertInertRemediation } from './recommend-only';
export {
  candidatesOfKind,
  detectorResult,
  findingsOf,
  nodeKindCensus,
  populationCoverage,
  securityFindingsOf,
} from './population';
export type {
  DetectorResult,
  KindCensus,
  Population,
  SecurityDetector,
  SecurityDetectorSpec,
  UnjudgedCandidate,
} from './population';
export * from './substrate';
export { C1_DETECTOR_ID, detectUnauthorizedInboundEdge } from './detectors/c1-unauthorized-inbound-edge';
export { C2_DETECTOR_ID, detectAggregateOracle } from './detectors/c2-aggregate-oracle';
export { C3_DETECTOR_ID, detectDiscardedVerdict } from './detectors/c3-discarded-verdict';
export { C4_DETECTOR_ID, detectUnboundedPublication } from './detectors/c4-unbounded-publication';
export { C5_DETECTOR_ID, detectFailOpen } from './detectors/c5-fail-open';
export { C6_DETECTOR_ID, detectCredentialUnboundedSink } from './detectors/c6-credential-unbounded-sink';
export { C7_DETECTOR_ID, detectSynthesizedPrincipal } from './detectors/c7-synthesized-principal';
export { C8_DETECTOR_ID, detectHumanExecutedCommand } from './detectors/c8-human-executed-command';
export { C9_DETECTOR_ID, detectDuplicatedDecision } from './detectors/c9-duplicated-decision';
