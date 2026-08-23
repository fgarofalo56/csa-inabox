/**
 * ESTATE PAUSE / RESUME — the orchestrator (PRP §10b W2).
 *
 * This is the composition layer between W1's safety-critical inventory
 * (`./pause-inventory`) / state model (`./pause-state`) and the ARM actuators
 * that already exist in `lib/azure/*`. It contains NO new pause verb: every
 * mutation is delegated to a client that already ships and is already exercised
 * by an `/api/admin/scaling/*` route.
 *
 * ── WHAT THIS SLICE DOES, AND WHAT IT DELIBERATELY DOES NOT ────────────────
 * IN:  the PAUSE tier only — native pause/stop/suspend. NOTHING is deleted.
 * OUT: HIBERNATE (delete + redeploy), the invariant reconciler, idle
 *      auto-pause, the Gov dispatch path, and fallback-SKU AUTOMATION. Those
 *      are PRP work items W6/W7/W8; this file surfaces the declared fallback
 *      (R-CAP-1/3) but never applies it on its own.
 *
 * ── WHY EVERYTHING IS INJECTED ─────────────────────────────────────────────
 * The pure half (`planPause`, `startPause`, `pollPause`, `startResume`,
 * `pollResume`) takes an `EstateActuator` and never imports an Azure client at
 * module scope. That is what makes the scope-safety rules TESTABLE: a unit test
 * hands in an actuator that records what it was asked to touch, and the test
 * asserts a non-Loom resource never appears in that recording. A module that
 * reached for `armPost` directly could only be tested by mocking the network.
 *
 * `createArmActuator()` is the real one. It `await import`s its clients lazily
 * so this module stays import-light for the pure tests.
 *
 * ── FIVE INVARIANTS THIS FILE IS RESPONSIBLE FOR ───────────────────────────
 *
 *  1. R-SCOPE-3, re-verify before acting. `startPause` calls
 *     `reverifyBeforeAct` for EVERY candidate, immediately before the mutation,
 *     and a non-`loom-owned` verdict leaves the resource RUNNING. There is no
 *     branch that acts on a candidate without that call returning `proceed`.
 *
 *  2. No pause without a recorded pre-pause state. If the AUTHORITATIVE ARM
 *     read fails, we do not pause. Pausing something whose prior SKU/power
 *     state we could not record makes resume a guess, and §6 of the PRP is
 *     explicit that the snapshot is the record resume restores from.
 *
 *  3. PAUSED is never claimed on a dispatch. Every pause verb in Azure is a
 *     202 long-running operation, so `startPause` leaves the estate `PAUSING`
 *     and `pollPause` promotes it to `PAUSED` only after a fresh authoritative
 *     ARM read shows every resource stopped. (PRP §3c: Resource Graph is a
 *     replicated index and was MEASURED reporting a Synapse pool `Online` after
 *     a pause had already succeeded — so state comes from ARM, and only ARM.)
 *
 *  4. RUNNING requires a SERVABLE probe, not a status field. Microsoft's own
 *     docs say a resumed Synapse pool reports `ONLINE` 2-3 minutes before it
 *     can serve a query. `pollResume` therefore downgrades a `confirmed-running`
 *     ARM outcome to `unknown` when the data-plane probe fails, which
 *     `deriveResumeState` turns into RESUME_FAILED. This is the same
 *     recency-vs-serving error as #3676 — the fix is to probe the thing, not to
 *     trust the field that describes it.
 *
 *  5. The console cannot pause itself out of existence. `ESTATE_PAUSE_TIER`
 *     omits Container Apps: the Loom console IS a Container App, and the
 *     surface that resumes the estate must survive the pause. ACA scale-to-zero
 *     is a real saving (~$388/mo) and is tracked as a follow-up, but it needs
 *     per-app ownership re-verification that this slice does not build.
 */

import {
  assertTransition,
  armPowerReading,
  capturePrePauseState,
  confirmResume,
  deriveResumeState,
  isPausedState,
  isRunningState,
  newPauseSnapshot,
  type ArmPowerReading,
  type EstatePauseSnapshot,
  type EstatePauseState,
  type EstatePowerState,
  type EstateSkuSnapshot,
  type PausedResourceSnapshot,
  type ResumeOutcome,
} from './pause-state';
import {
  buildPauseInventory,
  dryRunPause,
  pausableTypeSpec,
  reverifyBeforeAct,
  LOOM_ESTATE_TAG_KEY,
  LOOM_ITEM_TAG_KEY,
  type DeployManifest,
  type DiscoveredResource,
  type DryRunResult,
  type PauseCandidate,
  type PauseInventory,
  type PauseScope,
} from './pause-inventory';
import { assertNoFalseGreen } from './capacity-preflight';

// ---------------------------------------------------------------------------
// The tier this slice actuates
// ---------------------------------------------------------------------------

/**
 * The ARM types this PAUSE slice will actuate, lower-cased.
 *
 * A type in `PAUSABLE_RESOURCE_TYPES` but NOT here is reported in the dry-run
 * as `out-of-tier` — visible, explained, and left running. That is deliberately
 * noisier than silently dropping it: a resource that disappears from both the
 * "would pause" and "left running" lists is a resource nobody reviewed.
 *
 * Container Apps are excluded for the reason in the module header (invariant 5).
 * Stream Analytics jobs are excluded because all 251 measured Running=0 and ASA
 * bills only while started — stopping a stopped job saves nothing and adds 251
 * ARM mutations to the blast radius.
 */
export const ESTATE_PAUSE_TIER: readonly string[] = [
  'microsoft.synapse/workspaces/sqlpools',
  'microsoft.kusto/clusters',
  'microsoft.analysisservices/servers',
  'microsoft.compute/virtualmachinescalesets',
];

/** Why a Loom-owned, pausable-typed resource is nevertheless out of this tier. */
export const OUT_OF_TIER_REASONS: Readonly<Record<string, string>> = {
  'microsoft.app/containerapps':
    'Container Apps are excluded from this slice. The Loom console itself runs as a Container App, '
    + 'so the surface that resumes the estate must stay reachable; scale-to-zero across the app '
    + 'fleet needs per-app ownership re-verification that this work item does not build.',
  'microsoft.streamanalytics/streamingjobs':
    'Stream Analytics jobs bill only while STARTED, and every job measured on this estate is already '
    + 'stopped. Stopping a stopped job saves nothing and widens the blast radius.',
  'microsoft.web/sites':
    'Function Apps / App Service here run on Y1 Consumption plans, which are already $0 at idle.',
};

/**
 * TYPICAL resume time per type, in seconds. Used ONLY to draw a progress bar.
 *
 * Every figure is Microsoft's own published language, converted to a number so
 * a bar can move; none of them is a guarantee, and the UI says so. Microsoft's
 * Fabric pause/resume page publishes NO duration at all, so an honest estimate
 * with a stated basis is already better than the model we are copying.
 */
