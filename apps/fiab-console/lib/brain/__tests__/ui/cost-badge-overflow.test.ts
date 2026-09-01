/**
 * #4241 defect 11 — the cost badge that painted over its neighbours.
 *
 * ── WHAT THIS CAUGHT, AND WHY NOTHING ELSE DID ─────────────────────────────
 * `formatCostFigure` returns `"$46.66 (DERIVED estimate — not a bill; <basis>)"`.
 * On the live estate `basis` is a full pricing methodology — measured at ~650
 * characters, naming the meters, the retail-rate source and read date, the
 * excluded free grant, and where the scale facts came from. The whole string
 * was passed as the children of a Fluent `Badge`: a FIXED-HEIGHT chip (20px)
 * with `overflow: visible` and no wrapping. Measured on the live console
 * 2026-09-01 via getBoundingClientRect: the badge box stayed 20px tall while
 * its text laid out **1330px wide**, painting across the badge row above it
 * and the "ownership NOT established" badge below.
 *
 * Neither the ten-defect code-reading audit nor the 1818-test suite saw it:
 * jsdom performs no layout, so an overflowing box measures the same as a
 * contained one, and every committed fixture carries a SHORT basis. Only real
 * estate data is long enough to overflow. The lesson is pinned here as a
 * LENGTH-SHAPED fixture: the guard is not "does it render" but "is the string
 * the chip receives bounded".
 */
import { describe, expect, it } from 'vitest';
import { splitCostLabel } from '@/app/admin/brain/recommendations';

/** The live shape, verbatim from the estate (loom-risingwave, 2026-09-01). */
const LIVE_LABEL =
  '$46.66 (DERIVED estimate — not a bill; 1 always-on replica(s) x 2 vCPU x 30d @ ' +
  '$0.000003/vCPU-s (Container Apps "Standard vCPU Idle Usage") + 1 x 4 GiB x 30d @ ' +
  '$0.000003/GiB-s ("Standard Memory Idle Usage"). IDLE meters used because the service ' +
  'has no inbound traffic — the ACTIVE vCPU rate ($0.000024/vCPU-s) is 8x higher and ' +
  'would overstate this. Retail list, eastus, read 2026-08-23 from ' +
  'https://prices.azure.com/api/retail/prices. EXCLUDES the monthly free grant ' +
  '(180,000 vCPU-s + 360,000 GiB-s per subscription, which on a small estate can absorb ' +
  'this entirely), reservations, EA/MCA/CSP discounts, per-request and networking ' +
  "meters, and any regional rate difference. Scale facts came from 'resource')";

describe('splitCostLabel — a badge is a chip, not a paragraph', () => {
  it('THE LIVE SHAPE: the chip is short enough for a fixed-height badge', () => {
    const { chip, basis } = splitCostLabel(LIVE_LABEL);
    // The measured overflow was 1330px of text in a 20px-tall box. A chip that
    // fits carries the amount and the marker and nothing else.
    expect(chip.length).toBeLessThan(60);
    expect(chip).toBe('$46.66 (DERIVED estimate — not a bill)');
    // And the basis is NOT lost — it is the evidence for the number.
    expect(basis.length).toBeGreaterThan(400);
    expect(basis).toContain('Standard vCPU Idle Usage');
    expect(basis).toContain('EXCLUDES the monthly free grant');
  });

  it('keeps the DERIVED marker in the CHIP, never demoted to the basis', () => {
    // The load-bearing contract: a derived estimate must never read as a bill.
    // Moving the marker out of the glanceable chip would break that even though
    // the text would still be "present" somewhere on the card.
    const { chip, basis } = splitCostLabel(LIVE_LABEL);
    expect(chip).toContain('DERIVED estimate — not a bill');
    expect(basis).not.toContain('DERIVED estimate — not a bill');
  });

  it('splits a BILLED label the same way', () => {
    const { chip, basis } = splitCostLabel(
      '$12.00 (billed, Cost Management export 2026-08-30; amortized, tag loom-estate-id)',
    );
    expect(chip).toBe('$12.00 (billed, Cost Management export 2026-08-30)');
    expect(basis).toBe('amortized, tag loom-estate-id');
  });

  it('leaves an already-short label whole, with no basis line', () => {
    // No semicolon → nothing to split → the chip is the label and no empty
    // paragraph is rendered beneath it.
    const { chip, basis } = splitCostLabel('$3.10 (DERIVED estimate — not a bill)');
    expect(chip).toBe('$3.10 (DERIVED estimate — not a bill)');
    expect(basis).toBe('');
  });

  it('does not guess at an unrecognised shape', () => {
    // Refusing to split beats inventing a boundary: a mangled chip would
    // misstate provenance, which is worse than a long one.
    const odd = 'cost unavailable';
    expect(splitCostLabel(odd)).toEqual({ chip: odd, basis: '' });
  });

  it('MUTATION GUARD: a chip that swallowed the basis fails this suite', () => {
    // If splitCostLabel ever regresses to returning the label whole, the
    // first spec's length bound is what goes red — pinned explicitly here so
    // the intent survives a refactor of that spec.
    const { chip } = splitCostLabel(LIVE_LABEL);
    expect(chip).not.toContain('Retail list, eastus');
    expect(chip.length).toBeLessThan(LIVE_LABEL.length / 4);
  });
});
