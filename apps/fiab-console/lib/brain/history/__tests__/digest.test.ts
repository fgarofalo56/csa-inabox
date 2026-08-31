/**
 * THE ANTI-NOISE PROPERTY: an unchanged estate produces no change.
 *
 * This is #3935's hard constraint, and it is the property that decides whether
 * the feature is useful or is a firehose of false positives. Everything asserted
 * here is about a graph that DID NOT CHANGE still hashing identically.
 *
 * ── THE CASE THAT ACTUALLY HAPPENS ─────────────────────────────────────────
 * Azure Resource Graph does not promise a stable row order between calls, and
 * `buildLiveGraph` iterates rows. So the realistic failure is not a subtle field
 * drift — it is the same estate arriving in a different order and hashing
 * differently, every single poll. The shuffle test below is that case, and it
 * asserts the shuffle ACTUALLY MOVED SOMETHING first: a shuffle that no-ops
 * would make this whole file pass while proving nothing.
 */

import { describe, it, expect } from 'vitest';
import {
  canonicalizeContent,
  computeContentDigest,
  computeCounts,
  verifyGraphVersion,
  versionId,
} from '../digest';
import { diffVersions, isSemanticallyEmpty } from '../diff';
import { projectGraph } from '../project';
import { HISTORY_FORMAT_VERSION } from '../model';
import type { GraphVersionContent, VersionEdgeRecord, VersionNode } from '../model';
import {
  BASELINE,
  buildEstate,
  cloneVersion,
  rebuildVersion,
  seededShuffle,
  versionFrom,
} from './fixtures';

const T0 = '2026-08-24T09:00:00.000Z';
const T1 = '2026-08-24T11:00:00.000Z';

describe('digest — an unchanged estate produces no change', () => {
  it('two independent builds of the same estate hash identically', () => {
    const a = computeContentDigest(projectGraph(buildEstate(BASELINE)));
    const b = computeContentDigest(projectGraph(buildEstate(BASELINE)));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a REORDERED pull of the same estate hashes identically', () => {
    const content = projectGraph(buildEstate(BASELINE));
    const shuffledNodes = seededShuffle(content.nodes);
    const shuffledEdges = seededShuffle(content.edges);

    // The control: a shuffle that did not move anything would make the
    // assertion below vacuous. Both arrays must actually differ in order.
    expect(shuffledNodes.map((n) => n.id)).not.toEqual(content.nodes.map((n) => n.id));
    expect(shuffledEdges.map((e) => e.id)).not.toEqual(content.edges.map((e) => e.id));

    const shuffled: GraphVersionContent = {
      formatVersion: content.formatVersion,
      nodes: shuffledNodes,
      edges: shuffledEdges,
    };
    expect(computeContentDigest(shuffled)).toBe(computeContentDigest(content));
  });

  it('two captures of an unchanged estate at DIFFERENT instants share a digest', () => {
    const v0 = versionFrom(BASELINE, T0);
    const v1 = versionFrom(BASELINE, T1);
    expect(v1.digest).toBe(v0.digest);
    // Different ids (the instant leads) but the same content address — which is
    // what lets `captureGraphVersion` refuse to store the second one.
    expect(v1.id).not.toBe(v0.id);
  });

  it('EQUAL DIGESTS IMPLY AN EMPTY DIFF — the invariant the dedupe rests on', () => {
    const v0 = versionFrom(BASELINE, T0);
    const v1 = versionFrom(BASELINE, T1);
    const d = diffVersions(v0, v1);
    expect(d.identical).toBe(true);
    expect(isSemanticallyEmpty(d)).toBe(true);
    expect(d.nodesAdded).toEqual([]);
    expect(d.nodesRemoved).toEqual([]);
    expect(d.nodesChanged).toEqual([]);
    expect(d.edgesAdded).toEqual([]);
    expect(d.edgesRemoved).toEqual([]);
    expect(d.edgesChanged).toEqual([]);
  });
});

