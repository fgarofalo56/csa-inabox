/**
 * LOOM BRAIN — the detector-local cost model. EVERY figure it produces is
 * `derived`, and it is structurally incapable of producing a `billed` one.
 *
 * PRP §1 decision 3 and §3.4: real cost comes from a Cost Management EXPORT to
 * storage, not the live API — the API returned HTTP 429 on 11 consecutive
 * attempts over ~35 minutes on 2026-08-23. So until that export exists, every
 * dollar figure in the Brain is an ESTIMATE OF A PRICE (measured SKU x published
 * retail rate), never a statement about a bill. This module only ever calls
 * {@link derivedCost}; `billedCost` is deliberately not imported.
 *
 * When `lib/brain/cost/` lands with the export reader, THIS module is the thing
 * it supersedes for the billed path. It stays as the fallback for a resource the
 * export does not cover, and the `source` field is what tells the two apart on
 * screen (`formatCostFigure` always attaches the label).
 *
 * ── THE RATES ARE MEASURED, NOT REMEMBERED ─────────────────────────────────
 * Read 2026-08-23 from the PUBLIC, unauthenticated Azure Retail Prices API —
 * `https://prices.azure.com/api/retail/prices`, `serviceName eq 'Azure Container
 * Apps'`, `priceType eq 'Consumption'`. A rate recalled from memory and presented
 * as "retail list" is a false claim under R7; these were fetched and the raw
 * meter names are recorded beside each number so the query can be re-run.
 *
 * ── GOV IS NOT COMMERCIAL, AND THE DIFFERENCE IS MATERIAL ──────────────────
 * `cloud-parity.md`: a Commercial-only capability is INCOMPLETE. A cost model
 * that hard-codes Commercial rates does not merely lack Gov support — it reports
 * a CONFIDENTLY WRONG number for Gov. On the IDLE rates this model actually
 * reports with, a Commercial figure understates Gov by 25% on BOTH vCPU and
 * memory; on the ACTIVE upper bound it also names, vCPU is understated by 20%:
 *
 *     vCPU active   commercial $0.000024/s   gov $0.000030/s   (+25% gov)
 *     vCPU idle     commercial $0.000003/s   gov $0.000004/s   (+33% gov)
 *     memory        commercial $0.000003/GiB-s gov $0.000004/GiB-s (+33% gov)
 *
 * So the rate table is keyed by ARM region, and a region that is NOT in it
 * produces NO figure and a stated reason — never a Commercial rate applied to an
 * unknown region, which is the shape of the bug this paragraph exists to prevent.
 *
 * ── WHY THE IDLE RATE IS THE HEADLINE NUMBER ───────────────────────────────
 * The detectors that attach a cost are reporting a service NOTHING CALLS, and
 * `learn.microsoft.com/azure/container-apps/billing` defines the idle regime as
 * exactly that shape: minReplicas > 0, scaled to that minimum, no HTTP requests
 * in flight, under 0.01 vCPU, under 1,000 B/s. So idle is not the convenient
 * rate, it is the documented one for this population. The ACTIVE figure is
 * computed too and named in the basis as the upper bound, because a probed
 * replica leaves idle briefly and a reader deserves the range rather than one
 * number whose regime is unstated.
 *
 * ── WHAT THIS MODEL DELIBERATELY DOES NOT DO ───────────────────────────────
 * It does not net off the per-subscription monthly free grant (180,000 vCPU-s and
 * 360,000 GiB-s, per the billing doc above). That grant is shared across every
 * Consumption app in the subscription, so attributing it to ONE app requires the
 * subscription's total usage — which this pure module does not have. Subtracting
 * it would flatter the number by an amount the code cannot establish; the basis
 * says so out loud instead.
 */

import { derivedCost, type AzureResourceNode, type CostFigure } from '../graph';

/** 730 hours, the Azure convention for a billing month. 730 * 3600. */
export const SECONDS_PER_MONTH = 2_628_000;

/** ISO date the rate table below was read from the retail prices API. */
export const RATES_READ_AT = '2026-08-23';

/** The retail prices endpoint the table was read from. Public, unauthenticated. */
export const RATES_SOURCE = 'https://prices.azure.com/api/retail/prices';