export const TYPICAL_RESUME_SECONDS: Readonly<Record<string, number>> = {
  // Learn: "several minutes", and the API reports ONLINE 2-3 min before it serves.
  'microsoft.synapse/workspaces/sqlpools': 420,
  // Learn: ~10 minutes to start, plus UNBOUNDED hot-cache rehydration.
  'microsoft.kusto/clusters': 600,
  // Resume returns quickly; the model must then be re-attached/queried.
  'microsoft.analysisservices/servers': 240,
  // VM allocation in a healthy region.
  'microsoft.compute/virtualmachinescalesets': 300,
};

// ---------------------------------------------------------------------------
// The injected actuator
// ---------------------------------------------------------------------------

/** The outcome of one ARM mutation. `ok:false` never throws away the reason. */
export interface ActuatorResult {
  ok: boolean;
  /** What was actually established, in the words shown to the operator. */
  detail: string;
  /** Raw failure text when `ok` is false. Classified by ./capacity-preflight. */
  error?: string;
}

/** An AUTHORITATIVE ARM read: power state + the SKU/replica facts resume needs. */
export interface PowerRead {
  /** null when the read did not establish a state. NEVER a default of Online. */
  reading: ArmPowerReading | null;
  error?: string;
  sku?: EstateSkuSnapshot;
  replicaCount?: number;
}

/** Whether the resource can actually SERVE, as opposed to reporting a state. */
export interface ServabilityProbe {
  /** 'servable' only when a real data-plane round-trip succeeded. */
  servable: boolean;
  detail: string;
  /** False when this type has no probe wired — reported, never assumed servable. */
  probed: boolean;
}

/**
 * Everything the orchestrator needs from the outside world.
 *
 * Deliberately five small methods rather than one `doPause(everything)`: each
 * one is a seam a test can make fail independently, which is how the fail-safe
 * branches get covered.
 */
export interface EstateActuator {
  /** R-SCOPE-3 — fresh tags for the re-verify, immediately before acting. */
  readTags(resourceId: string): Promise<Readonly<Record<string, string>> | null>;
  /** PRP §3c — authoritative ARM, never Resource Graph. */
  readPower(resource: {
    resourceId: string;
    resourceType: string;
    name: string;
  }): Promise<PowerRead>;
  /** The native pause/stop/suspend verb. Composes an existing lib/azure client. */
  pause(candidate: PauseCandidate): Promise<ActuatorResult>;
  /** The native resume/start verb. */
  resume(entry: PausedResourceSnapshot): Promise<ActuatorResult>;
  /** A REAL data-plane round-trip. `probed:false` when none is wired. */
  probeServable(entry: PausedResourceSnapshot): Promise<ServabilityProbe>;
}

// ---------------------------------------------------------------------------
// Planning — R-SCOPE-4
// ---------------------------------------------------------------------------

export interface EstatePlan {
  inventory: PauseInventory;
  dryRun: DryRunResult;
  /** Loom-owned + pausable, but held out of THIS tier, with the reason. */
  outOfTier: Array<{ resourceId: string; name: string; resourceType: string; reason: string }>;
  /**
   * THE POPULATION REPORT. What the ownership resolver actually found, and by
   * which evidence.
   *
   * This exists because a guard with a zero population passes silently. The
   * ownership tag `loom-estate-id` that PRP §3b calls the preferred signal is
   * stamped by NOTHING today — a grep of `platform/`, `deploy/`, `.github/` and
   * `scripts/` returns zero occurrences. On a deployment where the tag is absent
   * AND no deploy manifest resolves, `wouldPause` is legitimately EMPTY, and an
   * empty list rendered next to an enabled Pause button is the exact vaporware
   * shape this repo keeps removing.
   *
   * So the population travels with the plan, the UI states it, and
   * `pausable === 0` disables the button and explains itself instead of
   * pretending to be ready.
   */
  population: {
    /** Every resource the resolver was asked about. */
    examined: number;
    /** In-tier, Loom-owned, would be acted on. */
    pausable: number;
    /** How each pausable row's ownership was established. */
    byEvidence: { ownershipTag: number; deployManifest: number };
    /** Tag read failed — left running, and an error worth surfacing. */
    indeterminate: number;
    /** Read fine, positively not Loom's. The blog, Sentinel, Atlas, … */
    notLoomOwned: number;
    /** True when there is genuinely nothing to pause. */
    empty: boolean;
    /**
     * THE TAG CENSUS — the ownership tags counted SEPARATELY.
     *
     * Separately, and never summed into one "tagged" number, because they do
     * not mean the same thing and only ONE of them can decide this question:
     *
     *   loomEstateId  DECIDES. Its VALUE is the estate id, so it can tell this
     *                 estate from another one sharing the subscription. With
     *                 the deploy manifest, it is one of exactly TWO membership
     *                 sources.
     *   loomItemId    NOT a membership source. W1 removed it: it names an ITEM,
     *                 not an ESTATE, so it cannot answer "which estate". Counted
     *                 here only so a resource carrying it is not mistaken for
     *                 untagged. Its two writers stamp `Microsoft.Logic/workflows`
     *                 and `Microsoft.Insights/scheduledQueryRules`, neither of
     *                 which is a pausable type, so removing it cost nothing.
     *   loomManaged   REPORTED, NEVER USED. It is a BOOLEAN. It says "some Loom
     *                 deployment made this" and cannot say WHICH — so a resolver
     *                 keyed to it works fine in a single-estate subscription and
     *                 silently pauses a SIBLING estate's resources in a shared
     *                 one. Measured: 11 files stamp it, including aas-client.ts
     *                 (Analysis Services, ~$1,796/mo). Reaching for it would
     *                 make this feature look alive today and cause exactly the
     *                 cross-estate outage the whole scope design exists to
     *                 prevent. It is counted here so the gap is VISIBLE, and
     *                 there is no code path that consults it. See #3922.
     */
    tagCensus: { loomEstateId: number; loomItemId: number; loomManaged: number; untagged: number };
    /** Plain-English statement of the above, shown verbatim in the UI. */
    statement: string;
  };
}

/** Observed and reported, never consulted. See `tagCensus`. */
export const LOOM_MANAGED_TAG_KEY = 'loom-managed';

/** Case-insensitive tag presence, as ARM compares tag keys. */
function hasTag(tags: Readonly<Record<string, string>> | null, key: string): boolean {
  if (!tags) return false;
  const wanted = key.toLowerCase();
  return Object.keys(tags).some((k) => k.toLowerCase() === wanted);
}

/**
 * Count the ownership tags across the discovered set, SEPARATELY.
 *
 * A single "tagged: N" would be the defect. Two signals folded into one number
 * is how a resolver ends up with two methods for one decision — the shape this
 * repo has removed repeatedly — and it would hide the fact that the ONLY
 * estate-discriminating tag has zero population while weaker ones do not.
 *
 * Only `loomEstateId` is a membership source here. The other two are counted so
 * the GAP is visible and named, never so a caller can fall back to them.
 */
