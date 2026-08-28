/**
 * LOOM BRAIN W10 — the SCAN CONTRACT: verdicts, finding lifecycle, digest (#3936).
 *
 * This module is PURE — no Azure SDK, no fetch, no filesystem, no `node:crypto`.
 * Everything here is data and predicates over data, which is what makes the whole
 * scheduler provable without an Azure tenant. `./__tests__/purity.test.ts`
 * enforces that and carries an embedded control.
 *
 * ── WHY THIS LANE EXISTS ───────────────────────────────────────────────────
 * A Brain nobody runs finds nothing. This repo already holds the cautionary
 * instance: `lcu-autopilot` implements read -> decide -> actuate -> audit and has
 * NO scheduler, so it has never produced a finding in anger. W1–W9 built a graph,
 * six detectors, a security layer and a history; without a loop that runs them,
 * every one of those is a capability rather than an outcome.
 *
 * ── THE CONSTRAINT THAT SHAPES EVERYTHING BELOW: THE ESTATE IS PAUSED ──────
 * Standing operator mandate: the Commercial and Gov estates are kept PAUSED
 * unless actively validating. A naive `schedule:` cron therefore produces a RED
 * run every cycle carrying "could not reach Azure", the operator learns to
 * ignore the lane, and the lane becomes decorative — which is the exact failure
 * mode `deploy-integrity.md` R1 calls a silently-broken path.
 *
 * The forbidden cure is a config flag that skips the run: a boolean that
 * disables a job is a gate that cannot fail (`csa_loom_gates_that_cannot_fail`).
 *
 * So a run produces THREE verdicts, and every one of them is derived from an
 * ACTUAL ARM READ:
 *
 *   OK           reached ARM, at least one in-scope resource is Online. The
 *                graph is built, detectors run, a version is written, findings
 *                are reconciled, counts are reported.
 *   PAUSED       reached ARM, and EVERY in-scope resource is definitively
 *                stopped/paused/deallocated. Neutral: nothing was scanned, so
 *                the run is not green; nothing is broken, so it is not red. The
 *                observed per-resource states are reported verbatim.
 *   UNREACHABLE  RED. Auth failed, the network failed, ARM returned an error,
 *                zero in-scope resources were observed, or a state could not be
 *                established.
 *
 * ── THE PAUSED VERDICT CANNOT BE FORGED FROM A SETTING ─────────────────────
 * {@link PausedVerdict.readings} is `readonly ArmPowerReading[]`, and
 * `ArmPowerReading` (lib/estate/pause-state.ts) carries a TYPE-ONLY unique-symbol
 * brand whose sole constructor `armPowerReading()` requires an ARM api-version.
 * No object literal written outside that module satisfies the type, and
 * `pause-inventory`'s Resource Graph shape declares `powerState?: never`. So
 * "the estate is paused" is not expressible from an env var, a workflow input,
 * or a Resource Graph row — only from a direct ARM GET. That is the type system
 * doing what a comment cannot.
 *
 * MEASURED, 2026-08-22, which is why Resource Graph is refused for STATE: the
 * activity log recorded a Synapse pool `pause/action -> Succeeded @ 20:22:14`
 * while Resource Graph kept reporting that same pool `Online` afterwards. ARG is
 * a replicated index; what is indexed is not what is serving.
 *
 * ── R7: AN ERROR SAYS ONLY WHAT IT ESTABLISHED ─────────────────────────────
 * "could not reach" and "nothing is there" are DIFFERENT CLAIMS, and this module
 * refuses to conflate them. On 2026-08-05 a `2>/dev/null` turned a permission
 * denial into "the tag does not exist" and sent two investigations down the
 * wrong path. So:
 *
 *   reach failure (auth / network / HTTP)  -> the message says "could not reach"
 *   reached, and ARG returned zero rows    -> the message says it REACHED ARM
 *                                             and got zero rows. It does NOT say
 *                                             "could not reach".
 *
 * Both are red. `./__tests__/verdict.test.ts` asserts the second message does
 * not contain the phrase, because that assertion is the one that catches a
 * well-meaning "make every failure say could not reach" edit.
 *
 * ── THE LIFECYCLE, AND THE ONE PROPERTY WORTH THE MOST ─────────────────────
 *   new -> acknowledged -> accepted (won't fix) -> fixed
 *
 * and the event that matters more than any of them:
 *
 *   fixed -> REGRESSED
 *
 * A finding that comes back after being fixed is a regression, and it is louder
 * than a new finding: something that was understood and repaired has broken
 * again. Reporting it as merely `new` destroys that. It is made STRUCTURALLY
 * impossible three ways:
 *
 *   L1  {@link NewFinding} pins `regressionCount: 0` as a LITERAL and declares
 *       `fixedAt?: never` / `priorState?: never`, so a record carrying a repair
 *       history is not assignable to `new`.
 *   L2  {@link RegressedFinding} pins `priorState: 'fixed'` as a LITERAL, so a
 *       regression cannot be minted from any other state.
 *   L3  `./lifecycle.ts`'s `reconcile()` is the ONLY constructor of a next
 *       state, it has no `new` branch reachable when a prior record exists, and
 *       it re-checks that invariant at runtime before returning.
 *
 * ── ACCEPTED IS A SUPPRESSION, AND SUPPRESSIONS EXPIRE ─────────────────────
 * A reason-free suppression is how a real finding gets buried, and an `accepted`
 * with no expiry is indistinguishable from a deleted detector. So
 * {@link Suppression} requires `reason`, `owner` AND `expiresAt` — none
 * optional, none nullable — enforced at the type level (L4/L5 below) and again
 * at runtime by `acceptFinding()`, which additionally rejects an empty reason,
 * an empty owner, a non-future expiry and an expiry beyond
 * {@link MAX_SUPPRESSION_DAYS}.
 *
 * ── ABSENCE IS NOT A FIX ───────────────────────────────────────────────────
 * The subtlest way this lane could lie: mark every open finding `fixed` because
 * its detector did not report it — when the real reason is that the detector
 * ranged over an EMPTY population and was green and blind (PRP §3.2, §3.8).
 * `reconcile()` therefore takes the set of detectors that ran with a NON-BLIND
 * population, and a record whose detector is not in that set is left UNTOUCHED
 * and reported under `notEvaluated`. A detector that goes blind can no longer
 * silently close the whole backlog it used to produce.
 */

