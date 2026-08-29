/**
 * LOOM BRAIN W9 — CAPTURE: turn a live graph into a retained version, or prove
 * that nothing changed and write nothing.
 *
 * ── THE DEDUPE IS THE WHOLE FEATURE ────────────────────────────────────────
 * #3935's hard constraint is that *two captures of an unchanged estate must not
 * produce two versions that look like a change*. A history that records every
 * poll is not a history; it is a log of the polling schedule, and every
 * "what's new?" answer over it is noise.
 *
 * So a capture writes ONLY when the graph SEMANTICALLY changed, and it decides
 * that in two stages:
 *
 *   1. DIGEST EQUALITY — the fast path. The content address is over a sorted,
 *      semantic projection, so an unchanged estate re-pulled in a different row
 *      order hashes identically. Azure Resource Graph does not promise a stable
 *      row order, so this is the case that actually happens.
 *
 *   2. AN EMPTY DIFF — the exact path. Two versions can differ in a way the
 *      digest sees and the comparator does not: an edge id embeds its source
 *      line, so a wire moving down a bicep file mints a new id for the same
 *      wire. Stage 1 would call that a change. Stage 2 runs the real comparator
 *      and, if nothing was added, removed or changed, treats it as unchanged.
 *
 *      Stage 2 is what makes "a version exists ⟺ the graph changed" true rather
 *      than approximately true, and it costs one O(n) diff per capture.
 *
 * ── RETENTION IS ENFORCED HERE, ON THE WRITE PATH ──────────────────────────
 * Not by a sweeper, not by a cron, not by "the TTL will get it". Every
 * successful append is immediately followed by a prune to
 * `policy.maxVersions`, and the ids deleted are RETURNED so the caller can
 * report them. A retention routine that only runs on a schedule is a retention
 * routine that has never run in some deployment.
 *
 * ── OVERSIZE FAILS; IT DOES NOT TRUNCATE ───────────────────────────────────
 * A version is one document because a half-written graph read as a diff base
 * reports a mass of spurious removals and looks exactly like an outage. There is
 * therefore no chunking path and no truncation path — over budget throws
 * {@link GraphVersionTooLargeError} with the counts and a concrete remediation
 * (deploy-integrity R6), and NOTHING is written.
 */

import type { BrainGraphView, EdgeProvenance } from '../types';
import { computeContentDigest, computeCounts, versionId } from './digest';
import { diffVersions, isSemanticallyEmpty } from './diff';
import {
  GraphVersionTooLargeError,
  HISTORY_FORMAT_VERSION,
  type GraphDiff,
  type GraphVersion,
  type HistoryPopulation,
} from './model';
import { projectGraph } from './project';
import { planPrune } from './retention';
import type { GraphHistoryStore } from './store';

/** Why a capture did not write. Never collapsed into a bare boolean. */
export type UnchangedReason =
  /** The content address matched the head exactly. */
  | 'identical-digest'
  /**
   * The digest differed but the comparator found nothing added, removed or
   * changed — the same graph, re-identified. See stage 2 in the header.
   */
  | 'no-semantic-change';

export interface CaptureResult {
  readonly status: 'created' | 'unchanged';
  /** Present on both statuses: the version this capture resolved to. */
  readonly version: GraphVersion;
  /** Set only when `status` is `unchanged`. */
  readonly unchangedReason: UnchangedReason | null;
  /** Serialized size of the document, in bytes. Reported even when unchanged. */
  readonly bytes: number;
  /** Version ids retention deleted as part of this write. */
  readonly pruned: readonly string[];
  readonly population: HistoryPopulation;
  /** Anything the capture ESTABLISHED about its own limits. */
  readonly notes: readonly string[];
}

export interface CaptureArgs {
  readonly graph: BrainGraphView;
  readonly store: GraphHistoryStore;
  readonly estateId: string;
  /**
   * The provenances the capturing runtime actually COLLECTED.
   *
   * REQUIRED, and not derivable from the graph: an edge count of zero cannot
   * distinguish "the extractor ran and found none" from "the extractor is not
   * present in this image". A diff between two versions that disagree on this
   * would otherwise report a whole provenance as added or removed.
   */
  readonly collectedProvenances: readonly EdgeProvenance[];
  /** What triggered this capture. Stored verbatim on the version. */
  readonly source: string;
  readonly now?: () => Date;
}

