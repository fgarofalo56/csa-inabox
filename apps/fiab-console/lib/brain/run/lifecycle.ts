/**
 * LOOM BRAIN W10 — the FINDING LIFECYCLE (#3936).
 *
 * PURE. `reconcile()` is the ONLY constructor of a finding's next state, and
 * `acceptFinding()` / `acknowledgeFinding()` are the only two human transitions.
 * Nothing here reads a clock, a network or a store: every instant is passed in,
 * so every property below is provable with fixtures.
 *
 * ── THE FOUR PROPERTIES THIS FILE EXISTS TO HOLD ───────────────────────────
 *
 *  P-REG  A finding that recurs after `fixed` is a REGRESSION, never a `new`
 *         finding. Enforced three ways: the types (`./model.ts` L1/L2), the
 *         single-constructor shape of `reconcile()`, and
 *         `assertNoRegressionReportedAsNew()` which re-checks the result before
 *         it is returned. A regression is the most valuable signal this lane
 *         produces — something that was understood and repaired has broken again
 *         — and reporting it as `new` throws that away silently.
 *
 *  P-SUP  `accepted` requires a reason AND an owner. Rejected at the type level
 *         by `Suppression` (no field is optional) and again at runtime here,
 *         because a record can also arrive from Cosmos as untyped JSON.
 *
 *  P-EXP  Suppressions EXPIRE. An `accepted` with no expiry is indistinguishable
 *         from a deleted detector, so `expiresAt` is required, bounded by
 *         {@link MAX_SUPPRESSION_DAYS}, and on expiry the finding RE-SURFACES:
 *         it goes back to `acknowledged` (a human had seen it — that is what
 *         accepting it means) and the run digest lists it under
 *         `suppressionsExpired`.
 *
 *  P-BLIND  ABSENCE IS NOT A FIX. A finding is marked `fixed` only when its
 *         detector actually RAN over a NON-EMPTY population and did not report
 *         it. A detector that goes blind — or is removed from the detector list,
 *         or throws, or whose stored records are on an older schema — cannot
 *         close the backlog it used to produce. Those records are returned
 *         UNTOUCHED and listed under `notEvaluated`.
 *
 *         This is the property most likely to be "simplified" away, because the
 *         simplification reads better: `if (!seenThisRun) markFixed()`. PRP
 *         §3.2/§3.8 is the reason it must not be — a detector over an empty node
 *         set is green and blind, and this repo has found that failure
 *         repeatedly. Under the simple version, the FIRST run after a detector
 *         breaks marks its entire backlog fixed, and the run after the detector
 *         is repaired reports every one of them as `new`. The regression signal
 *         is not merely lost; it is inverted into a wave of false new findings.
 *
 * ── WHAT THE DIGEST IS ─────────────────────────────────────────────────────
 * What CHANGED since the last run. `stillOpen` and `suppressed` are counts, not
 * listings. A nightly report that re-prints the whole backlog is a report the
 * operator stops reading, and then the one line that mattered is missed.
 */

import type { Finding } from '../types';
import {
  FINDING_SCHEMA_VERSION,
  MAX_SUPPRESSION_DAYS,
  fingerprintOf,
  type AcceptedFinding,
  type AcknowledgedFinding,
  type FindingFingerprint,
  type FindingRecord,
  type FixedFinding,
  type NotEvaluated,
  type RegressedFinding,
  type RunDigest,
  type Suppression,
} from './model';

const MS_PER_DAY = 86_400_000;

/**
 * One finding as produced by a detector in THIS run, with its cross-run
 * identity resolved.
 */
export interface FindingOccurrence {
  readonly finding: Finding;
  readonly fingerprint: FindingFingerprint;
}

