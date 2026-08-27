/**
 * LOOM BRAIN — attribute cost onto graph nodes: BILLED when there is a bill,
 * DERIVED when there is not, and NOTHING when neither can be established.
 *
 * This is the module that decides which of the two sources a number came from,
 * so it is the module where the two could get conflated. Four properties hold
 * here. D1–D3 each carry a mutation in `__tests__/cost/mutation-harness.mjs`
 * that breaks their subject in THIS source and proves the test moves; D4 has
 * tests and control arms but NO mutation arm yet, and is named as unmutated
 * rather than left to read as equal to the other three:
 *
 *   D1  A MISSING EXPORT DEGRADES TO DERIVED, LABELLED. Not to `$0.00`, and not
 *       to a throw. `$0.00` is the dangerous one: an always-on service showing
 *       zero spend reads as "nothing to see", which is the precise opposite of
 *       what an unreachable always-on service means. Every figure produced on
 *       this path carries `source: 'derived'` and renders through
 *       `./figure.ts`, which cannot emit a bill's wording for it.
 *
 *   D2  AN UNPRICEABLE RESOURCE PRODUCES NO FIGURE AT ALL — it lands in
 *       `skipped` with its reason. A node whose scale was never measured is not
 *       a node that costs nothing; `../types.ts` says so about `ScaleFacts |
 *       undefined` and this module honours it rather than re-deciding.
 *
 *   D3  BILLED AND DERIVED ARE NEVER SUMMED INTO ONE NUMBER. `./figure.ts`'s
 *       `rollup` keeps the subtotals apart and reports both counts; there is no
 *       `totalUsd` to reach for.
 *
 *   D4  A PARTIAL READ IS VISIBLY PARTIAL. Whether the subtotals cover every
 *       dollar in scope is a different question from whether they are billed or
 *       derived, so it travels in its own field — `rollup.completeness` — and
 *       reaches the rendered string. Measured before D4 existed: a read this
 *       function had ALREADY classified `'incomplete'` rendered as
 *       `"$10.00 billed across 1 resource(s)"`. The signal was on the result
 *       object the whole time and never reached the only place it mattered.
 *
 * ── POPULATION, THREE OF THEM ──────────────────────────────────────────────
 * PRP §3.2 is non-negotiable and one count is not enough here, because three
 * different empty sets mean three different things:
 *
 *   `population`          graph-shaped, from the substrate's `makePopulation`.
 *                         `blind` ⇒ the node filter matched nothing, so the
 *                         answer is about no resources at all.
 *   `rowPopulation`       rows read from the export. `blind` ⇒ no billing data
 *                         was parsed, which is why everything is derived.
 *   `resourcePopulation`  resources actually priced. `blind` ⇒ nothing could be
 *                         priced even though resources existed — the state that
 *                         would otherwise render as a confident `$0.00`.
 *
 * ── RECOMMEND-ONLY (PRP §1 decision 1) ─────────────────────────────────────
 * Nothing in this file mutates Azure. It has no client and no fetch. Of the 13
 * Container App environments visible across the operator's six subscriptions,
 * ONE is Loom's — the other 12 are the operator's blog, Sentinel, two Atlas
 * estates and more — so a cost number here is an input to a human decision, and
 * never a trigger.
 *
 * PURE.
 */

import { makePopulation, type ReachabilityFilter } from '../graph/graph';
import type {
  AzureResourceNode,
  BrainGraphView,
  BrainNode,
  CostFigure,
  NodeId,
  Population,
  SkippedSubject,
} from '../types';
import {
  boundOf,
  CONTAINER_APP_TYPE,
  deriveContainerAppCost,
  isBand,
  type DerivedCostBand,
} from './derived';
import {
  renderCost,
  rollup,
  type CostRollup,
  type LabelledCost,
  type RollupCoverage,
} from './figure';
import { makeReadPopulation, type ReadPopulation } from './population';
import type { ContainerAppsRateCard } from './rate-card';
import type { CostExportRead } from './export-reader';

/** One resource's cost, with its provenance and its rendering. */
export interface CostAttribution {
  readonly nodeId: NodeId;
  readonly displayName: string;
  /** Billed or derived — read `.source`, never assume. */
  readonly figure: CostFigure;
  /**
   * The full band, present only on the derived path. Carrying it means a caller
   * can show the floor AND the ceiling rather than only the bound that was
   * picked for {@link figure}.
   */
  readonly band?: DerivedCostBand;
  /** Always carries its label. See `./figure.ts`. */
  readonly rendered: LabelledCost;
}

