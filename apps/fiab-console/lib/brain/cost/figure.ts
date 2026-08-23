/**
 * LOOM BRAIN — cost figures, and the render barrier around them.
 *
 * PRP §3.4 and PRP §1 decision 3: every dollar figure carries
 * `source: 'billed' | 'derived'`, and a derived number must never reach an
 * operator looking like a bill. `../types.ts` makes `CostFigure.source`
 * REQUIRED, which stops an *unlabelled* figure from being constructed. This
 * module closes the remaining half of the hole: it stops a labelled figure from
 * being **rendered** without its label, and it stops a derived figure from being
 * rendered through the billed path at all.
 *
 * ── WHY THE REQUIRED FIELD IS NOT ENOUGH ───────────────────────────────────
 * `CostFigure.source` being required makes this a compile error:
 *
 *     const c: CostFigure = { amountUsd: 41.99, basis: '…', asOf: '…' };  // ✗
 *
 * but it does nothing about this, which is the failure that actually ships:
 *
 *     <Text>{`$${figure.amountUsd.toFixed(2)}/mo`}</Text>                 // ✓ compiles
 *
 * That renders a DERIVED estimate — a measured SKU multiplied by a published
 * list rate — in the exact visual form of a bill, and no type in the system
 * objects. Under R7 (deploy-integrity) that is a false claim: the code never
 * established what was billed. Measured 2026-08-23, the Cost Management API
 * returned HTTP 429 on ELEVEN consecutive attempts over ~35 minutes, so every
 * figure this program has produced to date is derived. The failure mode is not
 * hypothetical; it is the default.
 *
 * ── THE BARRIER ────────────────────────────────────────────────────────────
 * A rendered figure is a BRANDED string, {@link LabelledCost}, and the only
 * constructors are in this file. A plain `string` — including a template
 * literal built from `amountUsd` — is not assignable to it, so a surface typed
 * to accept `LabelledCost` cannot be handed a bare number-as-text.
 *
 *     renderCost(figure)          any figure  → label ALWAYS attached
 *     renderBilled(billedFigure)  billed ONLY → derived is a COMPILE ERROR
 *
 * `renderBilled` is the important one. `DerivedFigure` is not assignable to
 * `BilledFigure` (they differ on the `source` literal), so
 * `renderBilled(derived)` does not typecheck — and because `tsconfig.build.json`
 * excludes `**` /`__tests__`/`**`, that property is ALSO asserted below in
 * source, following the `lib/estate/pause-state.ts` pattern the graph substrate
 * adopted. A `@ts-expect-error` in a test file would not be enforced by
 * `next build`.
 *
 * Defence in depth: `renderBilled` also checks `source` at RUNTIME and throws,
 * because a `CostFigure` reconstituted from JSON (a Cosmos document, an API
 * response) carries no compile-time guarantee at all. The cast is the realistic
 * bypass, so the cast is the one that is checked.
 *
 * PURE. No I/O, no Azure client, no React.
 */

import {
  formatCostFigure,
  type CostFigure,
  type CostSource,
} from '../types';

/** Fails to compile unless `T` is exactly `true`. */
type Assert<T extends true> = T;

// ---------------------------------------------------------------------------
// §Narrowed figures
// ---------------------------------------------------------------------------

/**
 * A figure that came from a real bill — a Cost Management export, read by
 * `./export-reader`. Nothing else in `lib/brain/cost` may construct one.
 */
export type BilledFigure = CostFigure & { readonly source: 'billed' };

/**
 * A figure computed as measured-SKU × published-rate. An ESTIMATE OF A PRICE,
 * not a statement about a bill.
 */
export type DerivedFigure = CostFigure & { readonly source: 'derived' };

/**
 * P-COST-1 — a derived figure is NOT a billed figure.
 *
 * If `CostSource` is ever widened to `string`, or the two aliases are ever
 * collapsed, this flips to `true` and `next build` fails HERE. That widening is
 * the only edit that would let `renderBilled(derivedFigure)` compile.
 */
type _DerivedIsNotBilled = Assert<DerivedFigure extends BilledFigure ? false : true>;

/** P-COST-1, the other direction — so neither alias can absorb the other. */
type _BilledIsNotDerived = Assert<BilledFigure extends DerivedFigure ? false : true>;

/**
 * P-COST-2 — `CostSource` has EXACTLY the two members. A third (`'estimated'`,
 * `'unknown'`, `'cached'`) would be a value with no rendering rule, and the
 * first thing anyone would do with it is render it like a bill.
 */
type _CostSourceIsExactlyTwo = Assert<
  [CostSource] extends ['billed' | 'derived']
    ? ['billed' | 'derived'] extends [CostSource]
      ? true
      : false
    : false
>;

// ---------------------------------------------------------------------------
// §The render barrier
// ---------------------------------------------------------------------------

/**
 * A cost string that is GUARANTEED to carry its provenance, because the only
 * way to obtain one is through a constructor in this module.
 *
 * Branded for the same reason `NodeId` is: the brand is not decoration, it is
 * the property. Type a UI prop or an API field as `LabelledCost` and a bare
 * `` `$${n}` `` becomes a compile error at that boundary.
 */
export type LabelledCost = string & { readonly __brand: 'LoomBrainLabelledCost' };

/**
 * P-COST-3 — a plain string is not a rendered cost. If the brand is ever
 * removed, this flips and the build fails, because at that moment every
 * unlabelled interpolation in the console becomes assignable to a field that
 * promises a label.
 */
type _BareStringIsNotLabelled = Assert<string extends LabelledCost ? false : true>;

/**
 * The marker every DERIVED rendering carries. Asserted by the tests, and
 * exported so a UI can search for it rather than re-deriving the rule.
 */