/** Turn a detector's findings into occurrences, rejecting duplicate identities. */
export function toOccurrences(findings: readonly Finding[]): readonly FindingOccurrence[] {
  const seen = new Map<string, string>();
  const out: FindingOccurrence[] = [];
  for (const f of findings) {
    const fingerprint = fingerprintOf(f);
    const prior = seen.get(fingerprint);
    if (prior !== undefined) {
      // Two findings sharing an identity would collapse into ONE record, so one
      // of them would vanish from the backlog with no trace. Deterministic
      // finding ids (detector-kit#findingId) make this a detector defect.
      throw new Error(
        `two findings in this run share the fingerprint '${fingerprint}' ` +
          `('${prior}' and '${f.detector}'). They would collapse into a single record and ` +
          'one of them would silently leave the backlog. A finding id must be unique per ' +
          'detector+subject — see lib/brain/detectors/detector-kit.ts#findingId.',
      );
    }
    seen.set(fingerprint, f.detector);
    out.push({ finding: f, fingerprint });
  }
  return out;
}

export interface ReconcileArgs {
  readonly estateId: string;
  readonly runId: string;
  /** ISO-8601 instant of this run. Every transition is stamped with it. */
  readonly at: string;
  /** Everything the store holds for this estate. */
  readonly previous: readonly FindingRecord[];
  /** What the detectors reported this run. */
  readonly occurrences: readonly FindingOccurrence[];
  /**
   * Detectors that ran AND whose population was non-empty.
   *
   * P-BLIND. A detector absent from this set cannot mark anything fixed. Build
   * it from `DetectorResult.population.blind === false`, never from "the
   * detector was in the list".
   */
  readonly evaluatedDetectors: ReadonlySet<string>;
  /** Detectors that ran but were BLIND, with the scope they ranged over. */
  readonly blindDetectors?: ReadonlyMap<string, string>;
}

export interface ReconcileResult {
  /** The next state of EVERY known fingerprint. Nothing is dropped. */
  readonly records: readonly FindingRecord[];
  readonly digest: RunDigest;
}

function commonFields(
  o: FindingOccurrence,
  estateId: string,
): Omit<
  FindingRecord & { state: 'new' },
  'state' | 'firstSeenAt' | 'firstSeenRunId' | 'lastSeenAt' | 'lastSeenRunId' | 'regressionCount'
> {
  const f = o.finding;
  return {
    schemaVersion: FINDING_SCHEMA_VERSION,
    fingerprint: o.fingerprint,
    estateId,
    detector: f.detector,
    severity: f.severity,
    title: f.title,
    summary: f.summary,
    subjects: f.subjects,
    evidence: f.evidence,
    population: f.population,
    confidence: f.confidence,
    ...(f.cost ? { cost: f.cost } : {}),
    remediation: f.remediation,
  };
}

/** True iff this suppression has lapsed at `at`. Boundary is inclusive. */
export function suppressionExpired(s: Suppression, at: string): boolean {
  return Date.parse(at) >= Date.parse(s.expiresAt);
}

/**
 * Accept a finding as won't-fix.
 *
 * The ONLY sanctioned way to reach `accepted`. Rejects a reason-free, owner-free,
 * expiry-free, already-expired or over-long suppression — every one of which is
 * a way a real finding gets buried. `regressionCount` is carried forward, so
 * accepting a finding does not erase the fact that it once regressed.
 */
