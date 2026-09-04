/**
 * LOOM BRAIN W9 — the graph HISTORY contract (#3935, PRP §3.7).
 *
 * The Brain's central claim is that *"an edge that should not have formed"* is a
 * security finding. That sentence is meaningless without a `before`. This module
 * is the `before`: a versioned, content-addressed record of what the graph
 * looked like, so **"new since the last version"** is a queryable fact rather
 * than a rendering of the current snapshot.
 *
 * It is PURE — no Azure SDK, no fetch, no filesystem, no `node:crypto`. The hash
 * lives in `./sha256` and is written in plain TypeScript precisely so that this
 * whole layer stays importable from any runtime (node, edge, a client bundle)
 * and so the digest is reproducible without a platform dependency.
 * `./__tests__/purity.test.ts` enforces that and carries an embedded control.
 *
 * ── WHY THE FAILURE MODE IS *NOISE*, NOT ABSENCE ───────────────────────────
 * A history feature dies of false positives long before it dies of missing
 * data. Two captures of an UNCHANGED estate that produce two versions which
 * *look* like a change make every later "what's new?" answer worthless, and the
 * operator stops reading it. So four separate decisions here all exist to make
 * "unchanged ⇒ no diff" a structural property rather than a hope:
 *
 *   1. THE DIGEST IS OVER A CANONICAL, SORTED, SEMANTIC PROJECTION.
 *      Azure Resource Graph does NOT promise a stable row order across calls,
 *      and the extractors iterate rows. Hash the graph as-emitted and the SAME
 *      estate hashes differently on the next pull. `./digest` sorts by id before
 *      hashing, so order cannot reach the digest.
 *
 *   2. LINE NUMBERS ARE NOT PART OF THE PROJECTION.
 *      A wire moving from `main.bicep:4730` to `:4731` because someone inserted
 *      a comment is not a graph change. Evidence lines are a property of the
 *      LIVE graph (where a finding reads them); persisting them here would make
 *      an unrelated edit look like estate drift.
 *
 *   3. AN AUTHORED VALUE IS STORED AS A CLASS + A LENGTH + A DIGEST, NEVER
 *      VERBATIM. This detects any change to the value while persisting none of
 *      it — an env var value can be a connection string, and this repo counts
 *      every place a secret can come to rest as a publication surface. The
 *      `empty` / `nonempty` distinction is preserved because it IS the founding
 *      finding (`LOOM_BROKER_URL: ''`).
 *
 *   4. A DIFF ONLY RANGES OVER PROVENANCES BOTH VERSIONS COLLECTED.
 *      The deployed console cannot collect `declared` (bicep is not in the
 *      image) or `imports` (sources are not in the image) — see
 *      `app/api/admin/brain/_lib/live-graph.ts`. If a future capture DOES
 *      collect them, comparing it against a version that did not would report
 *      every bicep edge as ADDED, and the reverse comparison would report them
 *      all as REMOVED. Neither is a change in the estate; both are a change in
 *      what was looked at. {@link GraphVersion.collectedProvenances} makes that
 *      distinction data, and `./diff` intersects rather than assumes.
 *
 * ── ATOMICITY ──────────────────────────────────────────────────────────────
 * A version is ONE document. It is never chunked, because a half-written graph
 * read as a diff base reports a mass of spurious "removed" edges and looks
 * exactly like a catastrophic outage. A capture whose serialized document would
 * exceed {@link RetentionPolicy.maxDocumentBytes} FAILS — it does not truncate,
 * and it does not split. See `./capture`.
 *
 * ── PUBLIC REPO ────────────────────────────────────────────────────────────
 * Stored graphs live in the estate's own Cosmos account and legitimately carry
 * that estate's ARM ids. NOTHING in this repository may. Every fixture here is
 * synthetic and `./__tests__/no-real-ids.test.ts` scans this whole directory for
 * GUID-shaped literals and fails on one.
 */

import type {
  DanglingReason,
  EdgeId,
  EdgeProvenance,
  ExtractorSource,
  NodeId,
  NodeKind,
} from '../types';