export function censusTags(discovered: readonly DiscoveredResource[]): {
  loomEstateId: number;
  loomItemId: number;
  loomManaged: number;
  untagged: number;
} {
  let loomEstateId = 0;
  let loomItemId = 0;
  let loomManaged = 0;
  let untagged = 0;
  for (const r of discovered) {
    const estate = hasTag(r.tags, LOOM_ESTATE_TAG_KEY);
    const item = hasTag(r.tags, LOOM_ITEM_TAG_KEY);
    const managed = hasTag(r.tags, LOOM_MANAGED_TAG_KEY);
    if (estate) loomEstateId += 1;
    if (item) loomItemId += 1;
    if (managed) loomManaged += 1;
    if (!estate && !item && !managed) untagged += 1;
  }
  return { loomEstateId, loomItemId, loomManaged, untagged };
}

/**
 * The dry run. Pure: no Azure call, nothing mutated.
 *
 * `buildPauseInventory` does the ownership work (per RESOURCE, never per
 * subscription and never per resource-group name). This function then applies
 * the tier filter and moves anything out-of-tier into its own list so it is
 * still visible in the preview rather than silently dropped.
 */
export function planPause(
  discovered: readonly DiscoveredResource[],
  ctx: { scope: PauseScope; manifest?: DeployManifest; now?: string },
): EstatePlan {
  const full = buildPauseInventory(discovered, ctx);

  const inTier: PauseCandidate[] = [];
  const outOfTier: EstatePlan['outOfTier'] = [];
  for (const c of full.pausable) {
    const type = c.resource.resourceType.toLowerCase();
    if (ESTATE_PAUSE_TIER.includes(type)) {
      inTier.push(c);
      continue;
    }
    outOfTier.push({
      resourceId: c.resource.resourceId,
      name: c.resource.name,
      resourceType: c.resource.resourceType,
      reason:
        OUT_OF_TIER_REASONS[type]
        ?? `${c.resource.name} is Loom-owned and pausable, but ${type} is not in this PAUSE tier.`,
    });
  }

  const inventory: PauseInventory = { ...full, pausable: inTier };
  const dryRun = dryRunPause(inventory);

  const byEvidence = {
    ownershipTag: inTier.filter((c) => c.ownership.source === 'ownership-tag').length,
    deployManifest: inTier.filter((c) => c.ownership.source === 'deploy-manifest').length,
  };
  const indeterminate = full.excluded.filter((e) => e.kind === 'ownership-indeterminate').length;
  const notLoomOwned = full.excluded.filter((e) => e.kind === 'not-loom-owned').length;
  const tagCensus = censusTags(discovered);
  const empty = inTier.length === 0;

  return {
    inventory,
    dryRun,
    outOfTier,
    population: {
      examined: discovered.length,
      pausable: inTier.length,
      byEvidence,
      indeterminate,
      notLoomOwned,
      empty,
      tagCensus,
      statement: populationStatement({
        examined: discovered.length,
        pausable: inTier.length,
        byEvidence,
        indeterminate,
        notLoomOwned,
        tagCensus,
        outOfTier: outOfTier.length,
      }),
    },
  };
}

/**
 * The sentence the UI shows above the preview. Written to be USEFUL when the
 * answer is zero, because zero is the answer on an untagged estate and an
 * unexplained empty list is indistinguishable from a broken feature.
 */
function populationStatement(p: {
  examined: number;
  pausable: number;
  byEvidence: { ownershipTag: number; deployManifest: number };
  indeterminate: number;
  notLoomOwned: number;
  tagCensus: { loomEstateId: number; loomItemId: number; loomManaged: number; untagged: number };
  outOfTier: number;
}): string {
  const evidence =
    `${p.byEvidence.ownershipTag} by the ${LOOM_ESTATE_TAG_KEY} tag, `
    + `${p.byEvidence.deployManifest} by the deploy manifest`;

  if (p.pausable > 0) {
    return (
      `${p.pausable} of ${p.examined} examined resource(s) would be paused (${evidence}). `
      + `${p.notLoomOwned} are positively not this estate's, ${p.indeterminate} could not be `
      + `established and are left running, and ${p.outOfTier} are held out of this PAUSE tier.`
    );
  }

  // The zero case. Say WHY, name every signal that WAS consulted, and say
  // plainly that pausing requires a tag nothing currently stamps. Until #3922
  // lands this is the PRIMARY user-visible surface of the feature, so it has to
  // carry its weight rather than read as a broken page.
  const managedNote =
    p.tagCensus.loomManaged > 0
      ? ` ${p.tagCensus.loomManaged} resource(s) do carry the boolean '${LOOM_MANAGED_TAG_KEY}' tag, but `
        + 'pause deliberately does NOT accept it: a boolean cannot tell this estate from another one '
        + "sharing the subscription, so acting on it could stop a sibling estate's resources."
      : '';
  const itemNote =
    p.tagCensus.loomItemId > 0
      ? ` ${p.tagCensus.loomItemId} carry '${LOOM_ITEM_TAG_KEY}', which names an ITEM rather than an `
        + 'ESTATE and is likewise not a membership source.'
      : '';

  return (
    `NOTHING would be paused, and that is the correct fail-safe answer — not a failure. `
    + `${p.examined} resource(s) were examined. Pause accepts exactly TWO ownership signals: the `
    + `'${LOOM_ESTATE_TAG_KEY}' tag (found on ${p.tagCensus.loomEstateId}) and a deploy-emitted `
    + `manifest (resolved ${p.byEvidence.deployManifest}). Neither is stamped by the platform today, `
    + `so the pause set is empty until the estate is tagged — tracked as #3922.`
    + managedNote
    + itemNote
  );
}

// ---------------------------------------------------------------------------
// Pause
// ---------------------------------------------------------------------------

/** What happened to ONE resource during a pause dispatch. */
export type PauseActionStatus =
  /** The ARM pause verb was accepted (202/200). Not yet CONFIRMED stopped. */
  | 'dispatched'
  /** ARM already reported it stopped; nothing was sent. */
  | 'already-paused'
  /** Left RUNNING on purpose — ownership or the ARM read did not establish enough. */
  | 'skipped'
  /** The ARM verb was rejected. */
  | 'failed';

export interface PauseActionResult {
  resourceId: string;
  name: string;
  resourceType: string;
  status: PauseActionStatus;
  /** States what was ESTABLISHED — never a cause the code did not verify (R7). */
  detail: string;
  error?: string;
}

export interface PauseRunResult {
  snapshot: EstatePauseSnapshot;
  actions: PauseActionResult[];
  /** True when at least one resource was actually asked to stop. */
  dispatchedAny: boolean;
  /**
   * True when the run captured NO resources at all — every candidate was
   * skipped, or there were none.
   *
   * This is called out because of a sharp edge in the state model:
   * `deriveResumeState` returns RUNNING for an EMPTY snapshot (correctly — there
   * is nothing to resume), so a snapshot that captured nothing would later
   * "resume successfully" and the whole no-op would render as a success. The
   * defence is not to special-case the resume; it is to refuse to record a
   * PAUSING estate that paused nothing. When this is true the state stays
   * RUNNING and the caller reports the per-resource skip reasons.
   */
  capturedNone: boolean;
}

