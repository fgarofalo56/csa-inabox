/**
 * ESTATE PAUSE — the preview DRIFT TOKEN and its one sanctioned comparator
 * (#4243 + review round 1).
 *
 * Extracted from `./pause-orchestrator` on 2026-08-31 when that file crossed
 * the 1500-LOC monolith ceiling (`scripts/ci/check-file-size.mjs`) — the same
 * bounded-context treatment as `./pause-actuator`. The orchestrator re-exports
 * every symbol below verbatim, so existing importers keep working unchanged.
 *
 * Pure and dependency-free (FNV-1a, no crypto import): what makes the drift
 * gate testable is that this module never reads env and never touches Azure.
 */

import type { DiscoveryReadFailure } from './pause-discovery-classify';

/** FNV-1a over the sorted, lower-cased ids: dependency-free, deterministic,
 *  and it changes when the SET changes rather than when its order does. */
function idsDigest(resourceIds: readonly string[]): string {
  const sorted = [...resourceIds].map((s) => s.toLowerCase()).sort();
  let h = 0x811c9dc5;
  for (const ch of sorted.join('|')) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${sorted.length}:${h.toString(16)}`;
}

/** What a preview token is computed FROM. See `previewToken`. */
export interface PreviewTokenInput {
  /** The ADDRESSABLE manifest population: env-derived deploy-named ids MINUS
   *  any id ARM positively reports absent (`partitionDiscovery`). Never a
   *  failed-read artifact. */
  manifestIds: readonly string[];
  /** The POSITIVELY-ESTABLISHED pause set (`dryRun.wouldPause`) — meaningful
   *  only when `readFailures` is 0, and compared only then. */
  establishedIds: readonly string[];
  /** How many discovery tag reads FAILED when this preview was computed. */
  readFailures: number;
}

/**
 * A stable, order-independent digest of a preview — a DRIFT guard, not a
 * security control (the caller is already a tenant admin). Same job as
 * `/api/admin/updates/apply`'s `confirmTag`: the operator confirmed a SPECIFIC
 * set, and if that set has genuinely changed since, the confirm is refused.
 *
 * ── #4243 — WHY THIS IS STRUCTURED, NOT ONE HASH ───────────────────────────
 * The first version hashed `wouldPause` — the TRANSIENTLY-READABLE set. One
 * throttled (429) tag read silently dropped a resource into `indeterminate`,
 * the count-embedding token changed, and the drift gate fired over an estate
 * that had NOT changed — with a refusal asserting "the set changed", a cause
 * the code never established (deploy-integrity R7). The live 2026-08-31 pause
 * failure was exactly this, manufactured by the console's own read-warmer
 * saturating the UAMI's ARM budget.
 *
 * So the token carries THREE facts, each compared only against its own
 * population (never a token built from a different one):
 *
 *   m — the ADDRESSABLE manifest population: the env-derived deploy-named ids
 *       MINUS any id ARM positively reports absent (`partitionDiscovery`).
 *       Built from the environment plus positive observations only — never
 *       from a failed read, so a throttled read cannot move it. A mismatch
 *       here is a POSITIVELY-observed change (a deploy rewired the env, or a
 *       named resource appeared/was removed) and refuses as real drift.
 *   p — the positively-established pause set. Compared ONLY when BOTH sides
 *       resolved with zero read failures; a mismatch then is a positively-
 *       observed membership change (a tag moved) and refuses as real drift.
 *   f — how many reads failed at preview time. Non-zero marks the preview
 *       itself as degraded, so a later confirm of it is refused with the
 *       honest "retry" message, never a drift claim.
 *
 * `evaluateDrift` is the only sanctioned comparator.
 */
export function previewToken(input: PreviewTokenInput): string {
  return `v2.m${idsDigest(input.manifestIds)}.p${idsDigest(input.establishedIds)}.f${input.readFailures}`;
}

export interface ParsedPreviewToken {
  manifestDigest: string;
  manifestCount: number;
  establishedDigest: string;
  establishedCount: number;
  readFailures: number;
}

/** Parse a v2 preview token. `null` for anything else — including the legacy
 *  single-hash format AND any non-string value (the token arrives from an
 *  untrusted JSON body, so `{"confirmToken": 5}` must land in the audited
 *  stale-token refusal, never crash `.trim()` into a generic 500 — #4243
 *  review round 1). Stale is never reported as drift. */
export function parsePreviewToken(token: unknown): ParsedPreviewToken | null {
  if (typeof token !== 'string') return null;
  const m = /^v2\.m(\d+):([0-9a-f]+)\.p(\d+):([0-9a-f]+)\.f(\d+)$/.exec(token.trim());
  if (!m) return null;
  return {
    manifestCount: Number(m[1]),
    manifestDigest: `${m[1]}:${m[2]}`,
    establishedCount: Number(m[3]),
    establishedDigest: `${m[3]}:${m[4]}`,
    readFailures: Number(m[5]),
  };
}

/** The three-way (plus refusal-shape) verdict of the drift gate. */
export type DriftVerdict =
  /** Token matches a fully-established, unchanged estate. Act. */
  | { kind: 'proceed' }
  /** #3989 — no token at all. The gate is not opt-in. */
  | { kind: 'no-token' }
  /** Unparseable / pre-v2 token. Stale, NOT evidence of drift. */
  | { kind: 'stale-token' }
  /** POSITIVELY observed: the env-derived manifest population changed. */
  | { kind: 'manifest-changed'; confirmedCount: number; currentCount: number }
  /** Discovery reads failed NOW — nothing established the estate changed. */
  | { kind: 'reads-failed'; failures: DiscoveryReadFailure[] }
  /** The PREVIEW was computed while reads were failing — its set may be short. */
  | { kind: 'preview-degraded'; previewFailures: number }
  /** POSITIVELY observed: both sides fully read, and the pause set differs. */
  | { kind: 'set-changed'; confirmedCount: number; currentCount: number };

/**
 * THE ONLY SANCTIONED TOKEN COMPARATOR (#4243).
 *
 * The invariant: a "the set changed" refusal is issued ONLY on a positively-
 * observed change — a manifest (env-derived) difference, or an established-set
 * difference measured with zero read failures on BOTH sides. Every other
 * non-match is reported as what it is: a missing token, a stale token, or
 * reads that failed — with a retry remediation, because nothing established
 * that the estate changed (deploy-integrity R7).
 */
export function evaluateDrift(args: {
  /** From an untrusted JSON body — a non-string parses as stale, never throws. */
  confirmToken: unknown;
  manifestIds: readonly string[];
  establishedIds: readonly string[];
  readFailures: DiscoveryReadFailure[];
}): DriftVerdict {
  if (!args.confirmToken) return { kind: 'no-token' };
  const parsed = parsePreviewToken(args.confirmToken);
  if (!parsed) return { kind: 'stale-token' };

  // (1) The stable population. Env-derived on both sides, so this comparison
  //     is valid even when every read failed — same population by construction.
  const manifestNow = idsDigest(args.manifestIds);
  if (parsed.manifestDigest !== manifestNow) {
    return {
      kind: 'manifest-changed',
      confirmedCount: parsed.manifestCount,
      currentCount: args.manifestIds.length,
    };
  }

  // (2) Reads failed NOW -> the current membership is only partially known.
  //     Refuse with retry; never compare a full population against a partial one.
  if (args.readFailures.length > 0) return { kind: 'reads-failed', failures: args.readFailures };

  // (3) The PREVIEW was partial -> the operator confirmed a possibly-short set.
  //     Also not drift: nothing says the estate changed, only that the preview
  //     must be retaken now that reads succeed.
  if (parsed.readFailures > 0) return { kind: 'preview-degraded', previewFailures: parsed.readFailures };

  // (4) Both sides fully established. A difference HERE is real drift.
  const establishedNow = idsDigest(args.establishedIds);
  if (parsed.establishedDigest !== establishedNow) {
    return {
      kind: 'set-changed',
      confirmedCount: parsed.establishedCount,
      currentCount: args.establishedIds.length,
    };
  }
  return { kind: 'proceed' };
}
