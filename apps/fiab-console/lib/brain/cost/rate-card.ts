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
 * Read from the Azure Retail Prices API, which is public and unauthenticated:
 *
 *   GET https://prices.azure.com/api/retail/prices
 *       ?$filter=serviceName eq 'Azure Container Apps' and type eq 'Consumption'
 *
 * Note what that query does NOT carry: an `armRegionName` filter. The whole
 * Container Apps Consumption price list comes back in ONE response — 764 items,
 * `pages=1`, no `NextPageLink` — so a complete global census costs a single
 * HTTP GET, and every region below was read in the same request as every other.
 *
 * That endpoint is also how the Gov cards were read. They did NOT come from an
 * authenticated Gov call: this workstation authenticates to a different tenant
 * and never runs `az` against Azure Government (see the Gov access rule).
 * `prices.azure.com` serves the `usgov*` meters to anonymous callers, so the Gov
 * rates here are measured rather than assumed — but see §CAVEATS.
 *
 * Every card therefore carries the SAME `asOf`, and that is a statement of fact
 * rather than a convenience: they were all read in one response. The table this
 * one replaces held TEN cards — centralus, eastus, eastus2, westus, westus3,
 * northeurope, japaneast, newzealandnorth, usgovvirginia, usgovarizona — and
 * ALL TEN were dated 2026-08-23, not merely the two the module exports by name.
 * The census re-read all ten and every one of their forty rates matched, as did
 * the eight meter ids the two named exports document below. So 2026-08-24 is
 * true of every card in the table, and no card is dated earlier than it was
 * actually confirmed.
 *
 * ── WHY THE TABLE IS KEYED BY EXACT REGION, NOT BY CLOUD ───────────────────
 * Until 2026-08-24 this module held ONE Commercial card (centralus) plus a list
 * of 38 region PREFIXES that every Commercial region resolved through. The
 * rates on the card were right; the CLASSIFIER was the defect.
 *
 * The census turns up 12 distinct price tiers across 61 priced regions, 58 of
 * them Commercial. Replaying the 38 prefixes against those 58: 55 matched a
 * prefix and were handed the centralus card, and 30 of those 55 are priced
 * ABOVE it — 19 understated by 42%, New Zealand by 50%, Brazil Southeast by
 * 129%. The other three, `belgiumcentral`, `jioindiacentral` and
 * `jioindiawest`, matched no prefix at all and correctly returned null. So the
 * flattening was 55 of 58, not all 58 — which matters only because the three it
 * missed are the three it got RIGHT, by accident, and a claim of "every region"
 * would be a claim nobody had measured.
 *
 * Measured against the prefix version: a `newzealandnorth` app at minReplicas 2,
 * 0.5 vCPU, 1 GiB was quoted LOWER $23.65 / UPPER $78.84, where the New Zealand
 * card gives LOWER $39.42 / UPPER $120.89. The "defensible floor" was 40% below
 * truth and looked exactly as confident as a correct one — which is the whole
 * failure mode, not a rounding complaint.
 *
 * Note that `westus2` prices at 0.000034 while `westus` and `westus3` price at
 * 0.000024. That is why a PREFIX cannot be the key: `'westus'` matches all three
 * and they are not the same price. Azure region names are not a price hierarchy,
 * and treating them as one is how a table of correct numbers produces wrong
 * answers.
 *
 * So the key is the exact lowercase ARM region, and a region that is NOT in the
 * table produces NO card and therefore NO figure. That is the same shape
 * `../detectors/cost-model.ts` already uses for the detector-local path, and it
 * is what this module's own contract always claimed: a typo, an empty string or
 * a sovereign region Loom has not priced lands on `null`, never on somebody
 * else's card.
 *
 * ── THE CENSUS ─────────────────────────────────────────────────────────────
 * 764 Consumption items, one response, spanning 62 distinct `armRegionName`
 * values. 61 of the 62 publish the four "Standard * Usage" meters, in 12
 * distinct price tiers. Every one of those 61 publishes ALL FOUR — the count of
 * regions publishing SOME BUT NOT ALL of the four is ZERO. There was no
 * "vCPU-active is known but the other three are not" population to exclude; the
 * Standard meters ship together or not at all. The 62nd region is `taiwannorth`,
 * and it is the subject of the "what absent means" note further down.
 *
 *   µUSD/vCPU-s   idle & memory   n   regions
 *   24            3               27  brazilsouth centralindia centralus
 *                                     eastasia eastus eastus2 francecentral
 *                                     francesouth germanywestcentral japaneast
 *                                     japanwest jioindiacentral jioindiawest
 *                                     koreacentral northcentralus northeurope
 *                                     norwayeast polandcentral southafricanorth
 *                                     southcentralus southindia swedencentral
 *                                     switzerlandnorth uaenorth westindia
 *                                     westus westus3
 *   26            3               1   mexicocentral
 *   28            4               2   indonesiacentral malaysiawest
 *   29            4               1   westcentralus
 *   30            4               3   usgovarizona usgovtexas usgovvirginia
 *   31            4               2   austriaeast belgiumcentral
 *   34            4               19  australiacentral australiacentral2
 *                                     australiaeast australiasoutheast
 *                                     canadacentral canadaeast chilecentral
 *                                     germanynorth israelcentral italynorth
 *                                     koreasouth qatarcentral southeastasia
 *                                     spaincentral switzerlandwest uksouth
 *                                     ukwest westeurope westus2
 *   36            5               1   newzealandnorth
 *   44            5               1   swedensouth
 *   45            6               2   norwaywest uaecentral
 *   46            6               1   southafricawest
 *   55            7               1   brazilsoutheast
 *
 * "idle & memory" is one column because in every tier the vCPU-idle, memory-
 * active and memory-idle rates are the same number. That is a fact about the
 * published list, not a simplification applied to it — the table below still
 * carries four independent fields, because the day Azure diverges them this
 * comment is what will be wrong, not the data model.
 *
 * ── WHAT "ABSENT FROM THE TABLE" ACTUALLY MEANS ────────────────────────────
 * The table below is the whole population this card shape can price. A region
 * absent from it is a region that publishes no STANDARD Container Apps
 * Consumption meter — which is NOT the same as publishing nothing, and that
 * distinction is the entire point of this section. Three cases, and they are
 * three different facts.
 *
 * `usdodeast` and `usdodcentral` are the ones that mattered, because the old
 * `usdod` prefix branch priced them anyway. The census confirms the exclusion
 * is honest and not an oversight: usdod returns ZERO Container Apps meters of
 * any kind — not a partial set, not a different SKU, none. Pricing those
 * regions from `usgovvirginia` was not a nearby-region estimate; it was a price
 * minted for a boundary where the service is not publicly priced at all.
 *
 * Azure China is the same shape: no `china*` region appears anywhere in the
 * global retail list, for Container Apps or otherwise.
 *
 * `taiwannorth` is the case that makes the word STANDARD load-bearing, and the
 * reason this section is not one sentence. Taiwan North IS in the retail list —
 * it is the 62nd `armRegionName` — and it DOES publish a Container Apps
 * Consumption meter. Exactly one: `Hybrid vCPU Usage`, productName 'Azure
 * Container Apps', skuName 'Hybrid', unit "1 Hour", $0.234, meter id
 * e5dc595c-a693-548d-94e0-4dacb54ba98d. No Standard meters, no Dedicated ones,
 * no Dynamic Sessions.
 *
 * A per-vCPU-HOUR meter is not something this card shape can multiply: every
 * field on {@link ContainerAppsRateCard} is a per-SECOND Standard rate, and
 * nothing here has established what the Hybrid plan meters against, so nothing
 * here will guess. `null` is therefore still the correct answer for a Standard
 * Consumption app in Taiwan North — but the REASON is "Azure publishes no
 * Standard rate here", not "Azure publishes nothing here". The unqualified
 * version of that sentence, which this file carried until it was reviewed,
 * would send a maintainer to the retail API, show them a Taiwan North row, and
 * let them conclude this table had dropped one. A stale comment is another copy
 * of a false claim — which is the thesis of the change that introduced it.
 *
 * `cloud-parity.md` says the same capability ships to every boundary; here that
 * means the derived path WORKS in Gov — all three Gov regions carry cards, not
 * two — not that it invents a Gov number, and not that it quotes a Commercial
 * one in its place.
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
 * 2. The table is the STANDARD-priced population as of `asOf`, not a fixed
 *    truth. Azure adds regions, and a region added after that date will be
 *    absent for the ordinary reason that it did not exist to be read. The fix is
 *    always to re-read the URL above and add the card, never to reach for a
 *    neighbour's — the 12 tiers below are exactly why a neighbour is not a proxy.
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
 * which is the shape this whole module exists to avoid. The census says that
 * requirement costs nothing — all 61 priced regions publish all four meters —
 * so this is a type-level guarantee that no future half-read can quietly
 * bypass, not a filter that excluded anybody.
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
export const RATES_READ_ON = '2026-08-24';

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
 * copy-paste across 61 cards is exactly how that happens.
 *
 * Note the generated string narrows to ONE region, while the read that produced
 * every number below was the single unfiltered census in the header. Both
 * queries return the same four meters for that region; the narrow one is in the
 * `basis` because a reader checking one figure wants four rows back, not 764.
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