/**
 * The projection's shape version.
 *
 * BUMPED WHENEVER A FIELD IS ADDED, REMOVED OR REINTERPRETED. Two versions with
 * different format versions are NOT comparable: the same estate would digest
 * differently and a field-by-field diff would report changes that are an
 * artifact of the schema. Rather than fail the whole read, the query layer
 * DISCARDS versions whose format differs from the head's and REPORTS the count
 * as `versionsIgnoredByFormat` — a silent discard would be a shrinking
 * population, which this repo treats as a P0 in its own right.
 */
export const HISTORY_FORMAT_VERSION = 1;

// ---------------------------------------------------------------------------
// §The projected node
// ---------------------------------------------------------------------------

/**
 * Replica facts as persisted.
 *
 * The whole record is `null` when scale was NOT MEASURED. That is not the same
 * as `minReplicas: 0`, and collapsing the two silently exonerates every resource
 * whose scale could not be read (`../types.ts` §ScaleFacts, deploy-integrity R7).
 */
export interface VersionNodeScale {
  readonly minReplicas: number;
  readonly maxReplicas: number | null;
  readonly cpu: number | null;
  readonly memory: string | null;
}

/** Ingress facts as persisted. `null` = not measured. */
export interface VersionNodeIngress {
  readonly external: boolean;
  readonly fqdn: string | null;
}

/**
 * A node, projected to the fields a DIFF can act on.
 *
 * Deliberately smaller than {@link import('../types').BrainNode}: a version is a
 * change-detection record, not a second copy of the estate. Anything a finding
 * needs beyond these fields it reads from the LIVE graph, joined on `id`.
 */
export interface VersionNode {
  readonly id: NodeId;
  readonly kind: NodeKind;
  readonly displayName: string;
  readonly resourceType: string | null;
  readonly subscriptionId: string | null;
  readonly resourceGroup: string | null;
  readonly location: string | null;
  readonly provisioningState: string | null;
  /** `null` = NOT MEASURED. Never coerced to zero. */
  readonly scale: VersionNodeScale | null;
  /** `null` = NOT MEASURED. */
  readonly ingress: VersionNodeIngress | null;
  /**
   * Tag KEYS only, sorted. `null` means the tags could not be READ
   * (indeterminate); `[]` means they were read and there are none. Values are
   * not persisted — a tag value is arbitrary customer text and the key set is
   * what a change query needs. The one value that IS load-bearing for ownership
   * is carried separately in {@link estateTag}.
   */
  readonly tagKeys: readonly string[] | null;
  /** The `loom-estate-id` tag value, or `null` when absent/unreadable. */
  readonly estateTag: string | null;
}

// ---------------------------------------------------------------------------
// §The projected edge
// ---------------------------------------------------------------------------

/**
 * What class of value the wire carried.
 *
 * `empty` is not a degenerate `nonempty`: it is the founding finding
 * (`{ name: 'LOOM_BROKER_URL', value: '' }`), and a history that cannot tell
 * `''` from a real endpoint cannot report the moment a wire was fixed — or the
 * moment one was emptied.
 */
export type RawValueClass = 'absent' | 'empty' | 'nonempty';

/**
 * Evidence, projected.
 *
 * NO LINE NUMBER (decision 2 in the header) and NO VERBATIM VALUE (decision 3).
 * `rawValueDigest` is the first 16 hex chars of the value's sha256 — enough to
 * detect any change, not enough to recover the value.
 */
export interface VersionEdgeEvidence {
  readonly artifact: string;
  readonly symbol: string | null;
  readonly extractor: ExtractorSource;
  readonly rawValueClass: RawValueClass;
  readonly rawValueLength: number;
  /** `null` iff `rawValueClass` is `absent`. */
  readonly rawValueDigest: string | null;
}

/** An edge, projected. Keeps the resolved/dangling split (`../types.ts` P2). */
export interface VersionEdge {
  readonly id: EdgeId;
  readonly provenance: EdgeProvenance;
  readonly from: NodeId;
  /** `null` iff `resolution` is `dangling` — the reachability property. */
  readonly to: NodeId | null;
  readonly resolution: 'resolved' | 'dangling';
  /** Who a dangling wire was MEANT to reach. `null` when unknown or resolved. */
  readonly intendedTo: NodeId | null;
  readonly danglingReason: DanglingReason | null;
}

