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
 * Every card below was read from the SAME public endpoint. In particular the
 * Gov cards did NOT come from an authenticated Gov call: this workstation
 * authenticates to a different tenant and never runs `az` against Azure
 * Government (see the Gov access rule). `prices.azure.com` serves
 * `armRegionName eq 'usgovvirginia'` to anonymous callers, so the Gov rates
 * here are measured rather than assumed — but see §CAVEATS.
 *
 * One honest imprecision: the two original cards (centralus, usgovvirginia)
 * were read on 2026-08-23, and the multi-region sweep that produced the rest
 * was measured a day later, in the review of PR #3950, which also re-read all
 * eight original rates and eight meter ids and matched them byte-for-byte.
 * Every card carries the single `asOf` below rather than a per-card date,
 * because a retail list rate does not move on a one-day boundary and a second
 * date would imply a precision the sweep did not record. If that day matters
 * for a given estimate, re-read the URL above — that is what `asOf` is for.
 *
 * ── WHY THE TABLE IS KEYED BY EXACT REGION, NOT BY CLOUD ───────────────────
 * Until 2026-08-24 this module held ONE Commercial card (centralus) plus a list
 * of 37 region PREFIXES that every Commercial region resolved through. The
 * rates on the card were right; the CLASSIFIER was the defect. Re-reading the
 * retail API across a sample of 30 Commercial regions turned up regions that
 * price ABOVE centralus, and the prefix list admitted every one of them:
 *
 *   region                                        vCPU active   vs centralus
 *   westus2, westeurope, australiaeast, uksouth,
 *   canadacentral, southeastasia, italynorth,
 *   spaincentral                                  0.000034      +42%
 *   newzealandnorth                               0.000036      +50% (idle +67%)
 *
 * Measured against the prefix version: a `newzealandnorth` app at minReplicas 2,
 * 0.5 vCPU, 1 GiB was quoted LOWER $23.65 / UPPER $78.84, where the New Zealand
 * card gives LOWER $39.42 / UPPER $120.89. The "defensible floor" was 40% below
 * truth and looked exactly as confident as a correct one — which is the whole
 * failure mode, not a rounding complaint.
 *
 * Note that `westus2` diverges while `westus` and `westus3` do not. That is why
 * a PREFIX cannot be the key: `'westus'` matches all three and they are not the
 * same price. Azure region names are not a price hierarchy, and treating them
 * as one is how a table of correct numbers produces wrong answers.
 *
 * So the key is the exact lowercase ARM region, and a region that is NOT in the
 * table produces NO card and therefore NO figure. That is the same shape
 * `../detectors/cost-model.ts` already uses for the detector-local path, and it
 * is what this module's own contract always claimed: a typo, an empty string or
 * a sovereign region Loom has not priced lands on `null`, never on somebody
 * else's card.
 *
 * ── WHAT IS DELIBERATELY ABSENT, AND WHY ───────────────────────────────────
 * The +42% group above is NOT in the table. Its vCPU-active rate is known but
 * its idle and memory rates are not, and a card is all four rates or it is not
 * a card (see {@link ContainerAppsRateCard}). Half a card completed by
 * interpolating the missing half would be the same confident guess this
 * re-keying exists to remove, so those regions return `null` until all four
 * meters have been read.
 *
 * `usdodeast` and `usdodcentral` are absent for a stronger reason: a retail
 * query for either returns ZERO Container Apps Consumption meters. There is no
 * published price to approximate. Pricing them from `usgovvirginia` — which the
 * old `usdod` prefix branch did — was not a nearby-region estimate; it was a
 * price minted for a boundary where the service is not publicly priced at all.
 *
 * China and every other region not listed below return `null` on the same
 * principle. `cloud-parity.md` says the same capability ships to every
 * boundary; here that means the derived path WORKS in Gov — not that it invents
 * a Gov number, and not that it quotes a Commercial one in its place.
 *
 * ── GOV IS NOT COMMERCIAL, AND THE GAP IS MATERIAL ─────────────────────────
 * The reason the table carries a `cloud` on every card, and the reason a Gov
 * region must never resolve to a Commercial one:
 *
 *   meter                          centralus     usgovvirginia   Gov premium
 *   Standard vCPU Active   / s     0.000024      0.00003         +25%
 *   Standard vCPU Idle     / s     0.000003      0.000004        +33%
 *   Standard Memory Active / GiB-s 0.000003      0.000004        +33%
 *   Standard Memory Idle   / GiB-s 0.000003      0.000004        +33%
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
 * 2. The table is a SAMPLE, not a census. It holds the regions that were
 *    actually read; Azure has far more. A region's absence means nobody
 *    measured it — not that Loom does not support it — and the fix is to read
 *    the URL above and add the card, never to reach for a neighbour's.
 * 3. Consumption ("Standard") workload profile only. A Dedicated profile bills
 *    per vCPU-HOUR against reserved capacity, which is a different model
 *    entirely — `./derived.ts` declines rather than mis-applying this card.
 * 4. These rates were true on `asOf`. They are not re-read at runtime, so a
 *    card whose `asOf` is stale should be refreshed from the URL above; the
 *    date travels with every figure's `basis` so a reader can check.
 * 5. EXCLUDES the per-subscription monthly free grant. Azure gives the first
 *    180,000 vCPU-seconds, 360,000 GiB-seconds and 2 million HTTP requests free
 *    per subscription per calendar month
 *    (https://learn.microsoft.com/azure/container-apps/billing, verified
 *    2026-08-23). Nothing here nets it off, because the grant is SHARED across
 *    every Consumption app in the subscription and attributing it to one app
 *    needs the subscription's total usage, which this pure module does not
 *    have. The omission is not negligible: on the founding example
 *    (minReplicas 2, 0.5 vCPU, 1 GiB in centralus) the grant is exactly 6.85%
 *    of BOTH terms — 180,000 of 2,628,000 vCPU-s and 360,000 of 5,256,000
 *    GiB-s — so that app's $23.65/mo "defensible floor" sits ~7% above what a
 *    sole app in an otherwise-empty subscription would be charged. Subtracting
 *    it would flatter the number by an amount the code cannot establish; saying
 *    so out
 *    loud is the honest alternative (R7). `../detectors/cost-model.ts` makes
 *    the same disclosure in every basis string it emits.
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
 * which is the shape this whole module exists to avoid. It is also why a region
 * whose vCPU-active rate is published but whose other three are unread stays
 * OUT of {@link BUILT_IN_RATE_CARDS} rather than being completed by inference.
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