export function acceptFinding(
  record: FindingRecord,
  args: { reason: string; owner: string; at: string; expiresAt: string },
): AcceptedFinding {
  const reason = args.reason.trim();
  const owner = args.owner.trim();
  if (reason === '') {
    throw new Error(
      `refusing to accept finding '${record.fingerprint}' with an EMPTY reason. A ` +
        'reason-free suppression is how a real finding gets buried: six months later ' +
        'nobody can tell it apart from a deleted detector.',
    );
  }
  if (owner === '') {
    throw new Error(
      `refusing to accept finding '${record.fingerprint}' with no OWNER. A suppression ` +
        'with nobody attached has nobody to ask when it expires.',
    );
  }
  const acceptedMs = Date.parse(args.at);
  const expiresMs = Date.parse(args.expiresAt);
  if (Number.isNaN(acceptedMs) || Number.isNaN(expiresMs)) {
    throw new Error(
      `refusing to accept finding '${record.fingerprint}': acceptedAt='${args.at}' / ` +
        `expiresAt='${args.expiresAt}' is not a parseable ISO-8601 instant.`,
    );
  }
  if (expiresMs <= acceptedMs) {
    throw new Error(
      `refusing to accept finding '${record.fingerprint}': the suppression expires at ` +
        `'${args.expiresAt}', which is not after '${args.at}'. A suppression that is ` +
        'already expired at creation is indistinguishable from one that was never made.',
    );
  }
  const days = (expiresMs - acceptedMs) / MS_PER_DAY;
  if (days > MAX_SUPPRESSION_DAYS) {
    throw new Error(
      `refusing to accept finding '${record.fingerprint}' for ${days.toFixed(0)} days: the ` +
        `ceiling is ${MAX_SUPPRESSION_DAYS}. A long-enough suppression is a deleted ` +
        'detector wearing a reason. Renew it deliberately instead.',
    );
  }
  const { ...rest } = record as FindingRecord & Record<string, unknown>;
  delete rest.fixedAt;
  delete rest.fixedByRunId;
  delete rest.priorState;
  delete rest.regressedAt;
  delete rest.regressedByRunId;
  delete rest.acknowledgedBy;
  delete rest.acknowledgedAt;
  delete rest.resurfacedFromSuppressionAt;
  return {
    ...(rest as unknown as Omit<AcceptedFinding, 'state' | 'suppression'>),
    state: 'accepted',
    suppression: { reason, owner, acceptedAt: args.at, expiresAt: args.expiresAt },
  };
}

/** Mark a finding as seen by a human. Carries `regressionCount` forward. */
export function acknowledgeFinding(
  record: FindingRecord,
  args: { by: string; at: string },
): AcknowledgedFinding {
  const by = args.by.trim();
  if (by === '') {
    throw new Error(
      `refusing to acknowledge finding '${record.fingerprint}' with no principal. An ` +
        'unattributed acknowledgement is a state change nobody made.',
    );
  }
  const { ...rest } = record as FindingRecord & Record<string, unknown>;
  delete rest.suppression;
  delete rest.priorState;
  delete rest.regressedAt;
  delete rest.regressedByRunId;
  delete rest.fixedAt;
  delete rest.fixedByRunId;
  return {
    ...(rest as unknown as Omit<AcknowledgedFinding, 'state' | 'acknowledgedBy' | 'acknowledgedAt'>),
    state: 'acknowledged',
    acknowledgedBy: by,
    acknowledgedAt: args.at,
  };
}

/**
 * Reconcile a run's detector output against the stored backlog.
 *
 * Returns the next state of EVERY known fingerprint — the union of the stored
 * records and this run's occurrences — plus the digest of what changed. Nothing
 * is dropped: a record this run could not evaluate comes back unchanged, and is
 * named in `digest.notEvaluated`.
 */
