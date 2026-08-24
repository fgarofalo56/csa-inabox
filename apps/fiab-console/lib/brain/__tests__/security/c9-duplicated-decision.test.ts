/**
 * C9 — the duplicated decision.
 *
 * The negative control here is load-bearing in a way the others are not: a
 * detector that flags duplication PER SE will be turned off, and this is the
 * class with the most open issues attached to it.
 */

import { describe, expect, it } from 'vitest';
import { detectDuplicatedDecision, securityFindingsOf } from '@/lib/brain/security';
import {
  C9_CANONICAL,
  C9_DIFFERENT_INPUTS,
  C9_DRIFTED,
  C9_EQUIVALENT_DUPLICATE,
  CLUSTER_KEY,
  TABLE_NON_CONTRADICTION,
  TABLE_POSITIVE_MATCH,
  graphOf,
} from './fixtures/corpus';

describe('C9 — the duplicated decision', () => {
  it('POSITIVE: fires when a member answers ALLOW where the canonical answers DENY', () => {
    const findings = securityFindingsOf(
      detectDuplicatedDecision(graphOf([C9_CANONICAL, C9_DRIFTED], { [CLUSTER_KEY]: 2 })),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].findingClass).toBe('C9-duplicated-decision');
    expect(findings[0].severity).toBe('critical');
  });

  it('names the row that diverges — caller-absent is the non-contradiction tell', () => {
    // `callerTid && docTid && docTid !== callerTid` short-circuits and PASSES
    // when either side is missing. An edge that fails to fire on missing data is
    // not an edge (bfd67ed1 / #3859).
    expect(TABLE_NON_CONTRADICTION['caller-absent']).toBe('allow');
    expect(TABLE_POSITIVE_MATCH['caller-absent']).toBe('deny');

    const findings = securityFindingsOf(
      detectDuplicatedDecision(graphOf([C9_CANONICAL, C9_DRIFTED], { [CLUSTER_KEY]: 2 })),
    );
    expect(findings[0].title).toContain('caller-absent');
    expect(findings[0].evidence.facts.join('\n')).toContain('NON-CONTRADICTION shape');
  });

  it('POSITIVE (NARROW): reports identical truth tables with DIFFERENT input provenance', () => {
    // #3843's shape: the comparison is right and the tid it reads is derived
    // differently. A truth-table diff cannot see it, because the table is a
    // function of the inputs and the inputs are what changed.
    const findings = securityFindingsOf(
      detectDuplicatedDecision(graphOf([C9_CANONICAL, C9_DIFFERENT_INPUTS], { [CLUSTER_KEY]: 2 })),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].evidence.facts.join('\n')).toContain('NARROW');
    // Deliberately graded lower than a table divergence — it IS weaker evidence
    // and must not be presented as if it were the same finding.
    expect(findings[0].severity).toBe('medium');
  });

  it('NEGATIVE CONTROL: does NOT fire on a duplicate whose truth table matches exactly', () => {
    // Duplication WITH equivalence is a maintainability issue, not a security
    // one. A detector that conflates them gets turned off — the worst available
    // outcome for the class with the most open issues.
    expect(
      detectDuplicatedDecision(graphOf([C9_CANONICAL, C9_EQUIVALENT_DUPLICATE], { [CLUSTER_KEY]: 2 }))
        .findings,
    ).toEqual([]);
  });

  it('NEGATIVE CONTROL: does NOT fire on a lone canonical implementation', () => {
    expect(
      detectDuplicatedDecision(graphOf([C9_CANONICAL], { [CLUSTER_KEY]: 1 })).findings,
    ).toEqual([]);
  });

  describe('the cluster SIZE is asserted against a declared count', () => {
    it('fires when a copy appears that the declaration does not know about', () => {
      const result = detectDuplicatedDecision(
        graphOf([C9_CANONICAL, C9_EQUIVALENT_DUPLICATE], { [CLUSTER_KEY]: 1 }),
      );
      const pop = result.findings.filter((f) => f.findingClass === 'POP-population-integrity');
      expect(pop).toHaveLength(1);
      expect(pop[0].title).toContain('2 implementation(s); 1 declared');
      expect(pop[0].evidence.facts.join('\n')).toContain('add copy N+1 in a file');
    });

    it('fires when the derived list SHRANK — the round-5 tell', () => {
      const result = detectDuplicatedDecision(graphOf([C9_CANONICAL], { [CLUSTER_KEY]: 3 }));
      const pop = result.findings.filter((f) => f.findingClass === 'POP-population-integrity');
      expect(pop).toHaveLength(1);
      expect(pop[0].evidence.facts.join('\n')).toContain('quietly getting shorter');
    });

    it('does not fire when the declaration matches', () => {
      expect(
        detectDuplicatedDecision(graphOf([C9_CANONICAL, C9_EQUIVALENT_DUPLICATE], { [CLUSTER_KEY]: 2 }))
          .findings,
      ).toEqual([]);
    });
  });

  it('reports a cluster with NO canonical member — drift there is undetectable, not undetected', () => {
    const orphanA = { ...C9_DRIFTED, id: 'fx:c9:orphan-a' };
    const orphanB = { ...C9_EQUIVALENT_DUPLICATE, id: 'fx:c9:orphan-b' };
    const findings = securityFindingsOf(
      detectDuplicatedDecision(graphOf([orphanA, orphanB], { [CLUSTER_KEY]: 2 })),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].title).toContain('NO canonical one');
  });

  it('POPULATION: judges every implementation, including the equivalent duplicate', () => {
    const result = detectDuplicatedDecision(
      graphOf([C9_CANONICAL, C9_EQUIVALENT_DUPLICATE, C9_DRIFTED], { [CLUSTER_KEY]: 3 }),
    );
    expect(result.population.judged).toHaveLength(3);
    expect(result.population.unjudged).toEqual([]);
  });
});