/** UTF-8 byte length of the serialized document. */
function byteLength(json: string): number {
  return new TextEncoder().encode(json).length;
}

/**
 * Build the version record for a graph, WITHOUT touching a store.
 *
 * Exported because the tests build versions too, and a test that constructs its
 * subject differently from production is testing its own constructor. There is
 * exactly one place a `GraphVersion` is assembled, and this is it.
 */
export function buildVersionRecord(args: {
  readonly graph: BrainGraphView;
  readonly estateId: string;
  readonly capturedAt: string;
  readonly collectedProvenances: readonly EdgeProvenance[];
  readonly source: string;
}): GraphVersion {
  const content = projectGraph(args.graph);
  const digest = computeContentDigest(content);
  return {
    id: versionId(args.capturedAt, digest),
    estateId: args.estateId,
    capturedAt: args.capturedAt,
    formatVersion: HISTORY_FORMAT_VERSION,
    digest,
    counts: computeCounts(content),
    // Normalized here so two captures that listed the same provenances in a
    // different order do not read as different coverage.
    collectedProvenances: [...new Set(args.collectedProvenances)].sort(),
    source: args.source,
    observedCount: 1,
    lastObservedAt: args.capturedAt,
    content,
  };
}

/**
 * The newest retained version, taken by `capturedAt` rather than by POSITION
 * (#4021 item 1).
 *
 * `planPrune` in `./retention` re-sorts its input for exactly this reason and
 * says so: *"a store returning them newest-first would otherwise prune the
 * newest 10, which is the worst possible failure of a retention routine and
 * exactly the kind of ordering assumption that does not survive a refactor."*
 * The same argument applies here and the failure is arguably worse — a reversed
 * `listSummaries` made the capture dedupe against the OLDEST version, so a
 * genuinely changed estate could be recorded as `unchanged` and the change
 * would never be retained at all.
 *
 * The tie-break on `id` is the same one `planPrune` uses, so the two functions
 * agree on which version is newest when two share a `capturedAt`.
 */
function newestOf<T extends { readonly capturedAt: string; readonly id: string }>(
  summaries: readonly T[],
): T | null {
  let best: T | null = null;
  for (const s of summaries) {
    if (best === null) { best = s; continue; }
    if (s.capturedAt > best.capturedAt) { best = s; continue; }
    if (s.capturedAt === best.capturedAt && s.id > best.id) best = s;
  }
  return best;
}

/**
 * Capture the current graph.
 *
 * Returns `created` with the stored version, or `unchanged` with the version the
 * capture resolved to (the existing head) and the reason.
 */