export function reconcile(args: ReconcileArgs): ReconcileResult {
  const { estateId, runId, at, previous, occurrences, evaluatedDetectors } = args;
  const blind = args.blindDetectors ?? new Map<string, string>();

  const priorByFingerprint = new Map<FindingFingerprint, FindingRecord>();
  for (const p of previous) {
    if (priorByFingerprint.has(p.fingerprint)) {
      throw new Error(
        `the store returned two records with fingerprint '${p.fingerprint}' for estate ` +
          `'${estateId}'. One of them would be silently discarded here; a finding's ` +
          'identity must be unique per estate.',
      );
    }
    priorByFingerprint.set(p.fingerprint, p);
  }

  const seen = new Set<FindingFingerprint>();
  const next: FindingRecord[] = [];
  const newFindings: FindingRecord[] = [];
  const regressions: RegressedFinding[] = [];
  const fixed: FixedFinding[] = [];
  const suppressionsExpired: FindingRecord[] = [];
  const notEvaluated: NotEvaluated[] = [];
  const notes: string[] = [];
  let stillOpen = 0;
  let suppressed = 0;

  // ── A. everything the detectors reported this run ─────────────────────────
  for (const occ of occurrences) {
    seen.add(occ.fingerprint);
    const prior = priorByFingerprint.get(occ.fingerprint);
    const base = commonFields(occ, estateId);

    // A record on an older schema is NOT a comparable prior. Treating it as
    // absent would mint a `new` record and destroy whatever repair history it
    // carried — including, if it was `fixed`, the regression this run just saw.
    if (prior !== undefined && prior.schemaVersion !== FINDING_SCHEMA_VERSION) {
      next.push(prior);
      notEvaluated.push({
        fingerprint: prior.fingerprint,
        detector: prior.detector,
        state: prior.state,
        reason:
          `stored on schemaVersion ${prior.schemaVersion}; this build reconciles ` +
          `schemaVersion ${FINDING_SCHEMA_VERSION}. Left UNTOUCHED — re-minting it would ` +
          'discard its repair history and could report a regression as new.',
      });
      continue;
    }

    if (prior === undefined) {
      // The ONLY branch that produces `new`, and it is reachable only when there
      // is no prior record at all. P-REG.
      const record: FindingRecord = {
        ...base,
        state: 'new',
        regressionCount: 0,
        firstSeenAt: at,
        firstSeenRunId: runId,
        lastSeenAt: at,
        lastSeenRunId: runId,
      };
      next.push(record);
      newFindings.push(record);
      continue;
    }

    const carried = {
      ...base,
      firstSeenAt: prior.firstSeenAt,
      firstSeenRunId: prior.firstSeenRunId,
      lastSeenAt: at,
      lastSeenRunId: runId,
    } as const;

    if (prior.state === 'fixed') {
      // ── THE REGRESSION. Louder than new, and structurally distinct from it.
      const record: RegressedFinding = {
        ...carried,
        state: 'regressed',
        priorState: 'fixed',
        fixedAt: prior.fixedAt,
        fixedByRunId: prior.fixedByRunId,
        regressedAt: at,
        regressedByRunId: runId,
        regressionCount: prior.regressionCount + 1,
      };
      next.push(record);
      regressions.push(record);
      continue;
    }

    if (prior.state === 'accepted') {
      if (suppressionExpired(prior.suppression, at)) {
        // P-EXP — the suppression lapsed and the finding is still here, so it
        // RE-SURFACES. Back to `acknowledged`, because a human had seen it: that
        // is what accepting it meant. It is NOT `new` (it has a history) and it
        // is NOT a regression (it was never fixed).
        const record: AcknowledgedFinding = {
          ...carried,
          state: 'acknowledged',
          acknowledgedBy: prior.suppression.owner,
          acknowledgedAt: prior.suppression.acceptedAt,
          resurfacedFromSuppressionAt: at,
          regressionCount: prior.regressionCount,
        };
        next.push(record);
        suppressionsExpired.push(record);
        notes.push(
          `suppression on '${prior.fingerprint}' expired at ${prior.suppression.expiresAt} ` +
            `(owner '${prior.suppression.owner}', reason: ${prior.suppression.reason}). The ` +
            'finding is still present and is now open again.',
        );
        continue;
      }
      const record: AcceptedFinding = {
        ...carried,
        state: 'accepted',
        suppression: prior.suppression,
        regressionCount: prior.regressionCount,
      };
      next.push(record);
      suppressed += 1;
      continue;
    }

    if (prior.state === 'acknowledged') {
      const record: AcknowledgedFinding = {
        ...carried,
        state: 'acknowledged',
        acknowledgedBy: prior.acknowledgedBy,
        acknowledgedAt: prior.acknowledgedAt,
        ...(prior.resurfacedFromSuppressionAt
          ? { resurfacedFromSuppressionAt: prior.resurfacedFromSuppressionAt }
          : {}),
        regressionCount: prior.regressionCount,
      };
      next.push(record);
      stillOpen += 1;
      continue;
    }

    if (prior.state === 'regressed') {
      // Still open since it regressed. Carried, not re-announced: the digest
      // reports transitions, and this one already fired on an earlier run.
      const record: RegressedFinding = {
        ...carried,
        state: 'regressed',
        priorState: 'fixed',
        fixedAt: prior.fixedAt,
        fixedByRunId: prior.fixedByRunId,
        regressedAt: prior.regressedAt,
        regressedByRunId: prior.regressedByRunId,
        regressionCount: prior.regressionCount,
      };
      next.push(record);
      stillOpen += 1;
      continue;
    }

    // prior.state === 'new' — still new, still open, not re-announced.
    const record: FindingRecord = {
      ...carried,
      state: 'new',
      regressionCount: 0,
    };
    next.push(record);
    stillOpen += 1;
  }

  // ── B. stored records the detectors did NOT report this run ───────────────
  for (const prior of previous) {
    if (seen.has(prior.fingerprint)) continue;

    // P-BLIND. Absence is only evidence of repair when the detector actually
    // ranged over a non-empty population.
    if (!evaluatedDetectors.has(prior.detector)) {
      next.push(prior);
      const blindScope = blind.get(prior.detector);
      notEvaluated.push({
        fingerprint: prior.fingerprint,
        detector: prior.detector,
        state: prior.state,
        reason:
          blindScope !== undefined
            ? `detector '${prior.detector}' ran BLIND this run (${blindScope}). Absence of ` +
              'the finding is therefore not evidence of repair, so the record is unchanged.'
            : `detector '${prior.detector}' did not run this run (not in the detector list, ` +
              'or it produced no result). The record is unchanged — a detector that stops ' +
              'running must not be able to close the backlog it produced.',
      });
      continue;
    }

    if (prior.schemaVersion !== FINDING_SCHEMA_VERSION) {
      next.push(prior);
      notEvaluated.push({
        fingerprint: prior.fingerprint,
        detector: prior.detector,
        state: prior.state,
        reason:
          `stored on schemaVersion ${prior.schemaVersion}; this build reconciles ` +
          `schemaVersion ${FINDING_SCHEMA_VERSION}. Left UNTOUCHED rather than marked fixed.`,
      });
      continue;
    }

    if (prior.state === 'fixed') {
      next.push(prior);
      continue;
    }

    // Gone, and the detector was watching. That is a fix — whatever state it was
    // in, including `accepted`: a suppression governs REPORTING, not existence.
    const record: FixedFinding = {
      schemaVersion: prior.schemaVersion,
      fingerprint: prior.fingerprint,
      estateId: prior.estateId,
      detector: prior.detector,
      severity: prior.severity,
      title: prior.title,
      summary: prior.summary,
      subjects: prior.subjects,
      evidence: prior.evidence,
      population: prior.population,
      confidence: prior.confidence,
      ...(prior.cost ? { cost: prior.cost } : {}),
      remediation: prior.remediation,
      firstSeenAt: prior.firstSeenAt,
      firstSeenRunId: prior.firstSeenRunId,
      lastSeenAt: prior.lastSeenAt,
      lastSeenRunId: prior.lastSeenRunId,
      regressionCount: prior.regressionCount,
      state: 'fixed',
      fixedAt: at,
      fixedByRunId: runId,
    };
    next.push(record);
    fixed.push(record);
  }

  if (blind.size > 0) {
    notes.push(
      `${blind.size} detector(s) ran BLIND (empty population) and could not close any ` +
        `finding: ${[...blind.keys()].sort().join(', ')}. A blind detector is green and ` +
        'says nothing (PRP §3.2).',
    );
  }

  const digest: RunDigest = {
    runId,
    estateId,
    at,
    newFindings,
    regressions,
    fixed,
    suppressionsExpired,
    stillOpen,
    suppressed,
    notEvaluated,
    evaluatedDetectors: [...evaluatedDetectors].sort(),
    notes,
  };

  assertNoRegressionReportedAsNew(next, priorByFingerprint);
  assertRecurrenceAfterFixIsReported({
    occurrences,
    priorByFingerprint,
    records: next,
    digest,
  });

  return { records: next, digest };
}

