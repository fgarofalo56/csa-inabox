/**
 * LOOM BRAIN W9 — THE DIFF. This is the product; the storage is not.
 *
 * Two versions in, added / removed / changed nodes and edges out, each carrying
 * the ids a {@link import('../types').Finding} is written against so the answer
 * joins straight back to the detectors.
 *
 * ── THREE DESIGN DECISIONS, EACH ONE AN ANTI-NOISE MEASURE ─────────────────
 *
 * 1. EDGES ARE PAIRED BY *WIRE*, NOT BY ID.
 *    An {@link import('../types').EdgeId} embeds the provenance, the target and
 *    the source line. So `LOOM_BROKER_URL: ''` becoming
 *    `LOOM_BROKER_URL: 'https://…'` RETIRES one id and MINTS another. Diffed by
 *    id, the single most interesting event this system can observe — a dead wire
 *    coming alive, or a live one being emptied — arrives as an unrelated
 *    addition next to an unrelated removal, and the connection is gone.
 *
 *    So edges are paired on a WIRE KEY: the source node, the artifact and the
 *    symbol that carried the wire (`LOOM_BROKER_URL` on the console app). The
 *    line is excluded, because a wire moving down a file is not a change. Where
 *    there is no symbol (`imports`, `owns`) there is no stable wire identity, so
 *    those fall back to including the target and are reported as add + remove —
 *    stated here rather than discovered later.
 *
 * 2. ONLY PROVENANCES *BOTH* VERSIONS COLLECTED ARE COMPARED.
 *    The deployed console cannot collect `declared` or `imports`
 *    (`app/api/admin/brain/_lib/live-graph.ts`: bicep and the repo sources are
 *    not in the image). If a future capture path DOES collect them, comparing it
 *    against a version that did not would report every bicep edge as ADDED, and
 *    the reverse comparison would report every one as REMOVED. Neither is a
 *    change in the estate; both are a change in what was looked at, and both
 *    would look exactly like a catastrophe. The intersection is computed, the
 *    excluded provenances are NAMED, and nothing is inferred from a zero count.
 *
 * 3. A PAIR THAT MATCHED WITH NO FIELD DIFFERENCE IS NOT A CHANGE.
 *    Two edges can share a wire and differ only in their id (their source line
 *    moved). That is counted as `reidentifiedEdges` and reported in `notes` —
 *    never as a change, and never silently dropped either.
 *
 * ── IT FAILS CLOSED ────────────────────────────────────────────────────────
 * Both sides are verified before anything is compared. A truncated base would
 * otherwise render as mass deletion, which is indistinguishable from a real
 * outage — #3935 names that as the mutation this code must survive.
 *
 * PURE. No I/O, no clock, no randomness.
 */

import { EDGE_PROVENANCES, type EdgeProvenance, type NodeId } from '../types';
import { verifyGraphVersion } from './digest';
import {
  GraphVersionIntegrityError,
  type EdgeChange,
  type FieldChange,
  type GraphDiff,
  type GraphVersion,
  type HistoryPopulation,
  type NodeChange,
  type RelationProvenanceChange,
  type VersionEdgeRecord,
  type VersionNode,
} from './model';

// ---------------------------------------------------------------------------
// Rendering — every value shown to a human goes through here
// ---------------------------------------------------------------------------

/**
 * `null` renders as an explicit token, never as an empty cell.
 *
 * `'(none)'` and `''` are different facts throughout this model — an env var
 * that is absent versus one wired to the empty string — and a renderer that
 * collapses them re-creates the ambiguity the type system spent effort removing.
 */
function show(v: string | number | boolean | null): string {
  if (v === null) return '(not set)';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  return v === '' ? "'' (empty)" : v;
}

function push(
  out: FieldChange[],
  field: string,
  before: string | number | boolean | null,
  after: string | number | boolean | null,
): void {
  if (before === after) return;
  out.push({ field, before: show(before), after: show(after) });
}

// ---------------------------------------------------------------------------
// Node comparison
// ---------------------------------------------------------------------------

