/**
 * ESTATE RESUME - the resume path split out of `./pause-orchestrator` (file-size ratchet).
 *
 * Holds `startResume` (dispatch, with the DB-before-consumer hold: a database's
 * consumers wait for it to read Online and are skipped when its start failed),
 * `pollResume` (two-stage confirmation, plus the release of held consumers),
 * `applyResumePoll`, and the pause-side `confirmConsumersStopped` read-back that
 * shares the consumer model. Behaviour-preserving move: everything is re-exported
 * from `./pause-orchestrator`, which stays the public surface.
 *
 * Only TYPES are imported from `./pause-orchestrator` (erased at compile time), so
 * there is no runtime cycle.
 */
import {
  assertTransition,
  confirmResume,
  deriveResumeState,
  isPausedState,
  isRunningState,
  type EstatePauseSnapshot,
  type PausedResourceSnapshot,
  type ResumeHold,
  type ResumeOutcome,
} from './pause-state';
import type { EstateActuator } from './pause-actuator';
import type { ResourceProgress } from './pause-orchestrator';
import { assertNoFalseGreen } from './capacity-preflight';
import { holdStateForThrottle, throttledDetail, throttleHoldReason } from './pause-throttle';
import { isConsumerType, isDbTierType } from './pause-guards';
import { TYPICAL_RESUME_SECONDS, orderForResume } from './pause-tier';

// ---------------------------------------------------------------------------
// Resume
// ---------------------------------------------------------------------------

export interface ResumeDispatch {
  resourceId: string;
  name: string;
  status: 'dispatched' | 'skipped' | 'failed';
  detail: string;
  error?: string;
}

export interface ResumeRunResult {
  snapshot: EstatePauseSnapshot;
  dispatches: ResumeDispatch[];
}

/**
 * TOTAL wait budget for read-backs in ONE pause request. Chosen at 20 s: the console's
 * routes time out at 30-60 s, and the pause request still has to dispatch every other
 * resource after this wait, so the read-back may only spend a bounded slice of it. The
 * budget is shared by every database in the request (a deadline, not a per-database
 * allowance), and consumers are confirmed concurrently, so N stuck consumers cost one
 * wait, not N.
 */
export const CONSUMER_DRAIN_BUDGET_MS = 20_000;

/**
 * Read each dispatched consumer's power state back (ARM, authoritative) until it
 * is stopped (paused state, or zero replicas), within a bounded number of reads AND
 * the shared `deadlineAt`. Consumers are confirmed concurrently. Anything that cannot
 * be confirmed fails closed with the reason.
 */
export async function confirmConsumersStopped(
  consumers: readonly string[],
  actions: ReadonlyArray<{ resourceId: string; name: string; resourceType: string; status: string }>,
  actuator: Pick<EstateActuator, 'readPower'>,
  drain?: { attempts?: number; delayMs?: number; budgetMs?: number },
  deadlineAt?: number,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const attempts = Math.max(1, drain?.attempts ?? 6);
  const delayMs = Math.max(0, drain?.delayMs ?? 3000);
  const deadline = deadlineAt ?? Date.now() + Math.max(0, drain?.budgetMs ?? CONSUMER_DRAIN_BUDGET_MS);
  const targets = consumers
    .map((name) =>
      actions.find((a) => isConsumerType(a.resourceType) && a.name.trim().toLowerCase() === name.trim().toLowerCase()),
    )
    // Not dispatched in this run (already-paused was read as stopped; anything else
    // was already refused by dbActGuard) -> nothing to wait for.
    .filter((a): a is NonNullable<typeof a> => !!a && a.status === 'dispatched');

  const confirmOne = async (done: (typeof targets)[number]): Promise<string | null> => {
    let last = 'no reading';
    let reads = 0;
    for (let i = 0; i < attempts; i += 1) {
      if (i > 0) {
        // Never sleep past the shared deadline: out of budget is a fail-closed answer, not a longer wait.
        if (Date.now() + delayMs > deadline) {
          return `its consumer ${done.name} was asked to stop but could not be confirmed stopped within the ${Math.round(
            (drain?.budgetMs ?? CONSUMER_DRAIN_BUDGET_MS) / 1000,
          )} s read-back budget after ${reads} read(s) (${last}).`;
        }
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      }
      reads += 1;
      try {
        const power = await actuator.readPower(done);
        if (!power.reading) {
          last = power.error ?? 'the power read established nothing';
        } else if (isPausedState(power.reading.powerState) || power.replicaCount === 0) {
          return null;
        } else {
          last = `still ${power.reading.powerState}${typeof power.replicaCount === 'number' ? ` with ${power.replicaCount} replica(s)` : ''}`;
        }
      } catch (e) {
        last = e instanceof Error ? e.message : String(e);
      }
    }
    return `its consumer ${done.name} was asked to stop but could not be confirmed stopped after ${attempts} read(s) (${last}).`;
  };

  const failures = (await Promise.all(targets.map(confirmOne))).filter((r): r is string => r !== null);
  return failures.length === 0 ? { ok: true } : { ok: false, reason: failures[0] };
}