/*
 * ---------------------------------------------------------------------------
 * The twelve measured tiers.
 *
 * Named for the tier's vCPU-active rate in millionths of a USD per vCPU-second
 * — `RATES_34` is 0.000034 — because that is the census's own key column, so a
 * tier here can be matched against the table in §THE CENSUS by reading its name.
 *
 * Named per TIER rather than per region because 61 regions share 12 sets of
 * numbers: a literal per region would be 61 objects of which 49 are duplicates,
 * which is the shape that invites a half-finished edit. A region later found to
 * have diverged from its tier is corrected by giving it its OWN literal and
 * moving it out of the tier's row in §THE CENSUS — never by editing a tier the
 * other members still depend on.
 *
 * In every tier the vCPU-idle, memory-active and memory-idle rates are equal.
 * That is a measured property of today's published list, NOT a law and not a
 * modelling shortcut, so each is still written out separately. The day Azure
 * prices idle memory apart from idle vCPU, only the numbers change here.
 * ---------------------------------------------------------------------------
 */

/** 27 regions, the largest tier and the cheapest — includes centralus. */
const RATES_24: MeasuredRates = {
  vcpuActive: 0.000024,
  vcpuIdle: 0.000003,
  memoryActive: 0.000003,
  memoryIdle: 0.000003,
};

