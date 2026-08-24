/**
 * LOOM BRAIN W10 — THE LOOP (#3936).
 *
 * `runBrainScan()` is the thing whose absence makes every other Brain work item
 * a capability rather than an outcome. It:
 *
 *   1. PROBES the estate — ARG discovery, then a direct ARM GET per resource.
 *   2. CLASSIFIES the verdict: OK / PAUSED / UNREACHABLE (`./verdict.ts`).
 *   3. On OK only: builds the graph, runs every detector, writes a graph version
 *      through W9's writer, reconciles the finding backlog, and reports counts.
 *   4. Persists a run record on EVERY path, including the red ones.
 *
 * ── RECOMMEND-ONLY, STRUCTURALLY ───────────────────────────────────────────
 * PRP §1 decision 1. Nothing in this module's dependency tree can mutate Azure:
 * the probe's only Azure verbs are `POST .../Microsoft.ResourceGraph/resources`
 * (a query) and `GET {resourceId}`; `RemediationProposal` pins
 * `mutatesAzure: false` and `requiresHumanApproval: true` as LITERAL types. The
 * measured reason is blast radius — of the 13 Container App environments visible
 * across these subscriptions, ONE is Loom's.
 *
 * ── WHY THE PAUSED PATH WRITES NOTHING ─────────────────────────────────────
 * A paused estate is not a scanned estate. Reconciling the backlog against a run
 * that examined nothing would mark the whole backlog `fixed` (nothing was
 * reported), and the first run after a resume would re-report every one of them
 * as `new`. That is P-BLIND at the estate level, and the cure is the same:
 * examine nothing, change nothing, and SAY so.
 *
 * ── WHY THIS DOES NOT CATCH ────────────────────────────────────────────────
 * `runDetectors` deliberately does not catch a throwing detector, and neither
 * does this. Swallowing would turn the scan into a gate that cannot fail: a
 * short but confident finding list with no indication that a detector died. A
 * reachability failure is different — that is a CLASSIFIED outcome carried as
 * data, not an exception, so the operator gets a named reason instead of a
 * stack trace (`deploy-integrity.md` R6).
 */

import { runDetectors, type DetectorRun } from '../detectors';
import type { Detector } from '../types';
import { classifyEstate, observedStates } from './verdict';
import { reconcile, toOccurrences } from './lifecycle';
import { detectPopulationRegression, digestOfIds, snapshotPopulations } from './population';
import {
  RUN_RECORD_TTL_SECONDS,
  FINDING_SCHEMA_VERSION,
  type DetectorPopulationSnapshot,
  type PopulationRegression,
  type RunDigest,
  type ScanCounts,
  type ScanRunRecord,
  type ScanVerdict,
} from './model';
import type {
  EstateProbe,
  FindingStore,
  GraphHistoryWriter,
  GraphSource,
  GraphVersionReceipt,
} from './ports';

export interface ScanDeps {
  readonly estateId: string;
  /** Boundary label: 'AzureCloud', 'AzureUSGovernment', … Never a literal host. */
  readonly cloud: string;
  readonly runId: string;
  readonly probe: EstateProbe;
  readonly graphSource: GraphSource;
  readonly history: GraphHistoryWriter;
  readonly findings: FindingStore;
  /** What triggered this run. Stored on the graph version and the run record. */
  readonly source: string;
  /** Injected clock. Every instant in the result comes from here. */
  readonly now?: () => Date;
  /** Defaults to `ALL_DETECTORS`. Overridden only by tests and mutations. */
  readonly detectors?: readonly Detector[];
  /**
   * Called the INSTANT the verdict is formed, before any persistence.
   *
   * MEASURED, first smoke run of the compiled CLI: an estate with no
   * `LOOM_COSMOS_ENDPOINT` classified UNREACHABLE correctly and then threw
   * inside `recordRun`, so the operator saw a Cosmos stack trace and never saw
   * the verdict the run had already established. The verdict is the one thing a
   * run must always surface; a later persistence failure is a separate, equally
   * loud defect, and neither is allowed to hide the other.
   *
   * This is NOT an error handler and nothing is swallowed — a persistence
   * failure still propagates and still fails the run.
   */
  readonly onVerdict?: (verdict: ScanVerdict) => void;
}

/** The outcome of one scan. Discriminated on the verdict, like the verdict. */
export interface ScanOutcome {
  readonly verdict: ScanVerdict;
  readonly runRecord: ScanRunRecord;
  /** Present only on the OK path. */
  readonly digest: RunDigest | null;
  /** Present only on the OK path. */
  readonly counts: ScanCounts | null;
  /** Present only on the OK path. */
  readonly graphVersion: GraphVersionReceipt | null;
  /** Present only on the OK path. */
  readonly detectorRun: DetectorRun | null;
  /**
   * Set when the SCANNER got worse than the previous run — PRP §5's P0.
   *
   * Orthogonal to `verdict`: the estate can be perfectly reachable and scanned
   * (verdict OK) while the scan itself has stopped looking at things. Those are
   * different investigations with different owners, so they are different
   * fields and different exit codes rather than a fourth verdict.
   */
  readonly populationRegression: PopulationRegression | null;
  /** Per-detector examined counts, persisted for the NEXT run to compare. */
  readonly detectorPopulations: readonly DetectorPopulationSnapshot[] | null;
  readonly notes: readonly string[];
}