/**
 * Dispatch the resume. Moves the estate to `RESUMING` and NOTHING further.
 *
 * `RUNNING` is never reachable from here — it is only ever produced by
 * `pollResume`, from confirmed ARM reads plus a servability probe. A resume is
 * a ~15-minute operation, so the request that starts it cannot possibly know
 * how it ended, and a function that returned RUNNING at dispatch time would be
 * asserting something it did not establish.
 */
export async function startResume(
  snapshot: EstatePauseSnapshot,
  actuator: EstateActuator,
  ctx?: { now?: string },
): Promise<ResumeRunResult> {
  assertTransition(snapshot.state, 'RESUMING');
  const now = ctx?.now ?? new Date().toISOString();
  const next: EstatePauseSnapshot = {
    ...snapshot,
    state: 'RESUMING',
    resumeStartedAt: now,
    updatedAt: now,
    resumeOutcomes: [],
    resumeHeld: [],
  };

  const dispatches: ResumeDispatch[] = [];
  const held: ResumeHold[] = [];
  for (const entry of orderForResume(snapshot.resources)) {
    // Restore TO the pre-pause state. Something that was already stopped when
    // Loom found it stays stopped — resuming it would be Loom starting a
    // resource nobody asked it to start.
    if (!isRunningState(entry.prePausePowerState)) {
      dispatches.push({
        resourceId: entry.resourceId,
        name: entry.name,
        status: 'skipped',
        detail:
          `${entry.name} was ${entry.prePausePowerState} before the pause, so it is left as it is. `
          + 'Resume restores the estate to what it was, not to what it could be.',
      });
      continue;
    }
    // R-SCOPE-3, the RESUME half. `startPause` calls `reverifyBeforeAct`; this
    // side deliberately does NOT re-read live tags, because resume is the
    // RECOVERY direction — a tag removed or rewritten while the estate was down
    // would then strand a paused resource permanently, which is a worse failure
    // than the one the check prevents.
    //
    // What it asserts instead is the snapshot's OWN recorded verdict.
    // `capturePrePauseState` refuses to write an entry that is not 'loom-owned'
    // (pause-state.ts), so every legitimately written entry satisfies this and
    // nothing recoverable is ever refused. What it stops is an entry that never
    // came from a gated pause at all — a hand-edited or tampered Cosmos document
    // driving `actuator.resume` at a resource Loom does not own. Before this,
    // resume was guarded only by the STRUCTURAL `assertActuationTarget`, which
    // checks that an id is well-formed and self-consistent, not that it is ours.
    if (entry.ownership?.verdict !== 'loom-owned') {
      dispatches.push({
        resourceId: entry.resourceId,
        name: entry.name,
        status: 'skipped',
        detail:
          `${entry.name} is recorded in this snapshot with ownership verdict `
          + `'${entry.ownership?.verdict ?? 'none'}', not 'loom-owned', so it was NOT resumed. A `
          + 'snapshot entry that did not come from a gated pause is not evidence that Loom may act '
          + 'on this resource.',
        error: `not-loom-owned:${entry.ownership?.verdict ?? 'none'}`,
      });
      continue;
    }

    // #5099 phase C: a database's consumers start only against a database that
    // STARTED. Databases dispatch first (rank 1 < 2), so their verdicts are known here.
    if (isConsumerType(entry.resourceType)) {
      const gate = consumerResumeGate(entry, snapshot.resources, dispatches);
      if (gate.kind === 'db-failed') {
        dispatches.push({
          resourceId: entry.resourceId,
          name: entry.name,
          status: 'skipped',
          detail:
            `${entry.name} was NOT started: database not started (the start request for ${gate.db.name} failed), `
            + 'so the app would come up against a database that is not there. Retry the resume once the database is fixed.',
          error: `database-not-started:${gate.db.name}`,
        });
        continue;
      }
      if (gate.kind === 'db-pending') {
        held.push({ resourceId: entry.resourceId, name: entry.name, dbResourceId: gate.db.resourceId, dbName: gate.db.name });
        dispatches.push({
          resourceId: entry.resourceId,
          name: entry.name,
          status: 'skipped',
          detail:
            `${entry.name} is held until ${gate.db.name} reads Online; the state poll starts it then. `
            + 'It is not reported running until a real request to it succeeds.',
        });
        continue;
      }
    }

    const result = await actuator.resume(entry);
    dispatches.push({
      resourceId: entry.resourceId,
      name: entry.name,
      status: result.ok ? 'dispatched' : 'failed',
      detail: result.detail,
      ...(result.error ? { error: result.error } : {}),
    });
  }

  next.resumeHeld = held;
  return { snapshot: next, dispatches };
}

