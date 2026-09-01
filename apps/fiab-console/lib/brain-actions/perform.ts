/**
 * LOOM BRAIN ACTIONS — the perform orchestrator (#4242).
 *
 * The ONLY path from a recommendation to an Azure write. The route
 * (`app/api/admin/brain/perform`) parses + authorizes + audits; THIS module
 * runs the guard chain in order and, only when every guard passes AND the
 * staged confirm has been consumed, hands the server-resolved subject to an
 * executor.
 *
 * The guard ORDER is load-bearing — cheapest and most categorical first:
 *
 *   registry        can this class be performed AT ALL? (security: never)
 *   estate scope    the mutation path is bound to ONE estate id (#4258 item 2)
 *   snapshot        fresh rebuild; complete collection (#4015/#4016)
 *   finding         the rebuild still produces this finding, subject matches
 *   ownership       fresh tag read still confirms it is OURS
 *   vacuity         the detector examined something real (P3)
 *   subject         Container App with full ARM coordinates, id derived here
 *   statefulness    the deploy does not declare this a pinned singleton (#4257)
 *   write scope     inside the credential's configured subscription + RG
 *   ARM freshness   authoritative GET still matches the evidence
 *   staged confirm  the two-step re-affirm gate (auto-tune's ARM_CLASSES
 *                   pattern, adapted from ticks to an explicit human confirm)
 *
 * `loadSnapshot` is injected by the route rather than imported here so this
 * package has no runtime dependency on `app/**` (the wire types are imported
 * type-only and erase at compile time).
 *
 * ── THE MUTATION PATH IS ESTATE-SCOPED (#4258 item 2) ──────────────────────
 * `loadSnapshot()` used to be called with NO arguments here, which
 * `lib/brain/graph/extractors/resource-graph.ts` explicitly forbids for a
 * mutating caller: with no `estateId`, ANY non-empty `loom-estate-id` tag value
 * counts as owned. That is fine for the estate-wide report the graph route
 * serves and is not fine for a write — once #4255's backfill stamps tags,
 * `guardOwnership` would have degraded to "carries some Loom estate tag", with
 * only the write-scope guard bounding the blast radius. The estate id is now
 * resolved here and REQUIRED: unresolvable means refuse, never run permissive.
 */

import type { BrainSnapshot } from '@/app/api/admin/brain/_lib/wire';
import {
  AcaArmError,
  readAcaConfig,
} from '@/lib/azure/container-apps-arm-client';
import {
  executeDeleteResource,
  executeScaleToZero,
  freshContainerAppRead,
} from './executors';
import {
  guardDetectorNotVacuous,
  guardEvidenceFresh,
  guardFindingPresent,
  guardOwnership,
  guardScalableToZero,
  guardSnapshotComplete,
  guardWriteScope,
  resolvePerformSubject,
} from './guards';
import { resolvePerformEntry } from './registry';
import { declaredNonScalableToZero } from './scalability';
import { recommendationStateStore, type RecommendationStateStore, type StateActor } from './state-store';
import type {
  GuardRefusal,
  PerformExecutorKind,
  PerformReceipt,
  PerformRequest,
} from './types';

/** Every way a perform attempt can end. All of them are audited by the route. */
export type PerformOutcome =
  | { readonly kind: 'not-performable'; readonly reason: string }
  | { readonly kind: 'refused'; readonly refusal: GuardRefusal }
  | {
      readonly kind: 'staged';
      readonly executor: PerformExecutorKind;
      readonly confirmToken: string;
      readonly expiresAt: string;
    }
  | {
      readonly kind: 'performed';
      readonly receipt: PerformReceipt;
      /**
       * Whether the state store accepted the performed record. A store outage
       * AFTER a confirmed ARM write must never un-claim the mutation (R7 in
       * the inverted direction) — the receipt is returned regardless, with
       * this disclosure attached, mirroring the proposals route's
       * `persisted: false` pattern.
       */
      readonly persisted: boolean;
      readonly persistError?: string;
    }
  | {
      readonly kind: 'failed';
      readonly executor: PerformExecutorKind;
      /** The real error, verbatim. */
      readonly error: string;
      /**
       * Whether the write was CONFIRMED. Always false on this arm — a failed
       * call is never claimed as "not mutated" either, because a transport
       * failure mid-write establishes neither (R7). The audit row carries the
       * same honesty.
       */
      readonly mutationConfirmed: false;
      /** Whether the failure record reached the state store (fail-soft). */
      readonly persisted: boolean;
      readonly persistError?: string;
    };