/**
 * Dispatch the pause. Leaves the estate in `PAUSING` — never `PAUSED`.
 *
 * The order inside the loop is the safety argument, so read it as one:
 *
 *   re-verify ownership  ->  read authoritative power state  ->  snapshot  ->  act
 *
 * Ownership first, so an ARM read is never even issued against a resource we
 * have no business touching. The power read second, so a resource whose prior
 * state we cannot record is never paused (invariant 2). The snapshot third, so
 * the record resume restores from exists BEFORE the mutation rather than after
 * it. Only then the mutation.
 */
export async function startPause(
  plan: EstatePlan,
  actuator: EstateActuator,
  ctx: {
    snapshotId: string;
    tenantId: string;
    estateId: string;
    /**
     * Re-reads the deploy manifest AT ACT TIME (W1 made this a callback so a
     * pre-fetched manifest cannot be replayed). Omitting it is a valid,
     * fail-safe choice: manifest-sourced ownership then cannot be re-verified,
     * so the `loom-estate-id` tag becomes mandatory for the final go/no-go.
     */
    readManifest?: () => Promise<DeployManifest | null>;
    createdBy?: string;
    now?: string;
  },
): Promise<PauseRunResult> {
  const snapshot = newPauseSnapshot({
    id: ctx.snapshotId,
    tenantId: ctx.tenantId,
    estateId: ctx.estateId,
    createdBy: ctx.createdBy,
    now: ctx.now,
  });
  const actions: PauseActionResult[] = [];
  let dispatchedAny = false;

  for (const candidate of plan.inventory.pausable) {
    const { resource } = candidate;
    const base = {
      resourceId: resource.resourceId,
      name: resource.name,
      resourceType: resource.resourceType,
    };

    // (1) R-SCOPE-3 — re-verify membership IMMEDIATELY before acting. A tag can
    //     be removed, or a resource re-created under different ownership,
    //     between the preview the operator confirmed and this line.
    //
    //     `readManifest` is a CALLBACK, invoked here at act time — W1 removed
    //     the ability to hand it a pre-fetched value on purpose, so stale
    //     ownership data cannot be replayed against a live mutation. We pass the
    //     same env resolver the plan used, so it is genuinely re-read.
    const recheck = await reverifyBeforeAct(candidate, actuator.readTags, {
      estateId: ctx.estateId,
      ...(ctx.readManifest ? { readManifest: ctx.readManifest } : {}),
    });
    if (!recheck.proceed) {
      actions.push({ ...base, status: 'skipped', detail: recheck.reason });
      continue;
    }

    // (2) Authoritative ARM power read. No reading -> no snapshot -> no pause.
    const power = await actuator.readPower(resource);
    if (!power.reading) {
      actions.push({
        ...base,
        status: 'skipped',
        detail:
          `Could not read the authoritative ARM power state of ${resource.name}`
          + `${power.error ? `: ${power.error}` : ''}. Its pre-pause state could not be recorded, so `
          + 'pausing it would leave resume guessing. Left RUNNING.',
        ...(power.error ? { error: power.error } : {}),
      });
      continue;
    }

    // (3) Snapshot BEFORE the mutation. `capturePrePauseState` itself refuses a
    //     non-`loom-owned` verdict, so this is a second, independent gate on the
    //     same fact — belt and braces on the one decision that can cause an
    //     outage in somebody else's estate.
    const entry = capturePrePauseState({
      resourceId: resource.resourceId,
      resourceType: resource.resourceType,
      name: resource.name,
      resourceGroup: resource.resourceGroup,
      subscriptionId: resource.subscriptionId,
      location: resource.location,
      reading: power.reading,
      sku: power.sku,
      replicaCount: power.replicaCount,
      fallbackSku: candidate.fallbackSku,
      ownership: recheck.ownership,
    });
    snapshot.resources.push(entry);

    // (4) Already stopped? Record it and send nothing. Resume will restore it TO
    //     stopped, because `prePausePowerState` says that is where it started.
    if (isPausedState(power.reading.powerState)) {
      actions.push({
        ...base,
        status: 'already-paused',
        detail:
          `ARM reports ${resource.name} is already ${power.reading.powerState}; no pause was sent. `
          + 'Resume will leave it in this state, because that is what it was before Loom looked.',
      });
      continue;
    }

    // (5) The mutation.
    const result = await actuator.pause(candidate);
    dispatchedAny = dispatchedAny || result.ok;
    actions.push({
      ...base,
      status: result.ok ? 'dispatched' : 'failed',
      detail: result.detail,
      ...(result.error ? { error: result.error } : {}),
    });
  }

  snapshot.updatedAt = ctx.now ?? new Date().toISOString();

  // A pause that captured NOTHING is not a paused estate. Record it as RUNNING
  // rather than as PAUSING-with-zero-resources, so a later resume cannot report
  // a vacuous success over a snapshot that never held anything.
  const capturedNone = snapshot.resources.length === 0;
  if (capturedNone) {
    assertTransition(snapshot.state, 'RUNNING');
    snapshot.state = 'RUNNING';
  }

  return { snapshot, actions, dispatchedAny, capturedNone };
}

/** Per-resource live progress, as the UI renders it. */
export interface ResourceProgress {
  resourceId: string;
  name: string;
  resourceType: string;
  /** What ARM says right now. `Unknown` when the read failed — never defaulted. */
  powerState: EstatePowerState;
  /**
   * Where this resource is SUPPOSED to end up, from its pre-pause state.
   *
   * The UI branches on this + `powerState`, and NEVER on a `ResumeConfirmation`
   * string. W1 renamed the success members precisely because a hand-rolled
   * comparison gets this wrong in BOTH directions: the old single
   * `confirmed-running` painted a correctly-still-stopped resource green, and
   * comparing against `confirmed-running` alone under the new names would paint
   * a correctly-restored-paused one RED. Where a confirmation verdict is
   * genuinely needed, `isResumeSuccess()` is the only sanctioned reader.
   */
  expectation: 'running' | 'stopped';
  /** Derived from `powerState` vs `expectation` — not from a confirmation enum. */
  atExpectedState: boolean;
  /** 'done' | 'in-flight' | 'unknown' | 'failed'. */
  phase: 'done' | 'in-flight' | 'unknown' | 'failed';
  detail: string;
  /** Resume only: whether a real data-plane round-trip succeeded. */
  servable?: boolean;
  /** Resume only: false when no probe is wired for this type. */
  probed?: boolean;
  /** Typical seconds for this type's resume, for the progress bar only. */
  typicalResumeSeconds?: number;
}

export interface PausePollResult {
  state: EstatePauseState;
  progress: ResourceProgress[];
  /** Count of snapshot resources CONFIRMED stopped by a fresh ARM read. */
  confirmed: number;
  total: number;
  reason: string;
}

/**
 * Re-read authoritative ARM and decide whether the estate has actually reached
 * PAUSED. This is the ONLY promoter of `PAUSING -> PAUSED`.
 *
 * A resource whose read fails counts as NOT confirmed. That is the whole point:
 * `Unknown != Paused`, exactly as `Unknown != Online` on the resume side.
 */
