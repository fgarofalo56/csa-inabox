/**
 * LOOM BRAIN W10 — HOW LONG SINCE THIS LANE ACTUALLY SCANNED? (#3936)
 *
 * PURE. Takes the two run records the store already provides plus this run's
 * instant, and returns a fact. No clock, no store, no environment — so every
 * threshold below is provable with fixtures.
 *
 * ── WHY THIS EXISTS (review of #4014, S5) ──────────────────────────────────
 * `scan.ts` mapped PAUSED to exit 0 with no staleness axis at all, and under the
 * standing estate-pause mandate PAUSED is the NORMAL operating mode. So the lane
 * would go green every night having built no graph, run no detector and
 * reconciled nothing, and nothing anywhere would escalate it. The number that
 * surfaces it already existed — `FindingStore.scannedRunAgeRuns()` — and was
 * consumed on the OK path only, as `basisAgeRuns`. On the PAUSED path it was
 * never called.
 *
 * This is the same finding as B1 seen from the other end, and the review said so:
 * a lane that cannot write to Cosmos cannot complete a run in ANY verdict, so it
 * would never establish a baseline — which is indistinguishable, at the check
 * level, from a lane that is merely paused. One of those needs an engineer
 * tonight and the other does not, so they must not render the same.
 */

import { SCAN_STALENESS_CEILING_DAYS, type ScanRunRecord, type ScanStaleness } from './model';

const MS_PER_DAY = 86_400_000;

/** Whole days between two ISO-8601 instants, or `null` if either is unreadable. */
function daysBetween(fromIso: string, toIso: string): number | null {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  // R7: an unparseable instant is "I could not establish this", never 0.
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.max(0, Math.floor((to - from) / MS_PER_DAY));
}

/**
 * What this run establishes about the lane's own scanning history.
 *
 * @param lastScanned the most recent run whose `detectorPopulations` is non-null
 * @param lastAny     the most recent run of ANY verdict — the thing that tells
 *                    "first run ever" apart from "has run and never scanned"
 * @param ageRuns     `FindingStore.scannedRunAgeRuns()`; `0` means no scanned
 *                    run inside the store's bounded window
 * @param at          this run's instant
 */
export function assessScanStaleness(args: {
  readonly lastScanned: ScanRunRecord | null;
  readonly lastAny: ScanRunRecord | null;
  readonly ageRuns: number;
  readonly at: string;
  readonly ceilingDays?: number;
}): ScanStaleness {
  const ceilingDays = args.ceilingDays ?? SCAN_STALENESS_CEILING_DAYS;
  const { lastScanned, lastAny } = args;

  if (lastScanned !== null) {
    const ageDays = daysBetween(lastScanned.startedAt, args.at);
    const exceeded = ageDays !== null && ageDays > ceilingDays;
    return {
      lastScannedRunId: lastScanned.runId,
      lastScannedAt: lastScanned.startedAt,
      lastScannedAgeRuns: args.ageRuns,
      ageDays,
      neverScanned: false,
      ceilingDays,
      exceeded,
      message: exceeded
        ? `STALE: this lane last ACTUALLY SCANNED ${ageDays} day(s) ago (run ` +
          `'${lastScanned.runId}' at ${lastScanned.startedAt}, ${args.ageRuns} run(s) back), ` +
          `which is past the ${ceilingDays}-day ceiling. Every run since then reached Azure ` +
          `and established that nothing was running, so no graph was built, no detector ran ` +
          `and no finding state changed — the backlog is that many days old and the ` +
          `population comparison has had no new basis in all that time. This is RED because a ` +
          `lane that has not scanned in ${ageDays} days is not distinguishable, from its ` +
          `check alone, from one that CANNOT scan. Resume the estate for a validation window, ` +
          `or record a decision that this estate is not being scanned.`
        : ageDays === null
          ? `last actual scan: run '${lastScanned.runId}' — its startedAt ` +
            `('${lastScanned.startedAt}') could not be parsed, so the age in days was NOT ` +
            `established. The run age is ${args.ageRuns} run(s) back.`
          : `last actual scan: ${ageDays} day(s) ago (run '${lastScanned.runId}' at ` +
            `${lastScanned.startedAt}, ${args.ageRuns} run(s) back). Ceiling is ` +
            `${ceilingDays} days.`,
    };
  }

  if (lastAny === null) {
    // The genuine first run for this estate. Nothing is stale about it.
    return {
      lastScannedRunId: null,
      lastScannedAt: null,
      lastScannedAgeRuns: args.ageRuns,
      ageDays: null,
      neverScanned: true,
      ceilingDays,
      exceeded: false,
      message:
        'last actual scan: NEVER — and this is the FIRST run recorded for this estate, so ' +
        'there is nothing to be stale about yet. The next run that reaches a running estate ' +
        'establishes the baseline.',
    };
  }

  // The loudest case in deploy-integrity R3: the lane HAS been running and has
  // never once scanned. Measured from the oldest thing this run can see.
  const ageDays = daysBetween(lastAny.startedAt, args.at);
  const exceeded = ageDays !== null && ageDays > ceilingDays;
  return {
    lastScannedRunId: null,
    lastScannedAt: null,
    lastScannedAgeRuns: args.ageRuns,
    ageDays,
    neverScanned: true,
    ceilingDays,
    exceeded,
    message:
      `NEVER SCANNED: this lane has run before — the most recent was '${lastAny.runId}' at ` +
      `${lastAny.startedAt}, verdict ${lastAny.verdict} — and NOT ONE run for this estate has ` +
      `ever carried detector populations. So there is no baseline, no graph version history ` +
      `from this lane, and the population comparator (PRP §5) has never had a basis to ` +
      `compare against.` +
      (ageDays === null
        ? ` The age in days was NOT established: '${lastAny.startedAt}' could not be parsed.`
        : exceeded
          ? ` The most recent previous run was ${ageDays} day(s) ago, past the ` +
            `${ceilingDays}-day ceiling, so this is RED. "It has never actually scanned" is ` +
            `deploy-integrity R3's loudest case, not a silent pass.`
          : ` The most recent previous run was ${ageDays} day(s) ago, inside the ` +
            `${ceilingDays}-day ceiling, so this is reported and not yet red.`),
  };
}