/** A projected edge with its evidence. Split so the diff can compare halves. */
export interface VersionEdgeRecord extends VersionEdge {
  readonly evidence: VersionEdgeEvidence;
}

// ---------------------------------------------------------------------------
// §The version
// ---------------------------------------------------------------------------

/**
 * The hashed payload. Sorted by id on construction AND again inside
 * `./digest`'s canonicalizer, so a caller that reorders cannot move the digest.
 */
export interface GraphVersionContent {
  readonly formatVersion: number;
  readonly nodes: readonly VersionNode[];
  readonly edges: readonly VersionEdgeRecord[];
}

/**
 * The counts, stored ALONGSIDE the content.
 *
 * Redundant on purpose: they are an INDEPENDENT integrity check. A truncated
 * `nodes` array whose digest was recomputed by whatever truncated it still
 * disagrees with `counts.nodes`, so two different corruptions have to agree
 * before a corrupt version reads as sound. See `./digest`'s `verifyGraphVersion`.
 */
export interface GraphVersionCounts {
  readonly nodes: number;
  readonly edges: number;
  readonly resolvedEdges: number;
  readonly danglingEdges: number;
  readonly byProvenance: Readonly<Record<EdgeProvenance, number>>;
  readonly byKind: Readonly<Record<NodeKind, number>>;
}

/**
 * HOW COMPLETE THE PULL THAT PRODUCED THIS VERSION WAS (#4016).
 *
 * ── WHY IT LIVES ON THE VERSION ──────────────────────────────────────────
 *
 * `arg-collect.ts` returns `complete: false` without throwing when it hits its
 * page cap or when `totalRecords` disagrees with the rows it actually read. A
 * version captured from such a pull records a PARTIAL estate, and the next
 * complete pull diffs against it and reports every resource in the unread
 * remainder as an ADDITION — or, worse, an earlier complete version diffed
 * against a later partial one reports them as REMOVALS, which reads exactly like
 * an outage. The route now refuses to write a partial version at all, but a
 * store that predates that refusal can still hold one, and a predicate whose
 * output is a deletion proposal must be able to SEE that.
 *
 * ── WHY IT IS OPTIONAL, AND WHY `undefined` IS NOT `false` ───────────────
 *
 * Versions written before this field existed carry nothing. `undefined` means
 * NOT RECORDED, which is a different fact from "recorded as incomplete", and
 * treating it as `false` would retroactively refuse every historical answer on
 * evidence that was never gathered. Only an explicit `complete === false`
 * triggers the refusals in `./queries`.
 *
 * ── WHY IT IS NOT IN THE DIGEST ──────────────────────────────────────────
 *
 * The digest is the CONTENT address, over the projected graph. Completeness is
 * metadata about the READ, not about the graph. Folding it in would mean an
 * incomplete pull followed by a complete pull of an unchanged estate hashed
 * differently, minting a version that records no change — the exact defect
 * `capture.ts`'s two-stage dedupe exists to prevent.
 */
export interface CollectionCompleteness {
  /** `false` iff the collector established it did not read the whole estate. */
  readonly complete: boolean;
  readonly rowsFetched: number;
  /**
   * What the source said existed, or `null` when it did not say.
   *
   * `null` is NOT zero. Azure Resource Graph omits `totalRecords` on some
   * responses, and coercing that to 0 would make a complete pull of an empty
   * estate indistinguishable from a pull whose total was never reported —
   * exactly the unknown-as-negative substitution this field exists to prevent.
   */
  readonly totalRecords: number | null;
}

/**
 * A version's metadata — everything except the graph itself.
 *
 * The list endpoint reads THESE (a projected Cosmos query), so showing 50
 * versions does not load 50 graphs.
 */
