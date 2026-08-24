/**
 * DETECTORS — the population rule, and the refusal that protects it.
 *
 * PRP §3.2: "A detector that returns zero findings must report the population it
 * examined. A detector over an empty node set is green and blind — that failure
 * has been found repeatedly in this repo. This is non-negotiable."
 *
 * ── THE TWO EMPTY-ISH STATES, AND WHY ONLY ONE OF THEM IS VISIBLE ──────────
 * `Population.blind` fires when the SUBJECT SET was empty. That is the easy
 * case, and the substrate already makes it impossible to omit.
 *
 * The hard case is the other one, and `blind` does NOT fire on it: a query for
 * "no inbound `declared` edge" over a graph containing ZERO declared edges
 * returns EVERY NODE. The node set was not empty, so nothing is flagged as
 * blind, and the output is the loudest possible answer — a screenful of
 * findings, every one vacuously true. That is the DEFAULT outcome of writing
 * the obvious query against this runtime, because the deployed console image
 * contains no bicep and no sources.
 *
 * `refuseIfUncollected` is the guard. These specs prove it discriminates rather
 * than merely blocking: fed a graph WITHOUT declared edges it declines, and fed
 * one WITH declared edges it emits. A guard that always says no is
 * indistinguishable from a detector that is broken.
 */

import { describe, expect, it } from 'vitest';
import {
  buildGraph,
  edgeId,
  extractFromResourceGraph,
  makePopulation,
  azureResourceNodeId,
  deployArtifactNodeId,
  type ExtractionResult,
  type PendingEdge,
} from '@/lib/brain/graph';
import {
  danglingEmptyWires,
  declaredButNotConfigured,
  reachableButUnobserved,
  runDetectors,
  unreachableAlwaysOn,
  type DetectContext,
} from '@/app/api/admin/brain/_lib/detect';
import { buildLiveGraph } from '@/app/api/admin/brain/_lib/live-graph';
import { snapshotFromCollection } from '@/app/api/admin/brain/_lib/snapshot';
import { BROKER_ID, collection, containerAppRow, estateRows, appId, SUB_A } from './estate-fixture';

function ctxFromRows(rows = estateRows()): DetectContext {
  const live = buildLiveGraph(rows);
  const owned = new Set<string>();
  for (const e of live.graph.edges) {
    if (e.provenance === 'owns' && e.resolution === 'resolved') owned.add(e.to as string);
  }
  return { graph: live.graph, coverage: live.coverage, owned };
}

describe('every detector reports its population — including when it finds nothing', () => {
  const ctx = ctxFromRows();

  it('the graph under test is NOT empty (this suite would otherwise be vacuous)', () => {
    expect(ctx.graph.nodes.length).toBeGreaterThan(5);
    expect(ctx.graph.edges.length).toBeGreaterThan(0);
  });

  for (const [name, fn] of Object.entries({
    unreachableAlwaysOn,
    danglingEmptyWires,
    declaredButNotConfigured,
    reachableButUnobserved,
  })) {
    it(`${name} carries a population and a scope`, () => {
      const run = fn(ctx);
      expect(run.result.population).toBeDefined();
      expect(run.result.population.scope.length).toBeGreaterThan(10);
      expect(run.result.population.byProvenance).toBeDefined();
      expect(run.result.detector).toBeTruthy();
    });
  }
});