/**
 * P-REG, THE LOAD-BEARING FORM: assert the TRANSITION, not the destination.
 *
 * ── WHY THIS REPLACED THE STATE-ONLY CHECK (review of #4014) ──────────────
 * The original guard only inspected records whose state was `new`. That defends
 * exactly one laundering route, and the reviewer found the others in one try:
 * route a recurrence to `acknowledged` instead, scope it to a detector no test
 * exercises, and everything stayed green — the guard never fired, the digest
 * counted it under `stillOpen` ("unchanged, not listed"), and nothing printed.
 * The BROAD form of that same edit was caught; the narrow one was silent, which
 * is the evasion shape this repo has measured as the one that actually works.
 *
 * Worse, that escape broke the argument used to justify the declared blind spot
 * in `__tests__/mutation/mutations.mjs` — "the runtime guard exists in addition
 * to the tests" only holds if the runtime guard covers more than one route.
 *
 * So the property is now stated the way it is actually meant: **a fingerprint
 * whose prior record was `fixed` and which the detectors reported again this run
 * MUST appear in `digest.regressions`.** Whatever state anyone writes it as,
 * whatever detector it belongs to. There is no destination that satisfies this
 * except the right one.
 */
export function assertRecurrenceAfterFixIsReported(args: {
  readonly occurrences: readonly FindingOccurrence[];
  readonly priorByFingerprint: ReadonlyMap<FindingFingerprint, FindingRecord>;
  readonly records: readonly FindingRecord[];
  readonly digest: RunDigest;
}): void {
  const reported = new Set(args.digest.regressions.map((r) => r.fingerprint));
  const byFingerprint = new Map(args.records.map((r) => [r.fingerprint, r]));

  for (const occ of args.occurrences) {
    const prior = args.priorByFingerprint.get(occ.fingerprint);
    if (prior === undefined || prior.state !== 'fixed') continue;

    // A record on an older schema is deliberately left untouched and is NOT a
    // reconciled recurrence — `reconcile` reports it under `notEvaluated`
    // instead, and re-minting it is the thing that would destroy the history.
    if (prior.schemaVersion !== FINDING_SCHEMA_VERSION) continue;

    const now = byFingerprint.get(occ.fingerprint);
    if (reported.has(occ.fingerprint) && now?.state === 'regressed') continue;

    throw new Error(
      `finding '${occ.fingerprint}' (detector '${prior.detector}') was FIXED at ` +
        `${prior.fixedAt} and the detectors reported it again this run, but it was ` +
        `reconciled to state '${now?.state ?? '<dropped>'}' and ` +
        `${reported.has(occ.fingerprint) ? 'is' : 'is NOT'} in the run digest's regression ` +
        'list. A recurrence after a repair is a REGRESSION — the single most valuable signal ' +
        'this lane produces — and it must be reported as one whatever state it is written ' +
        'as. Reporting it as `new` resets its history; reporting it as `acknowledged` or ' +
        '`accepted` buries it in the still-open count where nothing prints it.',
    );
  }
}

