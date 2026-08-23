/**
 * LOOM BRAIN — detectors. Public surface.
 *
 * Six pure functions `BrainGraphView -> DetectorResult`. PRP §3.2: "Each is a
 * pure function `graph -> Finding[]`" — with the one deliberate strengthening the
 * substrate's types already encode: a detector returns a {@link DetectorResult},
 * not a bare array, so it CANNOT report a verdict without reporting the
 * population it examined.
 *
 *   unreachable-service   always-on, and nothing in the deployment wires to it.
 *                         THE ACCEPTANCE TEST — this is what finds
 *                         `loom-capacity-broker`.
 *   dangling-wire         a wire that exists and resolves to '' or a missing
 *                         resource. The receipt half of the finding above.
 *   orphan                a node whose established parent is not in the graph.
 *   declared-but-dead     wired in the template, absent from the deployment.
 *   always-on-unused      reachable and receiving no traffic.
 *   config-drift          the template and the deployment disagree about a wire.
 *
 * ── NOTHING HERE MUTATES AZURE ─────────────────────────────────────────────
 * Every module in this directory is pure: a graph in, findings out. There is no
 * Azure client, no fetch, no filesystem access, and no code path that could
 * delete or scale anything — `__tests__/detectors/purity.test.ts` asserts that
 * with an embedded control, so a broken matcher and a clean directory are not
 * indistinguishable. `RemediationProposal` pins `mutatesAzure: false` and
 * `requiresHumanApproval: true` as LITERAL types, so a self-approving proposal
 * does not typecheck.
 *
 * ── READ THE POPULATION BEFORE THE FINDINGS ────────────────────────────────
 * Three states look alike from a finding count of zero, and only the population
 * and the skip list tell them apart:
 *
 *   population.blind === true          the detector ranged over NOTHING.
 *   skipped is large, findings empty   it examined a real set and could not
 *                                      EVALUATE it (no telemetry, no ownership
 *                                      tag, no establishable parent).
 *   skipped empty, findings empty      a genuinely clean result.
 *
 * `always-on-unused` is in the middle state today and will be until a telemetry
 * extractor exists. It reports that rather than reporting a clean estate.
 */

export {
  bySeverity,
  ownership,
  ownershipCaveat,
  resolvedEdgeCount,
  severityForMonthlyUsd,
  vacuityReason,
  type Ownership,
} from './detector-kit';

export {
  CONTAINER_APPS_RETAIL_RATES,
  RATES_READ_AT,
  RATES_SOURCE,
  SECONDS_PER_MONTH,
  estimateAlwaysOnMonthlyCost,
  memoryGiB,
  type ContainerAppsRates,
  type CostEstimate,
} from './cost-model';

export { UNREACHABLE_SERVICE, unreachableService } from './unreachable-service';
export { DANGLING_WIRE, REPORTED_REASONS, danglingWire } from './dangling-wire';
export { ORPHAN, armParentId, orphan, orphanDetector, type OrphanOptions } from './orphan';
export { DECLARED_BUT_DEAD, declaredButDead } from './declared-but-dead';
export { ALWAYS_ON_UNUSED, alwaysOnUnused } from './always-on-unused';
export { CONFIG_DRIFT, configDrift, normalizeLiteral, type DriftKind } from './config-drift';

import {
  makePopulation,
  type BrainGraphView,
  type Detector,
  type DetectorResult,
  type Finding,
  type Population,
  type SkippedSubject,
} from '../graph';
import { bySeverity } from './detector-kit';
import { alwaysOnUnused } from './always-on-unused';
import { configDrift } from './config-drift';
import { danglingWire } from './dangling-wire';
import { declaredButDead } from './declared-but-dead';
import { orphan } from './orphan';
import { unreachableService } from './unreachable-service';

/**
 * Every detector, in the order they are run.
 *
 * Order does not affect results — each is pure and reads an immutable graph — but
 * it fixes the order findings appear in, which keeps a rendered report stable
 * between runs.
 */
export const ALL_DETECTORS: readonly Detector[] = [
  unreachableService,
  danglingWire,
  configDrift,
  declaredButDead,
  alwaysOnUnused,
  orphan,
];

/** The aggregate of one detector pass. */
export interface DetectorRun {
  /** Per-detector results, each with its own population and skip list. */
  readonly results: readonly DetectorResult[];
  /** Every finding from every detector, most severe first. */
  readonly findings: readonly Finding[];
  /** Every skip from every detector, with its detector name prefixed. */
  readonly skipped: readonly SkippedSubject[];
  /** The graph-level population the pass ran over. Not a sum of the per-detector ones. */
  readonly population: Population;
}

/**
 * Run detectors over a graph.
 *
 * Deliberately does NOT catch. A detector that throws is a defect in the
 * detector, and swallowing it here would turn this into a gate that cannot fail —
 * the pass would report a short but confident finding list with no indication
 * that a detector died. Let it propagate.
 */
export function runDetectors(
  graph: BrainGraphView,
  detectors: readonly Detector[] = ALL_DETECTORS,
): DetectorRun {
  const results = detectors.map((d) => d(graph));
  const findings = results.flatMap((r) => [...r.findings]).sort(bySeverity);
  const skipped = results.flatMap((r) =>
    r.skipped.map((s) => ({ subject: `[${r.detector}] ${s.subject}`, reason: s.reason })),
  );
  return {
    results,
    findings,
    skipped,
    population: makePopulation({
      subject: 'nodes',
      nodes: graph.nodes,
      edges: graph.edges,
      scope:
        `${detectors.length} detector(s) over ${graph.nodes.length} node(s) and ${graph.edges.length} ` +
        `edge(s); ${findings.length} finding(s), ${skipped.length} skipped subject(s). ` +
        'Per-detector populations are in `results` — this one is the graph, not a sum.',
    }),
  };
}