export async function pollPause(
  snapshot: EstatePauseSnapshot,
  actuator: EstateActuator,
): Promise<PausePollResult> {
  const progress: ResourceProgress[] = [];
  let confirmed = 0;

  for (const entry of snapshot.resources) {
    const power = await actuator.readPower(entry);
    const state = power.reading?.powerState ?? 'Unknown';

    // A resource that was ALREADY stopped before the pause counts as settled —
    // there was nothing to stop.
    const expectation: 'running' | 'stopped' = 'stopped';
    const wasRunning = isRunningState(entry.prePausePowerState);
    const settled = wasRunning ? isPausedState(state) : !isRunningState(state);
    if (settled) confirmed += 1;

    progress.push({
      resourceId: entry.resourceId,
      name: entry.name,
      resourceType: entry.resourceType,
      powerState: state,
      expectation,
      atExpectedState: settled,
      phase: settled ? 'done' : state === 'Unknown' ? 'unknown' : 'in-flight',
      detail: power.reading
        ? `ARM reports ${entry.name} is ${state}.`
        : `Could not read the ARM power state of ${entry.name}`
          + `${power.error ? `: ${power.error}` : ''}. Whether it stopped was NOT established.`,
    });
  }

  const total = snapshot.resources.length;
  const allConfirmed = total > 0 && confirmed === total;
  if (allConfirmed && snapshot.state === 'PAUSING') {
    assertTransition(snapshot.state, 'PAUSED');
  }
  return {
    state: allConfirmed ? 'PAUSED' : snapshot.state,
    progress,
    confirmed,
    total,
    reason: allConfirmed
      ? `All ${total} resource(s) confirmed stopped from authoritative ARM reads.`
      : `${confirmed} of ${total} resource(s) confirmed stopped. The estate is still PAUSING — `
        + 'a resource whose state could not be read counts as NOT confirmed.',
  };
}

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
  };

  const dispatches: ResumeDispatch[] = [];
  for (const entry of snapshot.resources) {
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
    const result = await actuator.resume(entry);
    dispatches.push({
      resourceId: entry.resourceId,
      name: entry.name,
      status: result.ok ? 'dispatched' : 'failed',
      detail: result.detail,
      ...(result.error ? { error: result.error } : {}),
    });
  }

  return { snapshot: next, dispatches };
}

export interface ResumePollResult {
  state: 'RESUMING' | 'RUNNING' | 'RESUME_FAILED';
  outcomes: ResumeOutcome[];
  progress: ResourceProgress[];
  unconfirmed: ResumeOutcome[];
  reason: string;
  /** True once every resource has settled one way or the other. */
  terminal: boolean;
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

  for (const entry of snapshot.resources) {
    const power = await actuator.readPower(entry);
    let outcome = confirmResume(entry, power.reading, power.error);
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
        outcome = {
          resourceId: entry.resourceId,
          confirmation: 'unknown',
          observedState: observed,
          reason:
            `ARM reports ${entry.name} is ${observed}, but a real request to it did not succeed: `
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
    };
  }

  return {
    state: verdict.state,
    outcomes,
    progress,
    unconfirmed: verdict.unconfirmed,
    terminal: true,
    reason: verdict.reason,
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
    ...(poll.state === 'RUNNING' ? { resumeConfirmedAt: now } : {}),
  };
}

/** Fold a pause poll back into the snapshot document for persistence. */
export function applyPausePoll(
  snapshot: EstatePauseSnapshot,
  poll: PausePollResult,
  now = new Date().toISOString(),
): EstatePauseSnapshot {
  if (snapshot.state !== poll.state) assertTransition(snapshot.state, poll.state);
  return {
    ...snapshot,
    state: poll.state,
    updatedAt: now,
    ...(poll.state === 'PAUSED' ? { pausedAt: now } : {}),
  };
}

// ===========================================================================
// The REAL side: estate id, the deploy-emitted manifest, and the ARM actuator.
//
// Everything below this line touches env and Azure. Everything above it is
// pure. The pure tests never reach past this comment.
// ===========================================================================

/**
 * The estate id. `LOOM_ESTATE_ID` when the deploy set one; otherwise derived
 * DETERMINISTICALLY from the subscription + admin RG the console is bound to.
 *
 * The derivation is not a guess about ownership — ownership still comes from the
 * manifest below. It only needs to be stable, so two snapshots of the same
 * estate carry the same key.
 */
export function resolveEstateId(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = (env.LOOM_ESTATE_ID || '').trim();
  if (explicit) return explicit;
  const sub = (env.LOOM_SUBSCRIPTION_ID || '').trim();
  const rg = (env.LOOM_ADMIN_RG || env.LOOM_ACA_RG || env.LOOM_DLZ_RG || '').trim();
  if (sub && rg) return `loom:${sub.slice(0, 8)}:${rg}`;
  return 'loom:unbound';
}

/** One entry of the deploy-emitted manifest, before any ARM read. */
export interface ManifestEntry {
  resourceId: string;
  resourceType: string;
  name: string;
  resourceGroup: string;
  subscriptionId: string;
  /** The env vars that produced this entry — shown in the UI so it is auditable. */
  fromEnv: string[];
}

/**
 * R-SCOPE-3 — resolve the pause set from the DEPLOY-EMITTED MANIFEST.
 *
 * The manifest is the console's own environment. `LOOM_SYNAPSE_WORKSPACE`,
 * `LOOM_KUSTO_CLUSTER_NAME`, `LOOM_AAS_SERVER_NAME` and friends are written by
 * the platform bicep at deploy time and name the EXACT resources this Loom
 * install is bound to. That makes them a per-resource ownership record with
 * precisely the property R-SCOPE-2b demands: it resolves ownership at the
 * RESOURCE, so a mixed resource group is not a problem — we never ask what else
 * is in the group.
 *
 * Read the two things this deliberately does NOT do:
 *
 *   • It does not enumerate a subscription. There is no `list resources` call
 *     anywhere in this file. 12 of the 23 pausable resources in these
 *     subscriptions belong to ten unrelated projects, and the only reliable way
 *     not to touch them is never to ask for them.
 *   • It does not enumerate a resource group. `rg-dlz-aiml-stack-dev` is
 *     measured to hold both Loom and non-Loom resources, so "everything in the
 *     Loom RGs" is wrong in exactly the same way as a name regex.
 *
 * A missing env var yields NO entry — an unnamed resource is simply not in the
 * pause set. Fail-safe means "leave it running".
 */