export interface PerformDeps {
  /**
   * Fresh snapshot rebuild — supplied by the route from the app's `_lib`.
   *
   * Takes the estate id, and this module SUPPLIES it: a mutating caller that
   * rebuilds without one gets ownership resolved permissively (#4258 item 2).
   * The parameter is required here so a caller cannot omit it by accident.
   */
  readonly loadSnapshot: (opts: { readonly estateId: string }) => Promise<BrainSnapshot>;
  /** Overridable for tests; defaults to the Cosmos-backed singleton. */
  readonly store?: RecommendationStateStore;
  /**
   * The estate this mutation is scoped to. Defaults to `LOOM_ESTATE_ID`;
   * overridable so the estate-scope arm is testable without touching env.
   */
  readonly estateId?: string;
}

/** The env var the deploy sets to bind this console to one estate (#3922). */
export const ESTATE_ID_ENV = 'LOOM_ESTATE_ID';

export async function performRecommendation(
  req: PerformRequest,
  actor: StateActor,
  deps: PerformDeps,
): Promise<PerformOutcome> {
  // ── registry: is this class performable at all? ─────────────────────────
  const entry = resolvePerformEntry(req.detector);
  if (!entry.performable || !entry.executor) {
    return {
      kind: 'not-performable',
      reason:
        entry.notPerformableReason ??
        `Detector '${req.detector}' has no registered executor.`,
    };
  }
  const executor = entry.executor;
  const store = deps.store ?? recommendationStateStore();

  // ── estate scope: a mutating rebuild MUST be bound to one estate ────────
  //
  // `resource-graph.ts` states the rule this enforces: without an estate id,
  // any non-empty `loom-estate-id` value counts as owned, which "is NOT
  // sufficient for a cleanup recommendation, because it cannot tell two Loom
  // estates apart". Refusing is the fail-closed direction — running permissive
  // would widen ownership on the one path that writes.
  const estateId = (deps.estateId ?? process.env[ESTATE_ID_ENV] ?? '').trim();
  if (estateId === '') {
    return {
      kind: 'refused',
      refusal: {
        guard: 'estate-scoped',
        reason:
          `REFUSED: ${ESTATE_ID_ENV} is not set on this console, so the fresh rebuild cannot be ` +
          'scoped to one estate. Ownership would then be resolved permissively — any resource ' +
          "carrying ANY non-empty 'loom-estate-id' value would read as owned, including a " +
          'sibling Loom estate sharing these subscriptions. A mutation is not performed from an ' +
          'unscoped rebuild. The deploy stamping the estate id is tracked as #3922. Nothing was ' +
          'changed in Azure.',
      },
    };
  }

  // ── server-side re-derivation: the fresh snapshot ───────────────────────
  const snapshot = await deps.loadSnapshot({ estateId });

  const incomplete = guardSnapshotComplete(snapshot);
  if (incomplete) return { kind: 'refused', refusal: incomplete };

  const located = guardFindingPresent(snapshot, req);
  if ('refusal' in located) return { kind: 'refused', refusal: located.refusal };
  const { finding, node } = located;

  const unowned = guardOwnership(finding);
  if (unowned) return { kind: 'refused', refusal: unowned };

  const vacuous = guardDetectorNotVacuous(snapshot, finding);
  if (vacuous) return { kind: 'refused', refusal: vacuous };

  const resolved = resolvePerformSubject(node);
  if ('refusal' in resolved) return { kind: 'refused', refusal: resolved.refusal };
  const { subject } = resolved;

  // ── #4257: the deploy's own declaration, BEFORE any ARM read or write ────
  const notScalable = guardScalableToZero(
    subject,
    executor,
    declaredNonScalableToZero(subject.displayName),
  );
  if (notScalable) return { kind: 'refused', refusal: notScalable };

  const outOfScope = guardWriteScope(subject, readAcaConfig());
  if (outOfScope) return { kind: 'refused', refusal: outOfScope };

  // ── ARM freshness: the authoritative read (#4015/#4016) ─────────────────
  let fresh;
  try {
    fresh = await freshContainerAppRead(subject);
  } catch (e) {
    const detail =
      e instanceof AcaArmError ? `ARM status ${e.status}: ${e.message}` : String(e);
    return {
      kind: 'refused',
      refusal: {
        guard: 'evidence-fresh',
        reason:
          `REFUSED: the current state of '${subject.displayName}' could NOT be read ` +
          `from ARM (${detail}), so the finding's evidence cannot be re-confirmed. ` +
          'Refusing rather than acting on an unverified state — this message says ' +
          '"could not read", not "does not match", because that is all that was ' +
          'established. Nothing was changed in Azure.',
      },
    };
  }

  const stale = guardEvidenceFresh(subject, fresh, executor);
  if (stale) return { kind: 'refused', refusal: stale };

  // ── the staged two-step confirm (every phase-1 executor is destructive) ─
  if (!req.confirmToken) {
    const staged = await store.stage(req.findingId, req.detector, req.subjectNodeId, actor);
    return {
      kind: 'staged',
      executor,
      confirmToken: staged.confirmToken,
      expiresAt: staged.expiresAt,
    };
  }
  const badConfirm = await store.consumeStagedToken(
    req.findingId,
    req.detector,
    req.subjectNodeId,
    req.confirmToken,
    actor,
  );
  if (badConfirm) return { kind: 'refused', refusal: badConfirm };

  // ── execute, with the real before/after ─────────────────────────────────
  //
  // THE TRY SCOPES THE EXECUTOR CALL ONLY (review of #4246, blocker). When the
  // executor and the state-store write shared one try, a Cosmos failure AFTER
  // a successful ARM write ran the catch and answered `failed` for a mutation
  // the code held a confirmed receipt for — R7 in the inverted direction —
  // and a second store failure inside the catch escaped this function
  // entirely, so a completed destructive mutation produced ZERO audit rows.
  // Now: once a receipt is held the outcome IS `performed`; store writes are
  // fail-soft with a `persisted:false` disclosure (the proposals route's
  // pattern), and no store outage can prevent this function returning an
  // outcome for the route to audit.
  const ids = { findingId: req.findingId, detector: req.detector };
  let receipt: PerformReceipt;
  try {
    receipt =
      executor === 'scale-to-zero'
        ? await executeScaleToZero(subject, fresh, ids)
        : await executeDeleteResource(subject, fresh, ids);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    let persisted = true;
    let persistError: string | undefined;
    try {
      await store.recordFailed(req.findingId, error, actor);
    } catch (se) {
      persisted = false;
      persistError = se instanceof Error ? se.message : String(se);
    }
    return {
      kind: 'failed',
      executor,
      error,
      mutationConfirmed: false,
      persisted,
      ...(persistError !== undefined ? { persistError } : {}),
    };
  }

  let persisted = true;
  let persistError: string | undefined;
  try {
    await store.recordPerformed(req.findingId, receipt, actor);
  } catch (e) {
    persisted = false;
    persistError = e instanceof Error ? e.message : String(e);
  }
  return {
    kind: 'performed',
    receipt,
    persisted,
    ...(persistError !== undefined ? { persistError } : {}),
  };
}
