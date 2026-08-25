/**
 * THE QUERIES — and above all the NEGATIVE CONTROL on the prune predicate.
 *
 * #3935: *"`nodeUnreachableForConsecutiveVersions(n)` does not fire on a node
 * that is unreachable in only the newest version — the negative control that
 * prevents deleting a mid-deploy resource."*
 *
 * Every test below that asserts the predicate FIRES is paired with one that
 * asserts it does NOT, because a predicate that returned every node would
 * satisfy the positive half on its own — and this repo has shipped guards that
 * pass by returning everything.
 *
 * The estate under test (from `./fixtures`, verified by the diff suite):
 *
 *     deploy:estate/estate-alpha   the ownership artifact — no inbound wires
 *     loom-console                 the SOURCE of every wire; nothing wires to it
 *     loom-direct-lake             wired, live            <- must NEVER fire
 *     loom-capacity-broker         wired to '' (DANGLING) <- must fire: the
 *                                                            founding finding
 *     loom-scratch                 no wire at all         <- must fire
 *     loom-fresh                   appears in v3 only     <- must NEVER fire
 */

import { describe, it, expect } from 'vitest';
import {
  buildHistory,
  edgesAddedSince,
  edgesAddedSincePrevious,
  nodeUnreachableForConsecutiveVersions,
} from '../queries';
import { UnknownBaseVersionError } from '../model';
import { SAFE_PRUNE_MIN_SPAN_MS } from '../retention';
import {
  BASELINE,
  ESTATE,
  RUNTIME_PROVENANCES,
  nodeIdOf,
  rebuildVersion,
  versionFrom,
  type EstateSpec,
} from './fixtures';

const V1_AT = '2026-08-20T09:00:00.000Z';
const V2_AT = '2026-08-21T09:00:00.000Z';
const V3_AT = '2026-08-22T09:00:00.000Z';

/** v2: the console goes to `Updating`. A node change, no edge change. */
const E2: EstateSpec = {
  ...BASELINE,
  apps: BASELINE.apps.map((a) =>
    a.name === 'loom-console' ? { ...a, provisioningState: 'Updating' } : a,
  ),
};

/** v3: back to `Succeeded`, plus a brand-new unwired app. */
const E3: EstateSpec = {
  ...BASELINE,
  apps: [...BASELINE.apps, { name: 'loom-fresh', minReplicas: 1 }],
};

const v1 = versionFrom(BASELINE, V1_AT);
const v2 = versionFrom(E2, V2_AT);
const v3 = versionFrom(E3, V3_AT);

const ESTATE_NODE = 'deploy:estate/estate-alpha';

function history() {
  return buildHistory(ESTATE, [v1, v2, v3], 3);
}

describe('buildHistory', () => {
  it('orders chronologically regardless of the order handed in', () => {
    const h = buildHistory(ESTATE, [v3, v1, v2], 3);
    expect(h.versions.map((v) => v.capturedAt)).toEqual([V1_AT, V2_AT, V3_AT]);
  });

  it('discards versions of a different format and COUNTS the discard', () => {
    const v3b = rebuildVersion(v3, { ...v3.content, formatVersion: 2 });
    const h = buildHistory(ESTATE, [v1, v2, v3b], 3);
    expect(h.versions).toHaveLength(1);
    expect(h.versions[0].id).toBe(v3b.id);
    // The count is the whole point: a schema bump that quietly halves the
    // history is a shrinking examined population, which PRP §5 calls a P0.
    expect(h.ignoredByFormat).toBe(2);
  });
});