function compareNodes(a: VersionNode, b: VersionNode): FieldChange[] {
  const out: FieldChange[] = [];
  push(out, 'kind', a.kind, b.kind);
  push(out, 'displayName', a.displayName, b.displayName);
  push(out, 'resourceType', a.resourceType, b.resourceType);
  push(out, 'subscriptionId', a.subscriptionId, b.subscriptionId);
  push(out, 'resourceGroup', a.resourceGroup, b.resourceGroup);
  push(out, 'location', a.location, b.location);
  push(out, 'provisioningState', a.provisioningState, b.provisioningState);

  // `scale === null` is NOT MEASURED. Rendered as such, so a resource whose
  // scale stopped being readable is never mistaken for one that scaled to zero.
  push(out, 'scale.minReplicas', a.scale === null ? null : a.scale.minReplicas, b.scale === null ? null : b.scale.minReplicas);
  push(out, 'scale.maxReplicas', a.scale === null ? null : a.scale.maxReplicas, b.scale === null ? null : b.scale.maxReplicas);
  push(out, 'scale.cpu', a.scale === null ? null : a.scale.cpu, b.scale === null ? null : b.scale.cpu);
  push(out, 'scale.memory', a.scale === null ? null : a.scale.memory, b.scale === null ? null : b.scale.memory);

  // THE EXPOSURE FIELD. `external: false -> true` is a private endpoint becoming
  // a public one — PRP §3.7's "drifted exposure" class, visible here as a node
  // change rather than needing its own detector.
  push(out, 'ingress.external', a.ingress === null ? null : a.ingress.external, b.ingress === null ? null : b.ingress.external);
  push(out, 'ingress.fqdn', a.ingress === null ? null : a.ingress.fqdn, b.ingress === null ? null : b.ingress.fqdn);

  // SORTED and JSON-rendered — NOT `join(',')` (#4017). The bare join shared the
  // digest's blind spot exactly: `['a,b']` and `['a','b']` both rendered `a,b`,
  // so stage 1 (the digest) deduped the two versions into one AND stage 2 (this
  // comparator) reported zero changes if one somehow survived. The two stages are
  // supposed to be independent; a shared blind spot makes the pair worthless.
  // Sorting matches `digest.ts`, which sorts before hashing: without it a pure
  // reorder would render here as a change the content address cannot see.
  push(
    out,
    'tagKeys',
    a.tagKeys === null ? null : JSON.stringify([...a.tagKeys].sort()),
    b.tagKeys === null ? null : JSON.stringify([...b.tagKeys].sort()),
  );
  push(out, 'estateTag', a.estateTag, b.estateTag);
  return out;
}

// ---------------------------------------------------------------------------
// Edge comparison + wire identity
// ---------------------------------------------------------------------------

/**
 * The identity of a WIRE across versions — see decision 1 in the header.
 *
 * With a symbol: source node + artifact + symbol. Without one there is no stable
 * identity, so the target and provenance are folded in and such an edge changing
 * target is reported as add + remove.
 */
export function wireKey(e: VersionEdgeRecord): string {
  const sym = e.evidence.symbol;
  if (sym !== null && sym !== '') {
    return `S|${e.from}|${e.evidence.artifact}|${sym}`;
  }
  const other = e.to ?? e.intendedTo ?? '';
  return `T|${e.from}|${e.evidence.artifact}|${e.provenance}|${other}`;
}

function compareEdges(a: VersionEdgeRecord, b: VersionEdgeRecord): FieldChange[] {
  const out: FieldChange[] = [];
  push(out, 'provenance', a.provenance, b.provenance);
  push(out, 'resolution', a.resolution, b.resolution);
  push(out, 'to', a.to, b.to);
  push(out, 'intendedTo', a.intendedTo, b.intendedTo);
  push(out, 'danglingReason', a.danglingReason, b.danglingReason);
  push(out, 'evidence.artifact', a.evidence.artifact, b.evidence.artifact);
  push(out, 'evidence.symbol', a.evidence.symbol, b.evidence.symbol);
  push(out, 'evidence.extractor', a.evidence.extractor, b.evidence.extractor);
  // The authored value, compared without being stored: an empty wire gaining a
  // real endpoint shows here as `empty -> nonempty`.
  push(out, 'value.class', a.evidence.rawValueClass, b.evidence.rawValueClass);
  push(out, 'value.length', a.evidence.rawValueLength, b.evidence.rawValueLength);
  push(out, 'value.digest', a.evidence.rawValueDigest, b.evidence.rawValueDigest);
  return out;
}