export interface GraphVersionSummary {
  /** `<compact ISO capture instant>-<first 12 of digest>`. Unique and sortable. */
  readonly id: string;
  /** Partition key. Scopes history to one estate; see `resolveEstateId()`. */
  readonly estateId: string;
  /** ISO-8601, UTC. When the CONTENT was first observed. Immutable. */
  readonly capturedAt: string;
  readonly formatVersion: number;
  /** Lowercase hex sha256 over the canonical content. THE CONTENT ADDRESS. */
  readonly digest: string;
  readonly counts: GraphVersionCounts;
  /**
   * Which provenances the capturing runtime actually COLLECTED.
   *
   * NOT derivable from a zero count: "the bicep extractor ran and found no
   * declared edges" and "bicep is not in this image" are different facts with
   * opposite consequences for a diff (header decision 4).
   */
  readonly collectedProvenances: readonly EdgeProvenance[];
  /** What triggered the capture, e.g. 'api:POST /api/admin/brain/history'. */
  readonly source: string;
  /**
   * How many captures have produced THIS digest, including the first.
   *
   * The only mutable field on a version, and it is excluded from the digest.
   * A lost concurrent update can only UNDER-count, which makes
   * `nodeUnreachableForConsecutiveVersions` more conservative, never less —
   * the fail-safe direction for a predicate whose output is a deletion
   * recommendation.
   */
  readonly observedCount: number;
  /** ISO-8601 of the most recent capture that produced this digest. */
  readonly lastObservedAt: string;
  /**
   * How complete the Resource Graph pull behind this version was.
   *
   * `undefined` on versions written before {@link CollectionCompleteness}
   * existed — NOT RECORDED, which is not the same as recorded-incomplete.
   */
  readonly collection?: CollectionCompleteness;
}

/** A version with its graph. */
export interface GraphVersion extends GraphVersionSummary {
  readonly content: GraphVersionContent;
}

// ---------------------------------------------------------------------------
// §Population — P3, applied to history
// ---------------------------------------------------------------------------

/**
 * WHAT THE ANSWER RANGED OVER.
 *
 * `../types.ts` P3 says a verdict cannot be read without its population, and
 * history has its own way of being green and blind: **one version**. A diff over
 * a single version is not "no changes", it is "no basis", and those render
 * identically unless the shape forces the distinction.
 *
 * `nodesPerVersion` / `edgesPerVersion` are chronological and answer the
 * acceptance question in #3935 verbatim — *report the population: number of
 * versions retained, nodes and edges per version*.
 */
export interface HistoryPopulation {
  /** Versions the STORE holds for this estate (may exceed `versionsExamined`). */
  readonly versionsRetained: number;
  /** Versions this particular answer ranged over. */
  readonly versionsExamined: number;
  /** Versions dropped because their `formatVersion` differs from the head's. */
  readonly versionsIgnoredByFormat: number;
  /** Node count per examined version, chronological (oldest first). */
  readonly nodesPerVersion: readonly number[];
  /** Edge count per examined version, chronological (oldest first). */
  readonly edgesPerVersion: readonly number[];
  /** True when the examined set was too small for the question to mean anything. */
  readonly blind: boolean;
  readonly scope: string;
}

// ---------------------------------------------------------------------------
// §Diff
// ---------------------------------------------------------------------------

/** One field that differs, rendered for display. Never a raw object dump. */
export interface FieldChange {
  readonly field: string;
  readonly before: string;
  readonly after: string;
}

export interface NodeChange {
  readonly id: NodeId;
  readonly displayName: string;
  readonly changes: readonly FieldChange[];
}

/**
 * An edge that PERSISTED across the two versions but changed shape.
 *
 * Distinct from added+removed on purpose. An edge id embeds its provenance and
 * its target, so `LOOM_BROKER_URL: ''` becoming `LOOM_BROKER_URL: 'https://…'`
 * mints a NEW id and retires the old one. Reported as add+remove, the single
 * most interesting event in the whole system — a dead wire coming alive — is
 * indistinguishable from two unrelated events. `./diff` pairs by WIRE KEY so it
 * lands here instead.
 */
export interface EdgeChange {
  readonly before: VersionEdgeRecord;
  readonly after: VersionEdgeRecord;
  readonly changes: readonly FieldChange[];
}