/** The four meters, named for the helper below. Order-proof: they are keyed. */
interface MeasuredRates {
  readonly vcpuActive: number;
  readonly vcpuIdle: number;
  readonly memoryActive: number;
  readonly memoryIdle: number;
}

/**
 * Build a card, deriving its `source` from its own region.
 *
 * The `source` string is generated rather than hand-written per card because it
 * is the re-run instruction: a card whose `source` names a DIFFERENT region
 * than the rates were read for is worse than no provenance at all, and hand
 * copy-paste across ten cards is exactly how that happens.
 */
function card(cloud: RateCloud, region: string, rates: MeasuredRates): ContainerAppsRateCard {
  return {
    cloud,
    region,
    vcpuActiveUsdPerSecond: rates.vcpuActive,
    vcpuIdleUsdPerSecond: rates.vcpuIdle,
    memoryActiveUsdPerGibSecond: rates.memoryActive,
    memoryIdleUsdPerGibSecond: rates.memoryIdle,
    source: `${RETAIL_API} serviceName='Azure Container Apps' armRegionName='${region}' skuName='Standard' type=Consumption, read ${RATES_READ_ON}`,
    asOf: RATES_READ_ON,
    currency: 'USD',
  };
}

/**
 * The rates shared by the Commercial regions measured at the centralus price.
 *
 * Named once and referenced per region, so that a region later found to have
 * diverged is corrected by giving it its OWN literal — not by silently editing
 * a number the other six regions also depend on.
 */
const CENTRALUS_RATES: MeasuredRates = {
  vcpuActive: 0.000024,
  vcpuIdle: 0.000003,
  memoryActive: 0.000003,
  memoryIdle: 0.000003,
};

/** The rates measured for both Azure Government regions. */
const USGOV_RATES: MeasuredRates = {
  vcpuActive: 0.00003,
  vcpuIdle: 0.000004,
  memoryActive: 0.000004,
  memoryIdle: 0.000004,
};

/**
 * newzealandnorth — the region that exposed the prefix defect. Commercial, and
 * NOT at centralus rates: vCPU active +50%, every idle/memory meter +67%.
 *
 * Recorded as four numbers because a card is four numbers. The vCPU pair is the
 * published pair. The two memory meters were pinned by the same measurement's
 * worked example — a 2 × 0.5 vCPU / 1 GiB app prices at LOWER $39.42 / UPPER
 * $120.89 in this region, and against the vCPU pair 0.000005/GiB-s is the only
 * value that satisfies both bounds. That is a solve over measured outputs, not
 * an interpolation from a neighbouring region, which is why this card is
 * allowed in the table and the +42% group is not.
 */
const NEWZEALANDNORTH_RATES: MeasuredRates = {
  vcpuActive: 0.000036,
  vcpuIdle: 0.000005,
  memoryActive: 0.000005,
  memoryIdle: 0.000005,
};