// ---------------------------------------------------------------------------
// The diff
// ---------------------------------------------------------------------------

export interface DiffOptions {
  /** Total versions the store holds, for the population. Defaults to 2. */
  readonly versionsRetained?: number;
  /** Versions discarded for a mismatched format, for the population. */
  readonly versionsIgnoredByFormat?: number;
}

function intersectProvenances(
  a: readonly EdgeProvenance[],
  b: readonly EdgeProvenance[],
): { readonly compared: EdgeProvenance[]; readonly notComparable: EdgeProvenance[] } {
  const sa = new Set(a);
  const sb = new Set(b);
  const compared: EdgeProvenance[] = [];
  const notComparable: EdgeProvenance[] = [];
  // Iterate the canonical list so the output order is stable regardless of how
  // either side ordered its own array.
  for (const p of EDGE_PROVENANCES) {
    const inA = sa.has(p);
    const inB = sb.has(p);
    if (inA && inB) compared.push(p);
    else if (inA || inB) notComparable.push(p);
  }
  return { compared, notComparable };
}

function assertVerified(v: GraphVersion): void {
  const verdict = verifyGraphVersion(v);
  if (!verdict.ok) throw new GraphVersionIntegrityError(v.id, verdict.check, verdict.detail);
}

/**
 * Diff two versions, oldest (`base`) against newest (`head`).
 *
 * THROWS {@link GraphVersionIntegrityError} when either side fails verification.
 * That is the fail-closed behaviour #3935 requires: a truncated base would
 * otherwise produce a list of removals that reads as an outage.
 */
