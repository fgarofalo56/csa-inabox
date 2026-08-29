/**
 * LOOM BRAIN W9 — the CONTENT ADDRESS, and the integrity check that guards it.
 *
 * A version's digest answers exactly one question: **would a diff against this
 * version be empty?** That equivalence is the anti-noise guarantee of the whole
 * feature, and it is a property of what goes INTO the hash:
 *
 *   SORTED       Azure Resource Graph does not promise a stable row order.
 *                Nodes and edges are sorted by id here — again, even though
 *                `./project` already sorts — so no caller can move the digest by
 *                reordering.
 *   SEMANTIC     exactly the fields `./diff` compares. Nothing else. A field
 *                that is hashed but not diffed produces a version that differs
 *                with an EMPTY diff; a field that is diffed but not hashed
 *                produces two versions that dedupe into one while differing.
 *                Both are the same bug from opposite ends, so the canonical form
 *                and the comparator are written as one pair and tested against
 *                each other (`__tests__/digest.test.ts`).
 *   INJECTIVE    every field is LENGTH-PREFIXED. Without that, a display name
 *                containing the separator could forge a field boundary and two
 *                different graphs could canonicalize identically — a collision
 *                by construction rather than by luck, and collisions here
 *                silently discard a real change.
 *
 * ── INTEGRITY: TWO INDEPENDENT CHECKS, BOTH FAIL CLOSED ────────────────────
 * #3935 asks for a corrupt version to make the diff *fail closed rather than
 * report mass deletion*. Truncation is the corruption that matters, because it
 * is PLAUSIBLE: every element that went missing reads as a deletion, and a
 * screen of deletions reads as an outage rather than as a bad read.
 *
 * So a stored version carries its counts as well as its digest, and
 * {@link verifyGraphVersion} tests both. They are independent: recomputing the
 * digest catches any content edit, and the counts catch a truncation even from
 * something that also rewrote the digest. Two corruptions have to agree before a
 * broken version reads as sound.
 */

import { EDGE_PROVENANCES, NODE_KINDS, type EdgeProvenance, type NodeKind } from '../types';
import {
  HISTORY_FORMAT_VERSION,
  type GraphVersion,
  type GraphVersionContent,
  type GraphVersionCounts,
  type IntegrityCheck,
  type VersionEdgeRecord,
  type VersionNode,
} from './model';
import { sha256Hex } from './sha256';

/** Field separator inside a record. Belt-and-braces: length-prefixing already delimits. */
const SEP = '\u0001';
/** Record separator. */
const REC = '\u0002';
/**
 * The token for `null`.
 *
 * NOT the empty string. `''` is a REAL value in this model — a wire authored to
 * nothing is the founding finding — so "absent" and "present and empty" must
 * canonicalize differently, or the digest cannot tell a wire being REMOVED from
 * a wire being EMPTIED. `f('')` renders `0:`, which starts with a digit; the
 * null token does not, so the two are unambiguous even without SEP.
 */
const NULL_TOKEN = '\u0000';

/** Length-prefix a field so no value can forge a boundary. */
function f(v: string | null): string {
  if (v === null) return NULL_TOKEN;
  return `${v.length}:${v}`;
}

function fnum(v: number | null): string {
  return v === null ? NULL_TOKEN : f(String(v));
}

function fbool(v: boolean | null): string {
  return v === null ? NULL_TOKEN : f(v ? '1' : '0');
}

function canonicalNode(n: VersionNode): string {
  return [
    'N',
    f(n.id),
    f(n.kind),
    f(n.displayName),
    f(n.resourceType),
    f(n.subscriptionId),
    f(n.resourceGroup),
    f(n.location),
    f(n.provisioningState),
    n.scale === null ? NULL_TOKEN : fnum(n.scale.minReplicas),
    n.scale === null ? NULL_TOKEN : fnum(n.scale.maxReplicas),
    n.scale === null ? NULL_TOKEN : fnum(n.scale.cpu),
    n.scale === null ? NULL_TOKEN : f(n.scale.memory),
    n.ingress === null ? NULL_TOKEN : fbool(n.ingress.external),
    n.ingress === null ? NULL_TOKEN : f(n.ingress.fqdn),
    // The key set is sorted by `./project`; sorted again here so a caller
    // cannot move the digest by handing over an unsorted array.
    //
    // EVERY KEY IS PREFIXED INDIVIDUALLY, and the COUNT leads (#4017). Prefixing
    // the JOINED string instead — `f(keys.join(','))` — was the one field in this
    // canonical form that was NOT injective: a comma is a legal Azure tag name
    // character, so the single key `a,b` and the pair `a` + `b` both rendered
    // `3:a,b` and hashed identically. Two versions differing only in that way
    // deduped into one and were never written. `f(count)` leading makes the field
    // self-delimiting on its own rather than relying on SEP.
    n.tagKeys === null
      ? NULL_TOKEN
      : [f(String(n.tagKeys.length)), ...[...n.tagKeys].sort().map((k) => f(k))].join(''),
    f(n.estateTag),
  ].join(SEP);
}

