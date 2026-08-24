/**
 * LOOM BRAIN W9 — THE QUERIES THE DETECTORS NEED (#3935 scope).
 *
 * Three questions, each of which is unanswerable from a single snapshot and
 * trivially answerable once the graph has a history:
 *
 *   edgesAddedSince(v)                        the risk surface for new-code
 *                                             review — "an edge that should not
 *                                             have formed" needs a "before"
 *   nodeUnreachableForConsecutiveVersions(n)  the SAFE prune predicate
 *   edgeProvenanceChanged()                   a declared wire becoming a live
 *                                             one, or the reverse
 *                                             (in `./diff`, where the pairing
 *                                             logic already lives)
 *
 * ── THE PRUNE PREDICATE IS THE DANGEROUS ONE ───────────────────────────────
 * Its output is a deletion proposal, so every default here leans toward NOT
 * firing:
 *
 *   n >= 2 is REQUIRED.  `n = 1` is "unreachable in the newest version", which
 *                        is the single-snapshot answer this whole work item
 *                        exists to replace. It throws rather than quietly
 *                        accepting the argument that reintroduces the bug.
 *   PRESENT IN ALL n.    A node that did not exist in the oldest examined
 *                        version cannot have been unreachable in it. Counting
 *                        absence as unreachability would make every newly
 *                        created resource instantly prunable — the exact
 *                        mid-deploy deletion #3935 names.
 *   A TIME FLOOR.        A deploy can produce several graph changes in minutes.
 *                        Version count answers "is this persistent?"; the span
 *                        answers "has enough real time passed for the wiring to
 *                        have happened?". Both are required, and the span
 *                        defaults ON (`SAFE_PRUNE_MIN_SPAN_MS`), opt-out.
 *   COVERAGE IS CHECKED. If any examined version did not COLLECT the provenance
 *                        being tested, every node in it has zero inbound edges
 *                        of that provenance vacuously. The query refuses and
 *                        says so rather than returning a screen of confident
 *                        nonsense — `Population.blind` does not catch this,
 *                        because the NODE set was not empty.
 *
 * ── FAIL CLOSED ON AN UNKNOWN BASE ─────────────────────────────────────────
 * `edgesAddedSince` with an id the history does not hold THROWS. The tempting
 * fallback — treat the unknown base as an empty graph — reports every edge in
 * the estate as newly added, to a consumer whose job is to highlight new edges
 * as a risk surface.
 *
 * The throw carries `history.retainedCount`, because this function sees a
 * WINDOW and not the store: "not in the window" and "not retained" are
 * different findings, and only the caller's retained count can tell them apart.
 * Reporting the window size as the retained count — and "no retained version
 * has this id" when 4 unloaded versions could hold it — is the R7 violation
 * this parameter exists to prevent.
 *
 * PURE. No I/O, no clock: `spanMs` is computed from the versions' own
 * timestamps, so the answer is reproducible from stored data alone.
 */

import type { EdgeProvenance, NodeId } from '../types';
import { diffVersions, isSemanticallyEmpty } from './diff';
import {
  UnknownBaseVersionError,
  type EdgeChange,
  type GraphDiff,
  type GraphVersion,
  type HistoryPopulation,
  type VersionEdgeRecord,
  type VersionNode,
} from './model';
import { SAFE_PRUNE_MIN_SPAN_MS } from './retention';

/**
 * A loaded window of history.
 *
 * `versions` is CHRONOLOGICAL — oldest first, newest last — matching
 * `GraphHistoryStore`. `retainedCount` is what the STORE holds, which may exceed
 * the window: the population must report the difference rather than let a
 * caller read "5 versions examined" as "5 versions exist".
 */
export interface GraphHistory {
  readonly estateId: string;
  readonly versions: readonly GraphVersion[];
  readonly retainedCount: number;
  /** Versions dropped because their format differs from the head's. */
  readonly ignoredByFormat: number;
}

/**
 * Build a history window from loaded versions, discarding any whose
 * `formatVersion` differs from the head's.
 *
 * The discard is COUNTED, never silent. A shrinking examined population is
 * treated as a P0 in this repo (PRP §5), and a schema bump that quietly halves
 * the history is exactly that failure wearing a maintenance hat.
 */
