/**
 * LOOM BRAIN W10 — the THREE-VERDICT classifier (#3936).
 *
 * PURE. Takes what a probe established and returns OK / PAUSED / UNREACHABLE.
 * Every input is an ARM reading or an ARM failure; there is no parameter here a
 * config flag could set, which is the point — see `./model.ts`'s header.
 *
 * ── THE DECISION TABLE, AND WHY EACH ROW FAILS THE WAY IT DOES ─────────────
 *
 *   failures > 0                       -> UNREACHABLE   "could not reach"
 *   discovered === 0                   -> UNREACHABLE   REACHED, zero rows
 *   readings !== discovered, 0 failures -> THROW         population left silently
 *   running > 0                        -> OK
 *   running === 0, all definitively stopped -> PAUSED
 *   running === 0, any state not established -> UNREACHABLE  REACHED, indeterminate
 *
 * The last row is the one that is easy to get wrong and expensive when you do.
 * `EstatePowerState` has NINE members and only three of them
 * (`Paused`/`Stopped`/`Deallocated`) establish that a resource is stopped.
 * `Unknown`, `Pausing`, `Resuming`, `Starting` and `Scaling` establish nothing.
 * The tempting predicate is `!isRunningState(s)` — one call, reads fine, and it
 * quietly turns "I could not tell" into "it is paused", which renders a
 * mid-pause or half-broken estate as a clean neutral outcome and stops the run
 * from ever going red. So PAUSED requires `isPausedState` to hold for EVERY
 * reading, and anything else with nothing running fails closed.
 *
 * ── R7 IS ENFORCED HERE, NOT DOCUMENTED HERE ───────────────────────────────
 * Only the three REACH failures produce a message containing "could not reach".
 * `no-resources-observed` and `state-indeterminate` were REACHED, and their
 * messages say so explicitly and name what was actually observed. There is a
 * runtime assertion at the bottom of `classifyEstate` that re-checks this
 * correspondence before returning, because the failure mode is not writing the
 * wrong string once — it is a later edit that "helpfully" unifies all the red
 * messages under one phrase.
 */

import {
  isPausedState,
  isRunningState,
  type ArmPowerReading,
  type EstatePowerState,
} from '../../estate/pause-state';
import {
  InconsistentProbeError,
  isReachFailure,
  type ObservedResourceState,
  type PowerStateCounts,
  type ProbeFailure,
  type ProbeResult,
  type ScanVerdict,
  type UnreachableReason,
} from './model';

/** The exact phrase a reach failure must carry, and nothing else may. */
export const COULD_NOT_REACH = 'could not reach';

const ZERO_COUNTS: PowerStateCounts = {
  Online: 0,
  Paused: 0,
  Pausing: 0,
  Resuming: 0,
  Stopped: 0,
  Starting: 0,
  Deallocated: 0,
  Scaling: 0,
  Unknown: 0,
};

/** Tally readings by state. Every member is present, including the zeroes. */
export function countByState(readings: readonly ArmPowerReading[]): PowerStateCounts {
  const out: Record<EstatePowerState, number> = { ...ZERO_COUNTS };
  for (const r of readings) out[r.powerState] += 1;
  return out;
}

/** Flatten readings for display and for the persisted run record. */
export function observedStates(
  readings: readonly ArmPowerReading[],
): readonly ObservedResourceState[] {
  return readings.map((r) => ({
    resourceId: r.resourceId,
    powerState: r.powerState,
    armApiVersion: r.armApiVersion,
    readAt: r.readAt,
  }));
}

/**
 * Which reason a set of failures establishes.
 *
 * `auth` dominates, then `network`, then `arm-error`. The ordering matters for
 * the remediation the operator is handed: a 403 among timeouts is a permission
 * problem that will still be there when the network settles, and reporting it
 * as a network blip sends the investigation to the wrong place.
 */
export function reasonForFailures(failures: readonly ProbeFailure[]): UnreachableReason {
  if (failures.some((f) => f.classification === 'auth')) return 'auth-failed';
  if (failures.some((f) => f.classification === 'network')) return 'network-failed';
  return 'arm-error';
}

