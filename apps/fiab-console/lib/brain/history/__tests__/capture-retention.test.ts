/**
 * CAPTURE + RETENTION.
 *
 * Two claims are proven here, and both are load-bearing enough that #3935 names
 * them individually:
 *
 *   AN UNCHANGED ESTATE PRODUCES NO NEW VERSION. Not "produces an empty diff" —
 *   produces NO VERSION. A history that grows on every poll is a log of the
 *   polling schedule; every "what's new?" answer over it is noise, and the
 *   storage bill is unbounded for no information.
 *
 *   RETENTION ACTUALLY BOUNDS. Enforced on the write path, in
 *   `captureGraphVersion`, so it cannot be defeated by a sweeper that was never
 *   scheduled. Sixty distinct captures leave exactly fifty versions.
 *
 * Both are asserted against the REAL store contract (`InMemoryGraphHistoryStore`
 * implements `GraphHistoryStore`, the same interface the Cosmos store does), so
 * these are properties of the algorithm rather than of a mock.
 */

import { describe, it, expect } from 'vitest';
import { captureGraphVersion } from '../capture';
import { GraphVersionTooLargeError } from '../model';
import {
  DEFAULT_MAX_VERSIONS,
  DEFAULT_RETENTION_POLICY,
  DEFAULT_TTL_SECONDS,
  planPrune,
} from '../retention';
import { InMemoryGraphHistoryStore } from '../store';
import {
  BASELINE,
  ESTATE,
  RUNTIME_PROVENANCES,
  buildEstate,
  versionFrom,
  type EstateSpec,
} from './fixtures';

function at(iso: string) {
  return () => new Date(iso);
}

function capture(
  store: InMemoryGraphHistoryStore,
  spec: EstateSpec,
  iso: string,
  collected: readonly ('configured' | 'owns' | 'declared')[] = RUNTIME_PROVENANCES as readonly (
    | 'configured'
    | 'owns'
  )[],
) {
  return captureGraphVersion({
    graph: buildEstate(spec),
    store,
    estateId: ESTATE,
    collectedProvenances: collected,
    source: 'test',
    now: at(iso),
  });
}