function canonicalEdge(e: VersionEdgeRecord): string {
  return [
    'E',
    f(e.id),
    f(e.provenance),
    f(e.from),
    f(e.to),
    f(e.resolution),
    f(e.intendedTo),
    f(e.danglingReason),
    f(e.evidence.artifact),
    f(e.evidence.symbol),
    f(e.evidence.extractor),
    f(e.evidence.rawValueClass),
    fnum(e.evidence.rawValueLength),
    f(e.evidence.rawValueDigest),
  ].join(SEP);
}

/**
 * The canonical text a digest is taken over. Exported for tests and for a
 * human staring at two digests that should have matched.
 */
export function canonicalizeContent(content: GraphVersionContent): string {
  const nodes = [...content.nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const edges = [...content.edges].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const parts: string[] = [`LOOM-BRAIN-GRAPH-HISTORY/${content.formatVersion}`];
  for (const n of nodes) parts.push(canonicalNode(n));
  for (const e of edges) parts.push(canonicalEdge(e));
  return parts.join(REC);
}

/** THE CONTENT ADDRESS. Lowercase hex sha256 over {@link canonicalizeContent}. */
export function computeContentDigest(content: GraphVersionContent): string {
  return sha256Hex(canonicalizeContent(content));
}

/**
 * Counts derived from the content. Stored alongside it as the second,
 * independent integrity check — see the header.
 */
export function computeCounts(content: GraphVersionContent): GraphVersionCounts {
  const byProvenance = {} as Record<EdgeProvenance, number>;
  for (const p of EDGE_PROVENANCES) byProvenance[p] = 0;
  const byKind = {} as Record<NodeKind, number>;
  for (const k of NODE_KINDS) byKind[k] = 0;

  for (const n of content.nodes) byKind[n.kind] += 1;

  let resolvedEdges = 0;
  let danglingEdges = 0;
  for (const e of content.edges) {
    byProvenance[e.provenance] += 1;
    if (e.resolution === 'resolved') resolvedEdges += 1;
    else danglingEdges += 1;
  }

  return {
    nodes: content.nodes.length,
    edges: content.edges.length,
    resolvedEdges,
    danglingEdges,
    byProvenance,
    byKind,
  };
}

export type IntegrityVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly check: IntegrityCheck; readonly detail: string };

/**
 * Verify a stored version against everything it claims about itself.
 *
 * Order is deliberate: the count checks run BEFORE the digest so that a
 * truncation — the corruption that would otherwise render as mass deletion —
 * produces the message that names it, rather than a generic hash mismatch.
 */
export function verifyGraphVersion(v: GraphVersion): IntegrityVerdict {
  if (v.formatVersion !== v.content.formatVersion) {
    return {
      ok: false,
      check: 'format',
      detail:
        `the record declares formatVersion ${v.formatVersion} and its content declares ` +
        `${v.content.formatVersion}. The projection schema and the record disagree, so no ` +
        'field-by-field comparison against it is sound.',
    };
  }
  if (v.counts.nodes !== v.content.nodes.length) {
    return {
      ok: false,
      check: 'node-count',
      detail:
        `it claims ${v.counts.nodes} node(s) and carries ${v.content.nodes.length}. ` +
        'That is the truncation signature: every absent node would read as a deletion.',
    };
  }
  if (v.counts.edges !== v.content.edges.length) {
    return {
      ok: false,
      check: 'edge-count',
      detail:
        `it claims ${v.counts.edges} edge(s) and carries ${v.content.edges.length}. ` +
        'That is the truncation signature: every absent edge would read as a removal.',
    };
  }
  const recomputed = computeContentDigest(v.content);
  if (recomputed !== v.digest) {
    return {
      ok: false,
      check: 'digest',
      detail:
        `its stored digest is ${v.digest} and its content hashes to ${recomputed}. ` +
        'The content was altered after it was written.',
    };
  }
  return { ok: true };
}

/**
 * The id a version is filed under: the capture instant plus the first 12 hex of
 * the content address.
 *
 * Sortable (the instant leads), unique (two captures in the same millisecond
 * with different content differ in the digest; with the SAME content they are
 * deduped and never both written), and free of the characters Cosmos forbids in
 * an item id (`/ \ ? #`).
 */
export function versionId(capturedAt: string, digest: string): string {
  const compact = capturedAt.replace(/[-:.]/g, '');
  return `${compact}-${digest.slice(0, 12)}`;
}

/** The format version this build writes. Re-exported so callers need one import. */
export { HISTORY_FORMAT_VERSION };