/**
 * The database (in this snapshot, started by this resume run) that `entry` waits
 * for, judged against what the run did to it so far.
 */
function consumerResumeGate(
  entry: PausedResourceSnapshot,
  all: readonly PausedResourceSnapshot[],
  dispatches: readonly ResumeDispatch[],
):
  | { kind: 'free' }
  | { kind: 'db-failed'; db: PausedResourceSnapshot }
  | { kind: 'db-pending'; db: PausedResourceSnapshot } {
  const me = entry.name.trim().toLowerCase();
  let pending: PausedResourceSnapshot | undefined;
  for (const db of all) {
    if (!isDbTierType(db.resourceType) || !db.consumers?.includes(me)) continue;
    const d = dispatches.find((x) => x.resourceId === db.resourceId);
    if (!d) continue;
    if (d.status === 'failed') return { kind: 'db-failed', db };
    if (d.status === 'dispatched') pending = pending ?? db;
  }
  return pending ? { kind: 'db-pending', db: pending } : { kind: 'free' };
}

export interface ResumePollResult {
  state: 'RESUMING' | 'RUNNING' | 'RESUME_FAILED';
  outcomes: ResumeOutcome[];
  progress: ResourceProgress[];
  unconfirmed: ResumeOutcome[];
  reason: string;
  /** True once every resource has settled one way or the other. */
  terminal: boolean;
  /** How many resources' reads/probes were throttled (429) in this poll. */
  throttled: number;
  /** Held consumers still waiting for their database (persist this over the snapshot's list). */
  resumeHeld?: ResumeHold[];
}

/**
 * Confirm a resume from authoritative ARM reads PLUS a real data-plane probe.
 *
 * The two-stage confirmation is the correctness core of this file:
 *
 *   stage 1  `confirmResume(entry, reading)`  — did ARM say it is Online?
 *   stage 2  `actuator.probeServable(entry)`  — can it actually serve a request?
 *
 * stage 2 exists because stage 1 is documented by Microsoft to LIE for 2-3
 * minutes on a Synapse dedicated pool: the ARM status flips to `ONLINE` before
 * the pool accepts a query. A resource that ARM reports Online but that fails
 * its probe is downgraded to `unknown` — not to `confirmed-mismatch`, because
 * "it is still warming up" and "it is broken" are different claims and we only
 * established the first.
 *
 * `deriveResumeState` then does the arithmetic, and it treats `unknown` as
 * failure. So an unprobeable or unfinished resume yields RESUME_FAILED, never
 * RUNNING (R-CAP-4).
 *
 * `settleAfterMs` exists so a poll taken 30 seconds into a 10-minute ADX start
 * reads `RESUMING` (still working) rather than `RESUME_FAILED` (gave up). It
 * bounds patience; it never converts an unconfirmed resource into a confirmed
 * one, which is why `unconfirmed` is reported identically in both branches.
 */