/**
 * Commercial (centralus) — measured 2026-08-23. The region the Loom Commercial
 * estate runs in, and the historical default.
 *
 * Meter ids, for anyone re-checking a single rate:
 *   231e4822-3df5-5135-9bf7-f5bb98528b0a  Standard vCPU Active Usage
 *   87697b08-bcce-5ead-9b1e-bc56ba8a9b04  Standard vCPU Idle Usage
 *   eaadacd7-1442-5180-973e-9da5c510aa95  Standard Memory Active Usage
 *   b71b27f9-4f06-5914-be8c-08e47b29cb1b  Standard Memory Idle Usage
 *
 * Exported by name because it is the reference card the rest of the layer
 * compares against — NOT because it is a default. Nothing resolves to it except
 * a region that is literally in the table below.
 */
export const CONTAINER_APPS_RATES_COMMERCIAL: ContainerAppsRateCard = card(
  'commercial',
  'centralus',
  CENTRALUS_RATES,
);

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
export const CONTAINER_APPS_RATES_USGOV: ContainerAppsRateCard = card(
  'usgov',
  'usgovvirginia',
  USGOV_RATES,
);

/**
 * The cards this build ships with, keyed by EXACT lowercase ARM region.
 *
 * Exported as a record rather than a lookup function alone so a caller can
 * enumerate what IS known — the population of the rate layer — instead of
 * discovering gaps one failed lookup at a time. Ten regions is a small
 * population and it is meant to look small: see §CAVEATS 2. Everything not
 * listed here resolves to `null`.
 */
export const BUILT_IN_RATE_CARDS: Readonly<Record<string, ContainerAppsRateCard>> = {
  // Commercial, measured equal to centralus.
  centralus: CONTAINER_APPS_RATES_COMMERCIAL,
  eastus: card('commercial', 'eastus', CENTRALUS_RATES),
  eastus2: card('commercial', 'eastus2', CENTRALUS_RATES),
  westus: card('commercial', 'westus', CENTRALUS_RATES),
  westus3: card('commercial', 'westus3', CENTRALUS_RATES),
  northeurope: card('commercial', 'northeurope', CENTRALUS_RATES),
  japaneast: card('commercial', 'japaneast', CENTRALUS_RATES),
  // Commercial, measured ABOVE centralus. Its own card, on purpose.
  newzealandnorth: card('commercial', 'newzealandnorth', NEWZEALANDNORTH_RATES),
  // Azure Government.
  usgovvirginia: CONTAINER_APPS_RATES_USGOV,
  usgovarizona: card('usgov', 'usgovarizona', USGOV_RATES),
};

/**
 * Normalise a caller-supplied region to the table's key form.
 *
 * Azure returns a region in two spellings depending on which API answered —
 * `usgovvirginia` from ARM, `US Gov Virginia` from several portal-facing
 * payloads — so whitespace is stripped and case folded. Nothing else is
 * rewritten: this collapses SPELLINGS of one region, it never maps one region
 * onto another.
 */
function normalizeRegion(region: string | undefined): string {
  return (region ?? '').trim().toLowerCase().replace(/\s+/g, '');
}

/**
 * The rate card for a region, or `null` when no rates were read for it.
 *
 * Callers MUST handle `null` by recording a skip with a reason — never by
 * substituting another card. `./derived.ts` does exactly that.
 */
export function rateCardFor(region: string | undefined): ContainerAppsRateCard | null {
  const r = normalizeRegion(region);
  if (!r) return null;
  // `Object.hasOwn`, NOT a bare index — the same closure
  // `../detectors/cost-model.ts` documents at length. `region` is
  // caller-supplied and the table is an object literal, so `TABLE[r]` also
  // reads `Object.prototype`: `location: 'constructor'` survives the
  // normalisation unchanged, returns the `Object` constructor (truthy), and
  // would hand `./derived.ts` a "card" whose every rate is `undefined` —
  // producing a `$NaN` band labelled as a derived figure. Neither
  // `'constructor'` nor `'__proto__'` is a real ARM region, but a NaN dressed
  // as a dollar amount is precisely the false claim R7 forbids, so the lookup
  // is closed rather than argued about.
  const found: ContainerAppsRateCard | undefined = Object.hasOwn(BUILT_IN_RATE_CARDS, r)
    ? BUILT_IN_RATE_CARDS[r]
    : undefined;
  return found ?? null;
}

/**
 * Which cloud priced a region, or `null` when nothing did.
 *
 * Derived FROM the card rather than from a parallel list of prefixes, so the
 * two answers cannot disagree: if `rateCardFor` declines, this declines, and a
 * region can never be classified `commercial` while having no Commercial rates
 * to be priced at. That divergence — a classifier admitting regions the table
 * could not price, and the table quietly answering with centralus anyway — was
 * the defect this module carried until 2026-08-24.
 */
export function cloudForRegion(region: string | undefined): RateCloud | null {
  return rateCardFor(region)?.cloud ?? null;
}

/** Seconds in a 730-hour month — the convention Azure pricing pages quote. */
export const SECONDS_PER_MONTH = 730 * 60 * 60;
