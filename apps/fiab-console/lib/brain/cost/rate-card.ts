/**
 * LOOM BRAIN — published retail rate cards for the DERIVED fallback.
 *
 * PRP §1 decision 3: real cost comes from a Cost Management export. When the
 * export has not landed yet — and its first data is roughly 24 hours behind the
 * export being created — the Brain still has to say something about spend, so
 * it multiplies a MEASURED SKU by a PUBLISHED LIST RATE. Every figure that
 * comes out of that is `derived`, forever, and `./figure.ts` makes it
 * unrenderable as a bill.
 *
 * ── PROVENANCE OF THE NUMBERS BELOW ────────────────────────────────────────
 * Read 2026-08-23 from the Azure Retail Prices API, which is public and
 * unauthenticated:
 *
 *   GET https://prices.azure.com/api/retail/prices
 *       ?$filter=serviceName eq 'Azure Container Apps'
 *               and armRegionName eq '<region>'
 *
 * Both cards were read from the SAME public endpoint. In particular the Gov
 * card did NOT come from an authenticated Gov call: this workstation
 * authenticates to a different tenant and never runs `az` against Azure
 * Government (see the Gov access rule). `prices.azure.com` serves
 * `armRegionName eq 'usgovvirginia'` to anonymous callers, so the Gov rates
 * here are measured rather than assumed — but see §CAVEATS.
 *
 * ── WHY THE CARD IS CLOUD-SCOPED, MEASURED ─────────────────────────────────
 * Commercial and Gov rates are NOT the same, and the gap is large enough that
 * applying one card to the other cloud would be a materially wrong number:
 *
 *   meter                          centralus     usgovvirginia   Gov premium
 *   Standard vCPU Active   / s     0.000024      0.00003         +25%
 *   Standard vCPU Idle     / s     0.000003      0.000004        +33%
 *   Standard Memory Active / GiB-s 0.000003      0.000004        +33%
 *   Standard Memory Idle   / GiB-s 0.000003      0.000004        +33%
 *
 * `cloud-parity.md` says the same capability ships to every boundary. Here that
 * means the derived path works in Gov — not that it pretends Gov costs what
 * Commercial costs. `rateCardFor()` refuses to guess.
 *
 * ── WHY A BAND, NOT A NUMBER ───────────────────────────────────────────────
 * Container Apps consumption bills vCPU-seconds and GiB-seconds at an ACTIVE
 * rate or an IDLE rate depending on whether the replica is processing a
 * request. For an always-on replica the split between the two is NOT MEASURED
 * by anything the Brain currently reads — there is no `observed` extractor yet
 * (the graph substrate reports `observed: 0` for exactly this reason).
 *
 * Picking one rate and calling the product "the cost" would assert something
 * the code cannot establish, which is R7. So `./derived.ts` computes BOTH
 * bounds and hands back a band. The band is the honest object; a single figure
 * is available only by naming which bound you took, and that choice is written
 * into the figure's `basis`.
 *
 * ── CAVEATS, STATED RATHER THAN IMPLIED ────────────────────────────────────
 * 1. LIST rates. Any EA/MCA negotiated discount, credit, reservation or savings
 *    plan on the operator's agreement makes the real bill LOWER. A derived
 *    figure is therefore an upper-ish bound on list terms, not a forecast.
 * 2. ONE region per cloud. `centralus` is where the Loom Commercial estate
 *    runs; `usgovvirginia` is the Gov analogue. Rates vary by region and the
 *    card records which one it read.
 * 3. Consumption ("Standard") workload profile only. A Dedicated profile bills
 *    per vCPU-HOUR against reserved capacity, which is a different model
 *    entirely — `./derived.ts` declines rather than mis-applying this card.
 * 4. These rates were true on `asOf`. They are not re-read at runtime, so a
 *    card whose `asOf` is stale should be refreshed from the URL above; the
 *    date travels with every figure's `basis` so a reader can check.
 *
 * PURE. Data only — no fetch. Re-reading the API is a caller's job, and
 * {@link ContainerAppsRateCard} is the shape to hand back when they do.
 */

/** Which cloud a card's rates were read for. */
export type RateCloud = 'commercial' | 'usgov';

/**
 * Per-second Container Apps consumption rates, in USD.
 *
 * All four rates are required. There is no partial card: a card missing the
 * idle rates could only produce a single-point estimate presented as a band,
 * which is the shape this whole module exists to avoid.
 */
export interface ContainerAppsRateCard {
  readonly cloud: RateCloud;
  /** The `armRegionName` these rates were read for, e.g. 'centralus'. */
  readonly region: string;
  /** USD per vCPU-second, replica actively serving. Meter "Standard vCPU Active Usage". */
  readonly vcpuActiveUsdPerSecond: number;
  /** USD per vCPU-second, replica idle. Meter "Standard vCPU Idle Usage". */
  readonly vcpuIdleUsdPerSecond: number;
  /** USD per GiB-second, replica actively serving. Meter "Standard Memory Active Usage". */
  readonly memoryActiveUsdPerGibSecond: number;
  /** USD per GiB-second, replica idle. Meter "Standard Memory Idle Usage". */
  readonly memoryIdleUsdPerGibSecond: number;
  /**
   * Where the numbers came from, precise enough to re-run. Lands verbatim in
   * every derived figure's `basis`.
   */
  readonly source: string;
  /** ISO-8601 date the rates were read. Travels with every figure. */
  readonly asOf: string;
  /** Currency. Only USD is supported; the Brain's figures are `amountUsd`. */
  readonly currency: 'USD';
}