import type {
  Confidence,
  CostFigure,
  EvidenceChain,
  Finding,
  FindingSeverity,
  NodeId,
  Population,
  RemediationProposal,
} from '../types';
import type { ArmPowerReading, EstatePowerState } from '../../estate/pause-state';

/** Fails to compile unless `T` is exactly `true`. */
type Assert<T extends true> = T;

/**
 * The persisted-shape version.
 *
 * BUMPED whenever a field is added, removed or reinterpreted. A stored record
 * whose `schemaVersion` differs from this is NOT reconciled against — it is
 * reported as `notEvaluated` rather than being silently treated as absent, which
 * would mark it fixed and then re-report it as `new` on the following run.
 */
export const FINDING_SCHEMA_VERSION = 1;

/** The longest a suppression may run before it must be renewed by a human. */
export const MAX_SUPPRESSION_DAYS = 180;

// ---------------------------------------------------------------------------
// §Probe — what the run established about reaching Azure
// ---------------------------------------------------------------------------

/**
 * Which half of the probe failed. Kept because they mean different things: a
 * discovery failure means the estate's SHAPE is unknown, while a power-read
 * failure means the shape is known and its STATE is not.
 */
export type ProbeStage = 'discovery' | 'power-read';

/**
 * How a probe failure is classified. `deploy-integrity.md` R6 requires a failure
 * to say which kind it is; R7 requires it to say only what was established.
 *
 * There is deliberately no `'unknown'` member that a caller could default to —
 * a failure whose class cannot be established is `arm-error`, which claims
 * nothing beyond "the call did not succeed".
 */
export type ProbeFailureClass = 'auth' | 'network' | 'arm-error';

/** One thing that went wrong while reaching Azure. Never summarized to a boolean. */
export interface ProbeFailure {
  readonly stage: ProbeStage;
  /** What was being read: an ARM resource id, or the query endpoint's name. */
  readonly target: string;
  readonly classification: ProbeFailureClass;
  /**
   * The HTTP status, or `null` when NO HTTP exchange completed (DNS failure,
   * timeout, no token). `null` is not `0` and is not "success" — it is the
   * difference between "Azure said no" and "Azure was never asked".
   */
  readonly httpStatus: number | null;
  /** Verbatim. Never a summary, never a stack trace alone. */
  readonly detail: string;
}

/**
 * What one probe pass established.
 *
 * `discovered` is carried SEPARATELY from `readings.length` on purpose. Equality
 * of the two is an invariant a probe implementation must maintain, and
 * `classifyEstate` throws {@link InconsistentProbeError} when it is violated
 * with no failure recorded — a probe that quietly drops a resource it discovered
 * would otherwise shrink the examined population with nothing to see it.
 */
export interface ProbeResult {
  /** ARM power readings, one per discovered in-scope resource. */
  readonly readings: readonly ArmPowerReading[];
  readonly failures: readonly ProbeFailure[];
  /** How many in-scope resources DISCOVERY found, before any state was read. */
  readonly discovered: number;
  /** Plain-English scope, e.g. "Loom Container Apps in 1 subscription". */
  readonly scope: string;
  /**
   * How many requests were RETRIED on a transient condition (429, 5xx, or no
   * response) during this pass.
   *
   * Carried out of the probe and rendered with the verdict (review S4 on #4014).
   * A lane with bounded retry and no retry COUNT smooths an intermittently
   * failing path into a run that looks identical to a healthy one — the estate
   * is degrading, every night is green, and the first visible symptom is the
   * night the retries run out. Optional so a fixture that does not model
   * transport need not state it; `undefined` means "not measured", not "zero".
   */
  readonly retries?: number;
}

// ---------------------------------------------------------------------------
// §Verdict
// ---------------------------------------------------------------------------

export type ScanVerdictKind = 'ok' | 'paused' | 'unreachable';

/**
 * Why a run is red.
 *
 * The split exists so the MESSAGE can be true. Only the first three are reach
 * failures and only they say "could not reach"; the last two were reached and
 * say what they actually found.
 */
export type UnreachableReason =
  /** No token, or ARM/ARG answered 401/403. */
  | 'auth-failed'
  /** DNS, TLS, timeout — no HTTP response at all. */
  | 'network-failed'
  /** An HTTP response that was not a success. */
  | 'arm-error'
  /** ARG answered, and returned zero in-scope resources. REACHED. */
  | 'no-resources-observed'
  /**
   * ARM answered for every resource, nothing is Online, and at least one state
   * is not definitively stopped (Unknown / Pausing / Resuming / Starting /
   * Scaling). REACHED. Fails closed: an indeterminate state must never be
   * laundered into PAUSED, which would make a mid-pause estate read as a clean
   * neutral outcome.
   */
  | 'state-indeterminate';