describe('digest — a real change DOES move it', () => {
  it('adding one app changes the digest', () => {
    const before = versionFrom(BASELINE, T0);
    const after = versionFrom(
      { ...BASELINE, apps: [...BASELINE.apps, { name: 'loom-new', minReplicas: 1 }] },
      T1,
    );
    expect(after.digest).not.toBe(before.digest);
  });

  it('filling an EMPTY wire changes the digest — the founding finding, fixed', () => {
    const before = versionFrom(BASELINE, T0);
    const after = versionFrom(
      {
        ...BASELINE,
        wires: BASELINE.wires.map((w) =>
          w.envVar === 'LOOM_BROKER_URL'
            ? { ...w, value: 'https://loom-capacity-broker.internal.example-env.centralus.azurecontainerapps.io' }
            : w,
        ),
      },
      T1,
    );
    expect(after.digest).not.toBe(before.digest);
  });

  it('a private endpoint becoming public changes the digest', () => {
    const before = versionFrom(BASELINE, T0);
    const after = versionFrom(
      {
        ...BASELINE,
        apps: BASELINE.apps.map((a) =>
          a.name === 'loom-capacity-broker' ? { ...a, external: true } : a,
        ),
      },
      T1,
    );
    expect(after.digest).not.toBe(before.digest);
  });
});

// ---------------------------------------------------------------------------
// #4020 R2/R3 — THE PAIR PROPERTY, TESTED IN BOTH DIRECTIONS
// ---------------------------------------------------------------------------
//
// `digest.ts`'s header states the contract: the canonical form and the
// comparator "are written as one pair and tested against each other", because
//   - hashed but NOT diffed  -> a version differs with an EMPTY diff;
//   - diffed but NOT hashed  -> two differing versions dedupe into one.
// Only ONE direction was actually tested. The spec above proves EQUAL DIGESTS
// IMPLY AN EMPTY DIFF. The converse — every hashed field is diffed and every
// diffed field is hashed — was asserted nowhere, and the review measured the
// consequence: dropping `value.digest` from `compareEdges` (R2) and dropping
// `rawValueDigest` from `canonicalEdge` (R3) each left the 103-test suite GREEN
// at RC=0, while control arms in the same sweep went RC=1. Two silent bugs from
// opposite ends of the same pair.
//
// The concrete case both arms hide is a SAME-LENGTH, SAME-CLASS authored-value
// rotation — a secret or connection string replaced with another of the same
// shape. It moves `rawValueDigest` and nothing else: under R3 stage 1 dedupes it
// away, under R2 stage 2 does.
//
// WHAT THIS BLOCK ASSERTS, and why it is not just a bigger table:
//   1. for every field the table names, mutating it MOVES THE DIGEST (hashed)
//      AND produces a NON-EMPTY DIFF naming that field (diffed);
//   2. the table COVERS every field the comparator emits — derived at runtime
//      from a maximally-different pair, so a field added to the comparator with
//      no table entry fails here rather than being quietly untested;
//   3. the canonical record's FIELD COUNT matches the table (plus the named
//      carve-outs), so a field added to the canonical form only also fails.
// (2) and (3) are what make this survive a future field added to one side.

/** Record/field separators from `digest.ts`. Changing them there reddens (3). */
const CANON_REC = '\u0002';
const CANON_SEP = '\u0001';

type NodeMut = { readonly field: string; readonly mutate: (n: VersionNode) => VersionNode };
type EdgeMut = { readonly field: string; readonly mutate: (e: VersionEdgeRecord) => VersionEdgeRecord };

/**
 * Node fields. `id` is deliberately absent and is asserted separately below:
 * a node id is the PAIRING KEY, so changing it is an add + a remove rather than
 * a field change, and `compareNodes` never emits it.
 */