/** 1 region: mexicocentral. */
const RATES_26: MeasuredRates = {
  vcpuActive: 0.000026,
  vcpuIdle: 0.000003,
  memoryActive: 0.000003,
  memoryIdle: 0.000003,
};

/** 2 regions: indonesiacentral, malaysiawest. */
const RATES_28: MeasuredRates = {
  vcpuActive: 0.000028,
  vcpuIdle: 0.000004,
  memoryActive: 0.000004,
  memoryIdle: 0.000004,
};

/** 1 region: westcentralus. */
const RATES_29: MeasuredRates = {
  vcpuActive: 0.000029,
  vcpuIdle: 0.000004,
  memoryActive: 0.000004,
  memoryIdle: 0.000004,
};

/**
 * All three Azure Government regions, and only those three. The single tier
 * that is not Commercial — see §GOV IS NOT COMMERCIAL for the deltas.
 */
const RATES_30: MeasuredRates = {
  vcpuActive: 0.00003,
  vcpuIdle: 0.000004,
  memoryActive: 0.000004,
  memoryIdle: 0.000004,
};

/** 2 regions: austriaeast, belgiumcentral. */
const RATES_31: MeasuredRates = {
  vcpuActive: 0.000031,
  vcpuIdle: 0.000004,
  memoryActive: 0.000004,
  memoryIdle: 0.000004,
};

/**
 * 19 regions — the second-largest tier, and the one that makes a prefix key
 * indefensible: westus2 is here while westus and westus3 are in RATES_24.
 */
const RATES_34: MeasuredRates = {
  vcpuActive: 0.000034,
  vcpuIdle: 0.000004,
  memoryActive: 0.000004,
  memoryIdle: 0.000004,
};

/**
 * 1 region: newzealandnorth — the region that exposed the prefix defect.
 * Commercial, and +50% / +67% against RATES_24.
 *
 * Corroborated independently of the census: a 2 × 0.5 vCPU / 1 GiB app prices
 * at LOWER $39.42 / UPPER $120.89 in this region, and against the published
 * vCPU pair 0.000005/GiB-s is the only value satisfying both bounds. The census
 * read and that solve-over-measured-outputs agree to the digit.
 */
