/**
 * LOOM BRAIN — DERIVED cost.
 *
 * EVERY FIGURE THIS MODULE PRODUCES IS `derived`, AND THAT IS NOT A PLACEHOLDER
 * FOR A BILLED ONE. PRP §1 decision 3: the Cost Management API returned HTTP 429
 * on 11 consecutive attempts over ~35 minutes, so nothing here has seen an
 * invoice. A derived figure is an estimate of a PRICE — measured SKU multiplied
 * by a published retail rate — and presenting one as a bill is a false claim
 * under R7. `CostFigure.source` carries the distinction and
 * `formatCostFigure()` renders it, which is why nothing in this file
 * interpolates `amountUsd` directly.
 *
 * ── THE IDLE/ACTIVE DISTINCTION IS THE WHOLE POINT ─────────────────────────
 * MEASURED 2026-08-23 from `https://prices.azure.com/api/retail/prices`
 * (`serviceName eq 'Azure Container Apps' and armRegionName eq 'eastus' and
 * priceType eq 'Consumption'`, 13 meters returned):
 *
 *     Standard vCPU Active Usage     $0.000024 / vCPU-second
 *     Standard vCPU Idle Usage       $0.000003 / vCPU-second     <- 8x LOWER
 *     Standard Memory Active Usage   $0.000003 / GiB-second
 *     Standard Memory Idle Usage     $0.000003 / GiB-second
 *
 * A service that is UNREACHABLE has, by definition, no traffic — so its
 * always-on replicas bill at the IDLE meter, not the active one. Estimating the
 * broker at the active vCPU rate would overstate its cost by roughly 8x on the
 * vCPU line, and the resulting headline saving would be wrong in the direction
 * that flatters this tool. So `idleAlwaysOnCost()` uses the IDLE rates
 * deliberately, and the basis string says so.
 *
 * That choice makes the number a FLOOR, which is the right kind of wrong here:
 * it under-claims. If the service were actually serving traffic it would cost
 * more — but if it were serving traffic it would have an inbound edge and would
 * not be in the finding.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT MODEL ──────────────────────────────────
 * Named so a reader can bound the error rather than trust the number:
 *   • The monthly FREE GRANT (180,000 vCPU-s + 360,000 GiB-s per subscription
 *     per month). On a small estate that can absorb a whole service, so the real
 *     saving can be ZERO. It is not modelled because the grant is consumed
 *     estate-wide and attributing it to one app would be an invention.
 *   • Reservations, savings plans, EA/MCA/CSP discounts — all invisible to the
 *     retail API.
 *   • Dedicated-plan and GPU workload profiles, which meter per hour on
 *     different SKUs entirely.
 *   • Per-request charges, ingress/egress, and the environment's own management
 *     meter.
 *   • Regional variation: the rates above are `eastus`. Other regions differ.
 *
 * Every one of those is in the basis string attached to the figure, so an
 * operator reading `$23.33` also reads what it excludes.
 */

import { derivedCost, type CostFigure, type ScaleFacts } from '@/lib/brain/graph';

/**
 * Rates as read from the Azure retail price list. Meter ids are from Azure's
 * PUBLIC price catalog — they identify a rate, not a tenant or a subscription.
 */
export const CONTAINER_APPS_RATES = {
  /** $/vCPU-second, replica kept alive by minReplicas and NOT processing. */
  idleVcpuSecond: 0.000003,
  /** $/GiB-second, same condition. */
  idleMemoryGibSecond: 0.000003,
  /** $/vCPU-second while processing. Recorded for contrast; NOT used below. */
  activeVcpuSecond: 0.000024,
  activeMemoryGibSecond: 0.000003,
  region: 'eastus',
  currency: 'USD',
  /** When the rates were read from the retail API. */
  readAt: '2026-08-23',
  source: 'https://prices.azure.com/api/retail/prices',
  meterIds: {
    idleVcpu: '2937c12a-555a-58f0-86fb-11db356f5fb0',
    idleMemory: 'ac22f07d-3385-5dca-a67a-c888b544b546',
    activeVcpu: 'ba69f1c7-e68f-56b1-bc7e-79aa26713625',
    activeMemory: 'f3d673ac-8004-5c9e-a541-8c9eaac1dfea',
  },
} as const;

/** Seconds in the 30-day window every figure below is expressed over. */
const SECONDS_PER_30D = 30 * 24 * 60 * 60;

/**
 * Parse a Container Apps memory string ('1Gi', '2.5Gi', '512Mi') to GiB.
 *
 * Returns `null` — never a default — when the string is absent or in a form this
 * function does not understand. A silent `0` would make an unparsed memory
 * spec look free, and the resulting estimate would be quietly too low with
 * nothing to indicate it.
 */
