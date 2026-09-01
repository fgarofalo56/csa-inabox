/**
 * ESTATE PAUSE — discovery-read CLASSIFICATION (#4243 + review round 1).
 *
 * Extracted from `./pause-orchestrator` on 2026-08-31 when that file crossed
 * the 1500-LOC monolith ceiling (`scripts/ci/check-file-size.mjs`) — the same
 * bounded-context treatment as `./pause-actuator`. The orchestrator re-exports
 * every symbol below verbatim, so existing importers keep working unchanged.
 *
 * WHAT THIS MODULE DECIDES: what one manifest tag read OBSERVED — and the
 * decision is load-bearing, because the three answers route three different
 * ways:
 *
 *   absent      -> the entry is EXCLUDED from the pause population (both GET
 *                  and POST, symmetrically, so the preview token stays
 *                  coherent) and surfaced with the env remediation;
 *   throttled   -> the row stays, and the pause REFUSES with a retry message;
 *   unreachable -> same as throttled, labelled honestly as unreachable.
 *
 * Pure and side-effect-free: no fetch, no Azure client. Callers hand in what
 * discovery already read, which is what makes every branch testable.
 */

import type { DiscoveredResource } from './pause-inventory';

/**
 * What ONE failed manifest read OBSERVED (#4243 review round 1).
 *
 *   absent      ARM ANSWERED and said the named resource does not exist. That
 *               is a POSITIVE observation, not a failed read.
 *   throttled   ARM refused to answer (429, stayed throttled through the
 *               bounded retry). Nothing was established.
 *   unreachable Any other failure — timeout, 5xx, auth, network. Nothing was
 *               established.
 */
export type TagReadObservationKind = 'absent' | 'throttled' | 'unreachable';

// Anchored on OUR OWN error formats, never a bare numeric substring — a bare
// `\b429\b` matches a resource name or a body byte-count and misclassifies
// (recorded incident class in this repo: a bare substring signal blocked two
// retryables). `armGetWithRetry` throws "… was throttled (429) …"; single-shot
// arm-client errors are "ARM <verb> <path> failed <status>: <body>".
const THROTTLED_SHAPE = /was throttled \(429\)|failed 429\b/;
// The 404 family: the transport-level status from arm-client's format, plus
// ARM's NotFound error codes for injected readers that surface the body only.
const ABSENT_SHAPE =
  /failed 404\b|\b(?:Parent)?ResourceNotFound\b|\bResourceGroupNotFound\b|\bSubscriptionNotFound\b/;

/** Classify a tag-read error string. See `TagReadObservationKind`. */
export function classifyTagReadFailure(error: string): TagReadObservationKind {
  if (THROTTLED_SHAPE.test(error)) return 'throttled';
  if (ABSENT_SHAPE.test(error)) return 'absent';
  return 'unreachable';
}

/** One discovery read that FAILED (throttled/unreachable — never `absent`). */
export interface DiscoveryReadFailure {
  resourceId: string;
  name: string;
  error: string;
  kind: 'throttled' | 'unreachable';
  /** Convenience mirror of `kind === 'throttled'` for display code. */
  throttled: boolean;
}

/** A deploy-named id ARM POSITIVELY reports does not exist. */
export interface AbsentManifestResource {
  resourceId: string;
  name: string;
  /** The raw ARM answer that established the absence. */
  error: string;
  /** The env vars that composed the id — the remediation names them. */
  fromEnv: string[];
  /** Shown verbatim in the UI, the 202 payload, and the audit row. */
  statement: string;
}

/**
 * The manifest facts `partitionDiscovery` needs — STRUCTURAL on purpose.
 * `pause-orchestrator`'s `ManifestEntry` satisfies it; depending on the shape
 * instead of the type keeps this module import-acyclic with the orchestrator
 * (which re-exports this module).
 */
export interface NamedManifestId {
  resourceId: string;
  /** The env vars that composed the id — carried into the absence statement. */
  fromEnv: readonly string[];
}

export interface DiscoveryPartition {
  /** Rows that exist (read OK) or whose readability is merely UNKNOWN. The
   *  unknown ones STAY here so they surface as `indeterminate` in the
   *  population and trip the reads-failed refusal — fail-safe, never silent. */
  present: DiscoveredResource[];
  /** Positively absent — excluded from the population on BOTH the GET and the
   *  POST side, so the preview token stays coherent across the two. */
  absent: AbsentManifestResource[];
  /** Reads that FAILED without establishing anything. */
  readFailures: DiscoveryReadFailure[];
}

/**
 * #4243 review round 1 — split discovery into PRESENT / ABSENT / UNREADABLE.
 *
 * ── WHY ABSENT IS ITS OWN CLASS AND NOT A READ FAILURE ─────────────────────
 * The live estate composes a SHIR id from mismatched env coordinates
 * (LOOM_DLZ_RG = the admin RG, no DLZ sub var yet), so ARM answers 404 on that
 * id DETERMINISTICALLY. Treating that 404 as a "failed read" made the strict
 * reads-failed gate refuse EVERY live pause with a "retry" remediation a
 * permanent 404 can never satisfy — strictly worse than the old behaviour,
 * which proceeded with the row silently indeterminate.
 *
 * A 404 is not uncertainty. ARM answered: THERE IS NO RESOURCE AT THIS ID.
 * Nothing at a nonexistent id can be paused, so the honest treatment is to
 * EXCLUDE the entry from the population (symmetrically, GET and POST, so the
 * token's m-part agrees while the absence persists), surface a NAMED warning
 * that says which env values to fix, and let the pause proceed over the
 * resources that do exist. If the resource later APPEARS, the m-part changes
 * and the drift gate refuses with the population-changed message — also a
 * positive observation. Throttled/timeout/5xx stay strict: they establish
 * nothing and still refuse with the retry message.
 */
export function partitionDiscovery(
  discovered: readonly DiscoveredResource[],
  entries: readonly NamedManifestId[],
): DiscoveryPartition {
  const byId = new Map(entries.map((e) => [e.resourceId.toLowerCase(), e]));
  const present: DiscoveredResource[] = [];
  const absent: AbsentManifestResource[] = [];
  const readFailures: DiscoveryReadFailure[] = [];
  for (const d of discovered) {
    if (d.tagsError == null) {
      present.push(d);
      continue;
    }
    const kind = classifyTagReadFailure(d.tagsError);
    if (kind === 'absent') {
      const fromEnv = [...(byId.get(d.resourceId.toLowerCase())?.fromEnv ?? [])];
      absent.push({
        resourceId: d.resourceId,
        name: d.name,
        error: d.tagsError,
        fromEnv,
        statement:
          `${d.name} is EXCLUDED from the pause set: the deploy environment names it`
          + `${fromEnv.length ? ` (${fromEnv.join(', ')})` : ''}, but ARM positively reports that no `
          + 'resource exists at that id. Nothing at a nonexistent id can be paused, so the pause '
          + 'proceeds without it. Fix those env values so they address the real resource. '
          + `Raw: ${d.tagsError.slice(0, 200)}`,
      });
      continue;
    }
    // Unreadable rows STAY in the population — they render as indeterminate
    // and trip the reads-failed refusal. Never silently dropped.
    present.push(d);
    readFailures.push({
      resourceId: d.resourceId,
      name: d.name,
      error: d.tagsError,
      kind,
      throttled: kind === 'throttled',
    });
  }
  return { present, absent, readFailures };
}