const RATES_36: MeasuredRates = {
  vcpuActive: 0.000036,
  vcpuIdle: 0.000005,
  memoryActive: 0.000005,
  memoryIdle: 0.000005,
};

/** 1 region: swedensouth. */
const RATES_44: MeasuredRates = {
  vcpuActive: 0.000044,
  vcpuIdle: 0.000005,
  memoryActive: 0.000005,
  memoryIdle: 0.000005,
};

/** 2 regions: norwaywest, uaecentral. */
const RATES_45: MeasuredRates = {
  vcpuActive: 0.000045,
  vcpuIdle: 0.000006,
  memoryActive: 0.000006,
  memoryIdle: 0.000006,
};

/** 1 region: southafricawest. */
const RATES_46: MeasuredRates = {
  vcpuActive: 0.000046,
  vcpuIdle: 0.000006,
  memoryActive: 0.000006,
  memoryIdle: 0.000006,
};

/** 1 region: brazilsoutheast — the most expensive published tier, +129%. */
const RATES_55: MeasuredRates = {
  vcpuActive: 0.000055,
  vcpuIdle: 0.000007,
  memoryActive: 0.000007,
  memoryIdle: 0.000007,
};

/**
 * Commercial (centralus) — measured 2026-08-23, re-read 2026-08-24 in the
 * census, from the SAME public endpoint; 2026-08-24 is the date the card below
 * carries, and the reconciliation is here rather than 360 lines away in
 * §PROVENANCE because this is where a reader arrives from `derived.test.ts`.
 * The region the Loom Commercial estate runs in, and the historical default.
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
  RATES_24,
);

/**
 * Azure Government (usgovvirginia) — measured 2026-08-23, re-read 2026-08-24 in
 * the census, from the SAME public endpoint. Every rate is higher than its
 * Commercial counterpart; see the header table.
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
  RATES_30,
);

/**
 * Every region the retail API publishes STANDARD Container Apps Consumption
 * rates for, keyed by EXACT lowercase ARM region. 61 of them, grouped by tier.
 *
 * Exported as a record rather than a lookup function alone so a caller can
 * enumerate what IS known — the population of the rate layer — instead of
 * discovering gaps one failed lookup at a time. Everything not listed here
 * resolves to `null`, and what is not listed is what Azure publishes no
 * STANDARD Consumption rate for. That is three distinct populations, not one:
 * usdod* and Azure China, which publish no Container Apps meter at ALL;
 * `taiwannorth`, which publishes a Container Apps Consumption meter but only
 * the Hybrid one; and any region added after the read date in `RATES_READ_ON`.
 * Do not compress those into "Azure does not publish it" — taiwannorth is a
 * counterexample to that sentence and this comment used to contain it. See
 * §WHAT "ABSENT FROM THE TABLE" ACTUALLY MEANS.
 *
 * Written out one region per line rather than generated from the tier groups.
 * A reducer would be shorter and would hide the thing worth seeing — that
 * westus2 is NOT in the same tier as westus — and it would let the two
 * identity-pinned entries below silently disagree with their group. That last
 * risk is now watched rather than merely warned about: see the tier-value and
 * identity-pinned-export blocks in `__tests__/cost/rate-card.test.ts`.
 */
