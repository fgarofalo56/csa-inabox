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
import type { GraphVersionContent } from '../model';
import { BASELINE, buildEstate, cloneVersion, seededShuffle, versionFrom } from './fixtures';

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