export function buildHistory(
  estateId: string,
  loaded: readonly GraphVersion[],
  retainedCount?: number,
): GraphHistory {
  const chronological = [...loaded].sort((a, b) => {
    if (a.capturedAt < b.capturedAt) return -1;
    if (a.capturedAt > b.capturedAt) return 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  if (chronological.length === 0) {
    return { estateId, versions: [], retainedCount: retainedCount ?? 0, ignoredByFormat: 0 };
  }
  const headFormat = chronological[chronological.length - 1].formatVersion;
  const kept = chronological.filter((v) => v.formatVersion === headFormat);
  return {
    estateId,
    versions: kept,
    retainedCount: retainedCount ?? loaded.length,
    ignoredByFormat: chronological.length - kept.length,
  };
}

function population(
  history: GraphHistory,
  examined: readonly GraphVersion[],
  blind: boolean,
  scope: string,
): HistoryPopulation {
  return {
    versionsRetained: history.retainedCount,
    versionsExamined: examined.length,
    versionsIgnoredByFormat: history.ignoredByFormat,
    nodesPerVersion: examined.map((v) => v.counts.nodes),
    edgesPerVersion: examined.map((v) => v.counts.edges),
    blind,
    scope,
  };
}

// ---------------------------------------------------------------------------
// edgesAddedSince
// ---------------------------------------------------------------------------

export interface EdgesAddedSinceResult {
  readonly sinceVersionId: string;
  readonly headVersionId: string;
  /** Wires that did not exist in the base version at all. */
  readonly added: readonly VersionEdgeRecord[];
  /**
   * Wires that existed and changed shape — an empty value gaining an endpoint, a
   * dangling wire resolving, a target moving. Reported separately from `added`
   * because the remediations differ, and because a consumer highlighting "new"
   * edges should not paint a pre-existing wire as new.
   */
  readonly changed: readonly EdgeChange[];
  /** Nodes that did not exist in the base version. Context for the new edges. */
  readonly nodesAdded: readonly VersionNode[];
  readonly diff: GraphDiff;
  readonly population: HistoryPopulation;
  readonly notes: readonly string[];
}

/**
 * Every edge present in the newest version and absent from `sinceVersionId`.
 *
 * THROWS {@link UnknownBaseVersionError} when the id is not in THIS history's
 * loaded versions — which is not the same statement as "not retained", and the
 * error says which of the two it established. Also throws
 * {@link import('./model').GraphVersionIntegrityError} when either version fails
 * verification, via `diffVersions`.
 */
export function edgesAddedSince(
  history: GraphHistory,
  sinceVersionId: string,
): EdgesAddedSinceResult {
  const versions = history.versions;
  if (versions.length === 0) {
    throw new UnknownBaseVersionError(sinceVersionId, [], {
      retainedCount: history.retainedCount,
    });
  }
  const baseIndex = versions.findIndex((v) => v.id === sinceVersionId);
  if (baseIndex < 0) {
    // The RETAINED count, never the window size. A window of 8 over 12 retained
    // versions must not report "8 version(s) are retained", and must not claim
    // the id is unretained when 4 versions it never looked at could hold it.
    throw new UnknownBaseVersionError(
      sinceVersionId,
      versions.map((v) => v.id),
      { retainedCount: history.retainedCount },
    );
  }
  const base = versions[baseIndex];
  const head = versions[versions.length - 1];
  const diff = diffVersions(base, head, {
    versionsRetained: history.retainedCount,
    versionsIgnoredByFormat: history.ignoredByFormat,
  });

  const notes = [...diff.notes];
  if (base.id === head.id) {
    notes.push(
      'the requested base IS the newest retained version, so nothing can be new relative to ' +
        'it. This is an empty ANSWER, not a clean estate — population.blind says so.',
    );
  }

  return {
    sinceVersionId: base.id,
    headVersionId: head.id,
    added: diff.edgesAdded,
    changed: diff.edgesChanged,
    nodesAdded: diff.nodesAdded,
    diff,
    population: population(
      history,
      versions.slice(baseIndex),
      base.id === head.id,
      `edges present in '${head.id}' and absent from '${base.id}'`,
    ),
    notes,
  };
}

/**
 * Everything new since the version immediately before the head.
 *
 * The default question a change feed asks, expressed once so every caller does
 * not re-derive "the one before the last" and get it wrong at length 1.
 */
export function edgesAddedSincePrevious(history: GraphHistory): EdgesAddedSinceResult | null {
  if (history.versions.length < 2) return null;
  return edgesAddedSince(history, history.versions[history.versions.length - 2].id);
}

// ---------------------------------------------------------------------------
// nodeUnreachableForConsecutiveVersions — THE SAFE PRUNE PREDICATE
// ---------------------------------------------------------------------------

export interface UnreachableStreak {
  readonly node: VersionNode;
  /** Versions examined, all of which had it present and with no inbound edge. */
  readonly versions: number;
  /** Wall-clock span covered by those versions, in ms. */
  readonly spanMs: number;
}

export interface ConsecutiveUnreachableResult {
  readonly provenance: EdgeProvenance;
  readonly required: number;
  readonly minSpanMs: number;
  /** Span between the oldest examined version and the head, in ms. */
  readonly spanMs: number;
  readonly nodes: readonly UnreachableStreak[];
  readonly population: HistoryPopulation;
  readonly notes: readonly string[];
}

export interface ConsecutiveUnreachableOptions {
  /** Which inbound edge type must be absent. Default `configured` — LIVE wiring. */
  readonly provenance?: EdgeProvenance;
  /** Wall-clock floor. Default {@link SAFE_PRUNE_MIN_SPAN_MS} (24h). */
  readonly minSpanMs?: number;
}

/**
 * Nodes with NO inbound resolved edge of `provenance` across the newest `n`
 * versions — and present in every one of them.
 *
 * `n` must be at least 2. Everything about the defaults is chosen so that a
 * false positive here cannot become a deletion; see the module header.
 */
export function nodeUnreachableForConsecutiveVersions(
  history: GraphHistory,
  n: number,
  opts?: ConsecutiveUnreachableOptions,
): ConsecutiveUnreachableResult {
  if (!Number.isInteger(n) || n < 2) {
    throw new RangeError(
      `nodeUnreachableForConsecutiveVersions requires an integer n >= 2 (got ${n}). ` +
        'n = 1 is the single-snapshot answer this predicate exists to replace: a node with no ' +
        'inbound edge in the newest version alone may simply be mid-deploy.',
    );
  }
  const provenance: EdgeProvenance = opts?.provenance ?? 'configured';
  const minSpanMs = opts?.minSpanMs ?? SAFE_PRUNE_MIN_SPAN_MS;
  const notes: string[] = [];
  const versions = history.versions;

  if (versions.length < n) {
    return {
      provenance,
      required: n,
      minSpanMs,
      spanMs: 0,
      nodes: [],
      population: population(
        history,
        versions,
        true,
        `${versions.length} retained version(s), ${n} required — no verdict is possible`,
      ),
      notes: [
        `only ${versions.length} version(s) are retained and ${n} are required. This is NOT ` +
          '"no unreachable nodes" — it is "no basis". A node cannot be shown persistently ' +
          'unreachable until the history is at least that deep.',
      ],
    };
  }

  const window = versions.slice(versions.length - n);
  const oldest = window[0];
  const head = window[window.length - 1];
  const spanMs = Date.parse(head.capturedAt) - Date.parse(oldest.capturedAt);

  // Coverage. A version that did not COLLECT this provenance has zero inbound
  // edges of it for every node, vacuously — `blind` does not fire, because the
  // node set was not empty. This is the check that stops a screen of confident
  // nonsense.
  const uncovered = window.filter((v) => !v.collectedProvenances.includes(provenance));
  if (uncovered.length > 0) {
    return {
      provenance,
      required: n,
      minSpanMs,
      spanMs,
      nodes: [],
      population: population(
        history,
        window,
        true,
        `${uncovered.length} of the ${n} examined version(s) did not collect '${provenance}'`,
      ),
      notes: [
        `${uncovered.length} of the ${n} examined version(s) did not COLLECT provenance ` +
          `'${provenance}' (${uncovered.map((v) => v.id).join(', ')}). Every node in those ` +
          'versions has zero inbound edges of it vacuously, so the predicate would fire on the ' +
          'entire estate. REFUSING to answer.',
      ],
    };
  }

  if (spanMs < minSpanMs) {
    notes.push(
      `the ${n} examined version(s) span ${spanMs} ms, under the ${minSpanMs} ms floor. A ` +
        'burst of graph changes during one deploy can satisfy the version count in minutes, ' +
        'and a resource created inside that window is unreachable in every one of them. No ' +
        'node is reported.',
    );
    return {
      provenance,
      required: n,
      minSpanMs,
      spanMs,
      nodes: [],
      population: population(
        history,
        window,
        true,
        `${n} version(s) examined but they span only ${spanMs} ms of wall clock`,
      ),
      notes,
    };
  }

  // Inbound tallies per version. Resolved edges only — a dangling wire does not
  // make its target reachable, which is the founding `loom-capacity-broker`
  // property and the reason `to` is `null` on a dangling edge.
  const inboundPerVersion = window.map((v) => {
    const counts = new Map<string, number>();
    for (const e of v.content.edges) {
      if (e.resolution !== 'resolved' || e.to === null) continue;
      if (e.provenance !== provenance) continue;
      counts.set(e.to, (counts.get(e.to) ?? 0) + 1);
    }
    return counts;
  });
  const presentPerVersion = window.map((v) => new Set(v.content.nodes.map((node) => node.id)));

  const out: UnreachableStreak[] = [];
  for (const node of head.content.nodes) {
    let qualifies = true;
    for (let i = 0; i < window.length; i += 1) {
      if (!presentPerVersion[i].has(node.id)) {
        qualifies = false;
        break;
      }
      if ((inboundPerVersion[i].get(node.id) ?? 0) > 0) {
        qualifies = false;
        break;
      }
    }
    if (qualifies) out.push({ node, versions: n, spanMs });
  }

  notes.push(
    `examined the newest ${n} of ${history.retainedCount} retained version(s), spanning ` +
      `${spanMs} ms; ${head.content.nodes.length} node(s) in the head version were tested for ` +
      `an inbound resolved '${provenance}' edge in every one of them.`,
  );

  return {
    provenance,
    required: n,
    minSpanMs,
    spanMs,
    nodes: out,
    population: population(
      history,
      window,
      false,
      `${head.content.nodes.length} node(s) in the head version, tested across ${n} consecutive ` +
        `version(s) for an inbound '${provenance}' edge`,
    ),
    notes,
  };
}

// ---------------------------------------------------------------------------
// Convenience re-exports so a consumer needs one import path
// ---------------------------------------------------------------------------

export { isSemanticallyEmpty };
export type { NodeId };