/**
 * The process exit code this outcome maps to.
 *
 *   OK                        0
 *   PAUSED                    0   — neutral. Nothing was scanned; nothing is broken.
 *   UNREACHABLE               2   — RED, and distinguishable from a crash (1).
 *   POPULATION REGRESSION     3   — RED on its own axis: the estate was scanned
 *                                   and the SCAN got worse (PRP §5).
 *
 * PAUSED being 0 is the one that needs justifying: Actions has only pass/fail,
 * so a paused estate would otherwise fail the lane nightly, the operator would
 * learn to ignore it, and the loop would become decorative. The verdict is
 * carried as a job OUTPUT and printed as the step-summary headline, so a passing
 * job never implies a completed scan.
 *
 * 3 is distinct from 2 because "I could not reach the estate" and "I reached it
 * and looked at a fifth of what I looked at yesterday" send an engineer to
 * completely different places.
 */
export function exitCodeForOutcome(outcome: ScanOutcome): 0 | 2 | 3 {
  if (outcome.verdict.kind === 'unreachable') return 2;
  if (outcome.populationRegression !== null) return 3;
  return 0;
}

/**
 * Exit code from a verdict alone.
 *
 * Kept for callers that only hold a verdict. Prefer {@link exitCodeForOutcome} —
 * this one CANNOT see a population regression, and a caller that uses it on a
 * full outcome will silently pass a run whose detectors went blind.
 */
export function exitCodeFor(v: ScanVerdict): 0 | 2 {
  return v.kind === 'unreachable' ? 2 : 0;
}

function countsFor(args: {
  detectorRun: DetectorRun;
  digest: RunDigest;
  recordsTotal: number;
  nodes: number;
  edges: number;
  blind: number;
}): ScanCounts {
  return {
    nodes: args.nodes,
    edges: args.edges,
    detectorsRun: args.detectorRun.results.length,
    detectorsBlind: args.blind,
    findingsProduced: args.detectorRun.findings.length,
    recordsTotal: args.recordsTotal,
    new: args.digest.newFindings.length,
    regressions: args.digest.regressions.length,
    fixed: args.digest.fixed.length,
    stillOpen: args.digest.stillOpen,
    suppressed: args.digest.suppressed,
    suppressionsExpired: args.digest.suppressionsExpired.length,
    notEvaluated: args.digest.notEvaluated.length,
  };
}

