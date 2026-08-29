/**
 * #4017 — THE CANONICAL FORM MUST BE INJECTIVE OVER `tagKeys`, AND THE
 * COMPARATOR MUST NOT SHARE ITS BLIND SPOT.
 *
 * `digest.ts` length-prefixes every field so no value can forge a field
 * boundary. One field did not obey that: `tagKeys` was prefixed ONCE over the
 * joined string, `f(keys.join(','))`. A comma is a legal Azure tag name
 * character (ARM forbids only `<>%&\?/` and control characters), so:
 *
 *     ['a,b']      ->  f('a,b')  ->  "3:a,b"
 *     ['a', 'b']   ->  f('a,b')  ->  "3:a,b"
 *
 * Byte-identical. And `diff.ts` rendered the same field the same way, so BOTH
 * dedupe stages were blind to the same input:
 *
 *   stage 1 (digest) deduped the two versions into one — nothing was written;
 *   stage 2 (diff)   reported zero node changes if one somehow was.
 *
 * The module header calls that pair's independence the design. A shared blind
 * spot makes it worthless, which is why this file asserts BOTH stages.
 *
 * The last test is the one that matters beyond this bug: it walks every field
 * of the canonical node form and asserts each is individually distinguishable,
 * so the NEXT non-prefixed field is caught by an existing test rather than by
 * another review.
 */

import { describe, it, expect } from 'vitest';
import { canonicalizeContent, computeContentDigest } from '../digest';
import { diffVersions } from '../diff';
import { projectGraph } from '../project';
import type { GraphVersionContent, VersionNode } from '../model';
import { BASELINE, buildEstate, rebuildVersion, versionFrom } from './fixtures';

const T0 = '2026-08-24T09:00:00.000Z';
const T1 = '2026-08-24T11:00:00.000Z';

/** Replace the tag key set on the first node, leaving everything else alone. */
function withTagKeys(
  content: GraphVersionContent,
  tagKeys: readonly string[] | null,
): GraphVersionContent {
  const [first, ...rest] = content.nodes;
  const patched: VersionNode = { ...first, tagKeys };
  return { formatVersion: content.formatVersion, nodes: [patched, ...rest], edges: content.edges };
}

describe('#4017 — tagKeys is injective in the canonical form', () => {
  it('ONE key named "a,b" and TWO keys "a" + "b" do NOT share a digest', () => {
    const base = projectGraph(buildEstate(BASELINE));
    const one = withTagKeys(base, ['a,b']);
    const two = withTagKeys(base, ['a', 'b']);

    // The control: the two contents genuinely differ, so a passing assertion
    // below is about the encoding and not about two identical inputs.
    expect(one.nodes[0].tagKeys).not.toEqual(two.nodes[0].tagKeys);

    expect(computeContentDigest(one)).not.toBe(computeContentDigest(two));
    expect(canonicalizeContent(one)).not.toBe(canonicalizeContent(two));
  });

  it('the COMPARATOR reports that same change — it does not share the blind spot', () => {
    const base = projectGraph(buildEstate(BASELINE));
    const v0 = rebuildVersion(versionFrom(BASELINE, T0), withTagKeys(base, ['a,b']));
    const v1 = rebuildVersion(versionFrom(BASELINE, T1), withTagKeys(base, ['a', 'b']));

    const diff = diffVersions(v0, v1);
    expect(diff.identical).toBe(false);
    const changed = diff.nodesChanged.find((c) => c.id === base.nodes[0].id);
    expect(changed).toBeDefined();
    expect(changed?.changes.map((f) => f.field)).toContain('tagKeys');
  });

  it('a REORDERED key set is NOT reported as a change — the comparator sorts, as the digest does', () => {
    const base = projectGraph(buildEstate(BASELINE));
    const v0 = rebuildVersion(versionFrom(BASELINE, T0), withTagKeys(base, ['b', 'a']));
    const v1 = rebuildVersion(versionFrom(BASELINE, T1), withTagKeys(base, ['a', 'b']));

    // Equal digests, so the pair is consistent: a field the digest cannot see
    // must not be a field the comparator reports.
    expect(v0.digest).toBe(v1.digest);
    expect(diffVersions(v0, v1).nodesChanged).toEqual([]);
  });

  it('[] and null still differ — read-and-empty is not the same fact as unreadable', () => {
    const base = projectGraph(buildEstate(BASELINE));
    expect(computeContentDigest(withTagKeys(base, []))).not.toBe(
      computeContentDigest(withTagKeys(base, null)),
    );
    // And an empty key is a real key: [''] is neither [] nor null.
    expect(computeContentDigest(withTagKeys(base, ['']))).not.toBe(
      computeContentDigest(withTagKeys(base, [])),
    );
  });

  it('INJECTIVITY over the whole node field list — the next unprefixed field fails here', () => {
    const base = projectGraph(buildEstate(BASELINE));
    const n = base.nodes[0];

    // Each entry perturbs exactly ONE field with a value chosen to collide under
    // a naive (non-length-prefixed, separator-joined) encoding. Every pair must
    // still produce two distinct digests.
    const perturbations: readonly (readonly [string, VersionNode, VersionNode])[] = [
      [
        'displayName / resourceType boundary',
        { ...n, displayName: 'x', resourceType: 'yz' },
        { ...n, displayName: 'xy', resourceType: 'z' },
      ],
      [
        'resourceGroup / location boundary',
        { ...n, resourceGroup: 'rg', location: 'eastus' },
        { ...n, resourceGroup: 'rge', location: 'astus' },
      ],
      [
        'subscriptionId / provisioningState boundary',
        { ...n, subscriptionId: 'sub', provisioningState: 'Succeeded' },
        { ...n, subscriptionId: 'subS', provisioningState: 'ucceeded' },
      ],
      [
        'tagKeys — one key with a separator vs two keys',
        { ...n, tagKeys: ['a,b'] },
        { ...n, tagKeys: ['a', 'b'] },
      ],
      [
        'tagKeys / estateTag boundary',
        { ...n, tagKeys: ['a'], estateTag: 'bc' },
        { ...n, tagKeys: ['a', 'b'], estateTag: 'c' },
      ],
      [
        'ingress.fqdn vs estateTag',
        { ...n, ingress: { external: false, fqdn: 'host' }, estateTag: 'tag' },
        { ...n, ingress: { external: false, fqdn: 'hostt' }, estateTag: 'ag' },
      ],
    ];

    for (const [label, a, b] of perturbations) {
      const ca: GraphVersionContent = { ...base, nodes: [a, ...base.nodes.slice(1)] };
      const cb: GraphVersionContent = { ...base, nodes: [b, ...base.nodes.slice(1)] };
      expect(JSON.stringify(a), `${label}: the two nodes must actually differ`).not.toBe(
        JSON.stringify(b),
      );
      expect(computeContentDigest(ca), `${label}: canonical form collided`).not.toBe(
        computeContentDigest(cb),
      );
    }
  });
});