export function resolveDeployManifest(env: NodeJS.ProcessEnv = process.env): {
  manifest: DeployManifest;
  entries: ManifestEntry[];
  /** Types that could have been in the tier but had no env var naming them. */
  unresolved: Array<{ label: string; needs: string[] }>;
} {
  const estateId = resolveEstateId(env);
  const entries: ManifestEntry[] = [];
  const unresolved: Array<{ label: string; needs: string[] }> = [];
  const v = (k: string) => (env[k] || '').trim();

  // --- Synapse dedicated SQL pool -----------------------------------------
  const synSub = v('LOOM_SYNAPSE_SUB') || v('LOOM_SUBSCRIPTION_ID');
  const synRg = v('LOOM_SYNAPSE_RG') || v('LOOM_DLZ_RG');
  const synWs = v('LOOM_SYNAPSE_WORKSPACE');
  const synPool = v('LOOM_SYNAPSE_DEDICATED_POOL');
  if (synSub && synRg && synWs && synPool) {
    entries.push({
      resourceId:
        `/subscriptions/${synSub}/resourceGroups/${synRg}/providers/Microsoft.Synapse`
        + `/workspaces/${synWs}/sqlPools/${synPool}`,
      resourceType: 'microsoft.synapse/workspaces/sqlpools',
      name: synPool,
      resourceGroup: synRg,
      subscriptionId: synSub,
      fromEnv: ['LOOM_SYNAPSE_SUB', 'LOOM_SYNAPSE_RG', 'LOOM_SYNAPSE_WORKSPACE', 'LOOM_SYNAPSE_DEDICATED_POOL'],
    });
  } else {
    unresolved.push({
      label: 'Synapse dedicated SQL pool',
      needs: ['LOOM_SYNAPSE_SUB (or LOOM_SUBSCRIPTION_ID)', 'LOOM_SYNAPSE_RG (or LOOM_DLZ_RG)', 'LOOM_SYNAPSE_WORKSPACE', 'LOOM_SYNAPSE_DEDICATED_POOL'],
    });
  }

  // --- ADX cluster ---------------------------------------------------------
  const adxSub = v('LOOM_KUSTO_SUB') || v('LOOM_SUBSCRIPTION_ID');
  const adxRg = v('LOOM_KUSTO_RG') || v('LOOM_DLZ_RG');
  const adxName = v('LOOM_KUSTO_CLUSTER_NAME');
  if (adxSub && adxRg && adxName) {
    entries.push({
      resourceId: `/subscriptions/${adxSub}/resourceGroups/${adxRg}/providers/Microsoft.Kusto/clusters/${adxName}`,
      resourceType: 'microsoft.kusto/clusters',
      name: adxName,
      resourceGroup: adxRg,
      subscriptionId: adxSub,
      fromEnv: ['LOOM_KUSTO_SUB', 'LOOM_KUSTO_RG', 'LOOM_KUSTO_CLUSTER_NAME'],
    });
  } else {
    unresolved.push({
      label: 'Azure Data Explorer cluster',
      needs: ['LOOM_KUSTO_SUB (or LOOM_SUBSCRIPTION_ID)', 'LOOM_KUSTO_RG (or LOOM_DLZ_RG)', 'LOOM_KUSTO_CLUSTER_NAME'],
    });
  }

  // --- Analysis Services server -------------------------------------------
  const aasSub = v('LOOM_AAS_SUB') || v('LOOM_SUBSCRIPTION_ID');
  const aasRg = v('LOOM_AAS_RG') || v('LOOM_DLZ_RG') || v('LOOM_ADMIN_RG');
  const aasName = v('LOOM_AAS_SERVER_NAME') || v('LOOM_AAS_SERVER');
  if (aasSub && aasRg && aasName) {
    entries.push({
      resourceId: `/subscriptions/${aasSub}/resourceGroups/${aasRg}/providers/Microsoft.AnalysisServices/servers/${aasName}`,
      resourceType: 'microsoft.analysisservices/servers',
      name: aasName,
      resourceGroup: aasRg,
      subscriptionId: aasSub,
      fromEnv: ['LOOM_AAS_SUB', 'LOOM_AAS_RG', 'LOOM_AAS_SERVER_NAME'],
    });
  } else {
    unresolved.push({
      label: 'Azure Analysis Services server',
      needs: ['LOOM_SUBSCRIPTION_ID', 'LOOM_AAS_RG (or LOOM_DLZ_RG / LOOM_ADMIN_RG)', 'LOOM_AAS_SERVER_NAME'],
    });
  }

  // --- SHIR VM scale set ---------------------------------------------------
  const shirSub = v('LOOM_SUBSCRIPTION_ID');
  const shirRg = v('LOOM_PURVIEW_SHIR_RG') || v('LOOM_DLZ_RG') || v('LOOM_ADMIN_RG');
  const shirName = v('LOOM_PURVIEW_SHIR_VMSS_NAME') || v('LOOM_SHIR_VMSS_NAME');
  if (shirSub && shirRg && shirName) {
    entries.push({
      resourceId: `/subscriptions/${shirSub}/resourceGroups/${shirRg}/providers/Microsoft.Compute/virtualMachineScaleSets/${shirName}`,
      resourceType: 'microsoft.compute/virtualmachinescalesets',
      name: shirName,
      resourceGroup: shirRg,
      subscriptionId: shirSub,
      fromEnv: ['LOOM_SUBSCRIPTION_ID', 'LOOM_PURVIEW_SHIR_RG', 'LOOM_PURVIEW_SHIR_VMSS_NAME'],
    });
  } else {
    unresolved.push({
      label: 'Self-hosted integration runtime (VMSS)',
      needs: ['LOOM_SUBSCRIPTION_ID', 'LOOM_PURVIEW_SHIR_RG (or LOOM_DLZ_RG / LOOM_ADMIN_RG)', 'LOOM_PURVIEW_SHIR_VMSS_NAME'],
    });
  }

  return {
    manifest: { estateId, resourceIds: entries.map((e) => e.resourceId) },
    entries,
    unresolved,
  };
}

/**
 * Turn manifest entries into `DiscoveredResource` rows by reading each one's
 * tags from ARM.
 *
 * `discoverySource: 'deploy-manifest'` is the truthful label — these rows came
 * from the deploy's own environment, not from a Resource Graph sweep. And per
 * `DiscoveredResource`'s type, they carry NO power state: that is read
 * separately, from authoritative ARM, by the actuator.
 *
 * A tag read that FAILS produces `tags: null` + `tagsError`, which
 * `resolveOwnership` turns into `indeterminate` — non-pausable. The resource
 * stays running. That is the SHIR idle-stop contract: never act on uncertainty.
 */
export async function discoverFromManifest(
  entries: readonly ManifestEntry[],
  readTags: (resourceId: string) => Promise<Readonly<Record<string, string>> | null>,
): Promise<DiscoveredResource[]> {
  const out: DiscoveredResource[] = [];
  for (const e of entries) {
    let tags: Readonly<Record<string, string>> | null = null;
    let tagsError: string | undefined;
    try {
      tags = await readTags(e.resourceId);
      if (tags == null) tagsError = 'the ARM read returned no tags collection';
    } catch (err) {
      tags = null;
      tagsError = err instanceof Error ? err.message : String(err);
    }
    out.push({
      resourceId: e.resourceId,
      resourceType: e.resourceType,
      name: e.name,
      resourceGroup: e.resourceGroup,
      subscriptionId: e.subscriptionId,
      tags,
      ...(tagsError ? { tagsError } : {}),
      discoverySource: 'deploy-manifest',
    });
  }
  return out;
}

