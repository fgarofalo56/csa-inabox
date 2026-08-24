/**
 * LOOM BRAIN — the FAIL-CLOSED guards in `detector-kit`, with embedded controls.
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
 * The three assertions in `finalizeResult` and the ownership post-condition are
 * guards, and this repo's recorded failure mode is guards that watch nothing: a
 * matcher keyed to the wrong shape, a population of zero, a verdict that does
 * not move when the subject is broken. On a healthy estate all four of these
 * guards are silent forever, which is exactly what a broken guard looks like.
 *
 * So every one of them is exercised here against an input that DOES violate it,
 * and asserted to throw. If a guard is ever weakened to a warning, a log line or
 * a no-op, these tests go red rather than going quiet.
 *
 * They are unit tests on exported functions rather than on a rigged graph on
 * purpose: you cannot build a graph that makes `ownership()` return `'owned'`
 * with zero `owns` edges — that is the point of the fix — so the only way to
 * prove the guard can fire is to call it with the impossible pair directly.
 */

import { describe, it, expect } from 'vitest';
import {
  assertLedgerBalances,
  assertNotGreenAndBlind,
  assertNotVacuous,
  assertOwnedImpliesOwnsEdge,
  makeLedger,
  ownership,
  subjectCount,
} from '../../detectors/detector-kit';
import { makePopulation, type Finding, type Population } from '../../graph';
import { BROKER_ID, buildEdgelessGraph, buildEstateScaleGraph, buildFixtureGraph } from './fixtures';

const FINDING = { id: 'f#1' } as unknown as Finding;

function population(args: { subject: 'nodes' | 'edges'; nodes: number; edges: number }): Population {
  return makePopulation({
    subject: args.subject,
    nodes: Array.from({ length: args.nodes }, () => ({}) as never),
    edges: Array.from({ length: args.edges }, () => ({ provenance: 'configured' }) as never),
    scope: 'synthetic population for the control',
  });
}

describe('OWNERSHIP is fail-closed on the one verdict that authorizes acting', () => {
  it("CONTROL: the guard fires on ('owned', 0) — it is not a no-op", () => {
    expect(() => assertOwnedImpliesOwnsEdge('owned', 0, 'azure:example')).toThrow(
      /OWNERSHIP FAIL-CLOSED/,
    );
  });

  it('the guard does NOT fire on the three legitimate states', () => {
    // A guard that throws on everything is as useless as one that throws on
    // nothing, and it would take the detector pass down on a healthy estate.
    expect(() => assertOwnedImpliesOwnsEdge('owned', 1, 'azure:example')).not.toThrow();
    expect(() => assertOwnedImpliesOwnsEdge('not-owned', 0, 'azure:example')).not.toThrow();
    expect(() => assertOwnedImpliesOwnsEdge('not-established', 0, 'azure:example')).not.toThrow();
  });

  it("'owned' on the tagged fixture rests on a real `owns` edge", () => {
    const graph = buildFixtureGraph();
    expect(ownership(graph, BROKER_ID)).toBe('owned');
    expect(graph.inboundEdges(BROKER_ID, 'owns').result.length).toBeGreaterThan(0);
  });

  it("the untagged estate-scale graph resolves 'not-established', never 'owned'", () => {
    const graph = buildEstateScaleGraph();
    for (const n of graph.nodes) expect(ownership(graph, n.id)).toBe('not-established');
  });
});

describe('A VERDICT OVER AN EMPTY POPULATION is refused', () => {
  it('CONTROL: a finding beside a blind population throws', () => {
    const blind = population({ subject: 'edges', nodes: 7, edges: 0 });
    expect(blind.blind).toBe(true);
    expect(() => assertNotGreenAndBlind('dangling-wire', [FINDING], blind)).toThrow(/BLIND VERDICT/);
  });

  it('CONTROL: the NODE subject is checked against `examined`, not `edgesExamined`', () => {
    // The two edge-subject detectors report `examined = graph.nodes.length`, so a
    // guard that read `examined` uniformly would pass a blind edge population and
    // fail a healthy node one. `subjectCount` is what makes the check honest.
    const nodeBlind = population({ subject: 'nodes', nodes: 0, edges: 9 });
    expect(subjectCount(nodeBlind)).toBe(0);
    expect(() => assertNotGreenAndBlind('orphan', [FINDING], nodeBlind)).toThrow(/BLIND VERDICT/);
    const edgeOnly = population({ subject: 'edges', nodes: 0, edges: 4 });
    expect(() => assertNotGreenAndBlind('config-drift', [FINDING], edgeOnly)).not.toThrow();
  });

  it('ZERO findings over a blind population is legal — that is an honest refusal', () => {
    const blind = population({ subject: 'edges', nodes: 7, edges: 0 });
    expect(() => assertNotGreenAndBlind('dangling-wire', [], blind)).not.toThrow();
  });
});

describe('A LOST VERDICT is refused', () => {
  it('CONTROL: an undispositioned candidate throws and names it', () => {
    const ledger = makeLedger('unreachable-service', ['a', 'b', 'c']);
    ledger.finding('a');
    ledger.cleared('b', 'wired');
    expect(ledger.unaccounted()).toEqual(['c']);
    expect(() => assertLedgerBalances('unreachable-service', ledger)).toThrow(/LOST VERDICT/);
    expect(() => assertLedgerBalances('unreachable-service', ledger)).toThrow(/'c'/);
  });

  it('a fully dispositioned universe passes, and the counts add up', () => {
    const ledger = makeLedger('orphan', ['a', 'b', 'c']);
    ledger.finding('a');
    ledger.cleared('b', 'parent present');
    ledger.skipped('c');
    expect(() => assertLedgerBalances('orphan', ledger)).not.toThrow();
    const c = ledger.counts();
    expect(c.finding + c.cleared + c.skipped).toBe(c.universe);
    expect(c.universe).toBe(3);
  });

  it('a candidate dispositioned TWICE is a hard error, not a last-write-wins', () => {
    const ledger = makeLedger('orphan', ['a']);
    ledger.cleared('a', 'parent present');
    expect(() => ledger.finding('a')).toThrow(/dispositioned 'a' twice/);
  });

  it('a disposition OUTSIDE the declared universe is a hard error', () => {
    // This is the population and the loop disagreeing about what was examined —
    // the same class of defect as a population that lies, seen from the other end.
    const ledger = makeLedger('orphan', ['a']);
    expect(() => ledger.cleared('z', 'parent present')).toThrow(/not in the 1-member universe/);
  });

  it('every pass branch is NAMED, so `cleared` cannot be incremented silently', () => {
    const ledger = makeLedger('config-drift', ['a']);
    ledger.cleared('a', 'both sides compared and they AGREE');
    expect(ledger.clearedReasons()).toEqual(['both sides compared and they AGREE']);
  });
});

describe('A VACUOUS VERDICT is refused', () => {
  it('CONTROL: findings while the required provenance has zero resolved edges throws', () => {
    const edgeless = buildEdgelessGraph();
    expect(() => assertNotVacuous('always-on-unused', edgeless, [FINDING], ['observed'])).toThrow(
      /VACUOUS VERDICT/,
    );
  });

  it('findings are allowed once the provenance the verdict rests on is populated', () => {
    const graph = buildFixtureGraph();
    expect(() =>
      assertNotVacuous('unreachable-service', graph, [FINDING], ['configured']),
    ).not.toThrow();
  });

  it('a detector that declares NO required provenance is never called vacuous', () => {
    const edgeless = buildEdgelessGraph();
    expect(() => assertNotVacuous('orphan', edgeless, [FINDING], [])).not.toThrow();
  });
});