describe('capture — an unchanged estate produces NO new version', () => {
  it('the first capture creates one', async () => {
    const store = new InMemoryGraphHistoryStore();
    const r = await capture(store, BASELINE, '2026-08-24T09:00:00.000Z');
    expect(r.status).toBe('created');
    expect(r.pruned).toEqual([]);
    expect((await store.listSummaries(ESTATE)).length).toBe(1);
    // ONE version is no basis for a change verdict, and says so.
    expect(r.population.blind).toBe(true);
    expect(r.population.versionsRetained).toBe(1);
    expect(r.population.nodesPerVersion).toEqual([r.version.counts.nodes]);
    expect(r.population.edgesPerVersion).toEqual([r.version.counts.edges]);
  });

  it('an IDENTICAL second capture writes nothing and bumps the observation count', async () => {
    const store = new InMemoryGraphHistoryStore();
    const first = await capture(store, BASELINE, '2026-08-24T09:00:00.000Z');
    const second = await capture(store, BASELINE, '2026-08-24T09:05:00.000Z');

    expect(second.status).toBe('unchanged');
    expect(second.unchangedReason).toBe('identical-digest');
    expect((await store.listSummaries(ESTATE)).length).toBe(1);

    // The retained version is byte-identical apart from the two observation
    // fields — `capturedAt`, `digest` and `content` are immutable.
    const head = (await store.listSummaries(ESTATE))[0];
    expect(head.id).toBe(first.version.id);
    expect(head.capturedAt).toBe('2026-08-24T09:00:00.000Z');
    expect(head.digest).toBe(first.version.digest);
    expect(head.observedCount).toBe(2);
    expect(head.lastObservedAt).toBe('2026-08-24T09:05:00.000Z');
  });

  it('TEN identical captures leave exactly one version', async () => {
    const store = new InMemoryGraphHistoryStore();
    for (let i = 0; i < 10; i += 1) {
      await capture(store, BASELINE, `2026-08-24T09:${String(i).padStart(2, '0')}:00.000Z`);
    }
    const kept = await store.listSummaries(ESTATE);
    expect(kept).toHaveLength(1);
    expect(kept[0].observedCount).toBe(10);
  });

  it('a RE-IDENTIFIED wire (same wire, new source line) writes nothing', async () => {
    // The digest sees the change (the edge id embeds the line); the comparator
    // does not (the projection drops it). Stage 1 would store a version here;
    // stage 2 is what stops it.
    const AT_100: EstateSpec = {
      ...BASELINE,
      declaredWires: [
        { onApp: 'loom-console', toApp: 'loom-capacity-broker', envVar: 'LOOM_BROKER_URL', line: 100 },
      ],
    };
    const AT_101: EstateSpec = {
      ...BASELINE,
      declaredWires: [
        { onApp: 'loom-console', toApp: 'loom-capacity-broker', envVar: 'LOOM_BROKER_URL', line: 101 },
      ],
    };
    const provs = ['configured', 'owns', 'declared'] as const;

    const store = new InMemoryGraphHistoryStore();
    const first = await capture(store, AT_100, '2026-08-24T09:00:00.000Z', provs);
    expect(first.status).toBe('created');

    // The control: the two projections really DO hash differently, so stage 2 is
    // genuinely being exercised rather than short-circuited by stage 1.
    const a = versionFrom(AT_100, '2026-08-24T09:00:00.000Z', { collectedProvenances: provs });
    const b = versionFrom(AT_101, '2026-08-24T10:00:00.000Z', { collectedProvenances: provs });
    expect(b.digest).not.toBe(a.digest);

    const second = await capture(store, AT_101, '2026-08-24T10:00:00.000Z', provs);
    expect(second.status).toBe('unchanged');
    expect(second.unchangedReason).toBe('no-semantic-change');
    expect((await store.listSummaries(ESTATE)).length).toBe(1);
  });

  it('a REAL change does create a second version', async () => {
    const store = new InMemoryGraphHistoryStore();
    await capture(store, BASELINE, '2026-08-24T09:00:00.000Z');
    const changed: EstateSpec = {
      ...BASELINE,
      apps: [...BASELINE.apps, { name: 'loom-new', minReplicas: 1 }],
    };
    const r = await capture(store, changed, '2026-08-24T10:00:00.000Z');
    expect(r.status).toBe('created');
    expect(r.unchangedReason).toBeNull();
    const kept = await store.listSummaries(ESTATE);
    expect(kept).toHaveLength(2);
    expect(kept[0].capturedAt < kept[1].capturedAt).toBe(true);
    expect(r.population.blind).toBe(false);
  });
});