/** Where the billed half of the answer came from. */
export type BilledSource = 'export' | 'none';

export interface CostAttributionResult {
  readonly attributions: readonly CostAttribution[];
  /** Graph-shaped population — nodes the filter selected. */
  readonly population: Population;
  /** Rows read from the export. Blind when there was no export. */
  readonly rowPopulation: ReadPopulation;
  /** Resources actually priced. Blind is the "would have rendered $0.00" state. */
  readonly resourcePopulation: ReadPopulation;
  readonly billedCount: number;
  readonly derivedCount: number;
  /**
   * Resources that could not be priced at all. Each has a reason in
   * {@link skipped}.
   *
   * NOT `skipped.length`: that list also carries one aggregate note about nodes
   * the filter admitted that are not Azure resources, and those are not
   * resources that could not be priced. The two are told apart by a typed flag,
   * never by the text of `subject` — see the note on that flag for why.
   */
  readonly unpricedCount: number;
  readonly skipped: readonly SkippedSubject[];
  /**
   * Subtotals kept apart. There is no combined total, by design (D3), and
   * `rollup.completeness` says whether these subtotals are all of it (D4).
   */
  readonly rollup: CostRollup;
  readonly billedSource: BilledSource;
  /**
   * Why the answer is (partly) derived. `null` only when a COMPLETE export
   * covered every priced resource. Anything else — no export, an incomplete
   * export, or an export that simply had no row for a resource — is named.
   */
  readonly degradeReason: string | null;
  /** Passed through from the export so a caller cannot quote a partial as whole. */
  readonly exportCompleteness: CostExportRead['completeness'] | null;
}

export interface AttributeCostOptions {
  /**
   * The parsed export. OPTIONAL — and its absence is the D1 path, not an error.
   * On 2026-08-23 this was the real state of the world: no export existed and
   * the live API was returning 429s.
   */
  readonly export?: CostExportRead;
  /**
   * Which bound of the derived band becomes {@link CostAttribution.figure}.
   * REQUIRED — there is no default, because a default would silently decide
   * whether the operator is looking at a floor or a ceiling.
   */
  readonly bound: 'lower' | 'upper';
  /** Override the rate card (e.g. rates re-read today). */
  readonly card?: ContainerAppsRateCard;
  /** Window to price on the derived path. Defaults to a 730-hour month. */
  readonly seconds?: number;
  /**
   * Restrict which nodes are priced. Defaults to Container Apps, which is the
   * only type `./derived.ts` can price today. Supply `describe` — it lands in
   * the population's scope.
   */
  readonly filter?: ReachabilityFilter;
}

const DEFAULT_FILTER: ReachabilityFilter = {
  resourceType: CONTAINER_APP_TYPE,
  describe: 'Container Apps (the only type the derived rate card prices)',
};

function applyFilter(nodes: readonly BrainNode[], f: ReachabilityFilter): BrainNode[] {
  return nodes.filter((n) => {
    if (f.kind && n.kind !== f.kind) return false;
    if (f.resourceType) {
      if (n.kind !== 'azure-resource') return false;
      if (n.resourceType.toLowerCase() !== f.resourceType.toLowerCase()) return false;
    }
    if (f.where && !f.where(n)) return false;
    return true;
  });
}

/**
 * A skip, carrying WHAT KIND of thing was skipped.
 *
 * `skipped` holds two categorically different entries: one per RESOURCE that
 * exists and could not be priced (D2), and a single aggregate note about nodes
 * the filter admitted that are not Azure resources at all. Only the first kind
 * is an unpriced resource, and {@link CostAttributionResult.unpricedCount}
 * counts only those.
 *
 * The discriminator used to be `subject.includes('non-azure-resource')`, and
 * `subject` on a D2 entry is a canonical ARM id — USER-CONTROLLABLE DATA.
 * Container App names are free-form, so a customer resource named
 * `non-azure-resource-sync` silently dropped out of the count while still
 * appearing in `skipped`: the worst pairing, because the number said nothing
 * was wrong and the list said otherwise.
 *
 * The flag is OPTIONAL and marks the NON-resource entry rather than the
 * resource ones, for two reasons. It leaves the D2 push site untouched, and —
 * the reason that matters — its absence therefore reads as "this IS an unpriced
 * resource". A future push that forgets the flag over-counts the blindness,
 * which is the safe direction here; under-counting it is the bug this replaces.
 */