/** The reasons whose message may — and must — say "could not reach". */
export const REACH_FAILURE_REASONS: readonly UnreachableReason[] = [
  'auth-failed',
  'network-failed',
  'arm-error',
] as const;

export function isReachFailure(r: UnreachableReason): boolean {
  return (REACH_FAILURE_REASONS as readonly string[]).includes(r);
}

/** Counts by ARM power state. Present on every verdict that read any state. */
export type PowerStateCounts = Readonly<Record<EstatePowerState, number>>;

interface VerdictBase {
  /** ISO-8601 instant the verdict was formed. */
  readonly at: string;
  /** The boundary label, e.g. 'AzureCloud' / 'AzureUSGovernment'. */
  readonly cloud: string;
  readonly estateId: string;
  /** What the probe ranged over. Rendered with every verdict (P3). */
  readonly scope: string;
  /** Operator-readable, and TRUE — see the R7 note in this file's header. */
  readonly message: string;
  /**
   * Transient-condition retries the probe performed to reach this verdict.
   *
   * Rendered whenever it is above zero. See {@link ProbeResult.retries} for why
   * a bounded-retry lane that hides its retry count is worse than one with no
   * retry at all.
   */
  readonly retries?: number;
}

/**
 * At least one in-scope resource is Online. The scan proceeds.
 *
 * `notRunning` and `indeterminate` are carried even here: an estate that is 3/29
 * running is a materially different thing to scan than one that is 29/29, and a
 * verdict that hid the difference would be reporting a partial estate as whole.
 */
export interface OkVerdict extends VerdictBase {
  readonly kind: 'ok';
  readonly readings: readonly ArmPowerReading[];
  readonly running: number;
  readonly notRunning: number;
  readonly indeterminate: number;
  readonly byState: PowerStateCounts;
}

/**
 * Every in-scope resource is definitively stopped.
 *
 * `readings` is REQUIRED and non-empty. Because `ArmPowerReading` is branded and
 * constructible only from an ARM GET, this verdict cannot be produced by a
 * setting, an input, or a Resource Graph row.
 */
export interface PausedVerdict extends VerdictBase {
  readonly kind: 'paused';
  readonly readings: readonly ArmPowerReading[];
  readonly byState: PowerStateCounts;
  /** Per-resource, rendered for the operator. The receipt for the verdict. */
  readonly observed: readonly ObservedResourceState[];
}

/** One resource's state, flattened for display and for the run record. */
export interface ObservedResourceState {
  readonly resourceId: string;
  readonly powerState: EstatePowerState;
  readonly armApiVersion: string;
  readonly readAt: string;
}

export interface UnreachableVerdict extends VerdictBase {
  readonly kind: 'unreachable';
  readonly reason: UnreachableReason;
  /** Empty for the two REACHED reasons; non-empty for the three reach failures. */
  readonly failures: readonly ProbeFailure[];
  /** Readings that WERE obtained before the run was declared red. May be empty. */
  readonly readings: readonly ArmPowerReading[];
  readonly byState: PowerStateCounts;
}

export type ScanVerdict = OkVerdict | PausedVerdict | UnreachableVerdict;

/** A verdict shape claiming PAUSED with no ARM readings at all. */
type PausedWithoutReadings = {
  kind: 'paused';
  at: string;
  cloud: string;
  estateId: string;
  scope: string;
  message: string;
  byState: PowerStateCounts;
  observed: readonly ObservedResourceState[];
};

/**
 * L6 — a PAUSED verdict must carry its ARM readings. If `readings` is ever made
 * optional, this flips to `true` and `next build` fails HERE. That is the one
 * edit that would let "the estate is paused" be asserted without an ARM GET
 * behind it, which is the whole reason this verdict exists rather than a flag.
 */
type _PausedMustCarryArmReadings = Assert<
  PausedWithoutReadings extends ScanVerdict ? false : true
>;

/**
 * A probe returned fewer readings than it discovered, and recorded no failure.
 *
 * THROWN, never absorbed. Silently accepting it shrinks the examined population
 * with nothing to see it — the exact evasion class this repo measures as its
 * dominant one (PRP §3.8: falling outside the population being examined,
 * invisible in every artifact except a population count).
 */
export class InconsistentProbeError extends Error {
  readonly discovered: number;
  readonly readings: number;
  constructor(discovered: number, readings: number) {
    super(
      `the estate probe discovered ${discovered} in-scope resource(s) but produced ` +
        `${readings} ARM power reading(s) and recorded NO failure. REFUSING to form a ` +
        'verdict: a reading that is neither present nor failed is a resource that ' +
        'silently left the examined population, and every verdict drawn over the ' +
        'remainder would be confident about a set it did not range over. Fix the probe ' +
        'so every discovered resource yields either a reading or a ProbeFailure.',
    );
    this.name = 'InconsistentProbeError';
    this.discovered = discovered;
    this.readings = readings;
  }
}

// ---------------------------------------------------------------------------
// §Suppression — L4 / L5
// ---------------------------------------------------------------------------

/**
 * An `accepted` (won't-fix) suppression.
 *
 * Every field is REQUIRED. A reason-free suppression buries a real finding; an
 * owner-free one has nobody to ask; an expiry-free one is indistinguishable
 * from a deleted detector. `acceptFinding()` in `./lifecycle` is the only
 * sanctioned constructor and validates all three at runtime as well.
 */
export interface Suppression {
  /** WHY this is not being fixed. Non-empty; validated at construction. */
  readonly reason: string;
  /** WHO owns that decision. Non-empty; validated at construction. */
  readonly owner: string;
  readonly acceptedAt: string;
  /**
   * ISO-8601. REQUIRED and never nullable. On or after this instant the
   * suppression lifts and the finding re-surfaces — see `reconcile()`.
   */
  readonly expiresAt: string;
}