export function diffVersions(
  base: GraphVersion,
  head: GraphVersion,
  opts?: DiffOptions,
): GraphDiff {
  // BOTH sides. The BASE is the dangerous one — a truncation there renders as
  // mass deletion — so it is verified first and never on trust.
  assertVerified(base); // diff base
  assertVerified(head); // diff head

  const notes: string[] = [];
  const { compared, notComparable } = intersectProvenances(
    base.collectedProvenances,
    head.collectedProvenances,
  );
  const comparable = new Set(compared);
  if (notComparable.length > 0) {
    notes.push(
      `provenance(s) ${notComparable.join(', ')} were collected by exactly one of the two ` +
        'versions and are EXCLUDED from this comparison. Including them would report every ' +
        'such edge as added or removed, which is a change in what was collected, not a ' +
        'change in the estate.',
    );
  }
  if (compared.length === 0) {
    notes.push(
      'the two versions share NO collected provenance. No edge comparison is possible; ' +
        'the edge lists below are empty because nothing was comparable, NOT because nothing ' +
        'changed.',
    );
  }

  // ── nodes ────────────────────────────────────────────────────────────────
  const baseNodes = new Map<string, VersionNode>();
  for (const n of base.content.nodes) baseNodes.set(n.id, n);
  const headNodes = new Map<string, VersionNode>();
  for (const n of head.content.nodes) headNodes.set(n.id, n);

  const nodesAdded: VersionNode[] = [];
  const nodesChanged: NodeChange[] = [];
  for (const [id, hn] of headNodes) {
    const bn = baseNodes.get(id);
    if (bn === undefined) {
      nodesAdded.push(hn);
      continue;
    }
    const changes = compareNodes(bn, hn);
    if (changes.length > 0) {
      nodesChanged.push({ id: hn.id, displayName: hn.displayName, changes });
    }
  }
  const nodesRemoved: VersionNode[] = [];
  for (const [id, bn] of baseNodes) {
    if (!headNodes.has(id)) nodesRemoved.push(bn);
  }

  // ── edges: exact id first, then wire key ─────────────────────────────────
  const baseEdges = base.content.edges.filter((e) => comparable.has(e.provenance));
  const headEdges = head.content.edges.filter((e) => comparable.has(e.provenance));

  const baseById = new Map<string, VersionEdgeRecord>();
  for (const e of baseEdges) baseById.set(e.id, e);

  const edgesChanged: EdgeChange[] = [];
  const unmatchedHead: VersionEdgeRecord[] = [];
  const matchedBaseIds = new Set<string>();
  let reidentifiedEdges = 0;

  for (const he of headEdges) {
    const be = baseById.get(he.id);
    if (be === undefined) {
      unmatchedHead.push(he);
      continue;
    }
    matchedBaseIds.add(he.id);
    const changes = compareEdges(be, he);
    if (changes.length > 0) edgesChanged.push({ before: be, after: he, changes });
  }

  const unmatchedBase = baseEdges.filter((e) => !matchedBaseIds.has(e.id));

  // Second pass — pair the leftovers by wire key, but ONLY where the key is
  // unambiguous on both sides. An ambiguous key (two unmatched wires sharing a
  // source, artifact and symbol) is left to fall through to add/remove rather
  // than guessing a pairing, for the same reason `graph.ts` refuses to resolve
  // an ambiguous resource name: a wrong pairing is inherited by everything
  // downstream with no way to see it.
  const baseByWire = new Map<string, VersionEdgeRecord[]>();
  for (const e of unmatchedBase) {
    const k = wireKey(e);
    const list = baseByWire.get(k);
    if (list) list.push(e);
    else baseByWire.set(k, [e]);
  }
  const headByWire = new Map<string, VersionEdgeRecord[]>();
  for (const e of unmatchedHead) {
    const k = wireKey(e);
    const list = headByWire.get(k);
    if (list) list.push(e);
    else headByWire.set(k, [e]);
  }

  const edgesAdded: VersionEdgeRecord[] = [];
  const pairedBaseIds = new Set<string>();
  let ambiguousWires = 0;

  for (const [k, heads] of headByWire) {
    const bases = baseByWire.get(k);
    if (bases === undefined) {
      for (const e of heads) edgesAdded.push(e);
      continue;
    }
    if (heads.length !== 1 || bases.length !== 1) {
      ambiguousWires += 1;
      for (const e of heads) edgesAdded.push(e);
      continue;
    }
    const be = bases[0];
    const he = heads[0];
    pairedBaseIds.add(be.id);
    const changes = compareEdges(be, he);
    if (changes.length > 0) edgesChanged.push({ before: be, after: he, changes });
    else reidentifiedEdges += 1;
  }

  const edgesRemoved = unmatchedBase.filter((e) => !pairedBaseIds.has(e.id));

  if (reidentifiedEdges > 0) {
    notes.push(
      `${reidentifiedEdges} edge(s) were re-identified with no semantic difference — the same ` +
        'wire, a new edge id (its source line moved). Counted here rather than reported as a ' +
        'change, and NOT silently dropped.',
    );
  }
  if (ambiguousWires > 0) {
    notes.push(
      `${ambiguousWires} wire key(s) matched more than one unpaired edge on a side. Those are ` +
        'reported as added/removed rather than paired by a guess.',
    );
  }

  const identical = base.digest === head.digest;
  const population = diffPopulation(base, head, compared, opts);

  return {
    baseVersionId: base.id,
    headVersionId: head.id,
    baseCapturedAt: base.capturedAt,
    headCapturedAt: head.capturedAt,
    identical,
    nodesAdded,
    nodesRemoved,
    nodesChanged,
    edgesAdded,
    edgesRemoved,
    edgesChanged,
    comparedProvenances: compared,
    provenancesNotComparable: notComparable,
    population,
    notes,
  };
}