export async function runBrainScan(deps: ScanDeps): Promise<ScanOutcome> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const notes: string[] = [];

  const probeResult = await deps.probe.probe();
  const at = now().toISOString();
  const verdict = classifyEstate(probeResult, {
    at,
    cloud: deps.cloud,
    estateId: deps.estateId,
  });
  deps.onVerdict?.(verdict);

  // ── the two non-scanning paths ───────────────────────────────────────────
  if (verdict.kind !== 'ok') {
    const runRecord: ScanRunRecord = {
      schemaVersion: FINDING_SCHEMA_VERSION,
      docType: 'scan-run',
      id: `run:${deps.runId}`,
      estateId: deps.estateId,
      runId: deps.runId,
      startedAt,
      finishedAt: now().toISOString(),
      cloud: deps.cloud,
      verdict: verdict.kind,
      verdictMessage: verdict.message,
      graphVersionId: null,
      counts: null,
      detectorPopulations: null,
      graphSubjectsDigest: null,
      observed: observedStates(verdict.readings),
      notes: [
        verdict.kind === 'paused'
          ? 'PAUSED: no graph was built, no detector ran, and NO finding state was ' +
            'changed. Reconciling a backlog against a run that examined nothing would ' +
            'mark every open finding fixed and then re-report them all as new after the ' +
            'next resume.'
          : 'UNREACHABLE: no graph was built, no detector ran, and NO finding state was ' +
            'changed. This run establishes nothing about the estate.',
      ],
      ttl: RUN_RECORD_TTL_SECONDS,
    };
    await deps.findings.recordRun(runRecord);
    return {
      verdict,
      runRecord,
      digest: null,
      counts: null,
      graphVersion: null,
      detectorRun: null,
      populationRegression: null,
      detectorPopulations: null,
      notes: [...notes, ...runRecord.notes],
    };
  }

  // ── the OK path ──────────────────────────────────────────────────────────
  //
  // The basis is the last run that actually SCANNED, never merely the last run.
  // PAUSED and UNREACHABLE runs persist a null population, so `lastRun` would
  // let ONE PAUSED NIGHT erase the baseline — and under the standing
  // estate-pause mandate PAUSED is the normal operating mode, which would switch
  // this comparator off almost always. Read BEFORE anything is written, so the
  // comparison cannot end up being against this run itself.
  const previousRun = await deps.findings.lastScannedRun(deps.estateId);
  const basisAgeRuns = await deps.findings.scannedRunAgeRuns(deps.estateId);

  const source = await deps.graphSource.build();
  notes.push(...source.notes);

  const detectorRun = runDetectors(source.graph, deps.detectors);

  // P-BLIND. A detector may only close a finding if it ranged over a NON-EMPTY
  // population. `population.blind` is computed by the substrate against the
  // detector's own subject set, so this is the detector's own admission rather
  // than an inference made here.
  const evaluatedDetectors = new Set<string>();
  const blindDetectors = new Map<string, string>();
  for (const r of detectorRun.results) {
    if (r.population.blind) blindDetectors.set(r.detector, r.population.scope);
    else evaluatedDetectors.add(r.detector);
  }

  // The graph version is written BEFORE the reconcile, and a failure to write it
  // propagates. A findings backlog with no `before` cannot answer "an edge that
  // should not have formed", which is the whole reason W9 exists.
  const graphVersion = await deps.history.capture({
    graph: source.graph,
    estateId: deps.estateId,
    collectedProvenances: source.collectedProvenances,
    source: deps.source,
  });
  notes.push(
    `graph version ${graphVersion.versionId} (${graphVersion.status}): ` +
      `${graphVersion.nodes} node(s), ${graphVersion.edges} edge(s)` +
      (graphVersion.pruned.length > 0
        ? `; retention deleted ${graphVersion.pruned.length} older version(s).`
        : '.'),
    ...graphVersion.notes,
  );

  const previous = await deps.findings.list(deps.estateId);
  const { records, digest } = reconcile({
    estateId: deps.estateId,
    runId: deps.runId,
    at,
    previous,
    occurrences: toOccurrences(detectorRun.findings),
    evaluatedDetectors,
    blindDetectors,
  });

  await deps.findings.put(records);

  const counts = countsFor({
    detectorRun,
    digest,
    recordsTotal: records.length,
    nodes: source.graph.nodes.length,
    edges: source.graph.edges.length,
    blind: blindDetectors.size,
  });

  // PRP §5 — a shrinking judged count is a P0. Compared against the last run
  // that actually SCANNED, and against each detector's own high-water mark so a
  // slow erosion cannot walk the population down one tolerable step at a time.
  const detectorPopulations = snapshotPopulations(detectorRun.results, {
    previous: previousRun?.detectorPopulations ?? null,
    at,
  });
  const populationRegression = detectPopulationRegression(previousRun, detectorPopulations, {
    basisAgeRuns,
  });
  // Composition at constant size. See ScanRunRecord.graphSubjectsDigest for what
  // this does and does not cover.
  const graphSubjectsDigest = digestOfIds(source.graph.nodes.map((n) => n.id));

  if (populationRegression !== null) notes.push(populationRegression.message);
  else if (previousRun === null || previousRun.detectorPopulations === null) {
    notes.push(
      'population comparison: NO BASIS. No previous run for this estate carries per-detector ' +
        'counts, so this run cannot tell "the detectors are looking at everything" from "the ' +
        'detectors have always looked at nothing". A PAUSED or UNREACHABLE run does not ' +
        'provide a basis; the next run that actually scans will.',
    );
  } else if (basisAgeRuns > 1) {
    notes.push(
      `population comparison: basis is run '${previousRun.runId}', ${basisAgeRuns} runs back — ` +
        'the runs in between did not scan (paused or unreachable), so this comparison spans ' +
        'more wall clock than one night.',
    );
  }
  if (previousRun !== null && previousRun.graphSubjectsDigest !== null) {
    if (previousRun.graphSubjectsDigest !== graphSubjectsDigest) {
      notes.push(
        `graph composition CHANGED since run '${previousRun.runId}' (subject digest ` +
          `${previousRun.graphSubjectsDigest} -> ${graphSubjectsDigest}) at ` +
          `${source.graph.nodes.length} node(s). A count alone cannot see this: swapping every ` +
          'subject while holding the count constant is invisible, and the graph pull is ' +
          'deliberately unscoped, so non-Loom growth can mask Loom disappearance one for one.',
      );
    }
  }

  const runRecord: ScanRunRecord = {
    schemaVersion: FINDING_SCHEMA_VERSION,
    docType: 'scan-run',
    id: `run:${deps.runId}`,
    estateId: deps.estateId,
    runId: deps.runId,
    startedAt,
    finishedAt: now().toISOString(),
    cloud: deps.cloud,
    verdict: 'ok',
    verdictMessage: verdict.message,
    graphVersionId: graphVersion.versionId,
    counts,
    detectorPopulations,
    graphSubjectsDigest,
    observed: observedStates(verdict.readings),
    notes: [...notes, ...digest.notes],
    ttl: RUN_RECORD_TTL_SECONDS,
  };
  await deps.findings.recordRun(runRecord);

  return {
    verdict,
    runRecord,
    digest,
    counts,
    graphVersion,
    detectorRun,
    populationRegression,
    detectorPopulations,
    notes: runRecord.notes,
  };
}