/** Normalise each provider's own power vocabulary onto `EstatePowerState`. */
export function normalizePowerState(resourceType: string, raw: unknown): EstatePowerState {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return 'Unknown';
  switch (resourceType.toLowerCase()) {
    case 'microsoft.synapse/workspaces/sqlpools':
      // Learn: Online | Paused | Pausing | Resuming | Scaling.
      if (s === 'online') return 'Online';
      if (s === 'paused') return 'Paused';
      if (s === 'pausing') return 'Pausing';
      if (s === 'resuming') return 'Resuming';
      if (s === 'scaling') return 'Scaling';
      return 'Unknown';
    case 'microsoft.kusto/clusters':
      // Learn: Running | Stopped | Starting | Stopping | Unavailable | Deleting.
      if (s === 'running') return 'Online';
      if (s === 'stopped') return 'Stopped';
      if (s === 'starting') return 'Starting';
      if (s === 'stopping') return 'Pausing';
      return 'Unknown';
    case 'microsoft.analysisservices/servers':
      // Learn: Succeeded (running) | Paused | Suspended | Suspending | Resuming | Scaling.
      if (s === 'succeeded') return 'Online';
      if (s === 'paused' || s === 'suspended') return 'Paused';
      if (s === 'suspending') return 'Pausing';
      if (s === 'resuming' || s === 'preparing' || s === 'provisioning') return 'Resuming';
      if (s === 'scaling') return 'Scaling';
      return 'Unknown';
    default:
      if (s === 'online' || s === 'running' || s === 'succeeded') return 'Online';
      if (s === 'paused' || s === 'stopped' || s === 'suspended') return 'Paused';
      if (s === 'deallocated') return 'Deallocated';
      return 'Unknown';
  }
}

/**
 * The REAL actuator. Every verb below delegates to a client that already ships:
 *
 *   Synapse pool  ->  synapse-pool-arm.ts   pausePool / resumePool / getPoolState
 *   ADX cluster   ->  kusto-arm-client.ts   stopKustoCluster / startKustoCluster
 *   AAS server    ->  arm-client.ts         armPost .../suspend | .../resume
 *   SHIR VMSS     ->  arm-client.ts         armPatch sku.capacity
 *
 * AAS and VMSS use the shared `armPost` / `armPatch` transport because no typed
 * client in this repo exposes a suspend or a scale-set capacity write — checked,
 * not assumed. They are the same authenticated ARM path every other client uses,
 * not a second transport.
 *
 * The imports are lazy so the pure half of this module stays importable in a
 * unit test without constructing an Azure credential chain.
 */
