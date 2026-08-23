/**
 * LOOM BRAIN cost — the rate cards, and the cloud-parity property that makes
 * them cloud-scoped rather than one global table.
 *
 * `cloud-parity.md`: the same capability ships to every boundary. Here that
 * means the derived path WORKS in Gov — not that it prices Gov at Commercial
 * rates. Measured 2026-08-23 from the public retail API, every Gov meter is
 * 25–33% above its Commercial counterpart, so a single card would understate
 * every Gov resource by that much AND look completely credible doing it.
 *
 * The population check for this layer: `BUILT_IN_RATE_CARDS` must cover exactly
 * the clouds `RateCloud` names. A card table missing a cloud makes every lookup
 * for it return null — correct behaviour, but silently zero coverage, which is
 * the "green and blind" shape one level down.
 */

import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_RATE_CARDS,
  cloudForRegion,
  CONTAINER_APPS_RATES_COMMERCIAL,
  CONTAINER_APPS_RATES_USGOV,
  rateCardFor,
  SECONDS_PER_MONTH,
  type RateCloud,
} from '../../cost/rate-card';

describe('the two cards are populated and measured', () => {
  it('covers EXACTLY the clouds RateCloud names — the population check', () => {
    const covered = Object.keys(BUILT_IN_RATE_CARDS).sort();
    const expected: RateCloud[] = ['commercial', 'usgov'];
    expect(covered).toEqual([...expected].sort());
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

describe('Gov is priced ABOVE Commercial — why the card is cloud-scoped', () => {
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
});

describe('cloudForRegion refuses to guess', () => {
  it('classifies Gov regions', () => {
    expect(cloudForRegion('usgovvirginia')).toBe('usgov');
    expect(cloudForRegion('usgovarizona')).toBe('usgov');
    expect(cloudForRegion('usdodeast')).toBe('usgov');
    expect(cloudForRegion('usdodcentral')).toBe('usgov');
  });

  it('classifies Commercial regions', () => {
    expect(cloudForRegion('centralus')).toBe('commercial');
    expect(cloudForRegion('eastus2')).toBe('commercial');
    expect(cloudForRegion('westeurope')).toBe('commercial');
  });

  it('tolerates the display spelling Azure returns ("US Gov Virginia")', () => {
    expect(cloudForRegion('US Gov Virginia')).toBe('usgov');
  });

  it('returns NULL for an unknown region rather than defaulting to Commercial', () => {
    // The defaulting version of this function is the bug: it prices a sovereign
    // or mistyped region at Commercial rates and returns a confident number.
    expect(cloudForRegion('atlantis')).toBeNull();
    expect(cloudForRegion('chinanorth3')).toBeNull();
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

  it('resolves a Commercial region to the Commercial card', () => {
    expect(rateCardFor('centralus')?.cloud).toBe('commercial');
  });

  it('returns null for an unclassifiable region', () => {
    expect(rateCardFor('nowhere')).toBeNull();
  });
});

describe('SECONDS_PER_MONTH matches the 730-hour convention Azure quotes', () => {
  it('is 730 hours in seconds', () => {
    expect(SECONDS_PER_MONTH).toBe(2_628_000);
  });
});
