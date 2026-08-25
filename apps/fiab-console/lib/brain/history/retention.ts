/**
 * LOOM BRAIN W9 — RETENTION. Bounded, and STATED.
 *
 * An append-only history of the estate graph is a cost defect waiting to happen,
 * and `no-vaporware.md` / the cost mandate in the PRP do not allow a capability
 * whose growth nobody owns. So the bound is expressed in three places, each of
 * which independently caps something different:
 *
 *   maxVersions       50   How many versions any one estate keeps. Enforced in
 *                          `./capture` on EVERY successful write, before the
 *                          call returns — not by a sweeper that might never run.
 *   ttlSeconds    7776000  90 days. The Cosmos container's `defaultTtl`, wired
 *                          in `platform/fiab/bicep/modules/admin-plane/
 *                          loom-console-cosmos.bicep`. This is the backstop for
 *                          the case `maxVersions` cannot cover: an estate that
 *                          stopped being captured. Count-based pruning only runs
 *                          when something writes.
 *   maxDocumentBytes 1.6M  A version is ONE document. This is the point at which
 *                          a capture FAILS rather than truncating or chunking —
 *                          see `GraphVersionTooLargeError`.
 *
 * ── WHY THE NUMBERS ARE THESE NUMBERS ──────────────────────────────────────
 *
 * 50 versions: a version is only written when the graph SEMANTICALLY changed
 * (`./capture`), so 50 is 50 real estate changes, not 50 polls. Measured
 * baseline (PRP §2): 63 Container Apps / 29 jobs / 13 environments. At the
 * projected ~250 bytes per node and ~200 per edge that is roughly 60-100 KB per
 * version, so the steady state is single-digit MB per estate. If the ARG query
 * is ever widened to the full estate (2,438 nodes measured), that becomes
 * ~1 MB/version and 50 MB retained — which is why `maxDocumentBytes` exists as a
 * hard stop rather than a warning.
 *
 * 90 days: long enough for `nodeUnreachableForConsecutiveVersions` to have a
 * meaningful window on a slow-moving estate, short enough that an abandoned
 * estate's history does not accrue indefinitely.
 *
 * 1.6 MB: below Cosmos's 2 MiB item ceiling with room for the JSON envelope and
 * the system properties Cosmos adds. NOT at the ceiling — a capture that fails
 * at the ceiling fails inside Cosmos with a generic error, and R6 says a failure
 * must classify itself and hand back a concrete remediation.
 */

import type { GraphVersionSummary } from './model';

/** Versions kept per estate. Enforced on every write in `./capture`. */
export const DEFAULT_MAX_VERSIONS = 50;

/** Container `defaultTtl`, in seconds. 90 days. Wired in bicep. */
export const DEFAULT_TTL_SECONDS = 7_776_000;

/** The single-document budget. A capture over this FAILS; it never truncates. */
export const DEFAULT_MAX_DOCUMENT_BYTES = 1_600_000;

/**
 * The minimum observed span before "unreachable across N versions" may be read
 * as a SAFE-TO-PRUNE signal.
 *
 * 24 hours. #3935: *"A node with no inbound edge today may be newly provisioned
 * and not yet wired."* The version count alone does not protect against that —
 * a deploy can produce several graph changes in minutes, and a resource created
 * at the start of it would be unreachable in every one of them. The version
 * count answers *"is this persistent?"*; the span answers *"has enough real time
 * passed for the wiring to have happened?"*, and a prune predicate needs both.
 */
export const SAFE_PRUNE_MIN_SPAN_MS = 86_400_000;

export interface RetentionPolicy {
  readonly maxVersions: number;
  readonly ttlSeconds: number;
  readonly maxDocumentBytes: number;
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  maxVersions: DEFAULT_MAX_VERSIONS,
  ttlSeconds: DEFAULT_TTL_SECONDS,
  maxDocumentBytes: DEFAULT_MAX_DOCUMENT_BYTES,
};

/**
 * Which version ids must go so that at most `maxVersions` remain.
 *
 * Pure and total, so the bound is testable without a store: hand it 60
 * summaries and it names the 10 oldest. The input is CHRONOLOGICAL (oldest
 * first) and is re-sorted here anyway — a store returning them newest-first
 * would otherwise prune the newest 10, which is the worst possible failure of a
 * retention routine and exactly the kind of ordering assumption that does not
 * survive a refactor.
 */
export function planPrune(
  summaries: readonly GraphVersionSummary[],
  maxVersions: number,
): readonly string[] {
  if (maxVersions < 1) {
    throw new RangeError(
      `maxVersions must be at least 1 (got ${maxVersions}). A retention policy that keeps ` +
        'nothing would delete the version just written and leave the history permanently empty.',
    );
  }
  const chronological = [...summaries].sort((a, b) => {
    if (a.capturedAt < b.capturedAt) return -1;
    if (a.capturedAt > b.capturedAt) return 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const excess = chronological.length - maxVersions;
  if (excess <= 0) return [];
  return chronological.slice(0, excess).map((s) => s.id);
}