export async function pollResume(
  snapshot: EstatePauseSnapshot,
  actuator: EstateActuator,
  opts?: { now?: string; settleAfterMs?: number },
): Promise<ResumePollResult> {
  const outcomes: ResumeOutcome[] = [];
  const progress: ResourceProgress[] = [];
  const throttledIds = new Set<string>();

  // #5099 phase C: release consumers held for a database that now reads Online.
  const stillHeld: ResumeHold[] = [];
  for (const hold of snapshot.resumeHeld ?? []) {
    const entry = snapshot.resources.find((r) => r.resourceId === hold.resourceId);
    const db = snapshot.resources.find((r) => r.resourceId === hold.dbResourceId);
    if (!entry || !db) continue;
    const dbPower = await actuator.readPower(db);
    if (dbPower.throttled) throttledIds.add(db.resourceId);
    if (dbPower.reading && isRunningState(dbPower.reading.powerState)) {
      const r = await actuator.resume(entry);
      if (r.ok) continue;
    }
    stillHeld.push(hold);
  }

  for (const entry of snapshot.resources) {
    const power = await actuator.readPower(entry);
    let outcome = confirmResume(entry, power.reading, power.error);
    if (power.throttled) {
      throttledIds.add(entry.resourceId);
      outcome = { ...outcome, reason: throttledDetail(entry.name, power.error, 'it is running') };
    }
    const observed = power.reading?.powerState ?? 'Unknown';

    // Where this resource is SUPPOSED to end up. Resume restores the estate to
    // what it WAS, so something already stopped before the pause is expected to
    // be stopped now.
    const expectation: 'running' | 'stopped' = isRunningState(entry.prePausePowerState)
      ? 'running'
      : 'stopped';

    let servable: boolean | undefined;
    let probed: boolean | undefined;

    // Probe ONLY the resources that are supposed to be up, and gate the probe on
    // the OBSERVED ARM state rather than on any `ResumeConfirmation` string. The
    // success set has TWO members (`confirmed-running` and
    // `confirmed-restored-paused`), so a hand-rolled comparison is wrong in one
    // direction or the other; `isResumeSuccess()` is the only sanctioned reader
    // of the verdict, and the observed state is what tells us whether to probe.
    if (expectation === 'running' && isRunningState(observed)) {
      const probe = await actuator.probeServable(entry);
      servable = probe.servable;
      probed = probe.probed;
      if (!probe.servable) {
        if (probe.throttled) throttledIds.add(entry.resourceId);
        outcome = {
          resourceId: entry.resourceId,
          confirmation: 'unknown',
          observedState: observed,
          reason:
            `ARM reports ${entry.name} is ${observed}, but `
            + (probe.probed
              ? 'a real request to it did not succeed: '
              : 'service readiness verification did not complete: ')
            + `${probe.detail} A resumed Synapse pool reports ONLINE 2-3 minutes before it can serve, `
            + 'so the status field alone does not establish that this resource is usable.',
        };
      }
    }

    // `atExpectedState` is computed from the OBSERVED power state, never from a
    // confirmation string, and a resource that is supposed to be up is only "at
    // its expected state" once a real request to it has succeeded.
    const atExpectedState =
      expectation === 'running'
        ? isRunningState(observed) && servable === true
        : isPausedState(observed);

    outcomes.push(outcome);
    progress.push({
      resourceId: entry.resourceId,
      name: entry.name,
      resourceType: entry.resourceType,
      powerState: observed,
      expectation,
      atExpectedState,
      phase: atExpectedState ? 'done' : observed === 'Unknown' ? 'unknown' : 'in-flight',
      detail: outcome.reason,
      ...(servable === undefined ? {} : { servable }),
      ...(probed === undefined ? {} : { probed }),
      typicalResumeSeconds: TYPICAL_RESUME_SECONDS[entry.resourceType.toLowerCase()],
    });
  }

  const verdict = deriveResumeState(snapshot, outcomes);
  const throttled = throttledIds.size;

  // A verdict manufactured by throttling alone is HELD, never settled (./pause-throttle).
  const held = holdStateForThrottle(verdict, throttledIds, snapshot.state);
  if (held) {
    const reason = throttleHoldReason(throttled, snapshot.resources.length);
    return { state: held, outcomes, progress, unconfirmed: verdict.unconfirmed, terminal: false, reason, throttled, resumeHeld: stillHeld };
  }

  // Still inside the published resume window: report RESUMING rather than a
  // premature failure. This can only DELAY a verdict, never manufacture a
  // successful one — `verdict.state === 'RUNNING'` short-circuits above it.
  const startedAt = snapshot.resumeStartedAt ? Date.parse(snapshot.resumeStartedAt) : NaN;
  const nowMs = Date.parse(opts?.now ?? new Date().toISOString());
  const settleAfterMs = opts?.settleAfterMs ?? defaultSettleMs(snapshot);
  const stillSettling =
    Number.isFinite(startedAt) && Number.isFinite(nowMs) && nowMs - startedAt < settleAfterMs;

  if (verdict.state === 'RESUME_FAILED' && stillSettling) {
    return {
      state: 'RESUMING',
      outcomes,
      progress,
      unconfirmed: verdict.unconfirmed,
      terminal: false,
      reason:
        `${verdict.unconfirmed.length} of ${snapshot.resources.length} resource(s) are not yet `
        + `confirmed servable, and the resume started ${Math.round((nowMs - startedAt) / 1000)}s ago `
        + `(typical window ${Math.round(settleAfterMs / 1000)}s). Still RESUMING — this is not a `
        + 'success claim, it is a statement that the window has not elapsed.',
      throttled,
      resumeHeld: stillHeld,
    };
  }

  return {
    state: verdict.state,
    outcomes,
    progress,
    unconfirmed: verdict.unconfirmed,
    terminal: true,
    reason: verdict.reason,
    throttled,
    resumeHeld: stillHeld,
  };
}