export async function captureGraphVersion(args: CaptureArgs): Promise<CaptureResult> {
  const now = args.now ?? (() => new Date());
  const capturedAt = now().toISOString();
  const notes: string[] = [];

  const candidate = buildVersionRecord({
    graph: args.graph,
    estateId: args.estateId,
    capturedAt,
    collectedProvenances: args.collectedProvenances,
    source: args.source,
  });
  const digest = candidate.digest;
  const counts = candidate.counts;

  const bytes = byteLength(JSON.stringify(candidate));

  const summaries = await args.store.listSummaries(args.estateId);
  const head = newestOf(summaries);

  // ── stage 1: the content address ─────────────────────────────────────────
  if (head !== null && head.digest === digest && head.formatVersion === HISTORY_FORMAT_VERSION) {
    await args.store.observe(args.estateId, head.id, capturedAt);
    const stored = await args.store.load(args.estateId, head.id);
    return {
      status: 'unchanged',
      version: stored ?? candidate,
      unchangedReason: 'identical-digest',
      bytes,
      pruned: [],
      // 2 examined: the retained head's digest and the candidate just built.
      population: capturePopulation(summaries, 2, 'dedupe against the retained head'),
      notes: [
        ...notes,
        `the projected graph hashes to the head version's digest (${digest.slice(0, 12)}…), so ` +
          'NO version was written. Its observation count was incremented instead.',
      ],
    };
  }

  // ── stage 2: the real comparator ─────────────────────────────────────────
  //
  // Only reachable when the digests differ. If the comparator ALSO says nothing
  // changed, the difference was in identity rather than in the estate, and
  // writing a version would manufacture a change out of a re-identification.
  if (head !== null && head.formatVersion === HISTORY_FORMAT_VERSION) {
    const headFull = await args.store.load(args.estateId, head.id);
    if (headFull !== null) {
      // Throws GraphVersionIntegrityError if the stored head is corrupt. That is
      // the correct outcome: a capture must not silently append on top of a
      // history whose most recent entry cannot be trusted as a diff base.
      const probe = diffVersions(headFull, candidate, {
        versionsRetained: summaries.length,
      });
      if (isSemanticallyEmpty(probe)) {
        await args.store.observe(args.estateId, head.id, capturedAt);
        const reloaded = await args.store.load(args.estateId, head.id);
        return {
          status: 'unchanged',
          version: reloaded ?? headFull,
          unchangedReason: 'no-semantic-change',
          bytes,
          pruned: [],
          // 2 examined: the head loaded in full, and the candidate just built.
          population: capturePopulation(summaries, 2, 'full comparison against the head'),
          notes: [
            ...notes,
            'the digest differed from the head but the comparator found nothing added, ' +
              'removed or changed — the same graph, re-identified. NO version was written.',
            ...probe.notes,
          ],
        };
      }
    }
  }

  // ── the write ────────────────────────────────────────────────────────────
  if (bytes > args.store.policy.maxDocumentBytes) {
    throw new GraphVersionTooLargeError(bytes, args.store.policy.maxDocumentBytes, counts);
  }

  await args.store.append(candidate);

  // ── retention, immediately, on the write path ────────────────────────────
  const after = await args.store.listSummaries(args.estateId);
  const doomed = planPrune(after, args.store.policy.maxVersions);
  for (const id of doomed) await args.store.remove(args.estateId, id);
  if (doomed.length > 0) {
    notes.push(
      `retention: ${doomed.length} oldest version(s) deleted to hold the estate at ` +
        `${args.store.policy.maxVersions}. The container also carries a ` +
        `${args.store.policy.ttlSeconds}-second TTL as the backstop for an estate that ` +
        'stops being captured.',
    );
  }

  const remaining = await args.store.listSummaries(args.estateId);
  return {
    status: 'created',
    version: candidate,
    unchangedReason: null,
    bytes,
    pruned: doomed,
    // The candidate, plus the head it was compared against when one existed.
    // On the FIRST capture there is no head, so exactly one version was examined.
    population: capturePopulation(
      remaining,
      head !== null ? 2 : 1,
      'versions retained after this write',
    ),
    notes,
  };
}

/**
 * The capture's population report.
 *
 * `versionsExamined` is the number of versions this capture ACTUALLY looked at
 * (#4021 item 2), not the size of the retained set. A capture compares the
 * candidate against the head and nothing else — so it is 2 when a head existed
 * and 1 (the candidate alone) on the very first capture. It used to be
 * `summaries.length`, which on a 50-version estate claimed the capture had
 * examined 50 versions when it had examined one plus the candidate.
 *
 * Population honesty is load-bearing throughout this module — a shrinking
 * examined count is treated as a P0 — so the one place the number was LARGER
 * than the work done mattered more here than it would elsewhere.
 * `versionsRetained` carries the population size, which is what it is for.
 */
function capturePopulation(
  summaries: readonly { readonly counts: { readonly nodes: number; readonly edges: number } }[],
  examined: number,
  scope: string,
): HistoryPopulation {
  return {
    versionsRetained: summaries.length,
    versionsExamined: examined,
    versionsIgnoredByFormat: 0,
    nodesPerVersion: summaries.map((s) => s.counts.nodes),
    edgesPerVersion: summaries.map((s) => s.counts.edges),
    // One version is a history with no basis for a change verdict. Reported as
    // blind so the first capture is never rendered as "no changes".
    blind: summaries.length < 2,
    scope: `${scope}; ${summaries.length} version(s) retained for this estate`,
  };
}

/** Re-exported so a caller can name the diff type without a second import. */
export type { GraphDiff };