/**
 * The billing rules this model implements. Cited in every basis, because the
 * free-grant sizes and the idle-eligibility conditions are FACTS ABOUT AZURE that
 * this code must not state from memory (R7).
 *
 * Verified 2026-08-23. The page states, verbatim: the first 180,000 vCPU-seconds,
 * 360,000 GiB-seconds and 2 million HTTP requests are free per subscription per
 * calendar month; and a replica bills at the reduced IDLE rate when its revision
 * has a minimum replica count greater than zero, is scaled to that minimum, all
 * containers are running, it is processing no HTTP requests, it is using less
 * than 0.01 vCPU cores, and it is receiving less than 1,000 bytes per second.
 *
 * That last list is why IDLE is the right headline rate here and not a
 * convenient one: it is the DEFINITION of a min-replica service nobody calls,
 * which is precisely the population these detectors report.
 */
export const BILLING_DOC = 'https://learn.microsoft.com/azure/container-apps/billing';

/**
 * Consumption (Standard workload profile) rates for one ARM region.
 *
 * Meter names, verbatim, so the query is reproducible:
 *   `Standard vCPU Active Usage`     per 1 Second
 *   `Standard vCPU Idle Usage`       per 1 Second
 *   `Standard Memory Active Usage`   per 1 GiB Second
 *   `Standard Memory Idle Usage`     per 1 GiB Second
 */
export interface ContainerAppsRates {
  readonly vcpuActivePerSecond: number;
  readonly vcpuIdlePerSecond: number;
  readonly memoryActivePerGiBSecond: number;
  readonly memoryIdlePerGiBSecond: number;
}

/**
 * MEASURED 2026-08-23. Four regions: the two Commercial regions this estate
 * actually runs in, and both Gov regions, so a Gov finding is priced at Gov rates
 * rather than silently at Commercial ones.
 *
 * Keys are lowercase ARM region names. A region absent from this map yields NO
 * cost figure — see {@link estimateAlwaysOnMonthlyCost}.
 */
export const CONTAINER_APPS_RETAIL_RATES: Readonly<Record<string, ContainerAppsRates>> = {
  centralus: {
    vcpuActivePerSecond: 0.000024,
    vcpuIdlePerSecond: 0.000003,
    memoryActivePerGiBSecond: 0.000003,
    memoryIdlePerGiBSecond: 0.000003,
  },
  eastus: {
    vcpuActivePerSecond: 0.000024,
    vcpuIdlePerSecond: 0.000003,
    memoryActivePerGiBSecond: 0.000003,
    memoryIdlePerGiBSecond: 0.000003,
  },
  usgovvirginia: {
    vcpuActivePerSecond: 0.00003,
    vcpuIdlePerSecond: 0.000004,
    memoryActivePerGiBSecond: 0.000004,
    memoryIdlePerGiBSecond: 0.000004,
  },
  usgovarizona: {
    vcpuActivePerSecond: 0.00003,
    vcpuIdlePerSecond: 0.000004,
    memoryActivePerGiBSecond: 0.000004,
    memoryIdlePerGiBSecond: 0.000004,
  },
};

/**
 * Parse a Container Apps memory string to GiB.
 *
 * Returns `null` on anything it does not recognise rather than guessing. A memory
 * string this function cannot read is NOT 0 GiB — treating it as zero would
 * silently halve an estimate and no one would see it happen.
 */
export function memoryGiB(memory: string): number | null {
  const m = /^\s*([0-9]*\.?[0-9]+)\s*(Gi|Mi|G|M)?\s*$/i.exec(memory);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  const unit = (m[2] ?? 'Gi').toLowerCase();
  if (unit === 'gi' || unit === 'g') return n;
  if (unit === 'mi' || unit === 'm') return n / 1024;
  return null;
}

/**
 * The result of trying to price a node.
 *
 * A UNION, not `CostFigure | undefined`, because "I could not price this" needs a
 * REASON that a detector can put in `skipped`. An undefined return would collapse
 * "the region has no published rate" and "the scale was never measured" into one
 * indistinguishable silence — the exact R7 failure the graph types spend their
 * `ScaleFacts | undefined` comment warning about.
 */
export type CostEstimate =
  | { readonly kind: 'priced'; readonly figure: CostFigure; readonly activeUpperBoundUsd: number }
  | { readonly kind: 'not-priced'; readonly reason: string };

/**
 * Derived monthly cost of an always-on Container App, at the IDLE rate.
 *
 * Every early return names what was missing. Nothing here defaults a missing
 * measurement to zero.
 */