export const BUILT_IN_RATE_CARDS: Readonly<Record<string, ContainerAppsRateCard>> = {
  // ---- 0.000024 / 0.000003 — 27 Commercial regions, the cheapest tier. ----
  brazilsouth: card('commercial', 'brazilsouth', RATES_24),
  centralindia: card('commercial', 'centralindia', RATES_24),
  centralus: CONTAINER_APPS_RATES_COMMERCIAL,
  eastasia: card('commercial', 'eastasia', RATES_24),
  eastus: card('commercial', 'eastus', RATES_24),
  eastus2: card('commercial', 'eastus2', RATES_24),
  francecentral: card('commercial', 'francecentral', RATES_24),
  francesouth: card('commercial', 'francesouth', RATES_24),
  germanywestcentral: card('commercial', 'germanywestcentral', RATES_24),
  japaneast: card('commercial', 'japaneast', RATES_24),
  japanwest: card('commercial', 'japanwest', RATES_24),
  jioindiacentral: card('commercial', 'jioindiacentral', RATES_24),
  jioindiawest: card('commercial', 'jioindiawest', RATES_24),
  koreacentral: card('commercial', 'koreacentral', RATES_24),
  northcentralus: card('commercial', 'northcentralus', RATES_24),
  northeurope: card('commercial', 'northeurope', RATES_24),
  norwayeast: card('commercial', 'norwayeast', RATES_24),
  polandcentral: card('commercial', 'polandcentral', RATES_24),
  southafricanorth: card('commercial', 'southafricanorth', RATES_24),
  southcentralus: card('commercial', 'southcentralus', RATES_24),
  southindia: card('commercial', 'southindia', RATES_24),
  swedencentral: card('commercial', 'swedencentral', RATES_24),
  switzerlandnorth: card('commercial', 'switzerlandnorth', RATES_24),
  uaenorth: card('commercial', 'uaenorth', RATES_24),
  westindia: card('commercial', 'westindia', RATES_24),
  westus: card('commercial', 'westus', RATES_24),
  westus3: card('commercial', 'westus3', RATES_24),

  // ---- 0.000026 / 0.000003 ----
  mexicocentral: card('commercial', 'mexicocentral', RATES_26),

  // ---- 0.000028 / 0.000004 ----
  indonesiacentral: card('commercial', 'indonesiacentral', RATES_28),
  malaysiawest: card('commercial', 'malaysiawest', RATES_28),

  // ---- 0.000029 / 0.000004 — westcentralus, alone, and not with westus. ----
  westcentralus: card('commercial', 'westcentralus', RATES_29),

  // ---- 0.00003 / 0.000004 — Azure Government, all three regions. ----
  usgovarizona: card('usgov', 'usgovarizona', RATES_30),
  usgovtexas: card('usgov', 'usgovtexas', RATES_30),
  usgovvirginia: CONTAINER_APPS_RATES_USGOV,

  // ---- 0.000031 / 0.000004 ----
  austriaeast: card('commercial', 'austriaeast', RATES_31),
  belgiumcentral: card('commercial', 'belgiumcentral', RATES_31),

  // ---- 0.000034 / 0.000004 — 19 regions, +42% over RATES_24. ----
  australiacentral: card('commercial', 'australiacentral', RATES_34),
  australiacentral2: card('commercial', 'australiacentral2', RATES_34),
  australiaeast: card('commercial', 'australiaeast', RATES_34),
  australiasoutheast: card('commercial', 'australiasoutheast', RATES_34),
  canadacentral: card('commercial', 'canadacentral', RATES_34),
  canadaeast: card('commercial', 'canadaeast', RATES_34),
  chilecentral: card('commercial', 'chilecentral', RATES_34),
  germanynorth: card('commercial', 'germanynorth', RATES_34),
  israelcentral: card('commercial', 'israelcentral', RATES_34),
  italynorth: card('commercial', 'italynorth', RATES_34),
  koreasouth: card('commercial', 'koreasouth', RATES_34),
  qatarcentral: card('commercial', 'qatarcentral', RATES_34),
  southeastasia: card('commercial', 'southeastasia', RATES_34),
  spaincentral: card('commercial', 'spaincentral', RATES_34),
  switzerlandwest: card('commercial', 'switzerlandwest', RATES_34),
  uksouth: card('commercial', 'uksouth', RATES_34),
  ukwest: card('commercial', 'ukwest', RATES_34),
  westeurope: card('commercial', 'westeurope', RATES_34),
  westus2: card('commercial', 'westus2', RATES_34),

  // ---- 0.000036 / 0.000005 — the region that exposed the prefix defect. ----
  newzealandnorth: card('commercial', 'newzealandnorth', RATES_36),

  // ---- 0.000044 / 0.000005 — swedensouth, not with swedencentral. ----
  swedensouth: card('commercial', 'swedensouth', RATES_44),

  // ---- 0.000045 / 0.000006 ----
  norwaywest: card('commercial', 'norwaywest', RATES_45),
  uaecentral: card('commercial', 'uaecentral', RATES_45),

  // ---- 0.000046 / 0.000006 ----
  southafricawest: card('commercial', 'southafricawest', RATES_46),

  // ---- 0.000055 / 0.000007 — the most expensive published tier. ----
  brazilsoutheast: card('commercial', 'brazilsoutheast', RATES_55),
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
