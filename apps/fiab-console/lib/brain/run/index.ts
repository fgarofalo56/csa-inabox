/**
 * LOOM BRAIN W10 — the scheduler + finding lifecycle. Public surface (#3936).
 *
 * ONE import path for the PURE layer:
 *
 *     import { runBrainScan, classifyEstate, reconcile } from '@/lib/brain/run';
 *
 * ── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────
 * `./cosmos-finding-store` and everything under `./azure/` are NOT re-exported.
 * They are the only modules in this directory permitted an Azure import, and
 * importing the pure layer must never drag the Azure SDK into a bundle. Reach
 * for them explicitly, from server or CLI code only.
 *
 * ── THE ONE THING A CONSUMER MUST NOT DO ───────────────────────────────────
 * Do not read a `ScanOutcome` without its verdict. A PAUSED run exits 0 and has
 * `digest === null`, `counts === null` — it is NOT a clean scan, it is a run that
 * examined nothing, and rendering it as "0 findings" would be the exact failure
 * this lane exists to avoid.
 */

export {
  FINDING_SCHEMA_VERSION,
  FINDING_STATES,
  HIGH_WATER_DECAY_DAYS,
  MAX_SUPPRESSION_DAYS,
  POPULATION_SHRINK_TOLERANCE,
  REACH_FAILURE_REASONS,
  RUN_RECORD_TTL_SECONDS,
  InconsistentProbeError,
  fingerprintOf,
  isReachFailure,
  type AcceptedFinding,
  type AcknowledgedFinding,
  type DetectorPopulationRegression,
  type DetectorPopulationSnapshot,
  type FindingFingerprint,
  type FindingRecord,
  type FindingState,
  type FixedFinding,
  type NewFinding,
  type NotEvaluated,
  type ObservedResourceState,
  type OkVerdict,
  type PausedVerdict,
  type PopulationRegression,
  type PopulationRegressionKind,
  type PowerStateCounts,
  type ProbeFailure,
  type ProbeFailureClass,
  type ProbeResult,
  type ProbeStage,
  type RegressedFinding,
  type RunDigest,
  type ScanCounts,
  type ScanRunRecord,
  type ScanVerdict,
  type ScanVerdictKind,
  type Suppression,
  type UnreachableReason,
  type UnreachableVerdict,
} from './model';

export {
  COULD_NOT_REACH,
  assertMessageMatchesReason,
  classifyEstate,
  countByState,
  observedStates,
  reasonForFailures,
  type ClassifyContext,
} from './verdict';

export {
  acceptFinding,
  acknowledgeFinding,
  assertNoRegressionReportedAsNew,
  assertRecurrenceAfterFixIsReported,
  reconcile,
  suppressionExpired,
  toOccurrences,
  type FindingOccurrence,
  type ReconcileArgs,
  type ReconcileResult,
} from './lifecycle';

export {
  InMemoryFindingStore,
  InMemoryGraphHistoryWriter,
  StaticGraphSource,
  seedFindings,
  type CaptureRequest,
  type EstateProbe,
  type FindingStore,
  type GraphHistoryWriter,
  type GraphSource,
  type GraphSourceResult,
  type GraphVersionReceipt,
} from './ports';

export {
  detectPopulationRegression,
  digestOfIds,
  fnv1a64,
  snapshotPopulations,
} from './population';

export {
  exitCodeFor,
  exitCodeForOutcome,
  runBrainScan,
  type ScanDeps,
  type ScanOutcome,
} from './scan';

export { renderCounts, renderRunReport, renderStepSummary, renderVerdictHeadline } from './report';
