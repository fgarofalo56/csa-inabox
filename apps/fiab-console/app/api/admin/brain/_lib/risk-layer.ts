/**
 * LOOM BRAIN — THE RISK LANE OF THE SYNAPSE VIEW.
 *
 * PRP §3.7: "security detection is reachability with the predicate inverted.
 * Waste is a node with no inbound edge. A vulnerability is an inbound edge that
 * should not exist." This module is the RENDERING side of that claim: it runs the
 * shipped detectors and flattens their output for the wire. It contains no
 * predicate of its own, and that is deliberate — #3934's binding constraint is
 * that this item renders and does not re-derive. A second implementation of "is
 * this edge authorized" would be the second implementation that drifts, and it
 * would drift toward clean, because clean is the branch nobody writes a fixture
 * for.
 *
 * ── THE ONE THING THIS MODULE ADDS: IT REFUSES TO FLATTEN A BLINDNESS ────
 *
 * `runSecuritySweep` returns findings AND a per-detector `judged / candidates`.
 * A naive flattener ships the findings. This one ships both, per detector, and
 * the layer type has no member in which findings can appear without them. The
 * measured reason is in `lib/brain/security/population.ts`: this repo's dominant
 * evasion is not an unguarded edge, it is falling outside the examined
 * population, and it is invisible in every artifact except a population count.
 *
 * ── AND IT NEVER TURNS "NO GRAPH" INTO "NO FINDINGS" ─────────────────────
 *
 * `buildRiskLayer` takes a {@link SecurityGraphSource} discriminated union, not a
 * graph-or-null. Passing "no graph" therefore cannot fall through to the sweep
 * with an empty graph — there is no expression that does it. The result is
 * `evaluated: false` carrying the registry of what WOULD have run, so the surface
 * can state the size of what it did not examine.
 *
 * ── PURE ─────────────────────────────────────────────────────────────────
 *
 * No fetch, no fs, no Azure. Everything below is a function of its argument,
 * which is what lets `synapse-risk.test.ts` run the REAL nine detectors over a
 * REAL modelled graph and assert the rendered output, rather than asserting a
 * stub of it.
 */

import {
  SECURITY_DETECTORS,
  populationCoverage,
  runSecuritySweep,
  type Finding as SecurityFinding,
} from '@/lib/brain/security';
import type { SecurityGraphSource } from './security-source';
import type {
  RiskLayer,
  WireRiskDetectorRegistration,
  WireRiskDetectorRun,
  WireRiskFinding,
} from './synapse-wire';

/** The detectors that exist, whether or not they ran. */
export function riskDetectorRegistry(): readonly WireRiskDetectorRegistration[] {
  return SECURITY_DETECTORS.map((spec) => ({
    detectorId: spec.id,
    taxonomyClass: spec.taxonomyClass,
    title: spec.title,
  }));
}

function toWireFinding(f: SecurityFinding): WireRiskFinding {
  return {
    id: f.id,
    detectorId: f.detectorId,
    findingClass: f.findingClass,
    severity: f.severity,
    confidence: f.confidence,
    title: f.title,
    evidence: {
      nodeIds: f.evidence.nodeIds,
      edgeIds: f.evidence.edgeIds,
      query: f.evidence.query,
      facts: f.evidence.facts,
    },
    remediation: {
      summary: f.remediation.summary,
      proposedCommands: f.remediation.proposedCommands,
      proposedPatchDescription: f.remediation.proposedPatchDescription,
      // Restated as the literal the substrate pins. If the substrate ever
      // widened it to `boolean`, this line stops compiling here rather than
      // shipping a self-approving remediation to a browser.
      requiresHumanApproval: true,
    },
  };
}

/**
 * Run the security sweep and flatten it, or report honestly that it did not run.
 *
 * The `taxonomyClass` / `title` join is by detector id against the registry
 * rather than by array index: `runSecuritySweep` iterates `SECURITY_DETECTORS` in
 * order today, but an index join would silently mislabel every row the moment
 * anything filters or reorders, and a mislabelled C5 row reading "C1" is worse
 * than no row.
 */
export function buildRiskLayer(source: SecurityGraphSource): RiskLayer {
  if (!source.available) {
    return { evaluated: false, reason: source.reason, registry: riskDetectorRegistry() };
  }

  const sweep = runSecuritySweep(source.graph);
  const byId = new Map(SECURITY_DETECTORS.map((s) => [s.id, s]));

  const detectors: WireRiskDetectorRun[] = sweep.perDetector.map((r) => {
    const spec = byId.get(r.detectorId);
    const cov = populationCoverage(r.population);
    return {
      detectorId: r.detectorId,
      taxonomyClass: spec?.taxonomyClass ?? 'UNKNOWN',
      title: spec?.title ?? r.detectorId,
      judged: cov.judged,
      candidates: cov.candidates,
      ratio: cov.ratio,
      unjudged: r.population.unjudged.map((u) => ({ nodeId: u.nodeId, reason: u.reason })),
      findingCount: r.findings.length,
    };
  });

  return {
    evaluated: true,
    graphSource: source.graph.source,
    findings: sweep.findings.map(toWireFinding),
    detectors,
    coverage: {
      judged: sweep.coverage.judged,
      candidates: sweep.coverage.candidates,
      ratio: sweep.coverage.ratio,
      incompleteDetectors: sweep.coverage.incompleteDetectors,
    },
  };
}