export function estimateAlwaysOnMonthlyCost(node: AzureResourceNode): CostEstimate {
  const scale = node.scale;
  if (scale === undefined) {
    return {
      kind: 'not-priced',
      reason:
        'scale facts were NOT MEASURED for this resource (no `properties.template.scale` in the ' +
        'discovery row). Absent scale is not minReplicas 0 — no cost can be derived.',
    };
  }
  // THE PREDICATE. A resource that scales to zero costs nothing when idle, so
  // there is no always-on figure to report for it.
  if (scale.minReplicas <= 0) {
    return {
      kind: 'not-priced',
      reason: `minReplicas is ${scale.minReplicas}: the resource scales to zero, so it has no always-on floor cost.`,
    };
  }
  if (scale.cpu === undefined || scale.memory === undefined) {
    return {
      kind: 'not-priced',
      reason:
        `per-replica cpu/memory were NOT MEASURED (cpu=${String(scale.cpu)}, memory=${String(scale.memory)}). ` +
        'A cost derived from a guessed container size would be a fabricated number.',
    };
  }
  const gib = memoryGiB(scale.memory);
  if (gib === null) {
    return {
      kind: 'not-priced',
      reason: `memory string '${scale.memory}' is not in a form this model can parse (expected e.g. '1Gi' or '512Mi').`,
    };
  }
  const region = node.location?.trim().toLowerCase();
  if (!region) {
    return {
      kind: 'not-priced',
      reason: 'the resource carries no `location`, and retail rates are per-region. No region, no rate, no figure.',
    };
  }
  // `Object.hasOwn`, NOT a bare index. The table is an object literal and
  // `region` is caller-supplied, so a bare `RATES[region]` also reads
  // `Object.prototype`. MEASURED in review of this PR: `location: 'constructor'`
  // survives `toLowerCase()` unchanged, returns the `Object` constructor
  // (truthy), passes an `if (!rates)` check, and yields `undefined * n = NaN` —
  // a `kind:'priced'` figure of `$NaN` that `severityForMonthlyUsd` then renders
  // at severity 'low'. `'__proto__'` does the same. Neither is a real ARM region,
  // but a NaN presented as a derived dollar figure is exactly the false claim
  // the module header above forbids, so the lookup is closed rather than argued
  // about.
  const rates = Object.hasOwn(CONTAINER_APPS_RETAIL_RATES, region)
    ? CONTAINER_APPS_RETAIL_RATES[region]
    : undefined;
  if (!rates) {
    return {
      kind: 'not-priced',
      reason:
        `no retail rate was read for region '${region}'. Known regions: ` +
        `${Object.keys(CONTAINER_APPS_RETAIL_RATES).join(', ')}. Applying another region's rate would ` +
        'be a confidently wrong number — Gov rates are 25-33% above Commercial.',
    };
  }

  const replicas = scale.minReplicas;
  const vcpuSeconds = replicas * scale.cpu * SECONDS_PER_MONTH;
  const gibSeconds = replicas * gib * SECONDS_PER_MONTH;

  const idleUsd = vcpuSeconds * rates.vcpuIdlePerSecond + gibSeconds * rates.memoryIdlePerGiBSecond;
  const activeUsd = vcpuSeconds * rates.vcpuActivePerSecond + gibSeconds * rates.memoryActivePerGiBSecond;

  const basis =
    `${replicas} always-on replica(s) x ${scale.cpu} vCPU x ${SECONDS_PER_MONTH}s/mo x ` +
    `$${rates.vcpuIdlePerSecond}/vCPU-s (IDLE) + ${replicas} x ${gib} GiB x ${SECONDS_PER_MONTH}s/mo x ` +
    `$${rates.memoryIdlePerGiBSecond}/GiB-s = $${idleUsd.toFixed(2)}/mo. ` +
    `ACTIVE-rate upper bound $${activeUsd.toFixed(2)}/mo. ` +
    `Azure Container Apps Consumption retail list for '${region}', read ${RATES_READ_AT} from ${RATES_SOURCE}. ` +
    `Scale facts from extractor '${scale.source}'. ` +
    `IDLE is the documented regime for this shape (${BILLING_DOC}): a replica bills at the reduced idle ` +
    'rate when its revision has minReplicas > 0, is scaled to that minimum, is processing no HTTP ' +
    'requests, is using under 0.01 vCPU and is receiving under 1,000 B/s. A replica answering liveness ' +
    'and readiness probes may leave idle briefly, so the true figure sits between this and the ACTIVE ' +
    'upper bound above. ' +
    'EXCLUDES the per-subscription monthly free grant (180,000 vCPU-s / 360,000 GiB-s / 2M requests, ' +
    `per ${BILLING_DOC}), which is shared across every Consumption app in the subscription and cannot ` +
    "be attributed to one app without the subscription's total usage.";

  return {
    kind: 'priced',
    // `derivedCost` is the only constructor used in this module. There is no code
    // path here that can produce a `billed` figure.
    figure: derivedCost(round2(idleUsd), basis, RATES_READ_AT),
    activeUpperBoundUsd: round2(activeUsd),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