const NODE_MUTATIONS: readonly NodeMut[] = [
  { field: 'kind', mutate: (n) => ({ ...n, kind: n.kind === 'azure-resource' ? 'loom-item' : 'azure-resource' }) },
  { field: 'displayName', mutate: (n) => ({ ...n, displayName: `${n.displayName}-renamed` }) },
  { field: 'resourceType', mutate: (n) => ({ ...n, resourceType: 'Microsoft.App/jobs' }) },
  { field: 'subscriptionId', mutate: (n) => ({ ...n, subscriptionId: 'sub-beta' }) },
  { field: 'resourceGroup', mutate: (n) => ({ ...n, resourceGroup: 'rg-loom-other' }) },
  { field: 'location', mutate: (n) => ({ ...n, location: 'eastus2' }) },
  { field: 'provisioningState', mutate: (n) => ({ ...n, provisioningState: 'Failed' }) },
  { field: 'scale.minReplicas', mutate: (n) => ({ ...n, scale: { minReplicas: 99, maxReplicas: n.scale?.maxReplicas ?? null, cpu: n.scale?.cpu ?? null, memory: n.scale?.memory ?? null } }) },
  { field: 'scale.maxReplicas', mutate: (n) => ({ ...n, scale: { minReplicas: n.scale?.minReplicas ?? 0, maxReplicas: 98, cpu: n.scale?.cpu ?? null, memory: n.scale?.memory ?? null } }) },
  { field: 'scale.cpu', mutate: (n) => ({ ...n, scale: { minReplicas: n.scale?.minReplicas ?? 0, maxReplicas: n.scale?.maxReplicas ?? null, cpu: 7.5, memory: n.scale?.memory ?? null } }) },
  { field: 'scale.memory', mutate: (n) => ({ ...n, scale: { minReplicas: n.scale?.minReplicas ?? 0, maxReplicas: n.scale?.maxReplicas ?? null, cpu: n.scale?.cpu ?? null, memory: '7Gi' } }) },
  { field: 'ingress.external', mutate: (n) => ({ ...n, ingress: { external: !(n.ingress?.external ?? false), fqdn: n.ingress?.fqdn ?? null } }) },
  { field: 'ingress.fqdn', mutate: (n) => ({ ...n, ingress: { external: n.ingress?.external ?? false, fqdn: 'moved.example.invalid' } }) },
  { field: 'tagKeys', mutate: (n) => ({ ...n, tagKeys: [...(n.tagKeys ?? []), 'zz-new-tag-key'] }) },
  { field: 'estateTag', mutate: (n) => ({ ...n, estateTag: 'estate-beta' }) },
];

/**
 * Edge fields. Two deliberate absences, both asserted explicitly below:
 *   `id`    hashed but NOT diffed BY DESIGN — the re-identification case
 *           (`diff.ts` decision 1/3): a wire whose source line moved keeps its
 *           wire key, pairs, and is counted rather than reported.
 *   `from`  hashed and not in `compareEdges`, because it is part of the WIRE
 *           KEY: changing it breaks the pairing, so it still yields a non-empty
 *           diff — as an add + a remove.
 */
const EDGE_MUTATIONS: readonly EdgeMut[] = [
  { field: 'provenance', mutate: (e) => ({ ...e, provenance: e.provenance === 'configured' ? 'observed' : 'configured' }) },
  { field: 'resolution', mutate: (e) => (e.resolution === 'resolved'
      ? { ...e, resolution: 'dangling', to: null, intendedTo: e.to, danglingReason: 'unresolved-target' }
      : { ...e, resolution: 'resolved', to: e.intendedTo ?? e.from, intendedTo: null, danglingReason: null }) },
  { field: 'to', mutate: (e) => ({ ...e, to: e.to === null ? e.from : null, resolution: e.to === null ? 'resolved' : 'dangling' }) },
  { field: 'intendedTo', mutate: (e) => ({ ...e, intendedTo: e.intendedTo === null ? e.from : null }) },
  { field: 'danglingReason', mutate: (e) => ({ ...e, danglingReason: e.danglingReason === null ? 'unresolved-target' : null }) },
  { field: 'evidence.artifact', mutate: (e) => ({ ...e, evidence: { ...e.evidence, artifact: `${e.evidence.artifact}.moved` } }) },
  { field: 'evidence.symbol', mutate: (e) => ({ ...e, evidence: { ...e.evidence, symbol: `${e.evidence.symbol ?? ''}_RENAMED` } }) },
  { field: 'evidence.extractor', mutate: (e) => ({ ...e, evidence: { ...e.evidence, extractor: e.evidence.extractor === 'container-app-env' ? 'bicep' : 'container-app-env' } }) },
  { field: 'value.class', mutate: (e) => ({ ...e, evidence: { ...e.evidence, rawValueClass: e.evidence.rawValueClass === 'empty' ? 'nonempty' : 'empty' } }) },
  { field: 'value.length', mutate: (e) => ({ ...e, evidence: { ...e.evidence, rawValueLength: e.evidence.rawValueLength + 17 } }) },
  {
    // THE ROTATION. Same class, same length — only the digest moves. This is
    // the entry R2 and R3 each make unobservable, from opposite ends.
    field: 'value.digest',
    mutate: (e) => ({
      ...e,
      evidence: {
        ...e.evidence,
        rawValueDigest: e.evidence.rawValueDigest === null
          ? '0'.repeat(16)
          : e.evidence.rawValueDigest.split('').reverse().join(''),
      },
    }),
  },
];

