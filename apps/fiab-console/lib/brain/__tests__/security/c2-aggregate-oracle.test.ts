/**
 * C2 — the aggregate oracle. The narrow arms are the point: a detector keyed to
 * "a count in a response body" is defeated four ways, and all four are here.
 */

import { describe, expect, it } from 'vitest';
import { detectAggregateOracle, securityFindingsOf } from '@/lib/brain/security';
import {
  DISCLOSURE_BOOLEAN,
  DISCLOSURE_COUNT,
  DISCLOSURE_CURSOR,
  DISCLOSURE_HEADER,
  c2NegativeResolvedScope,
  c2Positive,
  graphOf,
} from './fixtures/corpus';

describe('C2 — the aggregate oracle', () => {
  it('POSITIVE: fires on a count derived from a caller-chosen, unresolved scope', () => {
    const findings = securityFindingsOf(
      detectAggregateOracle(graphOf([c2Positive('fx:c2:count', [DISCLOSURE_COUNT])])),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].findingClass).toBe('C2-aggregate-oracle');
    // Identifiers redacted + a derived quantity not = the asymmetry signature.
    expect(findings[0].confidence).toBe('high');
    expect(findings[0].evidence.facts.join('\n')).toContain('ASYMMETRY');
  });

  it('POSITIVE (NARROW, bit-truncated): fires on a BOOLEAN — a count reduced to one bit', () => {
    const findings = securityFindingsOf(
      detectAggregateOracle(graphOf([c2Positive('fx:c2:bool', [DISCLOSURE_BOOLEAN])])),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].evidence.facts.join('\n')).toContain('NARROW');
  });

  it('POSITIVE (NARROW, off-channel): fires when the count leaves on a HEADER', () => {
    const findings = securityFindingsOf(
      detectAggregateOracle(graphOf([c2Positive('fx:c2:header', [DISCLOSURE_HEADER])])),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].evidence.facts.join('\n')).toContain('header channel');
  });

  it('POSITIVE (NARROW, no number at all): fires on cursor PRESENCE', () => {
    const findings = securityFindingsOf(
      detectAggregateOracle(graphOf([c2Positive('fx:c2:cursor', [DISCLOSURE_CURSOR])])),
    );
    expect(findings).toHaveLength(1);
  });

  it('grades every narrow shape the SAME as the count — shape is evidence, not a filter', () => {
    const grade = (id: string, d: typeof DISCLOSURE_COUNT) =>
      securityFindingsOf(detectAggregateOracle(graphOf([c2Positive(id, [d])])))[0].severity;

    const base = grade('fx:c2:g-count', DISCLOSURE_COUNT);
    expect(grade('fx:c2:g-bool', DISCLOSURE_BOOLEAN)).toBe(base);
    expect(grade('fx:c2:g-header', DISCLOSURE_HEADER)).toBe(base);
    expect(grade('fx:c2:g-cursor', DISCLOSURE_CURSOR)).toBe(base);
  });

  it('NEGATIVE CONTROL: does NOT fire when the scope was resolved before the query', () => {
    // Same handler, same `excludedByAccess: N`. The caller can only narrow to
    // scopes they already own, so the count is theirs to see. Without this
    // control a detector that simply flags counts scores identically on this
    // corpus while being useless in production.
    const findings = securityFindingsOf(
      detectAggregateOracle(graphOf([c2NegativeResolvedScope()])),
    );
    expect(findings).toEqual([]);
  });

  it('NEGATIVE CONTROL: does NOT fire when the disclosure is not derived from the scoped query', () => {
    const node = c2Positive('fx:c2:undirected', [
      { ...DISCLOSURE_COUNT, derivedFromScopedQuery: false },
    ]);
    expect(securityFindingsOf(detectAggregateOracle(graphOf([node])))).toEqual([]);
  });

  it('POPULATION: judges the resolved-scope control as well as the leaking handler', () => {
    const result = detectAggregateOracle(
      graphOf([c2Positive('fx:c2:p', [DISCLOSURE_COUNT]), c2NegativeResolvedScope()]),
    );
    expect(result.population.candidates).toHaveLength(2);
    expect(result.population.judged).toHaveLength(2);
    expect(result.population.unjudged).toEqual([]);
  });
});
