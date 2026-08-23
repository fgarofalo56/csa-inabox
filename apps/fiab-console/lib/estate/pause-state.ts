/**
 * ESTATE PAUSE/RESUME — the state model and the persisted pause snapshot.
 *
 * This module is PURE + side-effect-free (no React, no Azure SDK, no fetch).
 * It owns three things and nothing else:
 *
 *   1. the estate-level state machine (RUNNING / PAUSING / PAUSED / RESUMING /
 *      RESUME_FAILED) and its LEGAL transitions;
 *   2. the snapshot document persisted at pause time, so resume can restore the
 *      estate to exactly what it was — including a DECLARED fallback SKU for the
 *      capacity-constrained types (R-CAP-1);
 *   3. the `ArmPowerReading` brand, which is how "power state came from
 *      authoritative ARM, never from Resource Graph" is enforced by the TYPE
 *      SYSTEM rather than by a comment.
 *
 * The inventory/scope half lives in `./pause-inventory`, which imports FROM this
 * module. The dependency runs one way only (inventory → state), so the persisted
 * document shape has no dependency on the discovery mechanism.
 *
 * ── RESUME_FAILED IS NOT OPTIONAL (R-CAP-4) ────────────────────────────────
 * If a resume cannot be CONFIRMED, the state is RESUME_FAILED. It does not
 * collapse into RUNNING, and there is no transition from RESUME_FAILED directly
 * to RUNNING — the only way out is another RESUMING attempt that confirms every
 * resource. An unknown reported as a success is precisely the failure class this
 * repo keeps re-learning (#3676, #3798, and the recency-vs-serving family): the
 * reconciler believes the estate is up, the operator believes the estate is up,
 * and the thing that is actually down stays down silently.
 *
 * ── POWER STATE COMES FROM ARM, NEVER FROM RESOURCE GRAPH ──────────────────
 * MEASURED 2026-08-22: the activity log recorded
 *   Microsoft.Synapse/workspaces/sqlPools/pause/action -> Succeeded @ 20:22:14
 * while Azure Resource Graph continued to report that same pool `Online`
 * afterwards. Resource Graph is a REPLICATED INDEX; its recency is not a
 * guarantee, and "what is indexed" is not "what is serving".
 *
 * Resource Graph is fine for DISCOVERY (what exists). It is WRONG for STATE
 * (what is running). A reconciler that reads state from Resource Graph fights
 * itself: it pauses a pool, re-reads `Online`, and pauses it again — or it
 * resumes a pool, re-reads `Paused`, and declares RESUME_FAILED on a healthy
 * estate. So `ArmPowerReading` is a branded type whose ONLY constructor is
 * `armPowerReading()`, which requires an ARM api-version and an ARM-shaped
 * response. Nothing in `./pause-inventory` can produce one: the discovery type
 * there declares `powerState?: never`.
 */

// ---------------------------------------------------------------------------
// The estate state machine
// ---------------------------------------------------------------------------

/**
 * The five estate states. There is no sixth, and none of these is a synonym for
 * another — in particular RESUME_FAILED is a distinct terminal-until-retried
 * state, NOT a flavour of RUNNING.
 */
export type EstatePauseState =
  /** Everything in the Loom inventory is running (or was never paused). */
  | 'RUNNING'
  /** A pause is in flight, or completed only partially. */
  | 'PAUSING'
  /** Every in-scope resource was CONFIRMED stopped, and a snapshot exists. */
  | 'PAUSED'
  /** A resume is in flight. */
  | 'RESUMING'
  /** A resume finished WITHOUT confirming every resource. R-CAP-4. */
  | 'RESUME_FAILED';

export const ESTATE_PAUSE_STATES: readonly EstatePauseState[] = [
  'RUNNING',
  'PAUSING',
  'PAUSED',
  'RESUMING',
  'RESUME_FAILED',
] as const;

/**
 * The legal transitions, as data so they can be asserted rather than reviewed.
 *
 * Read the two load-bearing entries carefully:
 *
 *   RESUMING      -> RUNNING | RESUME_FAILED
 *       A resume lands in RUNNING only when EVERY resource was confirmed
 *       running. `deriveResumeState` is the only sanctioned way to pick between
 *       these two, and it treats `unknown` as failure.
 *
 *   RESUME_FAILED -> RESUMING
 *       and NOTHING else. You cannot "clear" a failed resume by declaring the
 *       estate healthy; you re-attempt it and confirm.
 *
 * PAUSING keeps a self-transition because a partial pause is still PAUSING —
 * claiming PAUSED with resources still burning is a false claim about the
 * estate. PAUSING -> RESUMING exists because resume is the SAFE direction: an
 * operator must always be able to abort a pause by bringing things back up.
 */