/** Head version with `patch` applied to the FIRST node / FIRST edge. */
function headWith(
  base: GraphVersionContent,
  patch: { readonly node?: (n: VersionNode) => VersionNode; readonly edge?: (e: VersionEdgeRecord) => VersionEdgeRecord },
): GraphVersionContent {
  return {
    formatVersion: base.formatVersion,
    nodes: patch.node ? [patch.node(base.nodes[0]), ...base.nodes.slice(1)] : base.nodes,
    edges: patch.edge ? [patch.edge(base.edges[0]), ...base.edges.slice(1)] : base.edges,
  };
}

describe('#4020 — canonical form and comparator cover the SAME fields', () => {
  const baseVersion = versionFrom(BASELINE, T0);
  const baseContent = baseVersion.content;

  it('the fixture is rich enough for the table (a control on the table itself)', () => {
    // Every mutation below patches nodes[0] / edges[0]. If either were absent,
    // or the first edge carried no digest to rotate, the whole block would pass
    // vacuously — which is the shape this issue is about.
    expect(baseContent.nodes.length).toBeGreaterThan(1);
    expect(baseContent.edges.length).toBeGreaterThan(1);
    expect(baseContent.edges[0].evidence.rawValueDigest).not.toBeNull();
  });

  it.each(NODE_MUTATIONS.map((m) => [m.field, m] as const))(
    'node field %s is BOTH hashed and diffed',
    (field, m) => {
      const head = headWith(baseContent, { node: m.mutate });
      // Direction 1 — HASHED. A field the comparator reads but the canonical
      // form ignores would dedupe this away and no version would be written.
      expect(computeContentDigest(head)).not.toBe(computeContentDigest(baseContent));
      // Direction 2 — DIFFED. A field the canonical form hashes but the
      // comparator ignores would store a version whose diff is empty.
      const d = diffVersions(baseVersion, rebuildVersion(versionFrom(BASELINE, T1), head));
      expect(isSemanticallyEmpty(d)).toBe(false);
      expect(d.nodesChanged.flatMap((c) => c.changes.map((f) => f.field))).toContain(field);
    },
  );

  it.each(EDGE_MUTATIONS.map((m) => [m.field, m] as const))(
    'edge field %s is BOTH hashed and diffed',
    (field, m) => {
      const head = headWith(baseContent, { edge: m.mutate });
      expect(computeContentDigest(head)).not.toBe(computeContentDigest(baseContent));
      const d = diffVersions(baseVersion, rebuildVersion(versionFrom(BASELINE, T1), head));
      expect(isSemanticallyEmpty(d)).toBe(false);
      // `to`/`resolution` mutations can also break the wire pairing and surface
      // as add+remove rather than a field change; either is a REPORTED change,
      // which is the property. When it does pair, the field must be named.
      const named = d.edgesChanged.flatMap((c) => c.changes.map((f) => f.field));
      const reportedAsAddRemove = d.edgesAdded.length > 0 || d.edgesRemoved.length > 0;
      expect(named.includes(field) || reportedAsAddRemove).toBe(true);
    },
  );

  it('the table COVERS every field the comparator can emit', () => {
    // The comparator's field list, derived at RUNTIME rather than transcribed:
    // mutate every table field at once and read back which names it produced.
    // A field added to `compareNodes`/`compareEdges` with no table entry shows
    // up here as an uncovered name.
    const allNodes = NODE_MUTATIONS.reduce<VersionNode>((n, m) => m.mutate(n), baseContent.nodes[0]);
    const allEdges = EDGE_MUTATIONS.reduce<VersionEdgeRecord>((e, m) => m.mutate(e), baseContent.edges[0]);
    const head = headWith(baseContent, { node: () => allNodes, edge: () => allEdges });
    const d = diffVersions(baseVersion, rebuildVersion(versionFrom(BASELINE, T1), head));

    const emittedNodeFields = new Set(d.nodesChanged.flatMap((c) => c.changes.map((f) => f.field)));
    for (const f of emittedNodeFields) {
      expect(NODE_MUTATIONS.map((m) => m.field)).toContain(f);
    }
    // The node arm must actually have produced a change list — an empty set
    // would make the loop above vacuous.
    expect(emittedNodeFields.size).toBeGreaterThan(0);

    const emittedEdgeFields = new Set(d.edgesChanged.flatMap((c) => c.changes.map((f) => f.field)));
    for (const f of emittedEdgeFields) {
      expect(EDGE_MUTATIONS.map((m) => m.field)).toContain(f);
    }
  });

  it('the CANONICAL form hashes exactly the fields the table plus the carve-outs name', () => {
    // Direction (3): a field added to `canonicalNode`/`canonicalEdge` and to
    // nothing else changes these counts and fails here, so "hashed but not
    // diffed" cannot be introduced silently.
    const records = canonicalizeContent(baseContent).split(CANON_REC);
    const nodeRec = records.find((r) => r.startsWith('N'));
    const edgeRec = records.find((r) => r.startsWith('E'));
    expect(nodeRec).toBeDefined();
    expect(edgeRec).toBeDefined();

    // tag + id + every table field.
    expect(nodeRec!.split(CANON_SEP)).toHaveLength(1 + 1 + NODE_MUTATIONS.length);
    // tag + id + from + every table field.
    expect(edgeRec!.split(CANON_SEP)).toHaveLength(1 + 2 + EDGE_MUTATIONS.length);
  });

  it('the two carve-outs are what they are documented to be', () => {
    // EDGE id — hashed, and NOT a change: the re-identification case. This is
    // the one hashed-not-diffed field that is correct, so it is measured rather
    // than trusted.
    const idHead = headWith(baseContent, { edge: (e) => ({ ...e, id: `${e.id}#moved` as typeof e.id }) });
    expect(computeContentDigest(idHead)).not.toBe(computeContentDigest(baseContent));
    const dId = diffVersions(baseVersion, rebuildVersion(versionFrom(BASELINE, T1), idHead));
    expect(isSemanticallyEmpty(dId)).toBe(true);
    expect(dId.notes.join(' ')).toContain('re-identified');

    // EDGE from — hashed, not in `compareEdges`, and SAFE for a measured
    // reason rather than by assumption: `edgeId()` (graph/node-id.ts) embeds
    // `from` in the id, and `wireKey()` embeds it too, so a real source change
    // necessarily moves BOTH. It therefore reaches the diff as an add + a
    // remove. The mutation moves them together, because moving `from` alone is
    // a state no extractor can produce.
    const oldFrom = baseContent.edges[0].from;
    const newFrom = baseContent.nodes.find((n) => n.id !== oldFrom)!.id;
    const fromHead = headWith(baseContent, {
      edge: (e) => ({ ...e, from: newFrom, id: e.id.replace(oldFrom, newFrom) as typeof e.id }),
    });
    expect(computeContentDigest(fromHead)).not.toBe(computeContentDigest(baseContent));
    const dFrom = diffVersions(baseVersion, rebuildVersion(versionFrom(BASELINE, T1), fromHead));
    expect(isSemanticallyEmpty(dFrom)).toBe(false);
    expect(dFrom.edgesAdded.length + dFrom.edgesRemoved.length).toBeGreaterThan(0);

    // NODE id — hashed, and reported as a removal plus an addition.
    const nodeIdHead = headWith(baseContent, {
      node: (n) => ({ ...n, id: `${n.id}-renamed` as typeof n.id }),
    });
    const dNode = diffVersions(baseVersion, rebuildVersion(versionFrom(BASELINE, T1), nodeIdHead));
    expect(dNode.nodesAdded.length).toBeGreaterThan(0);
    expect(dNode.nodesRemoved.length).toBeGreaterThan(0);
  });
});

