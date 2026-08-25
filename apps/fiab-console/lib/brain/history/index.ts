/**
 * LOOM BRAIN W9 — graph history. Public surface (#3935).
 *
 * ONE import path for everything the rest of the Brain and the console need:
 *
 *     import {
 *       captureGraphVersion, buildHistory, diffVersions,
 *       edgesAddedSince, nodeUnreachableForConsecutiveVersions,
 *     } from '@/lib/brain/history';
 *
 * ── WHAT THIS LAYER IS FOR ─────────────────────────────────────────────────
 * The Brain's central claim is that *"an edge that should not have formed"* is a
 * security finding. Without a `before`, that sentence has no referent: a
 * snapshot can say a node is unreachable NOW, but not that a route GAINED a
 * privileged edge and no authorization edge. This layer is the `before`.
 *
 * It is also what makes pruning safe. A node with no inbound edge today may be
 * newly provisioned and not yet wired; a node with no inbound edge across N
 * consecutive versions AND a real span of wall clock is genuinely dead.
 * Recommending a deletion off a single snapshot is how the Brain would delete
 * something that was mid-deploy.
 *
 * ── THE ONE THING A CONSUMER MUST NOT DO ───────────────────────────────────
 * Do not read a result without its `population`. `versionsExamined < 2` means
 * NO BASIS, not "no changes", and the two render identically unless the
 * consumer distinguishes them. Every result in this module carries a
 * {@link HistoryPopulation} with `blind` already computed for exactly that
 * reason (`../types.ts` P3).
 *
 * ── PURITY ─────────────────────────────────────────────────────────────────
 * Everything here is pure except `./cosmos-store`, which is the only module
 * permitted an Azure import and is NOT re-exported from this barrel — importing
 * the pure layer must never drag the Azure SDK into a bundle. Reach for
 * `@/lib/brain/history/cosmos-store` explicitly, from server code only.
 */

export {
  HISTORY_FORMAT_VERSION,
  GraphVersionIntegrityError,
  GraphVersionTooLargeError,
  UnknownBaseVersionError,
  type EdgeChange,
  type FieldChange,
  type GraphDiff,
  type GraphVersion,
  type GraphVersionContent,
  type GraphVersionCounts,
  type GraphVersionSummary,
  type HistoryPopulation,
  type IntegrityCheck,
  type NodeChange,
  type RawValueClass,
  type RelationProvenanceChange,
  type VersionEdge,
  type VersionEdgeEvidence,
  type VersionEdgeRecord,
  type VersionNode,
  type VersionNodeIngress,
  type VersionNodeScale,
} from './model';

export {
  canonicalizeContent,
  computeContentDigest,
  computeCounts,
  verifyGraphVersion,
  versionId,
  type IntegrityVerdict,
} from './digest';

export { sha256Hex, shortDigest } from './sha256';

export { classifyRawValue, projectGraph } from './project';

export {
  diffVersions,
  edgeProvenanceChanged,
  isSemanticallyEmpty,
  publicExposureGained,
  wireKey,
  type DiffOptions,
} from './diff';

export {
  buildHistory,
  edgesAddedSince,
  edgesAddedSincePrevious,
  nodeUnreachableForConsecutiveVersions,
  type ConsecutiveUnreachableOptions,
  type ConsecutiveUnreachableResult,
  type EdgesAddedSinceResult,
  type GraphHistory,
  type UnreachableStreak,
} from './queries';

export {
  DEFAULT_MAX_DOCUMENT_BYTES,
  DEFAULT_MAX_VERSIONS,
  DEFAULT_RETENTION_POLICY,
  DEFAULT_TTL_SECONDS,
  SAFE_PRUNE_MIN_SPAN_MS,
  planPrune,
  type RetentionPolicy,
} from './retention';

export {
  InMemoryGraphHistoryStore,
  toSummary,
  type GraphHistoryStore,
} from './store';

export {
  buildVersionRecord,
  captureGraphVersion,
  type CaptureArgs,
  type CaptureResult,
  type UnchangedReason,
} from './capture';
