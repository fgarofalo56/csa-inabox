/**
 * #4015 — A FORMAT-PUNCHED HOLE MUST NOT READ AS A CONSECUTIVE STREAK.
 *
 * `buildHistory` discards every loaded version whose `formatVersion` differs
 * from the head's. The discard was COUNTED but the count was a `filter`'s
 * leftovers: a version removed from the MIDDLE of the run leaves something that
 * is no longer contiguous, and `nodeUnreachableForConsecutiveVersions` then took
 * the newest `n` of that array and called them consecutive.
 *
 * That predicate's output is a DELETION PROPOSAL. A node wired only in the
 * punched-out version reads as unwired across the whole span, so the gap
 * masquerades as a streak and the answer proposes deleting a live resource.
 *
 * The measured trigger: >= 3 versions, a MIDDLE version on a different
 * `formatVersion`, and a node wired only in the discarded one. The existing
 * suite never builds a mixed-format history at that cardinality, which is why
 * it was green over this.
 *
 * Every positive assertion below is paired with its counterfactual — the same
 * five captures with no format bump — so "it refused" is a statement about the
 * hole and not about the fixture being unanswerable anyway.
 */

import { describe, it, expect } from 'vitest';
import { buildHistory, nodeUnreachableForConsecutiveVersions } from '../queries';
import { BASELINE, ESTATE, fqdnOf, rebuildVersion, versionFrom, type EstateSpec } from './fixtures';

const AT = [
  '2026-08-20T09:00:00.000Z',
  '2026-08-21T09:00:00.000Z',
  '2026-08-22T09:00:00.000Z',
  '2026-08-23T09:00:00.000Z',
  '2026-08-24T09:00:00.000Z',
] as const;

const SCRATCH = 'loom-scratch';

/** The one capture in which `loom-scratch` IS wired. */
const WIRED: EstateSpec = {
  ...BASELINE,
  wires: [
    ...BASELINE.wires,
    {
      onApp: 'loom-console',
      envVar: 'LOOM_SCRATCH_URL',
      value: `https://${fqdnOf(SCRATCH)}`,
      boundTo: SCRATCH,
    },
  ],
};

/** v1, v2, v4, v5 unwired; v3 wired. Format bump applied by the caller. */
function captures(bumpMiddleFormat: boolean) {
  const v1 = versionFrom(BASELINE, AT[0]);
  const v2 = versionFrom(BASELINE, AT[1]);
  const v3raw = versionFrom(WIRED, AT[2]);
  const v3 = bumpMiddleFormat
    ? rebuildVersion(v3raw, { ...v3raw.content, formatVersion: 2 })
    : v3raw;
  const v4 = versionFrom(BASELINE, AT[3]);
  const v5 = versionFrom(BASELINE, AT[4]);
  return { v1, v2, v3, v4, v5, all: [v1, v2, v3, v4, v5] };
}

const scratchIn = (r: { nodes: readonly { node: { displayName: string } }[] }): boolean =>
  r.nodes.some((s) => s.node.displayName === SCRATCH);

describe('#4015 — buildHistory records WHERE a format discard happened', () => {
  it('a middle discard is recorded with the kept version it followed', () => {
    const { v2, v3, all } = captures(true);
    const h = buildHistory(ESTATE, all, 5);

    expect(h.versions).toHaveLength(4);
    expect(h.ignoredByFormat).toBe(1);
    expect(h.formatGaps).toEqual([
      { droppedId: v3.id, droppedFormatVersion: 2, afterKeptId: v2.id },
    ]);
  });

  it('a discard OFF THE OLD END records afterKeptId: null — it is a trim, not a hole', () => {
    const v1raw = versionFrom(BASELINE, AT[0]);
    const v1 = rebuildVersion(v1raw, { ...v1raw.content, formatVersion: 2 });
    const rest = [versionFrom(BASELINE, AT[1]), versionFrom(BASELINE, AT[2])];
    const h = buildHistory(ESTATE, [v1, ...rest], 3);

    expect(h.ignoredByFormat).toBe(1);
    expect(h.formatGaps[0].afterKeptId).toBeNull();
  });

  it('a clean history records no gaps at all', () => {
    const { all } = captures(false);
    expect(buildHistory(ESTATE, all, 5).formatGaps).toEqual([]);
  });
});

describe('#4015 — the prune predicate REFUSES over a non-contiguous window', () => {
  it('THE COUNTERFACTUAL: with no format bump the predicate answers, and does NOT propose loom-scratch', () => {
    const { all } = captures(false);
    const r = nodeUnreachableForConsecutiveVersions(buildHistory(ESTATE, all, 5), 4);

    // It answered — so the fixture is genuinely answerable and the refusal below
    // is about the hole rather than about some other refusal in this window.
    expect(r.population.blind).toBe(false);
    // And it got the right answer: loom-scratch was wired inside the window.
    expect(scratchIn(r)).toBe(false);
    // The control that the predicate is not simply returning nothing.
    expect(r.nodes.length).toBeGreaterThan(0);
  });

  it('with v3 punched out, it REFUSES rather than proposing the node wired only in v3', () => {
    const { v3, all } = captures(true);
    const h = buildHistory(ESTATE, all, 5);
    const r = nodeUnreachableForConsecutiveVersions(h, 4);

    expect(r.population.blind).toBe(true);
    expect(r.nodes).toEqual([]);
    // The note NAMES the hole. "Examined the newest 4 of 5" is true and still
    // misleading, which is the whole complaint in #4015.
    const note = r.notes.join(' ');
    expect(note).toContain(v3.id);
    expect(note).toContain('not a consecutive run');
    expect(r.population.versionsIgnoredByFormat).toBe(1);
  });

  it('a gap OUTSIDE the examined window does not trigger the refusal', () => {
    const v1raw = versionFrom(BASELINE, AT[0]);
    const v1 = rebuildVersion(v1raw, { ...v1raw.content, formatVersion: 2 });
    const rest = [
      versionFrom(BASELINE, AT[1]),
      versionFrom(BASELINE, AT[2]),
      versionFrom(BASELINE, AT[3]),
    ];
    const h = buildHistory(ESTATE, [v1, ...rest], 4);
    expect(h.ignoredByFormat).toBe(1);

    // Window = the newest 3 kept versions; the drop sits before all of them.
    const r = nodeUnreachableForConsecutiveVersions(h, 3);
    expect(r.population.blind).toBe(false);
    expect(r.nodes.length).toBeGreaterThan(0);
  });
});