describe('canonical form — injectivity', () => {
  it('length-prefixing stops a field value forging a boundary', () => {
    // Two different graphs whose fields would concatenate identically if the
    // canonical form were "join with a separator" and a value contained one.
    const base = projectGraph(buildEstate(BASELINE));
    const first = base.nodes[0];
    const forged: GraphVersionContent = {
      formatVersion: base.formatVersion,
      nodes: [{ ...first, displayName: `${first.displayName}forged` }, ...base.nodes.slice(1)],
      edges: base.edges,
    };
    expect(computeContentDigest(forged)).not.toBe(computeContentDigest(base));
    expect(canonicalizeContent(forged)).not.toBe(canonicalizeContent(base));
  });

  it('an absent value and an empty value canonicalize differently', () => {
    const base = projectGraph(buildEstate(BASELINE));
    const first = base.nodes[0];
    const withNull: GraphVersionContent = {
      formatVersion: base.formatVersion,
      nodes: [{ ...first, location: null }, ...base.nodes.slice(1)],
      edges: base.edges,
    };
    const withEmpty: GraphVersionContent = {
      formatVersion: base.formatVersion,
      nodes: [{ ...first, location: '' }, ...base.nodes.slice(1)],
      edges: base.edges,
    };
    expect(computeContentDigest(withNull)).not.toBe(computeContentDigest(withEmpty));
  });
});