export function memoryToGib(memory: string | undefined): number | null {
  if (typeof memory !== 'string') return null;
  const m = /^([0-9]*\.?[0-9]+)\s*(Gi|Mi|G|M)?$/.exec(memory.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  switch (m[2]) {
    case 'Mi':
    case 'M':
      return n / 1024;
    case 'Gi':
    case 'G':
    case undefined:
      return n;
    default:
      return null;
  }
}

/** Why a cost could not be derived. Returned instead of a number, never as 0. */
export interface CostUnknown {
  readonly kind: 'unknown';
  /** What was missing. Rendered to the operator verbatim. */
  readonly reason: string;
}

export type CostEstimate = { readonly kind: 'derived'; readonly figure: CostFigure } | CostUnknown;

/**
 * 30-day IDLE cost of an always-on Container App, from its measured scale.
 *
 * Returns {@link CostUnknown} — not zero — when `minReplicas`, `cpu` or
 * `memory` was not measured. `ScaleFacts` deliberately makes each of those
 * optional so "not read" stays distinguishable from "read as zero"; collapsing
 * that here would reintroduce the exact fail-open the type was shaped to
 * prevent.
 */
export function idleAlwaysOnCost(
  scale: ScaleFacts | undefined,
  opts?: { readonly displayName?: string },
): CostEstimate {
  const who = opts?.displayName ? ` for '${opts.displayName}'` : '';
  if (!scale) {
    return {
      kind: 'unknown',
      reason:
        `scale facts were NOT MEASURED${who} — Resource Graph returned no ` +
        '`properties.template.scale`. This is indeterminate, not zero cost.',
    };
  }
  if (scale.cpu === undefined) {
    return {
      kind: 'unknown',
      reason:
        `minReplicas is ${scale.minReplicas}${who} but the container's vCPU request was ` +
        'not readable, so no rate can be applied. Reporting $0 here would be a false claim.',
    };
  }
  const gib = memoryToGib(scale.memory);
  if (gib === null) {
    return {
      kind: 'unknown',
      reason:
        `minReplicas is ${scale.minReplicas} and cpu is ${scale.cpu}${who}, but the memory ` +
        `spec ${scale.memory === undefined ? 'was not readable' : `('${scale.memory}') was not parseable`}, ` +
        'so the memory line cannot be priced.',
    };
  }

  const replicas = scale.minReplicas;
  const vcpuSeconds = replicas * scale.cpu * SECONDS_PER_30D;
  const gibSeconds = replicas * gib * SECONDS_PER_30D;
  const amount =
    vcpuSeconds * CONTAINER_APPS_RATES.idleVcpuSecond +
    gibSeconds * CONTAINER_APPS_RATES.idleMemoryGibSecond;

  const basis =
    `${replicas} always-on replica(s) x ${scale.cpu} vCPU x 30d ` +
    `@ $${CONTAINER_APPS_RATES.idleVcpuSecond}/vCPU-s (Container Apps "Standard vCPU Idle Usage") ` +
    `+ ${replicas} x ${gib} GiB x 30d ` +
    `@ $${CONTAINER_APPS_RATES.idleMemoryGibSecond}/GiB-s ("Standard Memory Idle Usage"). ` +
    `IDLE meters used because the service has no inbound traffic — the ACTIVE vCPU rate ` +
    `($${CONTAINER_APPS_RATES.activeVcpuSecond}/vCPU-s) is 8x higher and would overstate this. ` +
    `Retail list, ${CONTAINER_APPS_RATES.region}, read ${CONTAINER_APPS_RATES.readAt} from ` +
    `${CONTAINER_APPS_RATES.source}. EXCLUDES the monthly free grant (180,000 vCPU-s + ` +
    `360,000 GiB-s per subscription, which on a small estate can absorb this entirely), ` +
    `reservations, EA/MCA/CSP discounts, per-request and networking meters, and any ` +
    `regional rate difference. Scale facts came from '${scale.source}'.`;

  return {
    kind: 'derived',
    figure: derivedCost(round2(amount), basis, `${CONTAINER_APPS_RATES.readAt}T00:00:00Z`),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Sum a set of derived figures into one derived figure.
 *
 * Refuses to mix sources: if ANY input is `billed` the result would be neither,
 * so this throws rather than silently labelling a blend. There is currently no
 * billed input anywhere in the Brain, so this is a guard against a future
 * change, not a live path.
 */
export function sumDerived(figures: readonly CostFigure[], basis: string, asOf: string): CostFigure {
  const billed = figures.filter((f) => f.source === 'billed');
  if (billed.length > 0) {
    throw new Error(
      `refusing to sum ${billed.length} billed figure(s) with ${figures.length - billed.length} ` +
        'derived one(s): the total would be neither, and labelling it either way is a false claim',
    );
  }
  const total = figures.reduce((acc, f) => acc + f.amountUsd, 0);
  return derivedCost(round2(total), basis, asOf);
}