function renderFailure(f: ProbeFailure): string {
  const status = f.httpStatus === null ? 'no HTTP response' : `HTTP ${f.httpStatus}`;
  return `[${f.stage}] ${f.target}: ${f.classification}, ${status} — ${f.detail}`;
}

function describe(counts: PowerStateCounts): string {
  return (Object.entries(counts) as [EstatePowerState, number][])
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${s}=${n}`)
    .join(', ');
}

export interface ClassifyContext {
  readonly at: string;
  readonly cloud: string;
  readonly estateId: string;
}

/**
 * Form the run's verdict from what the probe established.
 *
 * Throws {@link InconsistentProbeError} when the probe lost a resource without
 * recording a failure — that is a defect in the probe, and absorbing it would
 * shrink the examined population invisibly.
 */
export function classifyEstate(probe: ProbeResult, ctx: ClassifyContext): ScanVerdict {
  const byState = countByState(probe.readings);
  const base = {
    at: ctx.at,
    cloud: ctx.cloud,
    estateId: ctx.estateId,
    scope: probe.scope,
    // S4 (#4014 review) — the retry count rides on EVERY verdict, not only the
    // red ones. A retried-then-succeeded run is the interesting case: it is the
    // only observable difference between a healthy estate and one that is
    // degrading toward the night the retries run out.
    ...(probe.retries === undefined ? {} : { retries: probe.retries }),
  } as const;

  // ── 1. a reach failure. RED, and the only branch that says "could not reach".
  if (probe.failures.length > 0) {
    const reason = reasonForFailures(probe.failures);
    const verdict: ScanVerdict = {
      ...base,
      kind: 'unreachable',
      reason,
      failures: probe.failures,
      readings: probe.readings,
      byState,
      message:
        `${COULD_NOT_REACH} Azure (${ctx.cloud}) to scan estate '${ctx.estateId}': ` +
        `${probe.failures.length} probe failure(s) over ${probe.scope}. ` +
        `NOTHING was scanned and NO finding state was changed — this run establishes ` +
        `nothing about the estate. Failures, verbatim: ${probe.failures
          .map(renderFailure)
          .join(' | ')}`,
    };
    return assertMessageMatchesReason(verdict);
  }

  // ── 2. the probe lost a resource without saying so.
  if (probe.readings.length !== probe.discovered) {
    throw new InconsistentProbeError(probe.discovered, probe.readings.length);
  }

  // ── 3. reached, and there is nothing in scope. RED, and it does NOT claim a
  //       reach failure: the query succeeded. What it cannot tell apart is "this
  //       estate has no Loom resources" from "this identity can see none of
  //       them", and saying so is the honest verdict.
  if (probe.discovered === 0) {
    const verdict: ScanVerdict = {
      ...base,
      kind: 'unreachable',
      reason: 'no-resources-observed',
      failures: [],
      readings: [],
      byState,
      message:
        `reached Azure (${ctx.cloud}) successfully and the discovery query returned ZERO ` +
        `in-scope resources for estate '${ctx.estateId}' over ${probe.scope}. This run is ` +
        'RED rather than clean because a verdict over an empty population establishes ' +
        'nothing: "the estate holds no Loom resources" and "this identity cannot see ' +
        'them" are indistinguishable from here. Remediation, most likely first: check the ' +
        'RESOURCE-GROUP scope (LOOM_BRAIN_RESOURCE_GROUPS) — it is the actual scoping ' +
        'mechanism and a wrong group name yields exactly this result; then the run ' +
        "identity's Reader assignment on the target subscription(s); then the subscription " +
        'scope (LOOM_BRAIN_SUBSCRIPTIONS) if it is set.',
    };
    return assertMessageMatchesReason(verdict);
  }

  const running = probe.readings.filter((r) => isRunningState(r.powerState)).length;
  const definitelyStopped = probe.readings.filter((r) => isPausedState(r.powerState)).length;
  const indeterminate = probe.readings.length - running - definitelyStopped;

  // ── 4. something is serving. Scan it.
  if (running > 0) {
    const verdict: ScanVerdict = {
      ...base,
      kind: 'ok',
      readings: probe.readings,
      running,
      notRunning: definitelyStopped,
      indeterminate,
      byState,
      message:
        `reached Azure (${ctx.cloud}); ${running} of ${probe.readings.length} in-scope ` +
        `resource(s) are Online over ${probe.scope}` +
        (definitelyStopped > 0 || indeterminate > 0
          ? `. NOTE: ${definitelyStopped} stopped and ${indeterminate} in a state that ` +
            'establishes neither — findings about those resources describe their WIRING, ' +
            'read from ARM, not their live traffic.'
          : '.') +
        ` States: ${describe(byState)}.`,
    };
    return assertMessageMatchesReason(verdict);
  }

  // ── 5. nothing running, and EVERY reading definitively stopped. NEUTRAL.
  if (definitelyStopped === probe.readings.length) {
    const verdict: ScanVerdict = {
      ...base,
      kind: 'paused',
      readings: probe.readings,
      byState,
      observed: observedStates(probe.readings),
      message:
        `reached Azure (${ctx.cloud}) and every one of the ${probe.readings.length} in-scope ` +
        `resource(s) for estate '${ctx.estateId}' is STOPPED — the estate is paused. ` +
        'Nothing was scanned, so this run is NOT green; nothing is broken, so it is NOT ' +
        `red. Observed states: ${describe(byState)}. Each reading came from a direct ARM ` +
        'GET (never Resource Graph, which is a replicated index and reports a paused ' +
        'Synapse pool Online for minutes afterwards). Resume the estate and re-dispatch ' +
        'this workflow to scan.',
    };
    return assertMessageMatchesReason(verdict);
  }

  // ── 6. nothing running, and at least one state was not established. RED.
  //       Fails closed rather than rendering a mid-transition estate as paused.
  const unclear = probe.readings
    .filter((r) => !isRunningState(r.powerState) && !isPausedState(r.powerState))
    .map((r) => `${r.resourceId} -> ${r.powerState}`);
  const verdict: ScanVerdict = {
    ...base,
    kind: 'unreachable',
    reason: 'state-indeterminate',
    failures: [],
    readings: probe.readings,
    byState,
    message:
      `reached Azure (${ctx.cloud}) and read all ${probe.readings.length} in-scope ` +
      `resource(s), but NOTHING is Online and ${indeterminate} resource(s) are in a state ` +
      'that establishes neither running nor stopped, so this run REFUSES to report the ' +
      'estate as paused. A transitional or Unknown state read as PAUSED would render a ' +
      'half-stopped or half-broken estate as a clean neutral outcome. Unresolved: ' +
      `${unclear.join(', ')}. All states: ${describe(byState)}.`,
  };
  return assertMessageMatchesReason(verdict);
}

/**
 * R7, enforced rather than described.
 *
 * A reach failure MUST say "could not reach"; anything that actually reached
 * Azure must NOT. Checked at runtime on the way out because the realistic
 * regression is not a typo — it is a later edit that unifies every red message
 * under one phrase for consistency, which would restore exactly the 2026-08-05
 * defect where "I could not reach the registry" was printed as "the tag does not
 * exist".
 *
 * EXPORTED so it can be tested DIRECTLY (review of #4014). Both branches
 * survived mutation because every test asserted the MESSAGES rather than the
 * assertion — so the defense that this file's header explicitly relies on had no
 * coverage of its own. `__tests__/verdict.test.ts` now constructs a mismatched
 * verdict in each direction and expects a throw.
 */
export function assertMessageMatchesReason(v: ScanVerdict): ScanVerdict {
  const says = v.message.includes(COULD_NOT_REACH);
  const mustSay = v.kind === 'unreachable' && isReachFailure(v.reason);
  if (mustSay && !says) {
    throw new Error(
      `verdict '${v.kind}/${v.reason}' is a REACH failure but its message does not contain ` +
        `'${COULD_NOT_REACH}'. #3936 requires a run that cannot reach Azure to say so in ` +
        `those words. Message was: ${v.message}`,
    );
  }
  if (!mustSay && says) {
    throw new Error(
      `verdict '${v.kind}${v.kind === 'unreachable' ? `/${v.reason}` : ''}' REACHED Azure but ` +
        `its message claims '${COULD_NOT_REACH}'. That is a cause the code did not ` +
        'establish (deploy-integrity.md R7). Message was: ' +
        v.message,
    );
  }
  return v;
}