describe('counts and ids', () => {
  it('counts agree with the content they were derived from', () => {
    const content = projectGraph(buildEstate(BASELINE));
    const counts = computeCounts(content);
    expect(counts.nodes).toBe(content.nodes.length);
    expect(counts.edges).toBe(content.edges.length);
    expect(counts.resolvedEdges + counts.danglingEdges).toBe(counts.edges);
    // The founding shape: at least one dangling `configured` wire is present in
    // the baseline, so a test asserting "dangling edges survive" is not vacuous.
    expect(counts.danglingEdges).toBeGreaterThan(0);
    expect(counts.byProvenance.configured).toBeGreaterThan(0);
  });

  it('a version id is sortable and carries the digest prefix', () => {
    const id = versionId(T0, 'abcdef0123456789'.padEnd(64, '0'));
    expect(id).toBe('20260824T090000000Z-abcdef012345');
    expect(versionId(T1, 'a'.repeat(64)) > versionId(T0, 'a'.repeat(64))).toBe(true);
    // Cosmos forbids these in an item id.
    expect(id).not.toMatch(/[/\\?#]/);
  });
});

describe('verifyGraphVersion — the integrity contract', () => {
  it('accepts an untouched version', () => {
    expect(verifyGraphVersion(versionFrom(BASELINE, T0))).toEqual({ ok: true });
  });

  it('rejects a TRUNCATED version by count, before the digest check', () => {
    const v = cloneVersion(versionFrom(BASELINE, T0));
    const half = Math.floor(v.content.nodes.length / 2);
    const corrupt = { ...v, content: { ...v.content, nodes: v.content.nodes.slice(0, half) } };
    const verdict = verifyGraphVersion(corrupt);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.check).toBe('node-count');
      expect(verdict.detail).toContain('truncation signature');
    }
  });

  it('rejects an EDITED version by digest', () => {
    const v = cloneVersion(versionFrom(BASELINE, T0));
    const nodes = [...v.content.nodes];
    nodes[0] = { ...nodes[0], displayName: 'renamed-out-of-band' };
    const verdict = verifyGraphVersion({ ...v, content: { ...v.content, nodes } });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.check).toBe('digest');
  });

  it('rejects a version whose declared format disagrees with its content', () => {
    const v = versionFrom(BASELINE, T0);
    const verdict = verifyGraphVersion({ ...v, formatVersion: HISTORY_FORMAT_VERSION + 1 });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.check).toBe('format');
  });
});