type SuppressionWithoutExpiry = { reason: string; owner: string; acceptedAt: string };
type SuppressionWithoutReason = { owner: string; acceptedAt: string; expiresAt: string };
type SuppressionWithoutOwner = { reason: string; acceptedAt: string; expiresAt: string };

/** L4 — an expiry-free suppression must not be constructible. */
type _SuppressionRequiresExpiry = Assert<
  SuppressionWithoutExpiry extends Suppression ? false : true
>;
/** L5a — a reason-free suppression must not be constructible. */
type _SuppressionRequiresReason = Assert<
  SuppressionWithoutReason extends Suppression ? false : true
>;
/** L5b — an owner-free suppression must not be constructible. */
type _SuppressionRequiresOwner = Assert<
  SuppressionWithoutOwner extends Suppression ? false : true
>;

// ---------------------------------------------------------------------------
// §Finding records — L1 / L2 / L3
// ---------------------------------------------------------------------------

export type FindingState = 'new' | 'acknowledged' | 'accepted' | 'fixed' | 'regressed';

export const FINDING_STATES: readonly FindingState[] = [
  'new',
  'acknowledged',
  'accepted',
  'fixed',
  'regressed',
] as const;

/**
 * The identity a finding keeps across runs.
 *
 * It is the detector's own deterministic `Finding.id`
 * (`detector-kit.ts#findingId`: `detector#subject`), NOT a hash of the rendered
 * text. Hashing the text would mint a NEW fingerprint every time a summary
 * string was reworded, which reports the same problem as new and loses its
 * repair history — including, fatally, its `fixed` marker, which is the only
 * thing that makes the next occurrence a REGRESSION.
 */
export type FindingFingerprint = string & { readonly __brand: 'BrainFindingFingerprint' };

/** The only sanctioned constructor. Rejects an empty id rather than minting one. */
export function fingerprintOf(finding: Pick<Finding, 'id' | 'detector'>): FindingFingerprint {
  const id = finding.id.trim();
  if (id === '') {
    throw new Error(
      `detector '${finding.detector}' produced a finding with an EMPTY id. A finding with ` +
        'no stable identity cannot be tracked across runs, so it can never be marked ' +
        'fixed and its next occurrence can never be recognised as a regression. ' +
        'Use detector-kit.ts#findingId().',
    );
  }
  return id as FindingFingerprint;
}

/** Fields every record carries, whatever its state. */
interface FindingRecordBase {
  readonly schemaVersion: number;
  readonly fingerprint: FindingFingerprint;
  /** Cosmos partition key. One estate's findings are one physical partition. */
  readonly estateId: string;
  readonly detector: string;
  readonly severity: FindingSeverity;
  readonly title: string;
  readonly summary: string;
  readonly subjects: readonly NodeId[];
  readonly evidence: EvidenceChain;
  /** The population the producing detector examined (P3). Never dropped. */
  readonly population: Population;
  readonly confidence: Confidence;
  readonly cost?: CostFigure;
  readonly remediation: RemediationProposal;
  readonly firstSeenAt: string;
  /** The run that first produced it. `digest.newFindings` keys off this. */
  readonly firstSeenRunId: string;
  readonly lastSeenAt: string;
  readonly lastSeenRunId: string;
  /**
   * How many times this finding has come back AFTER being fixed. Monotonic; it
   * is carried through every later state so the history is never erased by a
   * subsequent acknowledgement or acceptance.
   */
  readonly regressionCount: number;
}

/**
 * Seen for the FIRST time. L1 lives here.
 *
 * `regressionCount: 0` is a LITERAL and `fixedAt` / `priorState` are `never`, so
 * a record carrying any repair history is not assignable to this state. That is
 * what makes "report the regression as merely new" fail to compile rather than
 * fail in review.
 */
export interface NewFinding extends FindingRecordBase {
  readonly state: 'new';
  readonly regressionCount: 0;
  readonly fixedAt?: never;
  readonly priorState?: never;
  readonly regressedAt?: never;
  readonly suppression?: never;
}

/** A human has seen it and is not disputing it. */
export interface AcknowledgedFinding extends FindingRecordBase {
  readonly state: 'acknowledged';
  readonly acknowledgedBy: string;
  readonly acknowledgedAt: string;
  /** Set when this record reached `acknowledged` by a suppression EXPIRING. */
  readonly resurfacedFromSuppressionAt?: string;
  readonly suppression?: never;
}

/** Won't-fix, with a reason, an owner and an expiry. */
export interface AcceptedFinding extends FindingRecordBase {
  readonly state: 'accepted';
  readonly suppression: Suppression;
}

/** Gone. The detector ran with a real population and did not report it. */
export interface FixedFinding extends FindingRecordBase {
  readonly state: 'fixed';
  readonly fixedAt: string;
  /** The run that established the fix — i.e. the one that did NOT see it. */
  readonly fixedByRunId: string;
  readonly suppression?: never;
}

/**
 * Back after being fixed. THE LOUDEST EVENT THIS LANE PRODUCES. L2 lives here.
 *
 * `priorState: 'fixed'` is a LITERAL, so a regression cannot be minted from
 * `new`, `acknowledged` or `accepted`. `fixedAt` is REQUIRED, so a regression
 * always carries the repair it undid.
 */