export async function createArmActuator(): Promise<EstateActuator> {
  const { armGet, armPost, armPatch } = await import('@/lib/azure/arm-client');

  const apiVersion = (resourceType: string): string =>
    pausableTypeSpec(resourceType)?.armApiVersion ?? '2021-04-01';

  const readTags = async (resourceId: string) => {
    // The api-version is per-provider, so derive it from the id's own type.
    const type = armTypeFromId(resourceId);
    const body = await armGet<{ tags?: Record<string, string> }>(
      `${resourceId}?api-version=${apiVersion(type)}`,
    );
    // ARM omits `tags` entirely when a resource has none. That is a SUCCESSFUL
    // read establishing "no tags", which is different from a failed read — so
    // return {} here and let a thrown error be the only `null`.
    return body?.tags ?? {};
  };

  const readPower = async (resource: {
    resourceId: string;
    resourceType: string;
    name: string;
  }): Promise<PowerRead> => {
    const version = apiVersion(resource.resourceType);
    try {
      const body = await armGet<{
        sku?: { name?: string; tier?: string; family?: string; capacity?: number };
        properties?: { status?: string; state?: string };
      }>(`${resource.resourceId}?api-version=${version}`);
      const raw = body?.properties?.status ?? body?.properties?.state;
      return {
        reading: armPowerReading({
          resourceId: resource.resourceId,
          powerState: normalizePowerState(resource.resourceType, raw),
          armApiVersion: version,
        }),
        ...(body?.sku ? { sku: body.sku } : {}),
        ...(typeof body?.sku?.capacity === 'number' ? { replicaCount: body.sku.capacity } : {}),
      };
    } catch (err) {
      // R7 — say what happened, do not convert a failed read into a state.
      return { reading: null, error: err instanceof Error ? err.message : String(err) };
    }
  };

  const pause = async (candidate: PauseCandidate): Promise<ActuatorResult> => {
    const { resource } = candidate;
    const type = resource.resourceType.toLowerCase();
    try {
      switch (type) {
        case 'microsoft.synapse/workspaces/sqlpools': {
          const { pausePool } = await import('@/lib/azure/synapse-pool-arm');
          await pausePool();
          return { ok: true, detail: `ARM accepted the pause of dedicated SQL pool ${resource.name}.` };
        }
        case 'microsoft.kusto/clusters': {
          const { stopKustoCluster } = await import('@/lib/azure/kusto-arm-client');
          const r = await stopKustoCluster();
          return { ok: true, detail: `ARM accepted the stop of ADX cluster ${resource.name} (${r.provisioningState}).` };
        }
        case 'microsoft.analysisservices/servers': {
          await armPost(`${resource.resourceId}/suspend?api-version=${apiVersion(type)}`);
          return { ok: true, detail: `ARM accepted the suspend of Analysis Services server ${resource.name}.` };
        }
        case 'microsoft.compute/virtualmachinescalesets': {
          await armPatch(`${resource.resourceId}?api-version=${apiVersion(type)}`, { sku: { capacity: 0 } });
          return { ok: true, detail: `ARM accepted scaling ${resource.name} to 0 instances.` };
        }
        default:
          return {
            ok: false,
            detail: `${resource.name} is type ${type}, which this PAUSE tier does not actuate.`,
            error: `unsupported-type:${type}`,
          };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, detail: `The pause of ${resource.name} was REJECTED by ARM.`, error: message };
    }
  };

  const resume = async (entry: PausedResourceSnapshot): Promise<ActuatorResult> => {
    const type = entry.resourceType.toLowerCase();
    try {
      switch (type) {
        case 'microsoft.synapse/workspaces/sqlpools': {
          const { resumePool } = await import('@/lib/azure/synapse-pool-arm');
          await resumePool();
          return { ok: true, detail: `ARM accepted the resume of dedicated SQL pool ${entry.name}.` };
        }
        case 'microsoft.kusto/clusters': {
          const { startKustoCluster } = await import('@/lib/azure/kusto-arm-client');
          const r = await startKustoCluster();
          return { ok: true, detail: `ARM accepted the start of ADX cluster ${entry.name} (${r.provisioningState}).` };
        }
        case 'microsoft.analysisservices/servers': {
          await armPost(`${entry.resourceId}/resume?api-version=${apiVersion(type)}`);
          return { ok: true, detail: `ARM accepted the resume of Analysis Services server ${entry.name}.` };
        }
        case 'microsoft.compute/virtualmachinescalesets': {
          const capacity = entry.replicaCount ?? entry.sku?.capacity ?? 1;
          await armPatch(`${entry.resourceId}?api-version=${apiVersion(type)}`, { sku: { capacity } });
          return { ok: true, detail: `ARM accepted restoring ${entry.name} to ${capacity} instance(s).` };
        }
        default:
          return {
            ok: false,
            detail: `${entry.name} is type ${type}, which this PAUSE tier does not actuate.`,
            error: `unsupported-type:${type}`,
          };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, detail: `The resume of ${entry.name} was REJECTED by ARM.`, error: message };
    }
  };

  /**
   * A REAL data-plane round-trip — the answer to "can it serve?", which the ARM
   * status field does not give. Each probe is the cheapest query the engine
   * supports, so the probe itself costs effectively nothing.
   */
  const probeServable = async (entry: PausedResourceSnapshot): Promise<ServabilityProbe> => {
    const type = entry.resourceType.toLowerCase();
    try {
      switch (type) {
        case 'microsoft.synapse/workspaces/sqlpools': {
          const { executeQuery, dedicatedTarget } = await import('@/lib/azure/synapse-sql-client');
          await executeQuery(dedicatedTarget(), 'SELECT 1 AS loom_pause_probe', 20_000);
          return { servable: true, probed: true, detail: `${entry.name} answered SELECT 1 over TDS.` };
        }
        case 'microsoft.kusto/clusters': {
          const { executeQuery } = await import('@/lib/azure/kusto-client');
          const db = (process.env.LOOM_KUSTO_DATABASE || '').trim();
          if (!db) {
            return {
              servable: false,
              probed: false,
              detail:
                'No LOOM_KUSTO_DATABASE is set, so no KQL probe could be issued. Whether the cluster '
                + 'can serve was NOT established.',
            };
          }
          await executeQuery(db, 'print loom_pause_probe = 1');
          return { servable: true, probed: true, detail: `${entry.name} answered a KQL print.` };
        }
        case 'microsoft.analysisservices/servers': {
          const { listDatabases } = await import('@/lib/azure/aas-server-client');
          await listDatabases();
          return { servable: true, probed: true, detail: `${entry.name} answered a model list over XMLA.` };
        }
        default:
          return {
            servable: false,
            probed: false,
            detail:
              `No data-plane probe is wired for ${type}. Whether ${entry.name} can serve was NOT `
              + 'established — only that ARM reports it running.',
          };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { servable: false, probed: true, detail: `${entry.name} did not answer a probe request: ${message}` };
    }
  };

  return { readTags, readPower, pause, resume, probeServable };
}

// ---------------------------------------------------------------------------
// Persistence — the snapshot document
// ---------------------------------------------------------------------------

/**
 * The Cosmos discriminator + document id. ONE live snapshot per tenant: the
 * estate has one pause state, so a second concurrent snapshot would be two
 * competing claims about the same resources.
 *
 * The document lives in the existing `maintenance-jobs` container (PK
 * `/tenantId`), which is already a multi-kind sink — `lib/azure/
 * spark-telemetry-audit.ts` stores its `spark-telemetry-audit` doc there the
 * same way, with the same fixed-id + point-read pattern. Reusing it means this
 * feature needs no new Cosmos container and therefore no bicep change to work
 * on an existing deployment.
 */
export const ESTATE_PAUSE_DOC_KIND = 'estate-pause-snapshot';
export const ESTATE_PAUSE_DOC_ID = 'estate-pause:current';

interface EstatePauseDoc {
  id: string;
  tenantId: string;
  kind: typeof ESTATE_PAUSE_DOC_KIND;
  snapshot: EstatePauseSnapshot;
  updatedAt: string;
}

/** Read the current pause snapshot for a tenant, or null when none exists. */
export async function loadPauseSnapshot(tenantId: string): Promise<EstatePauseSnapshot | null> {
  if (!tenantId) return null;
  const { maintenanceJobsContainer } = await import('@/lib/azure/cosmos-client');
  const c = await maintenanceJobsContainer();
  const { resource } = await c.item(ESTATE_PAUSE_DOC_ID, tenantId).read<EstatePauseDoc>();
  if (!resource || resource.kind !== ESTATE_PAUSE_DOC_KIND) return null;
  // Validate on the way IN, not on the way out: `deserializePauseSnapshot`
  // refuses a document whose power state did not come from ARM, and a snapshot
  // we cannot establish the meaning of must not silently drive a resume.
  const { deserializePauseSnapshot } = await import('./pause-state');
  return deserializePauseSnapshot(resource.snapshot);
}

/** Persist (upsert) the current pause snapshot. */
export async function savePauseSnapshot(snapshot: EstatePauseSnapshot): Promise<void> {
  const { maintenanceJobsContainer } = await import('@/lib/azure/cosmos-client');
  const c = await maintenanceJobsContainer();
  const doc: EstatePauseDoc = {
    id: ESTATE_PAUSE_DOC_ID,
    tenantId: snapshot.tenantId,
    kind: ESTATE_PAUSE_DOC_KIND,
    snapshot,
    updatedAt: new Date().toISOString(),
  };
  await c.items.upsert(doc);
}

/** `/subscriptions/x/resourceGroups/y/providers/A/b/n[/c/m]` -> `a/b[/c]`. */
export function armTypeFromId(resourceId: string): string {
  const i = resourceId.toLowerCase().indexOf('/providers/');
  if (i < 0) return '';
  const parts = resourceId.slice(i + '/providers/'.length).split('/').filter(Boolean);
  if (parts.length < 2) return '';
  // provider, type, name [, subtype, name]…  -> provider/type[/subtype]
  const segments = [parts[0], parts[1]];
  for (let p = 3; p < parts.length; p += 2) segments.push(parts[p]);
  return segments.join('/').toLowerCase();
}

// ---------------------------------------------------------------------------
// Small helpers shared by the three BFF routes
// ---------------------------------------------------------------------------

/**
 * A stable, order-independent digest of the resource ids in a preview.
 *
 * This is a DRIFT guard, not a security control — the caller is already a
 * tenant admin. Its job is the same as `/api/admin/updates/apply`'s
 * `confirmTag`: the operator confirmed a SPECIFIC set of resources, and if the
 * resolved set has changed since (a tag added, a resource re-created, an env
 * var rewired by a deploy), the confirm is refused with a 409 rather than
 * silently pausing something they never saw.
 *
 * FNV-1a over the sorted, lower-cased ids: dependency-free, deterministic, and
 * it changes when the SET changes rather than when its order does.
 */
export function previewToken(resourceIds: readonly string[]): string {
  const sorted = [...resourceIds].map((s) => s.toLowerCase()).sort();
  let h = 0x811c9dc5;
  for (const ch of sorted.join('|')) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${sorted.length}:${h.toString(16)}`;
}

/**
 * Name what is missing rather than echoing a raw failure.
 *
 * deploy-integrity R7: an error must not assert a cause the code did not
 * establish. "ARM threw" is not the same claim as "ARM is not configured", and
 * on 2026-08-05 exactly that substitution ("the tag does not exist" for "I could
 * not reach the registry") sent two investigations down the wrong path. So this
 * states what happened, states what is required, and quotes the raw text.
 */
export function armGateMessage(e: unknown): string {
  const detail = e instanceof Error ? e.message : String(e);
  return (
    'The estate pause surface could not reach the Azure control plane, so no state was read. '
    + 'The Console UAMI (LOOM_UAMI_CLIENT_ID) must be able to acquire an ARM token for this '
    + `deployment. This is NOT a statement that the estate is running or paused. Raw: ${detail.slice(0, 300)}`
  );
}