describe('edgesAddedSince', () => {
  it('reports the edge that appeared, and only it', () => {
    const r = edgesAddedSince(history(), v1.id);
    expect(r.added).toHaveLength(1);
    expect(r.added[0].provenance).toBe('owns');
    expect(r.added[0].to).toBe(nodeIdOf('loom-fresh'));
    expect(r.nodesAdded.map((n) => n.id)).toEqual([nodeIdOf('loom-fresh')]);
    expect(r.diff.edgesRemoved).toEqual([]);
  });

  it('reports the population, including versions retained vs examined', () => {
    const r = edgesAddedSince(history(), v1.id);
    expect(r.population.versionsRetained).toBe(3);
    expect(r.population.versionsExamined).toBe(3);
    expect(r.population.blind).toBe(false);
    expect(r.population.nodesPerVersion).toEqual([
      v1.counts.nodes,
      v2.counts.nodes,
      v3.counts.nodes,
    ]);
    expect(r.population.edgesPerVersion).toEqual([
      v1.counts.edges,
      v2.counts.edges,
      v3.counts.edges,
    ]);
  });

  it('FAILS CLOSED on an unknown base — it does not report the whole estate as new', () => {
    let threw: unknown = null;
    try {
      edgesAddedSince(history(), 'no-such-version');
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(UnknownBaseVersionError);
    expect((threw as Error).message).toContain('REFUSING');
    // The failure mode being prevented, named explicitly: had it returned
    // instead of thrown, `added` would have held every edge in v3.
    expect(v3.content.edges.length).toBeGreaterThan(1);
  });

  it('an empty history refuses rather than declaring everything new', () => {
    expect(() => edgesAddedSince(buildHistory(ESTATE, [], 0), v1.id)).toThrow(
      UnknownBaseVersionError,
    );
  });

  /**
   * ── R7: THE REFUSAL STATES ONLY WHAT IT ESTABLISHED ──────────────────────
   *
   * This function sees a WINDOW. The read path loads the newest 8 of up to 50
   * retained versions, so "not in what I was given" and "not retained" are
   * different findings. The message used to make the second claim in both
   * cases, and to quote the WINDOW size as the retained count — measured
   * against 12 retained versions it said "no retained graph version has id X …
   * 8 version(s) are retained" with the id sitting in the store and 12 of them
   * retained. Two assertions, neither established, both false.
   */
  it('over a WINDOW it refuses to claim the id is unretained, and quotes the RETAINED count', () => {
    // 3 loaded, 12 retained — the shape the read path actually has.
    const windowed = buildHistory(ESTATE, [v1, v2, v3], 12);
    let threw: unknown = null;
    try {
      edgesAddedSince(windowed, 'a-version-outside-the-window');
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(UnknownBaseVersionError);
    const err = threw as UnknownBaseVersionError;
    expect(err.retainedCount).toBe(12);
    expect(err.message).toContain('12 version(s) are retained');
    // The window size must not be reported as the retained count.
    expect(err.message).not.toContain('3 version(s) are retained');
    // And no claim about a set this call never looked at.
    expect(err.message).toContain('does NOT establish that the id is unretained');
    expect(err.message).not.toContain('no retained version has that id');
    expect(err.message).toContain('REFUSING');
  });

  it('CAN say the id is unretained when the whole retained set was loaded', () => {
    let threw: unknown = null;
    try {
      edgesAddedSince(history(), 'no-such-version');
    } catch (e) {
      threw = e;
    }
    const err = threw as UnknownBaseVersionError;
    expect(err.retainedCount).toBe(3);
    expect(err.message).toContain('Every retained version was loaded');
    expect(err.message).toContain('no retained version has that id');
  });

  it('base === head returns nothing AND says it is blind', () => {
    const r = edgesAddedSince(history(), v3.id);
    expect(r.added).toEqual([]);
    expect(r.population.blind).toBe(true);
    expect(r.notes.join(' ')).toContain('not a clean estate');
  });

  it('edgesAddedSincePrevious is null with fewer than two versions', () => {
    expect(edgesAddedSincePrevious(buildHistory(ESTATE, [v1], 1))).toBeNull();
    const r = edgesAddedSincePrevious(history());
    expect(r?.sinceVersionId).toBe(v2.id);
    expect(r?.headVersionId).toBe(v3.id);
  });
});

describe('nodeUnreachableForConsecutiveVersions — the SAFE prune predicate', () => {
  it('fires on nodes unreachable across all three versions', () => {
    const r = nodeUnreachableForConsecutiveVersions(history(), 3);
    const ids = r.nodes.map((s) => s.node.id).sort();
    expect(ids).toEqual(
      [
        ESTATE_NODE,
        nodeIdOf('loom-capacity-broker'),
        nodeIdOf('loom-console'),
        nodeIdOf('loom-scratch'),
      ].sort(),
    );
  });

  it('NEGATIVE CONTROL — does NOT fire on a node present only in the newest version', () => {
    const r = nodeUnreachableForConsecutiveVersions(history(), 3);
    expect(r.nodes.map((s) => s.node.id)).not.toContain(nodeIdOf('loom-fresh'));
    // And it IS unreachable in the newest version — so the exclusion is due to
    // the consecutive-version rule, not to the node being wired.
    const inHead = v3.content.edges.filter(
      (e) => e.provenance === 'configured' && e.resolution === 'resolved' && e.to === nodeIdOf('loom-fresh'),
    );
    expect(inHead).toEqual([]);
  });

  it('NEGATIVE CONTROL — does NOT fire on a node that IS wired', () => {
    const r = nodeUnreachableForConsecutiveVersions(history(), 3);
    expect(r.nodes.map((s) => s.node.id)).not.toContain(nodeIdOf('loom-direct-lake'));
  });

  it('a DANGLING wire does not make its target reachable — the founding finding', () => {
    const r = nodeUnreachableForConsecutiveVersions(history(), 3);
    expect(r.nodes.map((s) => s.node.id)).toContain(nodeIdOf('loom-capacity-broker'));
  });

  it('is BLIND, not clean, when the history is shallower than n', () => {
    const r = nodeUnreachableForConsecutiveVersions(buildHistory(ESTATE, [v1, v2], 2), 3);
    expect(r.nodes).toEqual([]);
    expect(r.population.blind).toBe(true);
    expect(r.notes.join(' ')).toContain('no basis');
  });

  it('REFUSES n = 1 — the single-snapshot answer it exists to replace', () => {
    expect(() => nodeUnreachableForConsecutiveVersions(history(), 1)).toThrow(RangeError);
    expect(() => nodeUnreachableForConsecutiveVersions(history(), 0)).toThrow(RangeError);
    expect(() => nodeUnreachableForConsecutiveVersions(history(), 2.5)).toThrow(RangeError);
  });

  it('holds fire when the versions span less wall clock than the floor', () => {
    // Three versions minutes apart — exactly what a single deploy produces.
    const a = versionFrom(BASELINE, '2026-08-22T09:00:00.000Z');
    const b = versionFrom(E2, '2026-08-22T09:02:00.000Z');
    const c = versionFrom(E3, '2026-08-22T09:05:00.000Z');
    const r = nodeUnreachableForConsecutiveVersions(buildHistory(ESTATE, [a, b, c], 3), 3);
    expect(r.spanMs).toBe(5 * 60 * 1000);
    expect(r.minSpanMs).toBe(SAFE_PRUNE_MIN_SPAN_MS);
    expect(r.nodes).toEqual([]);
    expect(r.population.blind).toBe(true);
    expect(r.notes.join(' ')).toContain('under the');
  });

  it('the floor is opt-OUT, and opting out is what makes the floor test honest', () => {
    const a = versionFrom(BASELINE, '2026-08-22T09:00:00.000Z');
    const b = versionFrom(E2, '2026-08-22T09:02:00.000Z');
    const c = versionFrom(E3, '2026-08-22T09:05:00.000Z');
    const r = nodeUnreachableForConsecutiveVersions(buildHistory(ESTATE, [a, b, c], 3), 3, {
      minSpanMs: 0,
    });
    // Same estate, same three versions — only the floor changed. If this were
    // still empty, the previous test would have proved nothing.
    expect(r.nodes.length).toBeGreaterThan(0);
    expect(r.population.blind).toBe(false);
  });

  it('REFUSES when any examined version did not COLLECT the provenance', () => {
    // A version that never collected `configured` has zero inbound configured
    // edges for EVERY node, vacuously. `Population.blind` cannot catch it — the
    // node set is not empty — so the coverage check is the only thing between
    // this and a screen of confident nonsense.
    const blindV2 = versionFrom(E2, V2_AT, { collectedProvenances: ['owns'] });
    const r = nodeUnreachableForConsecutiveVersions(
      buildHistory(ESTATE, [v1, blindV2, v3], 3),
      3,
    );
    expect(r.nodes).toEqual([]);
    expect(r.population.blind).toBe(true);
    expect(r.notes.join(' ')).toContain('REFUSING');
  });

  it('an unreachable node that becomes wired stops firing', () => {
    const WIRED: EstateSpec = {
      ...BASELINE,
      wires: [
        ...BASELINE.wires,
        {
          onApp: 'loom-console',
          envVar: 'LOOM_SCRATCH_URL',
          value: 'https://loom-scratch.internal.example-env.centralus.azurecontainerapps.io',
          boundTo: 'loom-scratch',
        },
      ],
    };
    const wired = versionFrom(WIRED, V3_AT);
    const r = nodeUnreachableForConsecutiveVersions(buildHistory(ESTATE, [v1, v2, wired], 3), 3);
    expect(r.nodes.map((s) => s.node.id)).not.toContain(nodeIdOf('loom-scratch'));
    // ...while the broker, still on an empty wire, keeps firing. Without this,
    // the assertion above could pass because the predicate stopped working.
    expect(r.nodes.map((s) => s.node.id)).toContain(nodeIdOf('loom-capacity-broker'));
  });

  it('reports the population and the span it examined', () => {
    const r = nodeUnreachableForConsecutiveVersions(history(), 3);
    expect(r.required).toBe(3);
    expect(r.provenance).toBe('configured');
    expect(r.spanMs).toBe(2 * 24 * 60 * 60 * 1000);
    expect(r.population.versionsExamined).toBe(3);
    expect(r.population.versionsRetained).toBe(3);
    expect(r.population.blind).toBe(false);
    expect(r.population.nodesPerVersion).toEqual([
      v1.counts.nodes,
      v2.counts.nodes,
      v3.counts.nodes,
    ]);
    expect(r.notes.join(' ')).toContain('examined the newest 3');
  });

  it('examines the NEWEST n, not the oldest', () => {
    // With n = 2 the window is [v2, v3], so loom-fresh (new in v3) is still
    // excluded, but the span is exactly the 24h floor and must be accepted.
    const r = nodeUnreachableForConsecutiveVersions(history(), 2);
    expect(r.spanMs).toBe(SAFE_PRUNE_MIN_SPAN_MS);
    expect(r.nodes.map((s) => s.node.id)).not.toContain(nodeIdOf('loom-fresh'));
    expect(r.nodes.map((s) => s.node.id)).toContain(nodeIdOf('loom-scratch'));
  });

  it('honours a non-default provenance', () => {
    // Every node here has an inbound `owns` edge except the estate artifact
    // itself, so switching provenance must change the answer — proof the
    // parameter is wired through rather than ignored.
    const r = nodeUnreachableForConsecutiveVersions(history(), 3, { provenance: 'owns' });
    expect(r.nodes.map((s) => s.node.id)).toEqual([ESTATE_NODE]);
  });
});

describe('the population is reported even when nothing is found', () => {
  it('a clean estate still says how much it examined', () => {
    const ALL_WIRED: EstateSpec = {
      apps: [
        { name: 'loom-console', minReplicas: 2, external: true },
        { name: 'loom-direct-lake', minReplicas: 1 },
      ],
      wires: [
        {
          onApp: 'loom-console',
          envVar: 'LOOM_DIRECTLAKE_URL',
          value: 'https://loom-direct-lake.internal.example-env.centralus.azurecontainerapps.io',
          boundTo: 'loom-direct-lake',
        },
      ],
    };
    const a = versionFrom(ALL_WIRED, V1_AT);
    const b = versionFrom(
      { ...ALL_WIRED, apps: ALL_WIRED.apps.map((x) => ({ ...x, minReplicas: 3 })) },
      V3_AT,
    );
    const r = nodeUnreachableForConsecutiveVersions(buildHistory(ESTATE, [a, b], 2), 2);
    // The console and the estate artifact still have no inbound `configured`
    // edge — that is TRUE, not a bug — so the assertion is on the population,
    // which must be non-empty and non-blind either way.
    expect(r.population.blind).toBe(false);
    expect(r.population.versionsExamined).toBe(2);
    expect(r.population.nodesPerVersion.every((n) => n > 0)).toBe(true);
    expect(RUNTIME_PROVENANCES).toContain(r.provenance);
  });
});