export interface RegressedFinding extends FindingRecordBase {
  readonly state: 'regressed';
  /** LITERAL. The only state a regression may come from. */
  readonly priorState: 'fixed';
  /** When it HAD been fixed. Required — the regression's whole point. */
  readonly fixedAt: string;
  readonly fixedByRunId: string;
  readonly regressedAt: string;
  /** The run that observed the recurrence. `digest.regressions` keys off this. */
  readonly regressedByRunId: string;
  readonly suppression?: never;
}

export type FindingRecord =
  | NewFinding
  | AcknowledgedFinding
  | AcceptedFinding
  | FixedFinding
  | RegressedFinding;

// ── Build-checked assertions for L1 / L2 / L3 ──────────────────────────────

/** A `new` record that also claims it was once fixed. */
type NewCarryingARepairHistory = {
  schemaVersion: number;
  fingerprint: FindingFingerprint;
  estateId: string;
  detector: string;
  severity: FindingSeverity;
  title: string;
  summary: string;
  subjects: readonly NodeId[];
  evidence: EvidenceChain;
  population: Population;
  confidence: Confidence;
  remediation: RemediationProposal;
  firstSeenAt: string;
  firstSeenRunId: string;
  lastSeenAt: string;
  lastSeenRunId: string;
  regressionCount: number;
  state: 'new';
  fixedAt: string;
};

/**
 * L1 — if `NewFinding` ever stops forbidding `fixedAt` (or widens
 * `regressionCount` from the literal `0`), this flips to `true` and `next build`
 * fails HERE. That is the single edit that would let a regression be persisted
 * as a plain new finding.
 */
type _RegressionCannotBeEncodedAsNew = Assert<
  NewCarryingARepairHistory extends FindingRecord ? false : true
>;

/** A regression claiming it came from something other than `fixed`. */
type RegressedFromAcknowledged = {
  schemaVersion: number;
  fingerprint: FindingFingerprint;
  estateId: string;
  detector: string;
  severity: FindingSeverity;
  title: string;
  summary: string;
  subjects: readonly NodeId[];
  evidence: EvidenceChain;
  population: Population;
  confidence: Confidence;
  remediation: RemediationProposal;
  firstSeenAt: string;
  firstSeenRunId: string;
  lastSeenAt: string;
  lastSeenRunId: string;
  regressionCount: number;
  state: 'regressed';
  priorState: 'acknowledged';
  fixedAt: string;
  fixedByRunId: string;
  regressedAt: string;
  regressedByRunId: string;
};

/** L2 — a regression must come from `fixed` and from nothing else. */
type _RegressionOnlyFromFixed = Assert<
  RegressedFromAcknowledged extends FindingRecord ? false : true
>;

/** An `accepted` record with no suppression attached. */
type AcceptedWithoutSuppression = {
  schemaVersion: number;
  fingerprint: FindingFingerprint;
  estateId: string;
  detector: string;
  severity: FindingSeverity;
  title: string;
  summary: string;
  subjects: readonly NodeId[];
  evidence: EvidenceChain;
  population: Population;
  confidence: Confidence;
  remediation: RemediationProposal;
  firstSeenAt: string;
  firstSeenRunId: string;
  lastSeenAt: string;
  lastSeenRunId: string;
  regressionCount: number;
  state: 'accepted';
};

/** L3 — a suppression with no reason/owner/expiry cannot exist, so neither can this. */
type _AcceptedRequiresASuppression = Assert<
  AcceptedWithoutSuppression extends FindingRecord ? false : true
>;

// ---------------------------------------------------------------------------
// §Digest — what CHANGED, not what exists
// ---------------------------------------------------------------------------

/**
 * A record the run could not evaluate, and why.
 *
 * NOT the same as a finding that is still open, and emphatically not the same as
 * a fixed one. A record lands here when its detector did not run, ran over an
 * EMPTY population (green and blind), or the stored schema version differs from
 * {@link FINDING_SCHEMA_VERSION}. In every one of those cases the record is left
 * exactly as it was — absence of evidence is not evidence of repair.
 */
export interface NotEvaluated {
  readonly fingerprint: FindingFingerprint;
  readonly detector: string;
  readonly state: FindingState;
  /** What was ESTABLISHED about why. Never speculation. */
  readonly reason: string;
}

/**
 * What changed since the previous run.
 *
 * Deliberately NOT a re-listing of every open finding: a report that re-prints
 * the whole backlog every night is a report nobody reads, and the operator then
 * misses the one line that mattered. `stillOpen` and `suppressed` are COUNTS.
 * The listed sections are exactly the transitions.
 */
export interface RunDigest {
  readonly runId: string;
  readonly estateId: string;
  readonly at: string;
  /** Findings whose `firstSeenRunId` is this run. */
  readonly newFindings: readonly FindingRecord[];
  /** Findings whose `regressedByRunId` is this run. THE HEADLINE. */
  readonly regressions: readonly RegressedFinding[];
  /** Findings this run established are gone. */
  readonly fixed: readonly FixedFinding[];
  /** Suppressions that lapsed this run, re-surfacing their finding. */
  readonly suppressionsExpired: readonly FindingRecord[];
  /** Open and unchanged — a COUNT, not a listing. */
  readonly stillOpen: number;
  /** Currently suppressed by a live `accepted` — a COUNT. */
  readonly suppressed: number;
  readonly notEvaluated: readonly NotEvaluated[];
  /** Detectors that ran with a non-blind population this run. */
  readonly evaluatedDetectors: readonly string[];
  /** Anything the reconcile ESTABLISHED about its own limits. */
  readonly notes: readonly string[];
}

// ---------------------------------------------------------------------------
// §The run record
// ---------------------------------------------------------------------------