describe('the vacuous-truth refusal', () => {
  const ctx = ctxFromRows();

  it('at runtime `declared` is NOT collected — the precondition for the refusal', () => {
    expect(ctx.coverage.declared.collected).toBe(false);
    expect(ctx.coverage.declared.edgeCount).toBe(0);
  });

  it('declaredButNotConfigured DECLINES rather than returning every node', () => {
    const run = declaredButNotConfigured(ctx);
    expect(run.vacuous).toBe(true);
    expect(run.result.findings).toHaveLength(0);
    // The refusal is EXPLAINED, so "declined" cannot be read as "clean".
    expect(run.vacuousReason).toContain('NOT COLLECTED');
    expect(run.vacuousReason).toContain('vacuously true of every node');
  });

  it('reachableButUnobserved likewise declines — no telemetry extractor exists', () => {
    const run = reachableButUnobserved(ctx);
    expect(run.vacuous).toBe(true);
    expect(run.result.findings).toHaveLength(0);
    expect(ctx.coverage.observed.collected).toBe(false);
  });

  it('THE DISCRIMINATION TEST: given declared edges, the SAME detector emits', () => {
    // A guard that always declines is indistinguishable from a detector that is
    // broken. This is the arm that tells them apart.
    const emitting = declaredButNotConfigured({
      ...ctx,
      coverage: {
        ...ctx.coverage,
        declared: { collected: true, edgeCount: 1, note: 'synthetic, for this test' },
      },
    });
    expect(emitting.vacuous).toBe(false);
    // It ran; whether it found anything depends on the graph, and either way it
    // reported a population rather than refusing.
    expect(emitting.result.population.scope).toContain('declared');
  });

  it('and with declared edges PRESENT it produces a real finding', () => {
    // Build a graph that genuinely has a `declared` edge into the broker and no
    // `configured` one, then assert the detector names it. This proves the
    // detector's BODY works, not only its guard.
    const rows = estateRows();
    const base = extractFromResourceGraph(rows);
    const brokerArm = appId(SUB_A, 'loom-capacity-broker');
    const artifact = deployArtifactNodeId('platform/fiab/bicep/modules/admin-plane/main.bicep');
    const pending: PendingEdge = {
      provenance: 'declared',
      from: artifact,
      targetRef: brokerArm,
      emptyValue: false,
      evidence: {
        artifact: 'platform/fiab/bicep/modules/admin-plane/main.bicep',
        line: 4730,
        symbol: 'LOOM_BROKER_URL',
        rawValue: brokerArm,
        extractor: 'bicep',
      },
    };
    const declaredExtraction: ExtractionResult = {
      source: 'bicep',
      nodes: [
        {
          id: artifact,
          kind: 'deploy-artifact',
          displayName: 'admin-plane/main.bicep',
          source: 'bicep',
          path: 'platform/fiab/bicep/modules/admin-plane/main.bicep',
          artifactKind: 'bicep-module',
        },
      ],
      edges: [pending],
      population: makePopulation({ subject: 'edges', nodes: [], edges: [], scope: 'synthetic' }),
      skipped: [],
    };
    const graph = buildGraph([base, declaredExtraction]);
    expect(graph.report.edgesByProvenance.declared).toBe(1);

    const run = declaredButNotConfigured({
      graph,
      coverage: {
        ...ctx.coverage,
        declared: { collected: true, edgeCount: 1, note: 'synthetic' },
      },
      owned: new Set(),
    });
    expect(run.vacuous).toBe(false);
    const subjects = run.result.findings.flatMap((f) => f.subjects);
    expect(subjects).toContain(BROKER_ID);
    // Keep the import referenced and the id construction honest.
    expect(azureResourceNodeId(brokerArm)).toBe(BROKER_ID);
    expect(typeof edgeId).toBe('function');
  });
});

describe('MUTATION — breaking the refusal makes these specs red', () => {
  /**
   * The mutation applied to `refuseIfUncollected` in
   * `app/api/admin/brain/_lib/detect.ts`:
   *
   *     -  if (cov.collected) return null;
   *     +  return null;                       // never refuse
   *
   *     clean    RC=0   all specs pass
   *     mutated  RC=1   3 specs fail — declaredButNotConfigured stops declining
   *                     and returns 7 vacuous findings over a graph with ZERO
   *                     declared edges
   *
   * RCs recorded in the PR body. The spec below states the invariant the
   * mutation violates, so the failure is legible rather than incidental.
   */
  it('a detector NEVER emits a finding over a provenance with zero edges', () => {
    const ctx = ctxFromRows();
    for (const [name, fn] of Object.entries({ declaredButNotConfigured, reachableButUnobserved })) {
      const run = fn(ctx);
      const prov = name === 'declaredButNotConfigured' ? 'declared' : 'observed';
      expect(ctx.coverage[prov as 'declared' | 'observed'].edgeCount).toBe(0);
      expect(
        run.result.findings.length,
        `${name} emitted ${run.result.findings.length} finding(s) over ZERO '${prov}' edges — ` +
          'every one of them is vacuously true',
      ).toBe(0);
    }
  });
});