/** The date every rate below was read from the retail API. */
export const RATES_READ_ON = '2026-08-23';

const RETAIL_API = 'https://prices.azure.com/api/retail/prices';

/**
 * Commercial (centralus) — measured 2026-08-23.
 *
 * Meter ids, for anyone re-checking a single rate:
 *   231e4822-3df5-5135-9bf7-f5bb98528b0a  Standard vCPU Active Usage
 *   87697b08-bcce-5ead-9b1e-bc56ba8a9b04  Standard vCPU Idle Usage
 *   eaadacd7-1442-5180-973e-9da5c510aa95  Standard Memory Active Usage
 *   b71b27f9-4f06-5914-be8c-08e47b29cb1b  Standard Memory Idle Usage
 */
export const CONTAINER_APPS_RATES_COMMERCIAL: ContainerAppsRateCard = {
  cloud: 'commercial',
  region: 'centralus',
  vcpuActiveUsdPerSecond: 0.000024,
  vcpuIdleUsdPerSecond: 0.000003,
  memoryActiveUsdPerGibSecond: 0.000003,
  memoryIdleUsdPerGibSecond: 0.000003,
  source: `${RETAIL_API} serviceName='Azure Container Apps' armRegionName='centralus' skuName='Standard' type=Consumption, read ${RATES_READ_ON}`,
  asOf: RATES_READ_ON,
  currency: 'USD',
};

/**
 * Azure Government (usgovvirginia) — measured 2026-08-23 from the SAME public
 * endpoint. Every rate is higher than its Commercial counterpart; see the
 * header table.
 *
 * Meter ids:
 *   8ed515c6-c391-5243-a56d-0b84db16d235  Standard vCPU Active Usage
 *   a9905634-2527-52c6-b962-bc27ca24ad78  Standard vCPU Idle Usage
 *   e7131934-70d9-5db1-b2e7-071cda18e8e5  Standard Memory Active Usage
 *   8e7e05d6-c4a5-5498-9e72-9b294d1fcf75  Standard Memory Idle Usage
 */
export const CONTAINER_APPS_RATES_USGOV: ContainerAppsRateCard = {
  cloud: 'usgov',
  region: 'usgovvirginia',
  vcpuActiveUsdPerSecond: 0.00003,
  vcpuIdleUsdPerSecond: 0.000004,
  memoryActiveUsdPerGibSecond: 0.000004,
  memoryIdleUsdPerGibSecond: 0.000004,
  source: `${RETAIL_API} serviceName='Azure Container Apps' armRegionName='usgovvirginia' skuName='Standard' type=Consumption, read ${RATES_READ_ON}`,
  asOf: RATES_READ_ON,
  currency: 'USD',
};

/**
 * The cards this build ships with, by cloud.
 *
 * Exported as a record rather than a lookup function alone so a caller can
 * enumerate what IS known — the population of the rate layer — instead of
 * discovering gaps one failed lookup at a time.
 */
export const BUILT_IN_RATE_CARDS: Readonly<Record<RateCloud, ContainerAppsRateCard>> = {
  commercial: CONTAINER_APPS_RATES_COMMERCIAL,
  usgov: CONTAINER_APPS_RATES_USGOV,
};

/**
 * Map an Azure region to the cloud whose rate card applies.
 *
 * Returns `null` for a region this function cannot classify. `null` is the
 * point: an unrecognised region must NOT fall through to the Commercial card,
 * because that silently understates a Gov resource by 25–33% and — worse —
 * produces a confident-looking number for a boundary nobody checked. R7: if the
 * code does not know, it says it does not know.
 */
export function cloudForRegion(region: string | undefined): RateCloud | null {
  const r = (region ?? '').trim().toLowerCase().replace(/\s+/g, '');
  if (!r) return null;
  // Azure Government regions all carry the `usgov`/`usdod` prefixes.
  if (r.startsWith('usgov') || r.startsWith('usdod')) return 'usgov';
  // Every other known-good Azure Commercial region. Deliberately a positive
  // list of PREFIXES rather than "not Gov, therefore Commercial": a typo, an
  // empty string or a sovereign region Loom has not priced must land on null,
  // not on a Commercial answer.
  const COMMERCIAL_PREFIXES = [
    'eastus',
    'westus',
    'centralus',
    'northcentralus',
    'southcentralus',
    'westcentralus',
    'canada',
    'brazil',
    'northeurope',
    'westeurope',
    'uksouth',
    'ukwest',
    'france',
    'germany',
    'norway',
    'switzerland',
    'sweden',
    'poland',
    'italy',
    'spain',
    'uae',
    'qatar',
    'israel',
    'southafrica',
    'australia',
    'japan',
    'korea',
    'southeastasia',
    'eastasia',
    'centralindia',
    'southindia',
    'westindia',
    'newzealand',
    'indonesia',
    'malaysia',
    'mexico',
    'chile',
    'austria',
  ];
  return COMMERCIAL_PREFIXES.some((p) => r.startsWith(p)) ? 'commercial' : null;
}

/**
 * The rate card for a region, or `null` when the region cannot be classified.
 *
 * Callers MUST handle `null` by recording a skip with a reason — never by
 * substituting another card. `./derived.ts` does exactly that.
 */
export function rateCardFor(region: string | undefined): ContainerAppsRateCard | null {
  const cloud = cloudForRegion(region);
  return cloud ? BUILT_IN_RATE_CARDS[cloud] : null;
}

/** Seconds in a 730-hour month — the convention Azure pricing pages quote. */
export const SECONDS_PER_MONTH = 730 * 60 * 60;