/** Counts the run reports. #3936 acceptance: "and reports counts". */
export interface ScanCounts {
  readonly nodes: number;
  readonly edges: number;
  readonly detectorsRun: number;
  readonly detectorsBlind: number;
  readonly findingsProduced: number;
  readonly recordsTotal: number;
  readonly new: number;
  readonly regressions: number;
  readonly fixed: number;
  readonly stillOpen: number;
  readonly suppressed: number;
  readonly suppressionsExpired: number;
  readonly notEvaluated: number;
}

// ---------------------------------------------------------------------------
// §Population regression — PRP §5, "a shrinking `judged` count is a P0"
// ---------------------------------------------------------------------------

/**
 * What one detector examined, persisted per run so the NEXT run can compare.
 *
 * This is the whole mechanism behind {@link PopulationRegression}: without a
 * previous run's numbers, "this detector examined 0" and "this detector has
 * always examined 0" are indistinguishable, and only the first is an incident.
 */
export interface DetectorPopulationSnapshot {
  readonly detector: string;
  readonly examined: number;
  readonly blind: boolean;
  readonly findings: number;
  /**
   * The largest `examined` this detector has reached within the decay window.
   *
   * THE ANTI-RATCHET. Without it the comparator only ever asks "worse than
   * yesterday?", which a slow erosion answers "no" every single night.
   * MEASURED in review: 19% per run for twelve runs takes 1000 -> 77 — 92.3% of
   * the population gone — with ZERO regressions reported, because no single step
   * crossed the tolerance. And a large single drop was red for exactly one run,
   * then green on an immediate re-run with nothing about the estate changed: the
   * P0 could be cleared by pressing "Re-run jobs".
   *
   * Carried forward run to run, so it survives a run that did not scan.
   */
  readonly maxExamined: number;
  /** ISO-8601 of the run that set {@link maxExamined}. Drives the decay window. */
  readonly maxExaminedAt: string;
  /**
   * ISO-8601 of the last step this comparator actually REPORTED for this
   * detector — a `shrank` or a `went-blind`. `null` if it never has.
   *
   * THIS IS WHAT MAKES THE DECAY SAFE. See {@link HIGH_WATER_DECAY_FLOOR}: a
   * mark whose drop was announced may re-base freely, because the operator saw
   * it; a mark whose drop was never announced may only re-base by a bounded
   * amount, because nothing else ever told anyone it happened.
   */
  readonly reportedStepAt: string | null;
  /**
   * How many times in a row the mark has re-based DOWNWARD.
   *
   * Reported, not merely counted. Measured in review: twelve consecutive
   * downward re-bases removed 92.3% of a population and the operator was shown
   * nothing at all, because a re-base wrote a new baseline and left no trace.
   * Zero on any run that set a new maximum.
   */
  readonly decayRebases: number;
}

/** How a detector's examined set got worse. Each needs a different response. */
export type PopulationRegressionKind =
  /** It examined something last run and NOTHING this run. Green and blind. */
  | 'went-blind'
  /** It ran last run and did not run at all this run. */
  | 'disappeared'
  /** Its examined set shrank past {@link POPULATION_SHRINK_TOLERANCE}. */
  | 'shrank'
  /**
   * It is below its own HIGH-WATER MARK by more than the tolerance, even though
   * no single run crossed it. The anti-ratchet — see
   * {@link DetectorPopulationSnapshot.maxExamined}.
   */
  | 'below-high-water';

export interface DetectorPopulationRegression {
  readonly detector: string;
  readonly kind: PopulationRegressionKind;
  readonly previousExamined: number;
  readonly examined: number;
  readonly previouslyBlind: boolean;
  readonly blind: boolean;
  /** The high-water mark this was compared against, and when it was set. */
  readonly highWater: number;
  readonly highWaterAt: string;
  /**
   * Consecutive downward re-bases of that mark, carried from the snapshot.
   *
   * Surfaced in the message because a re-base used to be entirely invisible: it
   * wrote a new baseline and left the operator a number with no history behind
   * it. Twelve of them removed 92.3% of a population in review.
   */
  readonly decayRebases: number;
}

/**
 * THE SIGNAL PRP §5 CALLS THE MOST VALUABLE THING THIS SYSTEM PRODUCES.
 *
 * MEASURED, 2026-08-24, against the live Commercial estate: emptying the wire
 * binding table took the graph from 18 edges to 0, findings from 8 to 0, and
 * blind detectors from 1 to 2 — and the run still reported a cheerful `ok` with
 * "0 findings". Counts moved; the VERDICT did not. That is the shape of every
 * green-and-blind failure this repo has shipped, and #3936's mutation acceptance
 * asks precisely for it not to be possible.
 *
 * So a run whose detector populations got materially WORSE than the previous
 * run's is red on its own axis, with its own exit code, because "the estate is
 * unreachable" and "the scanner stopped looking at things" are different
 * investigations with different owners.
 *
 * ── WHY A GENUINE ESTATE SHRINK TRIPPING THIS IS ACCEPTABLE ────────────────
 * Deleting a fifth of the container apps will fire this once. That is the
 * fail-safe direction: a loud, self-clearing false positive costs one look, and
 * the NEXT run compares against the new smaller number and passes. The failure
 * this replaces costs an unbounded number of silent nights.
 */
export interface PopulationRegression {
  readonly detectors: readonly DetectorPopulationRegression[];
  readonly previousRunId: string;
  /**
   * How many runs back the basis is.
   *
   * `1` is the previous run. Larger means intervening runs did not SCAN — under
   * the standing estate-pause mandate that is normal, and an operator reading a
   * comparison against a basis eleven nights old needs to be told so rather than
   * left to assume it was last night's.
   */
  readonly basisAgeRuns: number;
  readonly message: string;
}

