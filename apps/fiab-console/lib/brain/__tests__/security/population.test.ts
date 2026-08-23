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
 */

import { describe, expect, it } from 'vitest';
import {
  detectorResult,
  populationCoverage,
  runSecuritySweep,
  SECURITY_DETECTORS,
  type Population,
} from '@/lib/brain/security';
import { cleanBaseline, graphOf } from './fixtures/corpus';

function pop(over: Partial<Population> = {}): Population {
  return {
    detectorId: 'test.detector',
    candidates: ['a', 'b'],
    judged: ['a', 'b'],
    unjudged: [],
    emptyIsExpected: false,
    ...over,
  };
}

describe('the population contract', () => {
  it('a compliant population produces no synthesized findings', () => {
    expect(detectorResult([], pop()).findings).toEqual([]);
  });

  it('THROWS when a detector judges a node it never enumerated', () => {
    // Not a finding about the graph — a defect in the DETECTOR. Shipping a
    // verdict from a broken population model is how RC=0 gets believed.
    expect(() => detectorResult([], pop({ judged: ['a', 'b', 'ghost'] }))).toThrow(
      /incoherent population/,
    );
  });

  it('THROWS when a candidate is silently dropped', () => {
    expect(() => detectorResult([], pop({ judged: ['a'] }))).toThrow(
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
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].findingClass).toBe('POP-population-integrity');
    expect(result.findings[0].severity).toBe('high');
    expect(result.findings[0].title).toContain('judged 1 of 2 candidates');
    expect(result.findings[0].evidence.facts.join('\n')).toContain('scope regex');
  });

  it('emits a HIGH finding for an EMPTY population — zero over zero is not clean', () => {
    const result = detectorResult([], pop({ candidates: [], judged: [] }));
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].id).toContain(':population:empty');
    expect(result.findings[0].severity).toBe('high');
  });

  it('suppresses the empty finding ONLY when emptiness is explicitly expected', () => {
    const result = detectorResult(
      [],
      pop({ candidates: [], judged: [], emptyIsExpected: true }),
    );
    expect(result.findings).toEqual([]);
  });

  it('populationCoverage reports 0 (not 1) for an empty population', () => {
    // Guards against the vacuous-truth reading: "judged all 0 of 0" must never
    // present as full coverage.
    expect(populationCoverage(pop({ candidates: [], judged: [] })).ratio).toBe(0);
    expect(populationCoverage(pop()).ratio).toBe(1);
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

  it('the sweep surfaces incomplete detectors by name, not only as a ratio', () => {
    const sweep = runSecuritySweep(cleanBaseline());
    expect(sweep.coverage.incompleteDetectors).toEqual([]);
    expect(sweep.coverage.ratio).toBe(1);
  });
});
