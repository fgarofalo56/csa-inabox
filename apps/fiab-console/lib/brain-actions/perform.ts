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
 *   snapshot        fresh rebuild; complete collection (#4015/#4016)
 *   finding         the rebuild still produces this finding, subject matches
 *   ownership       fresh tag read still confirms it is OURS
 *   vacuity         the detector examined something real (P3)
 *   subject         Container App with full ARM coordinates, id derived here
 *   write scope     inside the credential's configured subscription + RG
 *   ARM freshness   authoritative GET still matches the evidence
 *   staged confirm  the two-step re-affirm gate (auto-tune's ARM_CLASSES
 *                   pattern, adapted from ticks to an explicit human confirm)
 *
 * `loadSnapshot` is injected by the route rather than imported here so this
 * package has no runtime dependency on `app/**` (the wire types are imported
 * type-only and erase at compile time).
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
  guardSnapshotComplete,
  guardWriteScope,
  resolvePerformSubject,
} from './guards';
import { resolvePerformEntry } from './registry';
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
  | { readonly kind: 'performed'; readonly receipt: PerformReceipt }
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
    };

export interface PerformDeps {
  /** Fresh snapshot rebuild — supplied by the route from the app's `_lib`. */
  readonly loadSnapshot: () => Promise<BrainSnapshot>;
  /** Overridable for tests; defaults to the Cosmos-backed singleton. */
  readonly store?: RecommendationStateStore;
}

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

  // ── server-side re-derivation: the fresh snapshot ───────────────────────
  const snapshot = await deps.loadSnapshot();

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
  const ids = { findingId: req.findingId, detector: req.detector };
  try {
    const receipt =
      executor === 'scale-to-zero'
        ? await executeScaleToZero(subject, fresh, ids)
        : await executeDeleteResource(subject, fresh, ids);
    await store.recordPerformed(req.findingId, receipt, actor);
    return { kind: 'performed', receipt };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await store.recordFailed(req.findingId, error, actor);
    return { kind: 'failed', executor, error, mutationConfirmed: false };
  }
}