/**
 * How far an examined set may shrink before it is treated as a regression.
 *
 * 0.2 = a 20% drop. Chosen to sit above ordinary estate churn (an app deleted,
 * a job retired) and well below the shapes that matter — a filter that switches
 * off, an extractor that stops running, a scope that narrows. A `went-blind`
 * transition ignores this entirely: 0 is always a regression from non-zero.
 *
 * PINNED ABSOLUTELY BY TEST. `__tests__/population.test.ts` asserts the literal
 * `0.2`, and the over-tolerance fixtures use absolute numbers rather than
 * arithmetic on this constant. A fixture derived from the constant it guards
 * moves with the code — measured in review, where widening
 * {@link MAX_SUPPRESSION_DAYS} by one token changed nothing because its fixture
 * was built from `MAX_SUPPRESSION_DAYS + 1`.
 */
export const POPULATION_SHRINK_TOLERANCE = 0.2;

/**
 * How long a high-water mark stays authoritative before it may re-base.
 *
 * A genuine, permanent estate shrink must not pin the comparator to a number
 * that will never be reached again — that would be a gate that can never go
 * green, which is its own failure mode. After this many days without being
 * matched, the mark re-bases — by {@link HIGH_WATER_DECAY_FLOOR} at most, unless
 * the drop was already REPORTED, in which case it re-bases all the way.
 *
 * 30 days is long enough that a slow erosion is caught well inside the window,
 * and short enough that a deliberate downsizing clears within a month.
 */
export const HIGH_WATER_DECAY_DAYS = 30;

/**
 * The MOST a high-water mark may re-base downward in one decay window when the
 * drop that caused it was never reported.
 *
 * ── WHY THIS CONSTANT EXISTS (review of #4014, second pass) ────────────────
 * The first version re-based the mark to TODAY'S value once the window elapsed.
 * That turns each hold into a laundering step: drop 19% (inside the 20% step
 * tolerance, so silent), wait 31 days, and the reduction becomes the new
 * baseline. MEASURED end-to-end through `snapshotPopulations` +
 * `detectPopulationRegression`, twelve cycles of exactly that:
 *
 *     d31=810 d62=656 d93=531 d124=430 d155=348 d186=282
 *     d217=228 d248=185 d279=150 d310=122 d341=99 d372=80
 *     regressions fired: 0 over 372 days — 92% of the population gone
 *
 * The anti-ratchet itself is sound; the CONTROL is that the identical 19%
 * erosion at DAILY cadence fires 11 times out of 12. Only the re-basing rule was
 * wrong.
 *
 * ── WHY NOT `max(examined, prevMark * 0.8)` ────────────────────────────────
 * That was the suggested repair and it is a NO-OP against the very sequence it
 * was meant to fix, because 0.8 IS {@link POPULATION_SHRINK_TOLERANCE}'s floor
 * and the erosion is calibrated just inside it: 0.81 x mark is above 0.80 x mark
 * at every single cycle, so `max` returns `examined` twelve times out of twelve
 * and nothing changes. Verified numerically before this constant was chosen. The
 * repair has to be a rate SMALLER than the step tolerance, or it cannot bind.
 *
 * ── WHAT 0.9 MEANS, STATED PLAINLY ─────────────────────────────────────────
 * THE DECAY RATE IS THE MAXIMUM SILENTLY-PERMITTED CONTRACTION RATE. That is not
 * a tuning knob, it is the definition: an erosion that tracks the mark's decay
 * exactly is, by construction, indistinguishable from an estate that is honestly
 * getting smaller. So the contract is explicit — an examined set may contract by
 * up to 10% per 30-day window without comment; faster than that, with no step
 * ever crossing the tolerance, is reported. Measured against this constant:
 *
 *     19% / 31d  ->  fires at cycle 2
 *     12% / 31d  ->  fires at cycle 6
 *     10% / 31d  ->  never fires   (exactly the permitted rate)
 *      5% / 31d  ->  never fires
 *
 * ── AND WHY A REPORTED DROP IS EXEMPT ──────────────────────────────────────
 * A drop bigger than {@link POPULATION_SHRINK_TOLERANCE} already fired `shrank`
 * that night. The operator SAW it. Bounding its re-base would keep the lane red
 * for months over a downsizing that was announced the day it happened, breaking
 * the "clears within a month" promise above for no signal in return. So
 * {@link DetectorPopulationSnapshot.reportedStepAt} exempts it. The erosion this
 * constant exists for cannot use that exemption without first paying for a RED
 * RUN, which is precisely the visibility it was engineered to avoid.
 */
export const HIGH_WATER_DECAY_FLOOR = 0.9;

// ---------------------------------------------------------------------------
// §Scan staleness — "we have never actually scanned" (deploy-integrity R3)
// ---------------------------------------------------------------------------