function diffPopulation(
  base: GraphVersion,
  head: GraphVersion,
  compared: readonly EdgeProvenance[],
  opts?: DiffOptions,
): HistoryPopulation {
  const sameVersion = base.id === head.id;
  return {
    versionsRetained: opts?.versionsRetained ?? 2,
    versionsExamined: sameVersion ? 1 : 2,
    versionsIgnoredByFormat: opts?.versionsIgnoredByFormat ?? 0,
    nodesPerVersion: sameVersion
      ? [head.counts.nodes]
      : [base.counts.nodes, head.counts.nodes],
    edgesPerVersion: sameVersion
      ? [head.counts.edges]
      : [base.counts.edges, head.counts.edges],
    // A "diff" of a version against itself establishes NOTHING. It is not a
    // clean bill of health, and it must not render as one.
    blind: sameVersion,
    scope: sameVersion
      ? `version '${head.id}' compared against ITSELF — no basis for a change verdict`
      : `version '${base.id}' (${base.capturedAt}) -> '${head.id}' (${head.capturedAt}); ` +
        `edge provenances compared: ${compared.length === 0 ? 'NONE' : compared.join(', ')}`,
  };
}

/** True iff nothing added, removed or changed. Independent of the digest. */
export function isSemanticallyEmpty(d: GraphDiff): boolean {
  return (
    d.nodesAdded.length === 0 &&
    d.nodesRemoved.length === 0 &&
    d.nodesChanged.length === 0 &&
    d.edgesAdded.length === 0 &&
    d.edgesRemoved.length === 0 &&
    d.edgesChanged.length === 0
  );
}

// ---------------------------------------------------------------------------
// Derived views over a diff
// ---------------------------------------------------------------------------

/**
 * Relations whose set of provenances changed — PRP §3.7's *"a `declared`
 * private endpoint that became a `configured` public one"*.
 *
 * Keyed on the RELATION (`from -> to`) rather than on an edge, because that is
 * the level the question is asked at: the same two nodes were connected in the
 * template and are now connected in the deployment, or the reverse. An edge-level
 * view cannot express it — the two edges have different ids by construction.
 */
export function edgeProvenanceChanged(
  base: GraphVersion,
  head: GraphVersion,
): readonly RelationProvenanceChange[] {
  assertVerified(base);
  assertVerified(head);
  const { compared } = intersectProvenances(base.collectedProvenances, head.collectedProvenances);
  const comparable = new Set(compared);

  const relKey = (e: VersionEdgeRecord): string => `${e.from}|${e.to ?? e.intendedTo ?? ''}`;

  const index = (v: GraphVersion): Map<string, Set<EdgeProvenance>> => {
    const m = new Map<string, Set<EdgeProvenance>>();
    for (const e of v.content.edges) {
      if (!comparable.has(e.provenance)) continue;
      const k = relKey(e);
      const s = m.get(k);
      if (s) s.add(e.provenance);
      else m.set(k, new Set([e.provenance]));
    }
    return m;
  };

  const b = index(base);
  const h = index(head);
  const keys = new Set<string>([...b.keys(), ...h.keys()]);
  const out: RelationProvenanceChange[] = [];

  for (const k of [...keys].sort()) {
    const before = b.get(k) ?? new Set<EdgeProvenance>();
    const after = h.get(k) ?? new Set<EdgeProvenance>();
    const gained = EDGE_PROVENANCES.filter((p) => after.has(p) && !before.has(p));
    const lost = EDGE_PROVENANCES.filter((p) => before.has(p) && !after.has(p));
    if (gained.length === 0 && lost.length === 0) continue;
    const sep = k.indexOf('|');
    const from = k.slice(0, sep) as NodeId;
    const toRaw = k.slice(sep + 1);
    out.push({ from, to: toRaw === '' ? null : (toRaw as NodeId), gained, lost });
  }
  return out;
}

/**
 * Nodes whose ingress went from INTERNAL to EXTERNAL between the two versions.
 *
 * A convenience over `nodesChanged`, and a deliberately narrow one: a private
 * endpoint becoming public is the change most worth a human's attention, and it
 * should not require the reader to scan a field list to find it.
 */
export function publicExposureGained(diff: GraphDiff): readonly NodeChange[] {
  return diff.nodesChanged.filter((c) =>
    c.changes.some(
      (f) => f.field === 'ingress.external' && f.before === 'false' && f.after === 'true',
    ),
  );
}