describe('retention — the bound is real and is enforced on the write path', () => {
  it('sixty distinct captures leave exactly fifty versions', async () => {
    const store = new InMemoryGraphHistoryStore();
    const created: string[] = [];
    const prunedAll: string[] = [];

    for (let i = 1; i <= 60; i += 1) {
      const spec: EstateSpec = {
        ...BASELINE,
        apps: BASELINE.apps.map((a) =>
          a.name === 'loom-scratch' ? { ...a, minReplicas: i } : a,
        ),
      };
      const iso = new Date(Date.UTC(2026, 7, 1, 0, i, 0)).toISOString();
      const r = await capture(store, spec, iso);
      // Every one is a genuine change, so every one must be stored.
      expect(r.status).toBe('created');
      created.push(r.version.id);
      prunedAll.push(...r.pruned);
    }

    const kept = await store.listSummaries(ESTATE);
    expect(kept).toHaveLength(DEFAULT_MAX_VERSIONS);
    expect(kept).toHaveLength(50);

    // The OLDEST ten are gone and the NEWEST fifty remain. Asserting both
    // directions is what catches a prune that deleted from the wrong end — the
    // failure that would silently destroy the history it is meant to bound.
    const keptIds = kept.map((k) => k.id);
    expect(keptIds).toEqual(created.slice(10));
    expect(prunedAll.sort()).toEqual(created.slice(0, 10).sort());
    for (const gone of created.slice(0, 10)) {
      expect(await store.load(ESTATE, gone)).toBeNull();
    }
    expect(await store.load(ESTATE, created[59])).not.toBeNull();
  });

  it('the capture REPORTS the prune rather than doing it silently', async () => {
    const store = new InMemoryGraphHistoryStore({ ...DEFAULT_RETENTION_POLICY, maxVersions: 3 });
    let last = await capture(store, BASELINE, '2026-08-01T00:00:00.000Z');
    for (let i = 1; i <= 4; i += 1) {
      const spec: EstateSpec = {
        ...BASELINE,
        apps: BASELINE.apps.map((a) =>
          a.name === 'loom-scratch' ? { ...a, minReplicas: i } : a,
        ),
      };
      last = await capture(store, spec, `2026-08-01T00:0${i}:00.000Z`);
    }
    expect((await store.listSummaries(ESTATE))).toHaveLength(3);
    expect(last.pruned).toHaveLength(1);
    expect(last.notes.join(' ')).toContain('retention:');
    expect(last.notes.join(' ')).toContain(String(DEFAULT_TTL_SECONDS));
  });

  it('planPrune is order-insensitive and names the OLDEST', () => {
    const summaries = Array.from({ length: 60 }, (_, i) => ({
      id: `v${String(i).padStart(3, '0')}`,
      estateId: ESTATE,
      capturedAt: new Date(Date.UTC(2026, 7, 1, 0, i, 0)).toISOString(),
      formatVersion: 1,
      digest: 'x'.repeat(64),
      counts: {
        nodes: 1,
        edges: 1,
        resolvedEdges: 1,
        danglingEdges: 0,
        byProvenance: { declared: 0, configured: 1, imports: 0, observed: 0, owns: 0 },
        byKind: {
          'azure-resource': 1,
          'loom-item': 0,
          'deploy-artifact': 0,
          'code-module': 0,
        },
      },
      collectedProvenances: ['configured' as const],
      source: 'test',
      observedCount: 1,
      lastObservedAt: new Date(Date.UTC(2026, 7, 1, 0, i, 0)).toISOString(),
    }));

    const forward = planPrune(summaries, 50);
    const reversed = planPrune([...summaries].reverse(), 50);
    expect(forward).toHaveLength(10);
    expect(forward).toEqual(summaries.slice(0, 10).map((s) => s.id));
    // A store that returned newest-first would otherwise prune the NEWEST ten.
    expect(reversed).toEqual(forward);

    expect(planPrune(summaries.slice(0, 50), 50)).toEqual([]);
    expect(planPrune([], 50)).toEqual([]);
    expect(() => planPrune(summaries, 0)).toThrow(RangeError);
  });
});

describe('oversize — the capture FAILS, and writes nothing', () => {
  it('throws GraphVersionTooLargeError with the counts and a remediation', async () => {
    const store = new InMemoryGraphHistoryStore({
      ...DEFAULT_RETENTION_POLICY,
      maxDocumentBytes: 500,
    });
    let threw: unknown = null;
    try {
      await capture(store, BASELINE, '2026-08-24T09:00:00.000Z');
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(GraphVersionTooLargeError);
    expect((threw as Error).message).toContain('NOTHING was written');
    expect((threw as Error).message).toContain('maxDocumentBytes');
    // Nothing partial landed — atomicity is the whole reason this throws.
    expect(await store.listSummaries(ESTATE)).toEqual([]);
  });

  it('the same estate under the real budget writes fine (the control)', async () => {
    const store = new InMemoryGraphHistoryStore();
    const r = await capture(store, BASELINE, '2026-08-24T09:00:00.000Z');
    expect(r.status).toBe('created');
    expect(r.bytes).toBeGreaterThan(500);
    expect(r.bytes).toBeLessThan(DEFAULT_RETENTION_POLICY.maxDocumentBytes);
  });
});

describe('capture fails closed on a corrupt head', () => {
  it('does not append on top of a head that cannot be verified', async () => {
    const store = new InMemoryGraphHistoryStore();
    await capture(store, BASELINE, '2026-08-24T09:00:00.000Z');

    // Corrupt the stored head in place, the way a bad write or a partial read
    // would leave it: fewer nodes than its own counts claim.
    const head = (await store.loadRecent(ESTATE, 1))[0];
    await store.remove(ESTATE, head.id);
    await store.append({
      ...head,
      content: { ...head.content, nodes: head.content.nodes.slice(0, 1) },
    });

    const changed: EstateSpec = {
      ...BASELINE,
      apps: [...BASELINE.apps, { name: 'loom-new', minReplicas: 1 }],
    };
    await expect(capture(store, changed, '2026-08-24T10:00:00.000Z')).rejects.toThrow(
      /failed its node-count check and was REFUSED/,
    );
  });
});
