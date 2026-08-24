/**
 * THE POPULATION CONTRACT.
 *
 * Taxonomy §11.5 concludes that this repo's dominant evasion is falling outside
 * the examined population, and that the highest-value thing Loom Brain can build
 * is not the inverted reachability query — it is making every detector emit
 * `judged / candidates` and treating a shrinking `judged` as P0.
 *
 * This file is the test for that machinery itself. If these assertions are wrong,
 * every other spec in this directory is measuring something weaker than it claims.
 *
 * ── WHY THE `census` BLOCK EXISTS ─────────────────────────────────────────
 *
 * Review on 2026-08-23 defeated the previous version of this contract without
 * touching a single detector. Three narrowings injected into `candidatesOfKind`,
 * each gated on `graph.nodes.length > 13` (one above the largest fixture here),
 * passed the whole suite at `100 passed (100)` and made a live C1 defect vanish
 * while the sweep reported `ratio: 1.0`, `incompleteDetectors: []`, `unjudged: 0`.
 *
 * Every assertion in the original file compared `judged` against `candidates`.
 * Both descend from the array `candidatesOfKind` returns, so neither can see a
 * narrowing applied while that array is BUILT — the same 15-candidates/1-judged
 * failure as `check-tid-boundary-chokepoint.mjs`, moved one step upstream where
 * it logs 1/1 instead. The `census` block below is keyed to that: its graphs are
 * deliberately LARGER than any fixture, so a cardinality-gated bypass is inside
 * the tested range rather than beyond it.
 */

import { describe, expect, it } from 'vitest';
import {
  detectorResult,
  detectUnauthorizedInboundEdge,
  nodeKindCensus,
  populationCoverage,
  runSecuritySweep,
  SECURITY_DETECTORS,
  type Population,
} from '@/lib/brain/security';
import { c1NegativeOrgWideGate, cleanBaseline, graphOf } from './fixtures/corpus';

/** A graph of `n` authorizer nodes with predictable ids. */
function authorizerGraph(ids: readonly string[]) {
  return graphOf(ids.map((id) => c1NegativeOrgWideGate(id)));
}

const TWO_NODE_GRAPH = authorizerGraph(['a', 'b']);

function pop(over: Partial<Population> = {}): Population {
  return {
    detectorId: 'test.detector',
    declaredKinds: ['authorizer'],
    candidates: ['a', 'b'],
    judged: ['a', 'b'],
    unjudged: [],
    emptyIsExpected: false,
    ...over,
  };
}

