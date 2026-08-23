/**
 * LOOM BRAIN cost — the render barrier.
 *
 * THE GATE THIS FILE IS: "a test that a derived figure cannot be rendered as
 * billed." Two halves, because they fail differently:
 *
 *   TYPE     `renderBilled(derived)` must not compile. Asserted with
 *            `@ts-expect-error` here AND — more importantly — by
 *            `CostFigureInvariants` in `../../cost/figure.ts`, a SOURCE file.
 *            `tsconfig.build.json` excludes `** /__tests__/**`, so a
 *            `@ts-expect-error` written only here is checked by `tsc -p
 *            tsconfig.json` and by NOTHING in `next build`. The source-level
 *            assertion is the one that gates the build.
 *
 *   RUNTIME  `renderBilled(derived as unknown as BilledFigure)` must throw. The
 *            cast is the realistic bypass — a `CostFigure` reconstituted from a
 *            Cosmos document or an API response has no compile-time guarantee
 *            at all — so the cast is what gets checked.
 */

import { describe, expect, it } from 'vitest';
import { derivedCost, billedCost } from '../../types';
import {
  BILLED_MARKER,
  DERIVED_MARKER,
  isBilled,
  isDerived,
  renderBilled,
  renderCost,
  renderDerived,
  renderRollup,
  rollup,
  type BilledFigure,
  type DerivedFigure,
} from '../../cost/figure';

const DERIVED = derivedCost(
  41.99,
  '2 replicas x 0.5 vCPU over 2628000s at list rates',
  '2026-08-23',
) as DerivedFigure;

const BILLED = billedCost(
  38.4,
  "Cost Management export 'loom-brain-daily', period 2026-08-01..2026-08-22",
  '2026-08-22',
) as BilledFigure;

describe('a derived figure cannot be rendered as billed', () => {
  it('renderBilled REJECTS a derived figure at the type level', () => {
    // @ts-expect-error — DerivedFigure is not assignable to BilledFigure. If this
    // line ever compiles, the `source` literals have been widened and the whole
    // billed/derived distinction is decorative.
    const _bad = () => renderBilled(DERIVED);
    expect(typeof _bad).toBe('function');
  });

  it('renderBilled THROWS when the type is cast away', () => {
    expect(() => renderBilled(DERIVED as unknown as BilledFigure)).toThrow(
      /must never be rendered as a bill/,
    );
  });

  it('the throw names the actual source rather than a generic failure (R7)', () => {
    expect(() => renderBilled(DERIVED as unknown as BilledFigure)).toThrow(/'derived'/);
  });

  it('a derived rendering carries the DERIVED marker and NEVER the billed one', () => {
    const rendered = renderCost(DERIVED);
    expect(rendered).toContain(DERIVED_MARKER);
    expect(rendered).not.toContain(BILLED_MARKER);
  });

  it('a derived rendering never contains the bare word "billed" as a claim', () => {
    // The word may not appear at all in the derived wording — the failure this
    // guards is a label that reads "$41.99 billed (estimate)", which an operator
    // scanning a table absorbs as a bill.
    expect(renderCost(DERIVED).toLowerCase()).not.toContain('billed');
  });

  it('a billed rendering carries the billed marker and NOT the derived one', () => {
    const rendered = renderCost(BILLED);
    expect(rendered).toContain(BILLED_MARKER);
    expect(rendered).not.toContain(DERIVED_MARKER);
  });

  it('renderBilled accepts a genuine billed figure', () => {
    expect(renderBilled(BILLED)).toContain(BILLED_MARKER);
  });

  it('renderDerived rejects a cast billed figure, symmetrically', () => {
    expect(() => renderDerived(BILLED as unknown as DerivedFigure)).toThrow(/not 'derived'/);
  });
});

describe('the rendering always carries the amount AND the provenance', () => {
  it('both figures render their amount', () => {
    expect(renderCost(DERIVED)).toContain('41.99');
    expect(renderCost(BILLED)).toContain('38.40');
  });

  it('both figures render their basis, so the number is reproducible', () => {
    expect(renderCost(DERIVED)).toContain('0.5 vCPU');
    expect(renderCost(BILLED)).toContain('loom-brain-daily');
  });
});

describe('narrowing', () => {
  it('isBilled / isDerived discriminate', () => {
    expect(isBilled(BILLED)).toBe(true);
    expect(isBilled(DERIVED)).toBe(false);
    expect(isDerived(DERIVED)).toBe(true);
    expect(isDerived(BILLED)).toBe(false);
  });
});

describe('rollup keeps billed and derived apart (D3)', () => {
  it('reports the two subtotals separately with their counts', () => {
    const r = rollup([BILLED, DERIVED, DERIVED]);
    expect(r.billedUsd).toBeCloseTo(38.4, 6);
    expect(r.derivedUsd).toBeCloseTo(83.98, 6);
    expect(r.billedCount).toBe(1);
    expect(r.derivedCount).toBe(2);
  });

  it('offers NO combined total — the one number that cannot be honestly labelled', () => {
    const r = rollup([BILLED, DERIVED]) as unknown as Record<string, unknown>;
    expect('totalUsd' in r).toBe(false);
    expect('total' in r).toBe(false);
  });

  it('dominantSource is derived the moment ANY derived figure is present', () => {
    expect(rollup([BILLED, DERIVED]).dominantSource).toBe('derived');
  });

  it('dominantSource is billed only when every figure is billed', () => {
    expect(rollup([BILLED, BILLED]).dominantSource).toBe('billed');
  });

  it('an EMPTY rollup is derived and blind — it has established no billing', () => {
    const r = rollup([]);
    expect(r.blind).toBe(true);
    expect(r.dominantSource).toBe('derived');
  });

  it('an empty rollup renders as "nothing measured", NOT as $0.00', () => {
    const rendered = renderRollup(rollup([]));
    expect(rendered).toContain('NOT $0.00');
    expect(rendered).toContain('0 examined');
  });

  it('a mixed rollup renders BOTH subtotals so neither can be read as the whole', () => {
    const rendered = renderRollup(rollup([BILLED, DERIVED]));
    expect(rendered).toContain('billed');
    expect(rendered).toContain('DERIVED estimate');
    expect(rendered).toContain('38.40');
    expect(rendered).toContain('41.99');
  });
});