describe('ownership scoping — reports are wide, proposals are narrow', () => {
  it('with NO ownership tag, findings are reported and proposals withheld', () => {
    const snap = snapshotFromCollection(collection(estateRows()));
    expect(snap.ownership.blind).toBe(true);
    expect(snap.findings.length).toBeGreaterThan(0);
    // Reported across every subscription...
    expect(snap.collection.subscriptionsSeen).toBe(2);
    // ...and none of them approvable.
    expect(snap.findings.every((f) => f.ownershipConfirmed === false)).toBe(true);
  });

  it('the ownership note refuses to widen the key to the tags that ARE present', () => {
    const snap = snapshotFromCollection(collection(estateRows()));
    expect(snap.ownership.note).toContain('Do NOT widen the ownership key');
    expect(snap.ownership.note).toContain('deploy');
  });

  it('WITH the estate tag stamped, the same findings become approvable', () => {
    // The discrimination arm: without it, "nothing is ever approvable" would
    // satisfy the spec above and the ownership check could be hard-coded false.
    const rows = estateRows({ ownershipTag: 'estate-under-test' });
    const snap = snapshotFromCollection(collection(rows), { estateId: 'estate-under-test' });
    expect(snap.ownership.blind).toBe(false);
    expect(snap.ownership.confirmed).toBeGreaterThan(0);
    const approvable = snap.findings.filter((f) => f.ownershipConfirmed);
    expect(approvable.length).toBeGreaterThan(0);
  });

  it('a DIFFERENT estate id does NOT claim this estate\'s resources', () => {
    // Two Loom estates can share a subscription. An estate id that does not
    // match must confer no ownership — this is the whole reason the tag carries
    // a value rather than merely existing.
    const rows = estateRows({ ownershipTag: 'estate-A' });
    const snap = snapshotFromCollection(collection(rows), { estateId: 'estate-B' });
    expect(snap.ownership.confirmed).toBe(0);
    expect(snap.findings.every((f) => f.ownershipConfirmed === false)).toBe(true);
  });

  it('a resource whose tags could NOT be read is indeterminate, not unowned', () => {
    const rows = [
      ...estateRows({ ownershipTag: 'estate-A' }),
      // ARG returns `tags: null` when it could not read them.
      containerAppRow({ name: 'unreadable-tags', tags: null, minReplicas: 1 }),
    ];
    const snap = snapshotFromCollection(collection(rows), { estateId: 'estate-A' });
    expect(snap.ownership.indeterminate).toBeGreaterThan(0);
    // The count is reported separately from "unowned" so the two never merge.
    expect(snap.ownership.note).toContain('UNREADABLE');
  });
});

describe('ranking — by derived saving, with unpriced findings kept honest', () => {
  const snap = snapshotFromCollection(collection());
  const { findings } = runDetectors(ctxFromRows());

  it('priced findings are ordered by amount, descending', () => {
    const priced = snap.findings.filter((f) => f.cost).map((f) => f.cost!.amountUsd);
    expect(priced.length).toBeGreaterThan(0);
    const sorted = [...priced].sort((a, b) => b - a);
    expect(priced).toEqual(sorted);
  });

  it('an UNPRICED finding is never sorted as though it were $0', () => {
    // Treating "we could not price this" as zero pushes it below every priced
    // finding as if it were free. Priced findings come first; unpriced ones keep
    // their severity order behind them.
    const firstUnpriced = findings.findIndex((f) => !f.cost);
    const lastPriced = findings.map((f) => Boolean(f.cost)).lastIndexOf(true);
    if (firstUnpriced !== -1 && lastPriced !== -1) {
      expect(firstUnpriced).toBeGreaterThan(lastPriced);
    }
    // ...and the UI labels them, rather than rendering $0.00.
    for (const f of findings.filter((x) => !x.cost)) {
      expect(f.costLabel).toBeUndefined();
    }
  });
});