/** A relation whose set of provenances changed. See `edgeProvenanceChanged`. */
export interface RelationProvenanceChange {
  readonly from: NodeId;
  /** The other end: `to` when resolved, else `intendedTo`, else `null`. */
  readonly to: NodeId | null;
  readonly gained: readonly EdgeProvenance[];
  readonly lost: readonly EdgeProvenance[];
}

export interface GraphDiff {
  readonly baseVersionId: string;
  readonly headVersionId: string;
  readonly baseCapturedAt: string;
  readonly headCapturedAt: string;
  /** True iff the two digests are equal. Implies every list below is empty. */
  readonly identical: boolean;
  readonly nodesAdded: readonly VersionNode[];
  readonly nodesRemoved: readonly VersionNode[];
  readonly nodesChanged: readonly NodeChange[];
  readonly edgesAdded: readonly VersionEdgeRecord[];
  readonly edgesRemoved: readonly VersionEdgeRecord[];
  readonly edgesChanged: readonly EdgeChange[];
  /** Provenances BOTH versions collected — the only ones compared. */
  readonly comparedProvenances: readonly EdgeProvenance[];
  /** Collected by exactly one side. Excluded, and said so rather than implied. */
  readonly provenancesNotComparable: readonly EdgeProvenance[];
  readonly population: HistoryPopulation;
  /** Anything the diff ESTABLISHED about its own limits. Never speculation. */
  readonly notes: readonly string[];
}

// ---------------------------------------------------------------------------
// §Errors — every one of these FAILS CLOSED
// ---------------------------------------------------------------------------

/** Which integrity check rejected a stored version. */
export type IntegrityCheck = 'digest' | 'node-count' | 'edge-count' | 'format';

/**
 * A stored version did not verify.
 *
 * THROWN RATHER THAN ABSORBED. #3935: *"corrupt a stored version and prove the
 * diff fails closed rather than reporting mass deletion."* A truncated base is
 * the dangerous corruption precisely because it is PLAUSIBLE — every missing
 * node reads as a deletion, and a screen of deletions reads as an outage.
 */
export class GraphVersionIntegrityError extends Error {
  readonly versionId: string;
  readonly check: IntegrityCheck;
  readonly detail: string;
  constructor(versionId: string, check: IntegrityCheck, detail: string) {
    super(
      `graph version '${versionId}' failed its ${check} check and was REFUSED. ` +
        `${detail} No diff was computed: a corrupt base would report every missing ` +
        'element as a removal, which is indistinguishable from a real outage.',
    );
    this.name = 'GraphVersionIntegrityError';
    this.versionId = versionId;
    this.check = check;
    this.detail = detail;
  }
}

/**
 * The serialized version exceeded the single-document budget.
 *
 * Fails the capture. Does NOT truncate and does NOT split across documents:
 * either would give up the atomicity that makes a diff base trustworthy.
 */
export class GraphVersionTooLargeError extends Error {
  readonly bytes: number;
  readonly budget: number;
  constructor(bytes: number, budget: number, counts: GraphVersionCounts) {
    super(
      `the graph version serializes to ${bytes} bytes, over the ${budget}-byte ` +
        `single-document budget (${counts.nodes} nodes, ${counts.edges} edges). ` +
        'NOTHING was written — a version is one atomic document, and truncating or ' +
        'chunking it would make a later diff report the missing half as deletions. ' +
        'Remediation: narrow the Resource Graph query scope in ' +
        'app/api/admin/brain/_lib/arg-collect.ts, or raise maxDocumentBytes in ' +
        'lib/brain/history/retention.ts (ceiling: the Cosmos 2 MiB item limit).',
    );
    this.name = 'GraphVersionTooLargeError';
    this.bytes = bytes;
    this.budget = budget;
  }
}

