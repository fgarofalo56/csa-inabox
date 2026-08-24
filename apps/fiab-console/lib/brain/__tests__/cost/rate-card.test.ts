/**
 * LOOM BRAIN cost — the rate cards, and the two properties that make them safe
 * to price with: they are keyed by EXACT region, and an unpriced region gets
 * NOTHING rather than somebody else's card.
 *
 * ── WHY THE REGION KEY IS THE SUBJECT OF THIS FILE ─────────────────────────
 * The first version of this module carried correct rates and a wrong lookup: a
 * single Commercial card (centralus) reachable through 37 region PREFIXES. Every
 * rate in it was re-read from the retail API and matched byte-for-byte, and the
 * module still under-reported, because a table of right numbers handed to the
 * wrong region is a wrong answer that looks exactly like a right one.
 *
 * The measured harm, and the case these tests are the regression for: a
 * `newzealandnorth` app at minReplicas 2 / 0.5 vCPU / 1 GiB was quoted a
 * "defensible floor" of $23.65 where the New Zealand rates give $39.42 — 40%
 * low. The prefix `'westus'` is the tell: it matches westus, westus2 and
 * westus3, and westus2 prices 42% above the other two. Region names are not a
 * price hierarchy.
 *
 * ── THE POPULATION CHECK FOR THIS LAYER ────────────────────────────────────
 * Two shapes, both here. Every key must BE its card's region, so the key and
 * the provenance string cannot drift apart; and both clouds `RateCloud` names
 * must be represented, because a table missing a cloud makes every lookup for
 * it return null — correct behaviour, but silently zero coverage, which is the
 * "green and blind" shape one level down.
 *
 * ── AND WHY GOV STAYS SEPARATE ─────────────────────────────────────────────
 * `cloud-parity.md`: the same capability ships to every boundary. Here that
 * means the derived path WORKS in Gov — not that it prices Gov at Commercial
 * rates. Measured 2026-08-23 from the public retail API, every Gov meter is
 * 25–33% above its Commercial counterpart.
 */

import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_RATE_CARDS,
  cloudForRegion,
  CONTAINER_APPS_RATES_COMMERCIAL,
  CONTAINER_APPS_RATES_USGOV,
  rateCardFor,
  SECONDS_PER_MONTH,
  type ContainerAppsRateCard,
  type RateCloud,
} from '../../cost/rate-card';

