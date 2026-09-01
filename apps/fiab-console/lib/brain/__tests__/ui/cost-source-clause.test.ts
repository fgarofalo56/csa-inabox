/**
 * `costSourceClause()` — the banner's cost-provenance wording, DERIVED from the
 * snapshot's own `CostFigure.source` values (#4245 review, #4241 defect 2).
 *
 * This clause exists because its predecessor was an R7-shape violation: a stale
 * 2026-08-23 measurement ("the Cost Management API returned HTTP 429 on 11
 * consecutive attempts") baked as a literal and rendered as the present tense
 * of every future snapshot. The replacement claims only what the findings in
 * hand carry — so all four input shapes are pinned here, not just the derived
 * branch the estate fixture happens to exercise.
 */

import { describe, expect, it } from 'vitest';
import { costSourceClause } from '@/app/admin/brain/recommendations';
import type { WireFinding } from '@/app/api/admin/brain/_lib/wire';

/** A finding carrying only what the clause reads: `cost?.source`. */
function findingWith(source?: 'derived' | 'billed'): WireFinding {
  return (source ? { cost: { source } } : {}) as unknown as WireFinding;
}

describe('costSourceClause derives the provenance wording from the findings', () => {
  it('EMPTY: no priced finding produces no clause — never a claim about absent data', () => {
    expect(costSourceClause([])).toBe('');
    // Unpriced findings are not a cost source either.
    expect(costSourceClause([findingWith(), findingWith()])).toBe('');
  });

  it('ALL DERIVED: names the derivation and disclaims the bill', () => {
    const clause = costSourceClause([findingWith('derived'), findingWith(), findingWith('derived')]);
    expect(clause).toContain('DERIVED');
    expect(clause).toContain('not a bill');
    // It must not claim billing-export provenance it does not have.
    expect(clause).not.toContain('billing');
  });

  it('ALL BILLED: names the Cost Management export and does NOT disclaim a bill', () => {
    const clause = costSourceClause([findingWith('billed')]);
    expect(clause).toContain('Cost Management billing export');
    expect(clause).not.toContain('not a bill');
    expect(clause).not.toContain('DERIVED');
  });

  it('MIXED: names BOTH provenances rather than flattening to one', () => {
    const clause = costSourceClause([findingWith('billed'), findingWith('derived')]);
    expect(clause).toContain('mix');
    expect(clause).toContain('DERIVED');
    expect(clause).toContain('billing-export');
    // Order independence — the clause is a set property, not an array accident.
    expect(costSourceClause([findingWith('derived'), findingWith('billed')])).toBe(clause);
  });

  it('R7 GUARD: no branch bakes the retired incident literal', () => {
    for (const findings of [
      [],
      [findingWith('derived')],
      [findingWith('billed')],
      [findingWith('billed'), findingWith('derived')],
    ]) {
      expect(costSourceClause(findings)).not.toMatch(/429|consecutive/i);
    }
  });
});