const LEGAL_TRANSITIONS: Readonly<Record<EstatePauseState, readonly EstatePauseState[]>> = {
  RUNNING: ['PAUSING'],
  PAUSING: ['PAUSING', 'PAUSED', 'RESUMING', 'RUNNING'],
  PAUSED: ['RESUMING'],
  RESUMING: ['RUNNING', 'RESUME_FAILED'],
  RESUME_FAILED: ['RESUMING'],
};

/** True iff `from -> to` is a legal estate transition. */
export function canTransition(from: EstatePauseState, to: EstatePauseState): boolean {
  return (LEGAL_TRANSITIONS[from] ?? []).includes(to);
}

/** The states reachable from `from`, for a UI that offers only real actions. */
export function allowedTransitions(from: EstatePauseState): readonly EstatePauseState[] {
  return LEGAL_TRANSITIONS[from] ?? [];
}

/**
 * Throw on an illegal transition. Callers that persist a state change go through
 * this so an out-of-band write cannot silently launder RESUME_FAILED into
 * RUNNING (deploy-integrity.md R7 — the message states what was actually
 * established, not a guess at why).
 */
export function assertTransition(from: EstatePauseState, to: EstatePauseState): void {
  if (!canTransition(from, to)) {
    throw new Error(
      `Illegal estate transition ${from} -> ${to}. Legal from ${from}: `
        + `${(LEGAL_TRANSITIONS[from] ?? []).join(', ') || '(none)'}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Power state — the tri-state, and the ARM-only brand
// ---------------------------------------------------------------------------

/**
 * Power state as ARM reports it, normalised across the pausable types.
 *
 * `Unknown` is a first-class member, not a fallback for convenience. Every read
 * that could not establish the state MUST land here, because the whole model
 * depends on `Unknown != Online`.
 */
export type EstatePowerState =
  | 'Online'
  | 'Paused'
  | 'Pausing'
  | 'Resuming'
  | 'Stopped'
  | 'Starting'
  | 'Deallocated'
  | 'Scaling'
  | 'Unknown';

/** Runtime companion to `EstatePowerState`, for validating persisted documents. */
export const ESTATE_POWER_STATES: readonly EstatePowerState[] = [
  'Online',
  'Paused',
  'Pausing',
  'Resuming',
  'Stopped',
  'Starting',
  'Deallocated',
  'Scaling',
  'Unknown',
] as const;

/**
 * Brand marker — TYPE-ONLY (`declare const`), so it has no runtime existence and
 * is never emitted into the object. That is deliberate on both counts:
 *
 *   • no module outside this file can name the symbol, so no object literal
 *     anywhere else can satisfy `ArmPowerReading`; and
 *   • the persisted document stays plain JSON — a phantom key would have to be
 *     serialized, which would let a hand-written JSON blob forge the brand.
 *
 * The first version of this file used `[ARM_AUTHORITATIVE]: true` as a real
 * computed key in the returned literal, which threw `ReferenceError:
 * ARM_AUTHORITATIVE is not defined` at runtime — caught by
 * `__tests__/pause-state.test.ts` on its first run.
 */
declare const ARM_AUTHORITATIVE: unique symbol;

/**
 * A power-state reading from the AUTHORITATIVE ARM control plane.
 *
 * The brand is the enforcement. `capturePrePauseState` and `confirmResume`
 * accept ONLY this type, and `./pause-inventory`'s `DiscoveredResource` — the
 * Resource Graph shape — declares `powerState?: never`, so there is no
 * expression anywhere that turns a discovery row into one of these.
 */
export interface ArmPowerReading {
  /**
   * REQUIRED phantom brand. Required so an object literal written elsewhere is
   * NOT structurally assignable to `ArmPowerReading`; type-only so it is never
   * emitted or serialized. `armPowerReading()` is the sole constructor and casts
   * through `unknown` because the runtime object legitimately lacks this key.
   */
  readonly [ARM_AUTHORITATIVE]: true;
  readonly resourceId: string;
  readonly powerState: EstatePowerState;
  /** ISO-8601 instant the ARM GET returned. */
  readonly readAt: string;
  /** The ARM api-version used. Recorded so a stale reader is visible in the doc. */
  readonly armApiVersion: string;
}

/**
 * The ONLY constructor for an `ArmPowerReading`. Call it with the outcome of a
 * direct ARM GET on the resource (`GET {arm}/{resourceId}?api-version=...`).
 *
 * Passing a Resource Graph row here is not possible by accident: a
 * `DiscoveredResource` has no power-state field to hand over, so a caller who
 * wants a reading has to go and do the ARM GET.
 */
export function armPowerReading(args: {
  resourceId: string;
  powerState: EstatePowerState;
  armApiVersion: string;
  readAt?: string;
}): ArmPowerReading {
  if (!args.resourceId) throw new Error('armPowerReading requires a resourceId.');
  if (!args.armApiVersion) {
    throw new Error(
      `armPowerReading requires the ARM api-version used for ${args.resourceId}; `
        + 'a reading with no api-version cannot be shown to have come from ARM.',
    );
  }
  return {
    resourceId: args.resourceId,
    powerState: args.powerState,
    readAt: args.readAt ?? new Date().toISOString(),
    armApiVersion: args.armApiVersion,
  } as unknown as ArmPowerReading;
}

/** True iff this reading establishes the resource is actually serving. */
export function isRunningState(s: EstatePowerState): boolean {
  return s === 'Online';
}

// ---------------------------------------------------------------------------
// Build-checked type assertion for the brand.
//
// In a SOURCE file deliberately: `next.config` typechecks with
// `tsconfig.build.json`, which excludes `**/__tests__/**`, so the equivalent
// `@ts-expect-error` in the test file is NOT enforced by the build gate. This
// one is. Zero runtime cost.
// ---------------------------------------------------------------------------

/** Fails to compile unless `T` is exactly `true`. */
type Assert<T extends true> = T;

/** The shape a caller could hand-write, with no access to the brand symbol. */
type UnbrandedReading = {
  resourceId: string;
  powerState: EstatePowerState;
  readAt: string;
  armApiVersion: string;
};

/**
 * PRP §3c — the brand must stay REQUIRED. If it is made optional or removed,
 * `UnbrandedReading` becomes assignable to `ArmPowerReading`, the conditional
 * flips to `false`, and `next build` fails HERE — so a Resource Graph row could
 * never be laundered into an "authoritative" reading by weakening this type.
 */
type _BrandIsRequired = Assert<UnbrandedReading extends ArmPowerReading ? false : true>;

/** Keep the alias referenced so it cannot be pruned as dead code. */
export type EstatePauseStateTypeInvariants = [_BrandIsRequired];
/** True iff this reading establishes the resource is actually stopped. */
export function isPausedState(s: EstatePowerState): boolean {
  return s === 'Paused' || s === 'Stopped' || s === 'Deallocated';
}

// ---------------------------------------------------------------------------
// Ownership evidence (shared with ./pause-inventory, defined here because it is
// part of the PERSISTED document — the snapshot records WHY each resource was
// judged Loom's, so the decision is inspectable after the fact rather than
// re-derived from a scope rule that may since have changed).
// ---------------------------------------------------------------------------

/**
 * Three-valued, deliberately. `indeterminate` exists so a FAILED tag lookup is
 * distinguishable from a SUCCESSFUL lookup that found no Loom tag. Both are
 * non-pausable, but only one of them is an error worth surfacing.
 */
export type OwnershipVerdict = 'loom-owned' | 'not-loom-owned' | 'indeterminate';

export interface LoomOwnershipEvidence {
  verdict: OwnershipVerdict;
  /** Where the verdict came from. `none` accompanies not-loom-owned/indeterminate. */
  source: 'ownership-tag' | 'deploy-manifest' | 'none';
  /** The tag key that decided it — surfaced per-resource in the dry-run (R-SCOPE-4). */
  tagKey?: string;
  /** The tag value that decided it. */
  tagValue?: string;
  /** Plain-English reason. Must state what was ESTABLISHED, never a guess. */
  reason: string;
}

// ---------------------------------------------------------------------------
// The persisted snapshot document
// ---------------------------------------------------------------------------

/**
 * Schema version for `EstatePauseSnapshot`.
 *
 * Bump on ANY change to the persisted shape and extend `deserializePauseSnapshot`
 * with the migration. A snapshot is the ONLY record of what the estate looked
 * like before it was torn down to zero — silently mis-reading an old one is how
 * a resume restores the wrong SKU.
 */
export const ESTATE_PAUSE_SNAPSHOT_SCHEMA_VERSION = 1;

/** A SKU/capacity descriptor, as ARM expresses it. */
export interface EstateSkuSnapshot {
  name?: string;
  tier?: string;
  family?: string;
  /** DWU for a Synapse pool, node count for a Kusto cluster, replicas for ACA. */
  capacity?: number;
}

/**
 * R-CAP-1 — a DECLARED fallback SKU for the capacity-constrained types.
 *
 * Resume is not symmetric with pause: releasing capacity always works, but
 * re-acquiring it can fail with a capacity/quota error in the region. When that
 * happens the choice must have been made in advance and recorded IN THE
 * SNAPSHOT, so resume degrades to a smaller-but-running estate deterministically
 * rather than a human improvising a SKU under pressure.
 */
export interface EstateFallbackSku extends EstateSkuSnapshot {
  /** Why this fallback, in the words shown to the operator when it is used. */
  reason: string;
}

/** One resource's pre-pause condition. Everything resume needs to restore it. */
export interface PausedResourceSnapshot {
  /** Full ARM resource id. */
  resourceId: string;
  /** Full ARM type, lower-cased, e.g. 'microsoft.synapse/workspaces/sqlpools'. */
  resourceType: string;
  name: string;
  resourceGroup: string;
  subscriptionId: string;
  location?: string;

  /**
   * The power state the resource was in IMMEDIATELY BEFORE the pause, read from
   * authoritative ARM. Resume restores TO this — a resource that was already
   * `Paused` before Loom touched it is not started by a resume.
   */
  prePausePowerState: EstatePowerState;
  /** Always 'arm'. Present so a doc read years later shows the provenance. */
  powerStateSource: 'arm';
  /** ISO-8601 instant of the ARM read. */
  powerStateReadAt: string;
  /** The ARM api-version the reading used. */
  powerStateApiVersion: string;

  /** SKU/capacity at pause time. Resume restores this first. */
  sku?: EstateSkuSnapshot;
  /** Replica/instance/node count at pause time (ACA replicas, VMSS capacity). */
  replicaCount?: number;
  /** R-CAP-1 — used only when the original SKU is unavailable on resume. */
  fallbackSku?: EstateFallbackSku;

  /** R-SCOPE-3/4 — why this resource was judged Loom's, recorded at capture. */
  ownership: LoomOwnershipEvidence;
}

/**
 * The snapshot document persisted at pause time.
 *
 * Shape follows the `AppInstallJob` convention in `lib/azure/cosmos-client.ts`:
 * a UUID `id`, `tenantId` as the partition key so every read of one estate's
 * snapshots is a single-partition query, a coarse `status`/state, ISO
 * `createdAt`/`updatedAt`, and `createdBy` for the audit trail. `schemaVersion`
 * is additional to that pattern and is mandatory here.
 */
export interface EstatePauseSnapshot {
  /** snapshotId (UUID). */
  id: string;
  /** Partition key — the caller's oid, matching AppInstallJob. */
  tenantId: string;
  /** Persisted schema version. See ESTATE_PAUSE_SNAPSHOT_SCHEMA_VERSION. */
  schemaVersion: number;

  /**
   * The estate this snapshot belongs to. A subscription can host more than one
   * Loom estate (and a great deal that is not Loom at all), so a snapshot is
   * scoped by estate id, never by subscription.
   */
  estateId: string;
  /** Estate state at the time this document was last written. */
  state: EstatePauseState;

  /** Every resource that was in scope, with its pre-pause condition. */
  resources: PausedResourceSnapshot[];

  createdAt: string;
  updatedAt: string;
  createdBy?: string;

  /** Set when the estate entered PAUSED (every resource confirmed stopped). */
  pausedAt?: string;
  /** Set when a resume was last attempted. */
  resumeStartedAt?: string;
  /** Set when a resume CONFIRMED every resource running. */
  resumeConfirmedAt?: string;
  /**
   * Per-resource outcomes of the last resume attempt. Populated on both the
   * success and the RESUME_FAILED path — the failing path is the one that
   * matters, and it must name which resources are unconfirmed.
   */
  resumeOutcomes?: ResumeOutcome[];
}

// ---------------------------------------------------------------------------
// Resume confirmation — where "unknown is not success" is implemented
// ---------------------------------------------------------------------------

/**
 * The outcome of confirming ONE resource after a resume.
 *
 * FOUR members, not three, and the split is load-bearing. Review of PR #3897
 * found that the previous shape returned `confirmation: 'confirmed-running'`
 * together with `observedState: 'Paused'` in the legitimate already-paused case,
 * so any consumer branching on the string — which is the obvious thing for an
 * orchestrator or a status pill to do — would render a STOPPED resource as
 * RUNNING. The name now means what it says:
 *
 *   `confirmed-running`         ARM reports Online AND that is what was
 *                               expected. Safe to render as "running".
 *   `confirmed-restored-paused` The resource was ALREADY paused before Loom
 *                               touched it and is paused again. A correct
 *                               resume outcome, but it is NOT running — never
 *                               render it as such.
 *   `confirmed-mismatch`        ARM established a state that does not match the
 *                               pre-pause condition. A real failure.
 *   `unknown`                   Nothing was established. Not an error state and
 *                               not a success state; grouped with failure for
 *                               the estate verdict and reported by its own name.
 *
 * Use `isResumeSuccess()` rather than hand-rolling the success set.
 */
export type ResumeConfirmation =
  | 'confirmed-running'
  | 'confirmed-restored-paused'
  | 'confirmed-mismatch'
  | 'unknown';

/**
 * The confirmations that count as a successful resume for ONE resource.
 * Exported so a consumer cannot drift from `deriveResumeState`'s definition.
 */
export const RESUME_SUCCESS_CONFIRMATIONS: readonly ResumeConfirmation[] = [
  'confirmed-running',
  'confirmed-restored-paused',
] as const;

/** True iff this confirmation means the resource reached its expected state. */
export function isResumeSuccess(c: ResumeConfirmation): boolean {
  return RESUME_SUCCESS_CONFIRMATIONS.includes(c);
}

export interface ResumeOutcome {
  resourceId: string;
  confirmation: ResumeConfirmation;
  /** The ARM-observed state, when one was obtained. */
  observedState?: EstatePowerState;
  /** Why, in words that assert only what was established. */
  reason: string;
}

/**
 * Confirm one resource from an AUTHORITATIVE ARM reading.
 *
 * The signature is the enforcement point for PRP §3c: there is no overload that
 * accepts a Resource Graph row, and `ArmPowerReading` cannot be constructed from
 * one. Pass `null` when the ARM read failed — that yields `unknown`, which is
 * exactly right, and never `confirmed-running`.
 */
export function confirmResume(
  expected: PausedResourceSnapshot,
  reading: ArmPowerReading | null,
  readError?: string,
): ResumeOutcome {
  if (!reading) {
    return {
      resourceId: expected.resourceId,
      confirmation: 'unknown',
      reason:
        `Could not read the ARM power state of ${expected.name}`
        + `${readError ? `: ${readError}` : ' (no reading was returned)'}. `
        + 'The resource may or may not be running — this was NOT established.',
    };
  }
  if (reading.resourceId !== expected.resourceId) {
    return {
      resourceId: expected.resourceId,
      confirmation: 'unknown',
      reason:
        `The ARM reading supplied was for ${reading.resourceId}, not ${expected.resourceId}; `
        + 'it says nothing about this resource.',
    };
  }

  // ── THE UNKNOWN PRE-PAUSE STATE (PR #3897 review BLOCKER) ────────────────
  // If we never established what this resource was BEFORE the pause, we cannot
  // establish what "restored" means for it, so nothing here can be a success.
  //
  // The previous version tested `!isRunningState(expected.prePausePowerState)`,
  // and `!isRunningState('Unknown')` is TRUE — so a snapshot whose pre-pause
  // state was never established fell into the "was already paused, restore it to
  // paused" branch. Measured consequence: prePausePowerState='Unknown' with ARM
  // observing 'Stopped' returned confirmed-running, and the estate reported
  // RUNNING. That is R-CAP-4's forbidden outcome on exactly the scenario R-CAP
  // exists for: ARM returns a state the mapper does not recognise -> Unknown
  // recorded -> resume fails with InsufficientResourcesForSubscription -> ARM
  // reports Stopped -> "RUNNING".
  //
  // `capturePrePauseState` and `deserializePauseSnapshot` now both REFUSE an
  // Unknown pre-pause state, so this branch is unreachable through any
  // sanctioned path. It stays as defence in depth: a snapshot that reaches here
  // with Unknown is honestly reported as unknown, never as success.
  if (expected.prePausePowerState === 'Unknown') {
    return {
      resourceId: expected.resourceId,
      confirmation: 'unknown',
      observedState: reading.powerState,
      reason:
        `The pre-pause power state of ${expected.name} was never established, so whether ARM's `
        + `current ${reading.powerState} represents a successful resume cannot be determined.`,
    };
  }

  // A resource that was ALREADY paused before Loom touched it is restored to
  // paused — starting it would be wrong. Note this tests isPausedState
  // POSITIVELY; `!isRunningState(...)` is not the same predicate, because the
  // transitional and Unknown states satisfy it too.
  if (isPausedState(expected.prePausePowerState)) {
    return isPausedState(reading.powerState)
      ? {
          resourceId: expected.resourceId,
          confirmation: 'confirmed-restored-paused',
          observedState: reading.powerState,
          reason:
            `${expected.name} was ${expected.prePausePowerState} before the pause and ARM reports `
            + `${reading.powerState}; it is back to its pre-pause condition. It is NOT running, and `
            + 'was not expected to be.',
        }
      : {
          resourceId: expected.resourceId,
          confirmation: 'confirmed-mismatch',
          observedState: reading.powerState,
          reason:
            `${expected.name} was ${expected.prePausePowerState} before the pause but ARM now reports `
            + `${reading.powerState}; it does not match its pre-pause condition.`,
        };
  }

  if (isRunningState(reading.powerState)) {
    return {
      resourceId: expected.resourceId,
      confirmation: 'confirmed-running',
      observedState: reading.powerState,
      reason: `ARM reports ${expected.name} is ${reading.powerState}.`,
    };
  }
  if (reading.powerState === 'Unknown') {
    return {
      resourceId: expected.resourceId,
      confirmation: 'unknown',
      observedState: 'Unknown',
      reason:
        `ARM did not report a recognised power state for ${expected.name}. `
        + 'Whether it is running was NOT established.',
    };
  }
  return {
    resourceId: expected.resourceId,
    confirmation: 'confirmed-mismatch',
    observedState: reading.powerState,
    reason:
      `ARM reports ${expected.name} is ${reading.powerState}, not Online. `
      + 'It was expected to be running after the resume.',
  };
}

/**
 * R-CAP-4 — the estate verdict for a completed resume attempt.
 *
 * RUNNING requires EVERY resource to have reached its EXPECTED state — i.e.
 * `isResumeSuccess()`, which is `confirmed-running` for a resource that was
 * running before the pause and `confirmed-restored-paused` for one that was
 * already stopped. Anything else — a `confirmed-mismatch`, an `unknown`, a
 * resource with no outcome, or an EMPTY outcome list against a non-empty
 * snapshot — is RESUME_FAILED.
 *
 * The empty-list case is deliberate and is the same defect class as a gate with
 * a zero population: `outcomes.every(...)` on `[]` is vacuously true, so a
 * resume that confirmed NOTHING would otherwise return RUNNING. It is checked
 * against the snapshot's own resource count, not against the outcome list, so a
 * confirmation loop that silently skipped resources cannot pass either.
 */
export function deriveResumeState(
  snapshot: Pick<EstatePauseSnapshot, 'resources'>,
  outcomes: readonly ResumeOutcome[],
): { state: 'RUNNING' | 'RESUME_FAILED'; unconfirmed: ResumeOutcome[]; reason: string } {
  const expectedIds = snapshot.resources.map((r) => r.resourceId);
  const byId = new Map(outcomes.map((o) => [o.resourceId, o]));

  const unconfirmed: ResumeOutcome[] = [];
  for (const id of expectedIds) {
    const o = byId.get(id);
    if (!o) {
      unconfirmed.push({
        resourceId: id,
        confirmation: 'unknown',
        reason:
          `No confirmation was attempted for ${id}. Whether it is running was NOT established.`,
      });
      continue;
    }
    if (!isResumeSuccess(o.confirmation)) unconfirmed.push(o);
  }

  if (expectedIds.length === 0) {
    // Nothing was ever paused, so nothing needs confirming. This is the ONLY
    // path to RUNNING that does not require a positive confirmation, and it is
    // safe precisely because the snapshot asserts the estate was untouched.
    return {
      state: 'RUNNING',
      unconfirmed: [],
      reason: 'The snapshot contains no paused resources; there is nothing to resume.',
    };
  }

  if (unconfirmed.length > 0) {
    return {
      state: 'RESUME_FAILED',
      unconfirmed,
      reason:
        `${unconfirmed.length} of ${expectedIds.length} resource(s) were not CONFIRMED running `
        + `(${unconfirmed.map((u) => u.confirmation).join(', ')}). `
        + 'The estate is RESUME_FAILED — an unconfirmed resume is not a successful one.',
    };
  }

  return {
    state: 'RUNNING',
    unconfirmed: [],
    reason:
      `All ${expectedIds.length} resource(s) reached their expected pre-pause state, confirmed from `
      + 'authoritative ARM reads.',
  };
}

/**
 * Build one resource's pre-pause snapshot entry.
 *
 * Takes an `ArmPowerReading`, so a caller holding only Resource Graph discovery
 * data CANNOT capture a snapshot — which is the point (PRP §3c). The `fallback`
 * argument is where R-CAP-1's declared fallback SKU is stamped in;
 * `./pause-inventory` supplies it from the pausable-type registry.
 */
export function capturePrePauseState(args: {
  resourceId: string;
  resourceType: string;
  name: string;
  resourceGroup: string;
  subscriptionId: string;
  location?: string;
  reading: ArmPowerReading;
  sku?: EstateSkuSnapshot;
  replicaCount?: number;
  fallbackSku?: EstateFallbackSku;
  ownership: LoomOwnershipEvidence;
}): PausedResourceSnapshot {
  if (args.reading.resourceId !== args.resourceId) {
    throw new Error(
      `capturePrePauseState: the ARM reading is for ${args.reading.resourceId} but the resource is `
        + `${args.resourceId}. Capturing it would record another resource's power state.`,
    );
  }
  if (args.ownership.verdict !== 'loom-owned') {
    throw new Error(
      `capturePrePauseState: refusing to snapshot ${args.resourceId} — ownership verdict is `
        + `'${args.ownership.verdict}', not 'loom-owned'. ${args.ownership.reason}`,
    );
  }
  // A snapshot you cannot restore TO is not a snapshot. If ARM returned a state
  // the mapper does not recognise, recording it would produce a document that
  // resume cannot evaluate — and, before the #3897 review fix, one that resume
  // scored as SUCCESS. Fail here, at capture, where the pause has not happened
  // yet and nothing is lost by stopping.
  if (args.reading.powerState === 'Unknown') {
    throw new Error(
      `capturePrePauseState: refusing to snapshot ${args.resourceId} — ARM did not report a `
        + `recognised power state (api-version ${args.reading.armApiVersion}, read at `
        + `${args.reading.readAt}). Pausing a resource whose pre-pause state is unknown would `
        + 'produce a snapshot that resume cannot restore to, so the pause must not proceed.',
    );
  }
  return {
    resourceId: args.resourceId,
    resourceType: args.resourceType.toLowerCase(),
    name: args.name,
    resourceGroup: args.resourceGroup,
    subscriptionId: args.subscriptionId,
    ...(args.location ? { location: args.location } : {}),
    prePausePowerState: args.reading.powerState,
    powerStateSource: 'arm',
    powerStateReadAt: args.reading.readAt,
    powerStateApiVersion: args.reading.armApiVersion,
    ...(args.sku ? { sku: args.sku } : {}),
    ...(typeof args.replicaCount === 'number' ? { replicaCount: args.replicaCount } : {}),
    ...(args.fallbackSku ? { fallbackSku: args.fallbackSku } : {}),
    ownership: args.ownership,
  };
}

// ---------------------------------------------------------------------------
// Serialization — round-trip stable
// ---------------------------------------------------------------------------

/**
 * Serialize a snapshot for persistence. Deterministic: the object is emitted
 * with no undefined-valued keys, so `serialize -> deserialize -> serialize` is a
 * fixed point and a Cosmos round-trip does not mutate the document.
 */
export function serializePauseSnapshot(snap: EstatePauseSnapshot): string {
  return JSON.stringify(stripUndefined(snap));
}

/**
 * Parse a persisted snapshot. Rejects — never guesses at — a document it cannot
 * establish the meaning of: a missing/newer schema version, a missing estate id,
 * an unknown state, or a resource whose power state did not come from ARM.
 */
export function deserializePauseSnapshot(raw: string | unknown): EstatePauseSnapshot {
  const doc: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!doc || typeof doc !== 'object') {
    throw new Error('Pause snapshot is not an object.');
  }
  const d = doc as Record<string, unknown>;

  const version = d.schemaVersion;
  if (typeof version !== 'number') {
    throw new Error('Pause snapshot has no numeric schemaVersion; its shape cannot be established.');
  }
  // Bounded at BOTH ends. Bounding only the top accepted 0, -1 and 0.5 — none of
  // which names a shape this build has ever written (#3897 review).
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(
      `Pause snapshot schemaVersion ${version} is not a positive integer, so it names no shape this `
        + 'build has ever written.',
    );
  }
  if (version > ESTATE_PAUSE_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(
      `Pause snapshot schemaVersion ${version} is newer than this build understands `
        + `(${ESTATE_PAUSE_SNAPSHOT_SCHEMA_VERSION}). Refusing to read it rather than restore the `
        + 'wrong SKUs from a shape that has since changed.',
    );
  }
  if (typeof d.id !== 'string' || !d.id) throw new Error('Pause snapshot has no id.');
  if (typeof d.tenantId !== 'string' || !d.tenantId) {
    throw new Error('Pause snapshot has no tenantId (partition key).');
  }
  if (typeof d.estateId !== 'string' || !d.estateId) {
    throw new Error('Pause snapshot has no estateId; its scope cannot be established.');
  }
  if (!ESTATE_PAUSE_STATES.includes(d.state as EstatePauseState)) {
    throw new Error(`Pause snapshot has an unknown state '${String(d.state)}'.`);
  }
  if (!Array.isArray(d.resources)) {
    throw new Error('Pause snapshot has no resources array.');
  }

  for (const r of d.resources as Array<Record<string, unknown>>) {
    if (!r || typeof r !== 'object') throw new Error('Pause snapshot has a non-object resource.');
    if (typeof r.resourceId !== 'string' || !r.resourceId) {
      throw new Error('Pause snapshot has a resource with no resourceId.');
    }
    if (r.powerStateSource !== 'arm') {
      throw new Error(
        `Pause snapshot resource ${String(r.resourceId)} records powerStateSource `
          + `'${String(r.powerStateSource)}'. Only 'arm' is accepted — Resource Graph has been `
          + 'measured reporting a Synapse pool Online AFTER a successful pause action, so a '
          + 'snapshot built from it would restore the wrong state.',
      );
    }
    // The docstring above promises this function refuses what it cannot
    // establish the meaning of. Before the #3897 review it validated
    // `resourceId` and `powerStateSource` and then cast, so a document carrying
    // `prePausePowerState: 'TOTALLY_BOGUS'` was ACCEPTED and flowed straight
    // into `confirmResume`'s branching. Validating it here is what makes that
    // sentence true (deploy-integrity.md R7).
    if (!ESTATE_POWER_STATES.includes(r.prePausePowerState as EstatePowerState)) {
      throw new Error(
        `Pause snapshot resource ${String(r.resourceId)} records prePausePowerState `
          + `'${String(r.prePausePowerState)}', which is not a recognised power state. Resume `
          + 'cannot determine what restoring it would mean.',
      );
    }
    // Consistent with capturePrePauseState, which refuses to WRITE one of these.
    if (r.prePausePowerState === 'Unknown') {
      throw new Error(
        `Pause snapshot resource ${String(r.resourceId)} records prePausePowerState 'Unknown'. `
          + 'A snapshot whose pre-pause state was never established cannot be restored to, and '
          + 'evaluating a resume against it cannot yield a success.',
      );
    }
  }

  return doc as EstatePauseSnapshot;
}

/** Recursively drop undefined-valued keys so JSON round-trips are a fixed point. */
function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => stripUndefined(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) out[k] = stripUndefined(v);
    }
    return out as unknown as T;
  }
  return value;
}

/** A new, empty snapshot for an estate about to be paused. */
export function newPauseSnapshot(args: {
  id: string;
  tenantId: string;
  estateId: string;
  createdBy?: string;
  now?: string;
}): EstatePauseSnapshot {
  const now = args.now ?? new Date().toISOString();
  return {
    id: args.id,
    tenantId: args.tenantId,
    schemaVersion: ESTATE_PAUSE_SNAPSHOT_SCHEMA_VERSION,
    estateId: args.estateId,
    state: 'PAUSING',
    resources: [],
    createdAt: now,
    updatedAt: now,
    ...(args.createdBy ? { createdBy: args.createdBy } : {}),
  };
}