type ClassifiedSkip = SkippedSubject & {
  /**
   * Set ONLY on the aggregate note about nodes that are not Azure resources.
   * Its absence means the subject is a resource that could not be priced.
   */
  readonly notAResource?: true;
};

/**
 * Attribute cost across the graph.
 *
 * NEVER THROWS for want of an export. Read `.population`, `.rowPopulation` and
 * `.resourcePopulation` before `.attributions` — a result over an empty node
 * set, and a result where nothing could be priced, are both green and blind,
 * and both are visible in those three counts rather than in the dollar figures.
 */
export function attributeCost(
  graph: BrainGraphView,
  options: AttributeCostOptions,
): CostAttributionResult {
  const filter = options.filter ?? DEFAULT_FILTER;
  const candidates = applyFilter(graph.nodes, filter);
  const azure = candidates.filter((n): n is AzureResourceNode => n.kind === 'azure-resource');

  const exp = options.export;
  const billedMap = exp?.byResource;

  const attributions: CostAttribution[] = [];
  const skipped: ClassifiedSkip[] = [];
  let billedCount = 0;
  let derivedCount = 0;

  for (const node of azure) {
    const billed = billedMap?.get(node.id);
    if (billed) {
      attributions.push({
        nodeId: node.id,
        displayName: node.displayName,
        figure: billed,
        rendered: renderCost(billed),
      });
      billedCount += 1;
      continue;
    }

    // D1 — no bill for this resource. Derive, and LABEL. Never fall to $0.00.
    const outcome = deriveContainerAppCost(node, {
      card: options.card,
      seconds: options.seconds,
    });
    if (!isBand(outcome)) {
      // D2 — unpriceable. No figure, a reason, and it is NOT counted as zero.
      skipped.push({ subject: outcome.subject, reason: outcome.reason });
      continue;
    }
    const figure = boundOf(outcome, options.bound);
    attributions.push({
      nodeId: node.id,
      displayName: node.displayName,
      figure,
      band: outcome,
      rendered: renderCost(figure),
    });
    derivedCount += 1;
  }

  // Non-azure nodes that the filter let through are recorded rather than
  // silently dropped: a filter that admits a code-module and prices none of
  // them would otherwise look like a clean run over the wrong population.
  const nonAzure = candidates.length - azure.length;
  if (nonAzure > 0) {
    skipped.push({
      subject: `${nonAzure} non-azure-resource node(s)`,
      reason:
        'selected by the filter but not an Azure resource — cost is only defined for Azure resources',
      notAResource: true,
    });
  }

  // Counted off the typed flag, never off the subject text. See
  // {@link ClassifiedSkip}: `subject` on every other entry is an ARM id the
  // customer names, so a substring test over it is a discriminator an operator
  // can accidentally defeat by naming a Container App badly.
  const unpricedCount = skipped.filter((s) => s.notAResource !== true).length;

  const billedSource: BilledSource = exp ? 'export' : 'none';
  let degradeReason: string | null;
  if (!exp) {
    degradeReason =
      'NO Cost Management export was supplied, so every figure here is DERIVED — a measured SKU ' +
      'multiplied by a published list rate, not a bill. Provision the export with ' +
      'platform/fiab/bicep/modules/admin-plane/cost-export.bicep; its first data lands ~24h later.';
  } else if (exp.completeness !== 'complete') {
    // R7 — name only what happened. The fall-through clause is TRUE only when
    // something actually fell through. Measured on this module: a 2-partition
    // manifest with 1 partition supplied and the single resource in scope
    // billed from the partition that WAS read emitted "resources … fell through
    // to a derived estimate, which may double-count" with `derivedCount === 0`
    // behind it. Nothing fell through. That is an error string asserting a
    // cause the code never established, which is the shape R7 exists to forbid,
    // and it would send a reader hunting for double-counted estimates that do
    // not exist. The incompleteness is real either way, so it is stated either
    // way — only the consequence differs.
    const incompleteness =
      `the export was supplied but its completeness is '${exp.completeness}' ` +
      `(${exp.completenessDetail})`;
    degradeReason =
      derivedCount > 0
        ? `${incompleteness} — ${derivedCount} resource(s) had no row in the partitions that WERE ` +
          'read and fell through to a derived estimate, which may double-count against a ' +
          'partition not read.'
        : `${incompleteness} — every resource in scope was matched to a billed row from the ` +
          'partitions that WERE read, so none was estimated; the total is nonetheless a PARTIAL ' +
          'read, and a partition that was not read may carry further charges for these same ' +
          'resources.';
  } else if (derivedCount > 0) {
    degradeReason =
      `a complete export was read, but ${derivedCount} resource(s) had no row in it and fell ` +
      'through to a derived estimate. A resource with no billing row is usually one that has not ' +
      'yet appeared in a completed billing day.';
  } else {
    degradeReason = null;
  }

  // ── ROLLUP COVERAGE — is this total ALL of it? ──────────────────────────
  // Measured before this existed: a read this same function had ALREADY
  // classified `'incomplete'` produced a rollup that rendered
  // `"$10.00 billed across 1 resource(s)"`. Every count was honest and the
  // signal sat right there on `exportCompleteness` — it simply never reached
  // the string an operator reads, which is the only place it changes a
  // decision. A partial read shown as a flat billed total is the confident
  // wrong number this whole layer exists to prevent.
  //
  // Every established gap is named in ONE detail string rather than only the
  // first, following the missing-role message in `./export-reader`: someone who
  // closes the partition gap should not then discover the unpriced resources on
  // a second pass.
  const coverageGaps: string[] = [];
  let unknownCoverage: string | null = null;
  if (exp && exp.completeness === 'incomplete') {
    coverageGaps.push(
      `the export read is INCOMPLETE (${exp.completenessDetail}), so charges in the partitions ` +
        'that were NOT read are absent from these subtotals',
    );
  } else if (exp && exp.completeness === 'unknown') {
    unknownCoverage =
      `the export read's own completeness is 'unknown' (${exp.completenessDetail}), so whether ` +
      'these subtotals cover every billed charge was never established';
  }
  if (unpricedCount > 0) {
    coverageGaps.push(
      `${unpricedCount} resource(s) in scope could not be priced at all and contribute NOTHING ` +
        'to these subtotals — see `skipped` for the reason on each',
    );
  }

  // A missing export is NOT a coverage gap. Every priceable resource in scope
  // IS represented; that the figures are estimates is `dominantSource`'s
  // statement to make, and folding it in here would smear two categories into
  // one field — the same mistake `./export-reader` calls out about INFO lines
  // living in a list named `skipped`.
  //
  // An 'unknown' note rides along into a 'partial' verdict: landing on
  // 'partial' because of a DIFFERENT gap must not delete a second thing the
  // read could not establish.
  const everyGap = unknownCoverage === null ? coverageGaps : [...coverageGaps, unknownCoverage];
  let coverage: RollupCoverage;
  if (coverageGaps.length > 0) {
    coverage = { completeness: 'partial', detail: everyGap.join('; ') };
  } else if (unknownCoverage !== null) {
    coverage = { completeness: 'unknown', detail: unknownCoverage };
  } else {
    coverage = {
      completeness: 'complete',
      detail:
        `every one of the ${azure.length} Azure resource(s) the filter selected is represented ` +
        'in these subtotals' +
        (exp
          ? ", and the export read reported its own completeness as 'complete'"
          : ', priced from the rate card because no export was supplied'),
    };
  }

  return {
    attributions,
    population: makePopulation({
      subject: 'nodes',
      nodes: candidates,
      edges: graph.edges,
      scope:
        `${candidates.length} node(s)` +
        (filter.describe ? ` matching ${filter.describe}` : '') +
        `, priced billed-first then derived; ${azure.length} were Azure resources`,
    }),
    rowPopulation:
      exp?.population ??
      makeReadPopulation({
        subject: 'rows',
        examined: 0,
        scope: 'no Cost Management export supplied — zero billing rows read',
      }),
    resourcePopulation: makeReadPopulation({
      subject: 'resources',
      examined: attributions.length,
      // `unpricedCount`, not `skipped.length`: the aggregate non-Azure note is
      // in `skipped` and is not a resource that could not be priced. Counting
      // it here inflated the sentence by one whenever the filter admitted a
      // non-Azure node — the same conflation the substring test made.
      scope: `${azure.length} Azure resource(s) considered; ${unpricedCount} could not be priced`,
    }),
    billedCount,
    derivedCount,
    unpricedCount,
    skipped,
    rollup: rollup(attributions.map((a) => a.figure), coverage),
    billedSource,
    degradeReason,
    exportCompleteness: exp?.completeness ?? null,
  };
}

/** One resource's attribution, or `undefined`. Convenience over the array. */
export function attributionFor(
  result: CostAttributionResult,
  nodeId: NodeId,
): CostAttribution | undefined {
  return result.attributions.find((a) => a.nodeId === nodeId);
}