describe('the cards are populated and measured', () => {
  it('every KEY is the region of the card filed under it — key and provenance cannot drift', () => {
    // The `source` string is built from the card's `region`, so a card filed
    // under the wrong key would advertise a retail query that does not
    // reproduce it. That is worse than no provenance: it is provenance that
    // sends a reader to the wrong number and tells them it matched.
    for (const [key, card] of Object.entries(BUILT_IN_RATE_CARDS)) {
      expect([key, card.region]).toEqual([key, key]);
      expect(key).toBe(key.toLowerCase());
      expect(key.trim()).toBe(key);
    }
  });

  it('covers BOTH clouds RateCloud names — the population check', () => {
    const clouds = [...new Set(Object.values(BUILT_IN_RATE_CARDS).map((c) => c.cloud))].sort();
    const expected: RateCloud[] = ['commercial', 'usgov'];
    expect(clouds).toEqual([...expected].sort());
  });

  it('the table is not empty — a zero-population table would pass every loop below', () => {
    // Every per-card assertion in this file iterates the table. An empty table
    // makes all of them vacuously true, which is the failure mode that reads
    // most like a clean bill of health.
    expect(Object.keys(BUILT_IN_RATE_CARDS).length).toBeGreaterThan(1);
  });

  it('every rate is a positive finite USD number — no zero placeholders', () => {
    for (const card of Object.values(BUILT_IN_RATE_CARDS)) {
      for (const rate of [
        card.vcpuActiveUsdPerSecond,
        card.vcpuIdleUsdPerSecond,
        card.memoryActiveUsdPerGibSecond,
        card.memoryIdleUsdPerGibSecond,
      ]) {
        expect(Number.isFinite(rate)).toBe(true);
        expect(rate).toBeGreaterThan(0);
      }
      expect(card.currency).toBe('USD');
    }
  });

  it('every card names its source precisely enough to re-run', () => {
    for (const card of Object.values(BUILT_IN_RATE_CARDS)) {
      expect(card.source).toContain('prices.azure.com');
      expect(card.source).toContain(card.region);
      expect(card.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('idle rates are at or below active rates on every card', () => {
    for (const card of Object.values(BUILT_IN_RATE_CARDS)) {
      expect(card.vcpuIdleUsdPerSecond).toBeLessThanOrEqual(card.vcpuActiveUsdPerSecond);
      expect(card.memoryIdleUsdPerGibSecond).toBeLessThanOrEqual(card.memoryActiveUsdPerGibSecond);
    }
  });
});

describe('Gov is priced ABOVE Commercial — why the card carries its cloud', () => {
  const c = CONTAINER_APPS_RATES_COMMERCIAL;
  const g = CONTAINER_APPS_RATES_USGOV;

  it('vCPU active: Gov strictly higher', () => {
    expect(g.vcpuActiveUsdPerSecond).toBeGreaterThan(c.vcpuActiveUsdPerSecond);
  });

  it('vCPU idle: Gov strictly higher', () => {
    expect(g.vcpuIdleUsdPerSecond).toBeGreaterThan(c.vcpuIdleUsdPerSecond);
  });

  it('memory active: Gov strictly higher', () => {
    expect(g.memoryActiveUsdPerGibSecond).toBeGreaterThan(c.memoryActiveUsdPerGibSecond);
  });

  it('memory idle: Gov strictly higher', () => {
    expect(g.memoryIdleUsdPerGibSecond).toBeGreaterThan(c.memoryIdleUsdPerGibSecond);
  });

  it('the gap is material — at least 20% on vCPU active, so a wrong card is a wrong number', () => {
    const premium = g.vcpuActiveUsdPerSecond / c.vcpuActiveUsdPerSecond - 1;
    expect(premium).toBeGreaterThan(0.2);
  });

  it('the named exports are the two regions they claim to be', () => {
    // `derived.test.ts` and `attribute.test.ts` both price against these by
    // name, so what they point at is part of the contract, not an internal.
    expect([c.cloud, c.region]).toEqual(['commercial', 'centralus']);
    expect([g.cloud, g.region]).toEqual(['usgov', 'usgovvirginia']);
  });
});

describe('the key is the EXACT region — a prefix is not a price', () => {
  it('westus2 does NOT resolve through westus, which is a different price', () => {
    // The defect in one line. `'westus'` as a PREFIX matches all three, and
    // westus2 publishes vCPU-active 0.000034 against centralus's 0.000024 —
    // 42% higher. Two of the three priced correctly and the middle one did
    // not, which is why spot-checking the prefix list would never have found
    // it: the sample that fails is the one nobody thinks to draw.
    expect(rateCardFor('westus')?.region).toBe('westus');
    expect(rateCardFor('westus3')?.region).toBe('westus3');
    expect(rateCardFor('westus2')).toBeNull();
  });

  it('a region priced ABOVE centralus is NEVER handed the centralus card', () => {
    // These eight publish vCPU-active 0.000034, +42% on centralus. Today none
    // is in the table — their other three meters have not been read, and a
    // card is all four rates or it is not a card — so each returns null.
    //
    // The assertion is written to hold BOTH ways on purpose: if a future read
    // adds one of these with its own rates it still passes, and if anything
    // ever re-admits them at the centralus rate it fails. What it will not do
    // is pass vacuously, which a `if (card) { … }` loop over eight nulls
    // would.
    const PRICED_ABOVE_CENTRALUS = [
      'westus2',
      'westeurope',
      'australiaeast',
      'uksouth',
      'canadacentral',
      'southeastasia',
      'italynorth',
      'spaincentral',
    ];
    for (const region of PRICED_ABOVE_CENTRALUS) {
      const found = rateCardFor(region);
      expect([region, found?.vcpuActiveUsdPerSecond ?? null]).not.toEqual([
        region,
        CONTAINER_APPS_RATES_COMMERCIAL.vcpuActiveUsdPerSecond,
      ]);
    }
    // CONTROL — the same lookup DOES return the centralus rate for a region
    // that genuinely has it. Without this the eight assertions above would
    // also pass against a `rateCardFor` that returned null for everything.
    expect(rateCardFor('centralus')?.vcpuActiveUsdPerSecond).toBe(
      CONTAINER_APPS_RATES_COMMERCIAL.vcpuActiveUsdPerSecond,
    );
  });

  it('never hands back a card belonging to a DIFFERENT region', () => {
    // The general form of the defect. `rateCardFor` may answer with nothing,
    // or with the card read FOR THE REGION ASKED ABOUT — never with a
    // neighbour's, a prefix-sibling's, or the historical default's.
    const PROBES = [
      'centralus',
      'eastus',
      'eastus2',
      'westus',
      'westus2',
      'westus3',
      'northeurope',
      'westeurope',
      'japaneast',
      'newzealandnorth',
      'usgovvirginia',
      'usgovarizona',
      'usdodeast',
      'chinanorth3',
      'atlantis',
    ];
    let cardsReturned = 0;
    for (const region of PROBES) {
      const found = rateCardFor(region);
      if (found === null) continue;
      cardsReturned += 1;
      expect([region, found.region]).toEqual([region, region]);
    }
    // CONTROL — the loop above skips nulls, so without this it would pass just
    // as happily against a `rateCardFor` that returned null for every probe.
    expect(cardsReturned).toBeGreaterThan(0);
  });

  it('and today all eight are honestly absent, not quietly approximated', () => {
    for (const region of [
      'westus2',
      'westeurope',
      'australiaeast',
      'uksouth',
      'canadacentral',
      'southeastasia',
      'italynorth',
      'spaincentral',
    ]) {
      expect([region, rateCardFor(region)]).toEqual([region, null]);
      expect([region, cloudForRegion(region)]).toEqual([region, null]);
    }
  });

  it('usdodeast and usdodcentral return NULL — there is no published price at all', () => {
    // Not a nearby-region approximation problem. A retail query for either
    // returns ZERO Container Apps Consumption meters, so the old `usdod`
    // prefix branch was not estimating from usgovvirginia — it was minting a
    // price for a boundary where the service is not publicly priced.
    expect(rateCardFor('usdodeast')).toBeNull();
    expect(rateCardFor('usdodcentral')).toBeNull();
    expect(cloudForRegion('usdodeast')).toBeNull();
    expect(cloudForRegion('usdodcentral')).toBeNull();
    // CONTROL — the Gov path itself still resolves, so the four nulls above
    // are a statement about usdod and not about a broken Gov lookup.
    expect(cloudForRegion('usgovvirginia')).toBe('usgov');
    expect(cloudForRegion('usgovarizona')).toBe('usgov');
  });

  it('a prototype key is not a region — the lookup is closed', () => {
    // `region` is caller-supplied and the table is an object literal, so a
    // bare `TABLE[r]` also reads `Object.prototype`. `'constructor'` survives
    // normalisation unchanged and would return the `Object` constructor —
    // truthy, and every rate on it `undefined`, which multiplies out to a
    // `$NaN` band presented as a derived dollar figure.
    for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect([key, rateCardFor(key)]).toEqual([key, null]);
      expect([key, cloudForRegion(key)]).toEqual([key, null]);
    }
  });
});

describe('newzealandnorth — the 40% under-report, measured', () => {
  function nzCard(): ContainerAppsRateCard {
    const found = rateCardFor('newzealandnorth');
    if (found === null) {
      throw new Error('newzealandnorth must be in the table — it is the subject of this block');
    }
    return found;
  }

  it('has its OWN card, and it is not the centralus one', () => {
    const nz = nzCard();
    expect(nz.region).toBe('newzealandnorth');
    expect(nz.cloud).toBe('commercial');
    expect(nz.vcpuActiveUsdPerSecond).toBeGreaterThan(
      CONTAINER_APPS_RATES_COMMERCIAL.vcpuActiveUsdPerSecond,
    );
    expect(nz.vcpuIdleUsdPerSecond).toBeGreaterThan(
      CONTAINER_APPS_RATES_COMMERCIAL.vcpuIdleUsdPerSecond,
    );
    expect(nz.memoryIdleUsdPerGibSecond).toBeGreaterThan(
      CONTAINER_APPS_RATES_COMMERCIAL.memoryIdleUsdPerGibSecond,
    );
  });

  it('prices the founding example at $39.42 / $120.89, not $23.65 / $78.84', () => {
    // The harm as a number, computed by hand so this test does not simply
    // re-run `derived.ts`'s own expression. Founding example: minReplicas 2,
    // 0.5 vCPU, 1 GiB, one 730-hour month.
    //   always-on replica-seconds = 2 x 2_628_000 = 5_256_000
    //   vCPU-seconds              = 5_256_000 x 0.5 = 2_628_000
    //   GiB-seconds               = 5_256_000 x 1   = 5_256_000
    const vcpuSeconds = 2 * SECONDS_PER_MONTH * 0.5;
    const gibSeconds = 2 * SECONDS_PER_MONTH * 1;

    const nz = nzCard();
    const nzLower =
      vcpuSeconds * nz.vcpuIdleUsdPerSecond + gibSeconds * nz.memoryIdleUsdPerGibSecond;
    const nzUpper =
      vcpuSeconds * nz.vcpuActiveUsdPerSecond + gibSeconds * nz.memoryActiveUsdPerGibSecond;
    expect(nzLower).toBeCloseTo(39.42, 6);
    expect(nzUpper).toBeCloseTo(120.888, 6);

    // What the prefix classifier actually reported for this app, because it
    // resolved 'newzealandnorth' through the 'newzealand' prefix to the
    // centralus card.
    const c = CONTAINER_APPS_RATES_COMMERCIAL;
    const wrongLower = vcpuSeconds * c.vcpuIdleUsdPerSecond + gibSeconds * c.memoryIdleUsdPerGibSecond;
    const wrongUpper =
      vcpuSeconds * c.vcpuActiveUsdPerSecond + gibSeconds * c.memoryActiveUsdPerGibSecond;
    expect(wrongLower).toBeCloseTo(23.652, 6);
    expect(wrongUpper).toBeCloseTo(78.84, 6);

    // The floor it published was 40% below the floor it should have. Not a
    // rounding complaint — the wrong number was the one labelled "defensible".
    expect(wrongLower / nzLower).toBeCloseTo(0.6, 6);
  });
});

describe('cloudForRegion classifies ONLY what it can actually price', () => {
  // One table, so the positive and negative populations are visible together
  // and neither can quietly go to zero.
  const CASES: ReadonlyArray<readonly [string, RateCloud | null]> = [
    ['centralus', 'commercial'],
    ['eastus', 'commercial'],
    ['eastus2', 'commercial'],
    ['westus', 'commercial'],
    ['westus3', 'commercial'],
    ['northeurope', 'commercial'],
    ['japaneast', 'commercial'],
    ['newzealandnorth', 'commercial'],
    ['usgovvirginia', 'usgov'],
    ['usgovarizona', 'usgov'],
    // Azure hands the display spelling back from several portal-facing APIs.
    ['US Gov Virginia', 'usgov'],
    ['  CentralUS  ', 'commercial'],
    // Published ABOVE centralus; all four meters not yet read, so no card.
    ['westus2', null],
    ['westeurope', null],
    ['uksouth', null],
    ['italynorth', null],
    // No published Container Apps Consumption meters in the boundary at all.
    ['usdodeast', null],
    ['usdodcentral', null],
    // Sovereign boundaries Loom has never priced.
    ['chinanorth3', null],
    // Not a region.
    ['atlantis', null],
    ['nowhere', null],
  ];

  it('answers each region with the cloud that priced it, or null', () => {
    for (const [region, cloud] of CASES) {
      expect([region, cloudForRegion(region)]).toEqual([region, cloud]);
    }
  });

  it('the case table carries BOTH answers — agreement over an all-null set is not a result', () => {
    expect(CASES.filter(([, cloud]) => cloud !== null).length).toBeGreaterThan(0);
    expect(CASES.filter(([, cloud]) => cloud === null).length).toBeGreaterThan(0);
  });

  it('returns NULL for an unknown region rather than defaulting to Commercial', () => {
    // The defaulting version of this function is the bug: it prices a
    // sovereign, unread or mistyped region at Commercial rates and returns a
    // confident number. Note that 'westeurope' now sits in this class rather
    // than in the Commercial one — it is a real Commercial region, and it is
    // 42% more expensive than the card that used to answer for it, so an
    // answer of 'commercial' here was never the same thing as a right answer.
    expect(cloudForRegion('atlantis')).toBeNull();
    expect(cloudForRegion('chinanorth3')).toBeNull();
    expect(cloudForRegion('westeurope')).toBeNull();
  });

  it('returns NULL for absent and empty input', () => {
    expect(cloudForRegion(undefined)).toBeNull();
    expect(cloudForRegion('')).toBeNull();
    expect(cloudForRegion('   ')).toBeNull();
  });
});

describe('rateCardFor', () => {
  it('resolves a Gov region to the Gov card, not the Commercial one', () => {
    const card = rateCardFor('usgovvirginia');
    expect(card?.cloud).toBe('usgov');
    expect(card?.vcpuActiveUsdPerSecond).toBe(CONTAINER_APPS_RATES_USGOV.vcpuActiveUsdPerSecond);
  });

  it('resolves the other Gov region to a Gov card of its own', () => {
    const card = rateCardFor('usgovarizona');
    expect(card?.cloud).toBe('usgov');
    expect(card?.region).toBe('usgovarizona');
  });

  it('resolves a Commercial region to the Commercial card', () => {
    expect(rateCardFor('centralus')?.cloud).toBe('commercial');
  });

  it('returns null for an unclassifiable region', () => {
    expect(rateCardFor('nowhere')).toBeNull();
  });

  it('returns null for absent and empty input', () => {
    expect(rateCardFor(undefined)).toBeNull();
    expect(rateCardFor('')).toBeNull();
    expect(rateCardFor('   ')).toBeNull();
  });

  it('hands back the same card object the table holds, so a caller can compare identity', () => {
    expect(rateCardFor('centralus')).toBe(CONTAINER_APPS_RATES_COMMERCIAL);
    expect(rateCardFor('usgovvirginia')).toBe(CONTAINER_APPS_RATES_USGOV);
  });
});

describe('SECONDS_PER_MONTH matches the 730-hour convention Azure quotes', () => {
  it('is 730 hours in seconds', () => {
    expect(SECONDS_PER_MONTH).toBe(2_628_000);
  });
});