/**
 * P-REG, the narrower companion: a record with a HISTORY is never `new`.
 *
 * Kept alongside {@link assertRecurrenceAfterFixIsReported} because it catches a
 * different edit — a lifecycle RESET (an acknowledgement or an acceptance thrown
 * away by re-minting the record) that is not a recurrence-after-fix at all and
 * so is invisible to the transition guard.
 *
 * `new -> new` is the one legal carry-forward: a finding first seen last run and
 * still present this run stays `new` (it has not been acknowledged, accepted or
 * fixed), and its `firstSeenRunId` keeps it out of `digest.newFindings`. Every
 * other prior state carries a human decision or a repair, and resetting one to
 * `new` destroys it.
 */
export function assertNoRegressionReportedAsNew(
  records: readonly FindingRecord[],
  priorByFingerprint: ReadonlyMap<FindingFingerprint, FindingRecord>,
): readonly FindingRecord[] {
  for (const r of records) {
    if (r.state !== 'new') continue;
    const prior = priorByFingerprint.get(r.fingerprint);
    if (prior === undefined) continue;
    if (prior.state === 'new') continue;
    throw new Error(
      `finding '${r.fingerprint}' was reconciled to state 'new' but a prior record exists ` +
        `in state '${prior.state}'` +
        (prior.state === 'fixed'
          ? ` (fixed at ${prior.fixedAt}). This is a REGRESSION being reported as a new ` +
            'finding, which is the single most valuable signal in this lane being ' +
            'destroyed — #3936 requires a recurrence after a fix to be a distinct, louder ' +
            'event.'
          : '. A finding with a history is never `new`; that would reset its lifecycle and ' +
            'lose the repair record that makes a later recurrence a regression.'),
    );
  }
  return records;
}