/** The longest typical resume in the snapshot, plus 50% headroom, min 60s. */
function defaultSettleMs(snapshot: Pick<EstatePauseSnapshot, 'resources'>): number {
  const longest = snapshot.resources.reduce((max, r) => {
    const s = TYPICAL_RESUME_SECONDS[r.resourceType.toLowerCase()] ?? 0;
    return s > max ? s : max;
  }, 0);
  return Math.max(60_000, Math.round(longest * 1.5) * 1000);
}

/**
 * Fold a poll result back into the snapshot document for persistence.
 *
 * TWO independent gates run here, deliberately:
 *
 *   `assertNoFalseGreen` — the outcome-level check. A RUNNING write must be
 *       backed by a `confirmed-running` outcome for EVERY snapshot resource,
 *       including the zero-outcomes case that `[].every()` would wave through.
 *   `assertTransition`   — the state-machine check.
 *
 * The first is load-bearing on its own because `LEGAL_TRANSITIONS` permits
 * `RESUMING -> RUNNING` and `PAUSING -> RUNNING` DIRECTLY: the transition table
 * does not itself require confirmation, so `assertTransition` alone would let a
 * caller write RUNNING over an unconfirmed resume. Never call it alone on this
 * path — route through `deriveResumeState` (which `pollResume` does) and then
 * through this function.
 */
export function applyResumePoll(
  snapshot: EstatePauseSnapshot,
  poll: ResumePollResult,
  now = new Date().toISOString(),
): EstatePauseSnapshot {
  assertNoFalseGreen(poll.state, poll.outcomes, snapshot.resources.length);
  if (snapshot.state !== poll.state) assertTransition(snapshot.state, poll.state);
  return {
    ...snapshot,
    state: poll.state,
    updatedAt: now,
    resumeOutcomes: poll.outcomes,
    ...(poll.resumeHeld ? { resumeHeld: poll.resumeHeld } : {}),
    ...(poll.state === 'RUNNING' ? { resumeConfirmedAt: now } : {}),
  };
}

/**
 * True when a poll's held-consumer list differs from the stored one. The handler
 * persists on this independently of the state transition: RESUMING -> RESUMING is
 * not a transition (`resolveReadVerdict` says persist:false), so without this a
 * released hold stayed stored and every later poll re-read the database and
 * re-sent the consumer's start.
 */
export function resumeHoldsChanged(
  snapshot: Pick<EstatePauseSnapshot, 'resumeHeld'>,
  poll: Pick<ResumePollResult, 'resumeHeld'>,
): boolean {
  if (!poll.resumeHeld) return false;
  const ids = (l: readonly ResumeHold[] | undefined) => (l ?? []).map((h) => h.resourceId).sort().join('|');
  return ids(snapshot.resumeHeld) !== ids(poll.resumeHeld);
}