/**
 * `edgesAddedSince(history, id)` was given an id the loaded history does not
 * hold.
 *
 * FAILS CLOSED. The tempting fallback — treat an unknown base as empty — reports
 * the ENTIRE graph as newly added, which is the worst possible answer for a
 * query whose consumer highlights new edges as a risk surface.
 *
 * ── THE MESSAGE ASSERTS ONLY WHAT THE CALLER ESTABLISHED (R7) ──────────────
 * This error is raised from a WINDOW of loaded versions, which may be smaller
 * than the retained set. It therefore knows two different things depending on
 * the window:
 *
 *   every retained version was loaded  ->  the id is genuinely not retained.
 *   a bounded window was loaded        ->  the id is not COMPARABLE here, and
 *                                          whether it is retained is UNKNOWN.
 *
 * The previous wording said "no retained graph version has id X … N version(s)
 * are retained" in BOTH cases, where `N` was the window size. Measured against
 * 12 retained versions with a window of 8, that message asserted two facts the
 * code had not established, and both were false: the id WAS retained, and the
 * retained count was 12, not 8. `deploy-integrity.md` R7 exactly.
 * `retainedCount` is now carried so the message can tell the two states apart —
 * and say so when it does not know.
 *
 * `ignoredByFormat` is carried for the same reason (#4021 item 4): the gap
 * between retained and comparable is NOT all "not loaded". A version loaded and
 * then dropped by `buildHistory`'s format filter is comparable to nobody and
 * was certainly loaded. Supply it and the message splits the two exactly; omit
 * it and the message names both possibilities rather than asserting one.
 */
export class UnknownBaseVersionError extends Error {
  readonly requested: string;
  /** Ids the raising query could actually compare against (the loaded window). */
  readonly available: readonly string[];
  /** Versions the STORE holds for this estate. May exceed `available.length`. */
  readonly retainedCount: number;
  /**
   * Versions that WERE loaded and then discarded because their `formatVersion`
   * differs from the head's. 0 when the caller did not measure it.
   */
  readonly ignoredByFormat: number;
  constructor(
    requested: string,
    available: readonly string[],
    context?: { readonly retainedCount?: number; readonly ignoredByFormat?: number },
  ) {
    // Defaulting to the window size preserves the two-argument call, and in that
    // form the window IS the whole population, so the "complete" branch below is
    // the truthful one.
    const retained = Math.max(context?.retainedCount ?? available.length, available.length);
    const complete = retained === available.length;
    // ── "NOT LOADED" WAS THE WRONG REASON FOR PART OF THE COUNT (#4021 item 4) ──
    // The gap is arithmetic on retained-minus-COMPARABLE, and a version that was
    // loaded and then dropped by `buildHistory`'s format filter is comparable to
    // nobody while having certainly been loaded. Measured: 12 retained, a window
    // of 8, one loaded version format-discarded — the message read "4 retained
    // version(s) were NOT loaded" when 3 were unloaded and 1 was loaded and
    // discarded. Not an R7 violation (it errs toward MORE declared uncertainty,
    // and the sentence after it stays true), but it pointed an operator
    // debugging a format bump at retention. The count is now attributed only as
    // far as the caller established: precisely when `ignoredByFormat` is
    // supplied, and as two named possibilities when it is not.
    const gap = retained - available.length;
    const byFormat = Math.min(Math.max(context?.ignoredByFormat ?? 0, 0), gap);
    const unloaded = gap - byFormat;
    const attributed = context?.ignoredByFormat === undefined
      ? `${gap} retained version(s) are not in the comparable set — they were either not ` +
        'loaded, or loaded and then discarded because their format differs from the head\'s; ' +
        'this error does not know which. So it does '
      : `${unloaded} retained version(s) were not loaded and ${byFormat} were loaded but ` +
        'discarded for format, so this does ';
    super(
      `graph version '${requested}' is not among the ${available.length} version(s) loaded for ` +
        `comparison; ${retained} version(s) are retained for this estate. ` +
        (complete
          ? 'Every retained version was loaded, so no retained version has that id. '
          : attributed +
            'NOT establish that the id is unretained — only that it is not comparable from ' +
            'what was loaded. ') +
        'REFUSING to answer: treating an unknown base as an empty graph would report every ' +
        'edge in the estate as new.' +
        (available.length > 0 ? ` Oldest comparable: '${available[0]}'.` : ''),
    );
    this.name = 'UnknownBaseVersionError';
    this.requested = requested;
    this.available = available;
    this.retainedCount = retained;
    this.ignoredByFormat = byFormat;
  }
}