/**
 * How long the lane may go without ACTUALLY SCANNING before it goes red.
 *
 * ── WHY THIS AXIS EXISTS (review of #4014, S5) ────────────────────────────
 * PAUSED exits 0, and that is well argued — Actions has only pass/fail, and a
 * paused estate failing nightly is how an operator learns to ignore a lane. But
 * with no staleness axis it produced the failure from the opposite direction:
 * under the standing estate-pause mandate PAUSED is the NORMAL mode, so this
 * lane would be green every single night having built no graph, run no detector
 * and reconciled nothing — and NOTHING in the workflow, the report or the run
 * record would ever escalate that. A lane legitimately paused for sixty nights
 * was indistinguishable at the check level from a working one.
 *
 * `deploy-integrity.md` R3 names this exactly: *"A deploy path that has never
 * run is the loudest case of this, not a silent pass."*
 *
 * ── WHY DAYS AND NOT RUNS ─────────────────────────────────────────────────
 * A run count is not comparable across a lane whose cadence changes, and
 * `scannedRunAgeRuns()` is BOUNDED (it reads at most
 * {@link RUN_AGE_SCAN_LIMIT} runs), so past that bound it cannot answer at all.
 * Wall clock is what the operator actually asks about — "when did this last
 * really scan?" — and it is answerable from a single instant on the basis run.
 * The run age is still reported alongside it, because it says something the
 * day count does not: how many opportunities were missed.
 *
 * ── WHY THIS IS NOT A "GATE THAT CANNOT FAIL", NOR ONE THAT ALWAYS DOES ───
 * It is a THRESHOLD over a measured quantity, not a boolean that skips a run:
 * nothing about it can be set to make the lane green, and it is derived from
 * persisted run records rather than from configuration. It CAN sit red for as
 * long as an estate stays paused past the ceiling — and that is the intended
 * reading. Sixty nights of "nothing was scanned" is a standing condition that
 * someone should have decided about, not a background hum.
 *
 * 45 days is wider than any pause this estate has actually held and far inside
 * the window in which a permanently-dead lane would otherwise go unnoticed.
 */
export const SCAN_STALENESS_CEILING_DAYS = 45;

/**
 * What the run established about the last time this lane actually SCANNED.
 *
 * `null` age with `neverScanned: true` is the genuine first run for an estate —
 * distinct from "the lane has been running for weeks and has never scanned",
 * which is the case R3 calls the loudest.
 */
export interface ScanStaleness {
  /** The last run whose `detectorPopulations` is non-null, or `null`. */
  readonly lastScannedRunId: string | null;
  readonly lastScannedAt: string | null;
  /**
   * How many runs back that basis is, counting itself as 1. `0` means no
   * scanned run was found within the store's bounded window — NOT "one run ago".
   */
  readonly lastScannedAgeRuns: number;
  /**
   * Days since the lane last actually scanned. `null` only when there is no
   * earlier run at all to measure from — i.e. this is the first run.
   */
  readonly ageDays: number | null;
  /** True when no run for this estate has EVER carried detector populations. */
  readonly neverScanned: boolean;
  readonly ceilingDays: number;
  /** `ageDays` is past {@link ceilingDays}. RED, on its own exit code. */
  readonly exceeded: boolean;
  /** Operator-readable, and TRUE — states only what was established. */
  readonly message: string;
}


/** One scheduled run, persisted so a lane that stops running is visible. */
export interface ScanRunRecord {
  readonly schemaVersion: number;
  readonly docType: 'scan-run';
  readonly id: string;
  readonly estateId: string;
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly cloud: string;
  readonly verdict: ScanVerdictKind;
  readonly verdictMessage: string;
  /** Null on PAUSED and UNREACHABLE — no version is written on those paths. */
  readonly graphVersionId: string | null;
  readonly counts: ScanCounts | null;
  /**
   * Per-detector examined counts. Null on the two non-scanning paths.
   *
   * Persisted so the NEXT run can compare and detect a shrinking population.
   * Without it the comparison has no basis and the P0 signal cannot exist.
   */
  readonly detectorPopulations: readonly DetectorPopulationSnapshot[] | null;
  /**
   * A stable digest of the GRAPH's node-id set for this run. `null` on the two
   * non-scanning paths.
   *
   * WHY A COUNT IS NOT ENOUGH. `DetectorPopulationSnapshot` carries a count with
   * no identity, so swapping every subject while holding `examined` constant is
   * invisible to the comparator — measured in review. That matters here
   * specifically because the graph pull is deliberately UNSCOPED: ARG returns
   * every container app the identity can read (63 measured, of which 29 are
   * Loom's), so non-Loom growth can mask Loom's disappearance one for one.
   *
   * HONEST LIMIT, stated rather than implied: this digests the GRAPH's node set,
   * NOT each detector's examined subset. A detector's own subject list is not on
   * `DetectorResult` — `Population` exposes a count only — so per-detector
   * composition needs a change in `lib/brain/detectors`, which this lane does
   * not own. This catches composition change at the graph level and says so.
   */
  readonly graphSubjectsDigest: string | null;
  readonly observed: readonly ObservedResourceState[];
  readonly notes: readonly string[];
  /**
   * Cosmos per-document TTL, seconds. Run records are operational telemetry and
   * expire; FINDING records carry NO ttl, because a `fixed` finding that expired
   * would make its next occurrence read as `new` and destroy the regression
   * signal this lane exists to produce.
   */
  readonly ttl: number;
}

/** 90 days of run history. The container itself carries `defaultTtl: -1`. */
export const RUN_RECORD_TTL_SECONDS = 7_776_000;

// ---------------------------------------------------------------------------
// Keep the assertion aliases referenced so they cannot be pruned as dead code,
// exactly as `../types.ts` and `lib/estate/pause-state.ts` do.
// ---------------------------------------------------------------------------

/** The build-checked invariants of this module. Do not delete. */
export type BrainRunTypeInvariants = [
  _PausedMustCarryArmReadings,
  _SuppressionRequiresExpiry,
  _SuppressionRequiresReason,
  _SuppressionRequiresOwner,
  _RegressionCannotBeEncodedAsNew,
  _RegressionOnlyFromFixed,
  _AcceptedRequiresASuppression,
];