describe('the population contract', () => {
  it('a compliant population produces no synthesized findings', () => {
    expect(detectorResult([], pop(), TWO_NODE_GRAPH).findings).toEqual([]);
  });

  it('THROWS when a detector judges a node it never enumerated', () => {
    // Not a finding about the graph — a defect in the DETECTOR. Shipping a
    // verdict from a broken population model is how RC=0 gets believed.
    expect(() =>
      detectorResult([], pop({ judged: ['a', 'b', 'ghost'] }), TWO_NODE_GRAPH),
    ).toThrow(/incoherent population/);
  });

  it('THROWS when a candidate is silently dropped', () => {
    expect(() => detectorResult([], pop({ judged: ['a'] }), TWO_NODE_GRAPH)).toThrow(
      /neither judged nor declared unjudged/,
    );
  });

  it('emits a HIGH finding when candidates were declared unjudged', () => {
    // This is check-tid-boundary-chokepoint.mjs's live state expressed as data:
    // 15 candidates, 1 judged, and a consumer reading only RC=0 learns the
    // opposite of the truth.
    const result = detectorResult(
      [],
      pop({
        candidates: ['a', 'b'],
        judged: ['a'],
        unjudged: [{ nodeId: 'b', reason: 'parameter name did not match the scope regex' }],
      }),
      TWO_NODE_GRAPH,
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].findingClass).toBe('POP-population-integrity');
    expect(result.findings[0].severity).toBe('high');
    expect(result.findings[0].title).toContain('judged 1 of 2 candidates');
    expect(result.findings[0].evidence.facts.join('\n')).toContain('scope regex');
  });

  it('emits a HIGH finding for an EMPTY population — zero over zero is not clean', () => {
    const result = detectorResult([], pop({ candidates: [], judged: [] }), graphOf([]));
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].id).toContain(':population:empty');
    expect(result.findings[0].severity).toBe('high');
  });

  it('suppresses the empty finding ONLY when emptiness is explicitly expected', () => {
    const result = detectorResult(
      [],
      pop({ candidates: [], judged: [], emptyIsExpected: true }),
      graphOf([]),
    );
    expect(result.findings).toEqual([]);
  });

  it('populationCoverage reports 0 (not 1) for an empty population', () => {
    // Guards against the vacuous-truth reading: "judged all 0 of 0" must never
    // present as full coverage.
    expect(populationCoverage(pop({ candidates: [], judged: [] })).ratio).toBe(0);
    expect(populationCoverage(pop()).ratio).toBe(1);
  });

  // -------------------------------------------------------------------------
  // The census cross-check — the denominator that does not move with the filter
  // -------------------------------------------------------------------------

  describe('the census cross-check (candidate-level narrowing)', () => {
    // 14 nodes: one above the largest fixture in this suite, which is where the
    // three review bypasses hid. If a future change re-introduces a
    // cardinality gate at `> 13`, these graphs are on the far side of it.
    const IDS_14 = Array.from({ length: 14 }, (_, i) => `n${i}`);
    const GRAPH_14 = authorizerGraph(IDS_14);

    it('the census counts the graph independently of candidatesOfKind', () => {
      const census = nodeKindCensus(GRAPH_14);
      expect(census.countsByKind.get('authorizer')).toBe(14);
      expect(census.kindById.size).toBe(14);
      expect(census.kindById.get('n0')).toBe('authorizer');
    });

    // -----------------------------------------------------------------------
    // The specs above call `detectorResult` DIRECTLY, so `candidatesOfKind` is
    // NOT on their path — mutating it leaves them all green. That was measured,
    // not assumed: the first revision of this block was written without the two
    // specs below, and all three `hollow-candidates-*` arms ESCAPED at
    // `17 passed (17)`. A contract test that never runs the code it is
    // defending is the same shape of blindness it exists to catch.
    //
    // These two put a real detector on the path.
    // -----------------------------------------------------------------------

    it('a DETECTOR over a 14-node graph enumerates all 14 (candidatesOfKind on path)', () => {
      const result = detectUnauthorizedInboundEdge(GRAPH_14);
      expect(result.population.candidates).toHaveLength(14);
      expect(result.population.judged).toHaveLength(14);
      expect(new Set(result.population.candidates)).toEqual(new Set(IDS_14));
      expect(populationCoverage(result.population).ratio).toBe(1);
    });

    it('the whole SWEEP over a 14-node graph enumerates all 14', () => {
      // The registry-wide form: a narrowing in the shared helper hits all nine
      // detectors at once, so the sweep is where its blast radius shows.
      const sweep = runSecuritySweep(GRAPH_14);
      const c1 = sweep.perDetector.find((r) => r.population.declaredKinds.includes('authorizer'));
      expect(c1).toBeDefined();
      expect(c1?.population.candidates).toHaveLength(14);
      expect(sweep.coverage.candidates).toBe(14);
      expect(sweep.coverage.ratio).toBe(1);
    });

    it('a full candidate set over a 14-node graph is accepted', () => {
      // The positive control. Without this, a throw below proves nothing —
      // it could be throwing on the graph rather than on the narrowing.
      const result = detectorResult(
        [],
        pop({ candidates: IDS_14, judged: IDS_14 }),
        GRAPH_14,
      );
      expect(result.findings).toEqual([]);
      expect(populationCoverage(result.population).ratio).toBe(1);
    });

    it('THROWS on a narrowed candidate list even though judged === candidates', () => {
      // The exact shape that escaped review: candidates and judged AGREE, the
      // ratio is 1.0, unjudged is empty — and 13 of 14 nodes were never looked
      // at. Only a denominator taken from the graph can see this.
      const narrowed = IDS_14.slice(0, 1);
      expect(() =>
        detectorResult([], pop({ candidates: narrowed, judged: narrowed }), GRAPH_14),
      ).toThrow(/SILENT NARROWING/);
      // And the coverage number it would otherwise have reported:
      expect(populationCoverage(pop({ candidates: narrowed, judged: narrowed })).ratio).toBe(1);
    });

    it('THROWS on a candidate list padded with duplicates back to full length', () => {
      // Defeats a length-only comparison: 14 entries, 1 distinct node.
      const padded = IDS_14.map(() => IDS_14[0]);
      expect(padded).toHaveLength(14);
      expect(() =>
        detectorResult([], pop({ candidates: padded, judged: [IDS_14[0]] }), GRAPH_14),
      ).toThrow(/duplicate id/);
    });

    it('THROWS when a candidate is absent from the graph', () => {
      const withGhost = [...IDS_14.slice(0, 13), 'not-in-graph'];
      expect(() =>
        detectorResult([], pop({ candidates: withGhost, judged: withGhost }), GRAPH_14),
      ).toThrow(/absent from the graph or outside the declared kinds/);
    });

    it('THROWS when a candidate is of a kind the detector did not declare', () => {
      // A denominator drawn from the wrong class is not describing the class it
      // names, whatever its arithmetic.
      const mixed = graphOf([
        ...IDS_14.map((id) => c1NegativeOrgWideGate(id)),
        ...cleanBaseline().nodes.filter((n) => n.kind === 'publication'),
      ]);
      const publicationIds = mixed.nodes.filter((n) => n.kind === 'publication').map((n) => n.id);
      expect(publicationIds.length).toBeGreaterThan(0);
      expect(() =>
        detectorResult(
          [],
          pop({
            candidates: [...IDS_14, ...publicationIds],
            judged: [...IDS_14, ...publicationIds],
          }),
          mixed,
        ),
      ).toThrow(/outside the declared kinds/);
    });

    it('a narrowing routed through `unjudged` is ACCEPTED and REPORTED', () => {
      // The contract does not forbid narrowing. It forbids narrowing INVISIBLY.
      // Same 1-of-14 outcome as the throwing case above, declared instead of
      // hidden: it passes, and it emits the HIGH finding that says so.
      const result = detectorResult(
        [],
        pop({
          candidates: IDS_14,
          judged: IDS_14.slice(0, 1),
          unjudged: IDS_14.slice(1).map((nodeId) => ({
            nodeId,
            reason: 'parameter name did not match the scope regex',
          })),
        }),
        GRAPH_14,
      );
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].findingClass).toBe('POP-population-integrity');
      expect(result.findings[0].title).toContain('judged 1 of 14 candidates');
      expect(populationCoverage(result.population).ratio).toBeCloseTo(1 / 14);
    });
  });

  describe('the whole registry over an EMPTY graph', () => {
    it('every detector reports its emptiness rather than reporting clean', () => {
      const sweep = runSecuritySweep(graphOf([]));
      const security = sweep.findings.filter(
        (f) => f.findingClass !== 'POP-population-integrity',
      );
      expect(security).toEqual([]);
      // One empty-population finding per registered detector — no detector may
      // quietly pass on nothing.
      const empties = sweep.findings.filter((f) => f.id.endsWith(':population:empty'));
      expect(empties).toHaveLength(SECURITY_DETECTORS.length);
      expect(new Set(empties.map((f) => f.detectorId)).size).toBe(SECURITY_DETECTORS.length);
    });
  });

  it('every registered detector declares the kinds its population is drawn from', () => {
    // `declaredKinds` is the census's source. A detector that leaves it empty
    // has an expected count of 0 for every graph, which would make the
    // cross-check vacuous for that detector specifically — the single-detector
    // form of the same evasion.
    const sweep = runSecuritySweep(cleanBaseline());
    expect(sweep.perDetector).toHaveLength(SECURITY_DETECTORS.length);
    for (const result of sweep.perDetector) {
      expect(result.population.declaredKinds.length).toBeGreaterThan(0);
    }
  });

  it('the sweep surfaces incomplete detectors by name, not only as a ratio', () => {
    const sweep = runSecuritySweep(cleanBaseline());
    expect(sweep.coverage.incompleteDetectors).toEqual([]);
    expect(sweep.coverage.ratio).toBe(1);
  });
});