export const DERIVED_MARKER = 'DERIVED estimate — not a bill';

/** The marker every BILLED rendering carries. */
export const BILLED_MARKER = '(billed,';

/**
 * Render ANY figure with its provenance attached. The general-purpose
 * constructor; delegates the wording to `formatCostFigure` in `../types` so
 * there is exactly one place the label text lives.
 */
export function renderCost(figure: CostFigure): LabelledCost {
  return formatCostFigure(figure) as LabelledCost;
}

/**
 * Render a BILLED figure.
 *
 * A {@link DerivedFigure} is not assignable to the parameter, so
 * `renderBilled(derived)` is a compile error — that is the gate this module
 * exists for. The runtime check below covers the cast:
 *
 *     renderBilled(derived as unknown as BilledFigure)   // throws
 *
 * It THROWS rather than silently re-labelling, because silently downgrading to
 * "derived" would hide a real defect — code that believed it had billing data
 * and did not — behind a correct-looking string.
 */
export function renderBilled(figure: BilledFigure): LabelledCost {
  if (figure.source !== 'billed') {
    throw new Error(
      `renderBilled received a figure whose source is '${String(
        (figure as CostFigure).source,
      )}', not 'billed'. A derived estimate must never be rendered as a bill ` +
        `(PRP §3.4). Use renderCost() — it attaches the correct label.`,
    );
  }
  return formatCostFigure(figure) as LabelledCost;
}

/**
 * Render a DERIVED figure. Present so a caller that KNOWS it is holding an
 * estimate can say so at the call site; the output is identical to
 * `renderCost` on the same figure.
 */
export function renderDerived(figure: DerivedFigure): LabelledCost {
  if (figure.source !== 'derived') {
    throw new Error(
      `renderDerived received a figure whose source is '${String(
        (figure as CostFigure).source,
      )}', not 'derived'.`,
    );
  }
  return formatCostFigure(figure) as LabelledCost;
}

// ---------------------------------------------------------------------------
// §Narrowing
// ---------------------------------------------------------------------------

/** Narrow an unlabelled-at-the-type-level figure to a billed one. */
export function isBilled(figure: CostFigure): figure is BilledFigure {
  return figure.source === 'billed';
}

/** Narrow to a derived figure. */
export function isDerived(figure: CostFigure): figure is DerivedFigure {
  return figure.source === 'derived';
}

// ---------------------------------------------------------------------------
// §Aggregation — where billed and derived must NOT be added together
// ---------------------------------------------------------------------------

/**
 * The result of summing a mixed set of figures.
 *
 * Summing billed and derived dollars into one number produces a figure that is
 * neither, and whatever label it is then given is false for part of it. So the
 * two are kept apart and the caller is told how many of each went in. A total
 * whose `derivedCount > 0` is NOT a bill, and `dominantSource` says so.
 */
export interface CostRollup {
  readonly billedUsd: number;
  readonly derivedUsd: number;
  readonly billedCount: number;
  readonly derivedCount: number;
  /**
   * `'billed'` only when EVERY figure was billed and there was at least one.
   * `'derived'` when any derived figure is present, or when the set was empty —
   * an empty set has established no billing, so it must not claim to be one.
   */
  readonly dominantSource: CostSource;
  /** True iff no figures went in at all. An empty rollup establishes nothing. */
  readonly blind: boolean;
}

/**
 * Roll up figures WITHOUT conflating the two sources.
 *
 * Returns the two subtotals separately. There is deliberately no `totalUsd`:
 * the one number a caller would reach for is the one that cannot be honestly
 * labelled, so it is not offered. Render with {@link renderRollup}.
 */
export function rollup(figures: readonly CostFigure[]): CostRollup {
  let billedUsd = 0;
  let derivedUsd = 0;
  let billedCount = 0;
  let derivedCount = 0;
  for (const f of figures) {
    if (f.source === 'billed') {
      billedUsd += f.amountUsd;
      billedCount += 1;
    } else {
      derivedUsd += f.amountUsd;
      derivedCount += 1;
    }
  }
  return {
    billedUsd,
    derivedUsd,
    billedCount,
    derivedCount,
    dominantSource: derivedCount === 0 && billedCount > 0 ? 'billed' : 'derived',
    blind: figures.length === 0,
  };
}

/**
 * Render a rollup. Always names BOTH subtotals and their counts, so a reader
 * cannot mistake a mostly-derived total for a bill. An empty rollup renders as
 * "no figures" rather than as `$0.00` — zero dollars measured and zero dollars
 * KNOWN are different statements, and the second one is what an empty set
 * supports (R7).
 */
export function renderRollup(r: CostRollup): LabelledCost {
  if (r.blind) {
    return ('no cost figures (0 examined — this is NOT $0.00; nothing was measured)' as LabelledCost);
  }
  const parts: string[] = [];
  if (r.billedCount > 0) {
    parts.push(`$${r.billedUsd.toFixed(2)} billed across ${r.billedCount} resource(s)`);
  }
  if (r.derivedCount > 0) {
    parts.push(
      `$${r.derivedUsd.toFixed(2)} DERIVED estimate — not a bill; ${r.derivedCount} resource(s)`,
    );
  }
  return parts.join(' + ') as LabelledCost;
}

// ---------------------------------------------------------------------------
// Keep the assertion aliases referenced so they cannot be pruned as dead code,
// exactly as `../types.ts` and `lib/estate/pause-state.ts` do.
// ---------------------------------------------------------------------------

/** The build-checked invariants of this module. Do not delete. */
export type CostFigureInvariants = [
  _DerivedIsNotBilled,
  _BilledIsNotDerived,
  _CostSourceIsExactlyTwo,
  _BareStringIsNotLabelled,
];
