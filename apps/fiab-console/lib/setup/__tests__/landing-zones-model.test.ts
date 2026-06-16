/**
 * Tests for the DLZ overview data mapping (item-3).
 *
 * Mirrors the live data: hub in sub e093f4fd (centralus), one cross-sub DLZ
 * `rg-csa-loom-dlz-default-centralus` in sub 363ef5d1. Asserts the mapping
 * marks cross-sub correctly and derives attach state from write permission.
 */
import { describe, it, expect } from 'vitest';
import {
  parseDlzRgName,
  buildLandingZonesOverview,
  type DlzRgRow,
  type HubCoords,
} from '../landing-zones-model';

const HUB_SUB = 'e093f4fd-5047-4ee4-968d-a56942c665f3';
const TARGET_SUB = '363ef5d1-0e77-4594-a530-f51af23dbf8c';

const hub: HubCoords = { hubSubscriptionId: HUB_SUB, location: 'centralus', boundary: 'Commercial' };

describe('parseDlzRgName', () => {
  it('parses the live DLZ RG name', () => {
    expect(parseDlzRgName('rg-csa-loom-dlz-default-centralus')).toEqual({ domainName: 'default', region: 'centralus' });
  });

  it('parses a hyphenated domain', () => {
    expect(parseDlzRgName('rg-csa-loom-dlz-mission-ops-eastus2')).toEqual({ domainName: 'mission-ops', region: 'eastus2' });
  });

  it('returns null for non-DLZ RGs', () => {
    expect(parseDlzRgName('rg-csa-loom-admin-centralus')).toBeNull();
  });
});

describe('buildLandingZonesOverview', () => {
  const rows: DlzRgRow[] = [
    { name: 'rg-csa-loom-dlz-default-centralus', subscriptionId: TARGET_SUB, location: 'centralus' },
  ];

  it('marks a DLZ in a different sub than the hub as cross-subscription', () => {
    const o = buildLandingZonesOverview(hub, true, rows, new Set([HUB_SUB, TARGET_SUB]));
    expect(o.landingZones).toHaveLength(1);
    expect(o.landingZones[0].crossSubscription).toBe(true);
    expect(o.landingZones[0].domainName).toBe('default');
    expect(o.landingZones[0].id).toBe(`${TARGET_SUB}/rg-csa-loom-dlz-default-centralus`);
  });

  it('marks attached when the target sub is writable', () => {
    const o = buildLandingZonesOverview(hub, true, rows, new Set([HUB_SUB, TARGET_SUB]));
    expect(o.landingZones[0].attachState).toBe('attached');
  });

  it('marks detached when the cross-sub DLZ is in a Reader-only sub (the live case)', () => {
    // writableSubs = only the hub sub → the cross-sub DLZ is not writable.
    const o = buildLandingZonesOverview(hub, true, rows, new Set([HUB_SUB]));
    expect(o.landingZones[0].attachState).toBe('detached');
  });

  it('marks attached for a same-sub DLZ regardless of cross-sub writability', () => {
    const sameSubRows: DlzRgRow[] = [
      { name: 'rg-csa-loom-dlz-finance-centralus', subscriptionId: HUB_SUB, location: 'centralus' },
    ];
    const o = buildLandingZonesOverview(hub, true, sameSubRows, new Set([HUB_SUB]));
    expect(o.landingZones[0].crossSubscription).toBe(false);
    expect(o.landingZones[0].attachState).toBe('attached');
  });

  it('reports unknown attach state when permission was not probed', () => {
    const o = buildLandingZonesOverview(hub, true, rows, undefined);
    expect(o.landingZones[0].attachState).toBe('unknown');
  });

  it('skips RGs that do not match the DLZ naming convention', () => {
    const mixed: DlzRgRow[] = [
      ...rows,
      { name: 'rg-csa-loom-admin-centralus', subscriptionId: HUB_SUB },
      { name: 'some-other-rg', subscriptionId: HUB_SUB },
    ];
    const o = buildLandingZonesOverview(hub, true, mixed, new Set([HUB_SUB, TARGET_SUB]));
    expect(o.landingZones).toHaveLength(1);
  });

  it('returns an empty list (not mock data) when no DLZ RGs exist', () => {
    const o = buildLandingZonesOverview(hub, true, [], new Set([HUB_SUB]));
    expect(o.landingZones).toEqual([]);
    expect(o.hubExists).toBe(true);
  });

  it('orders hub-sub DLZs before cross-sub DLZs, then by domain', () => {
    const many: DlzRgRow[] = [
      { name: 'rg-csa-loom-dlz-zeta-centralus', subscriptionId: HUB_SUB },
      { name: 'rg-csa-loom-dlz-alpha-eastus2', subscriptionId: TARGET_SUB },
      { name: 'rg-csa-loom-dlz-beta-centralus', subscriptionId: HUB_SUB },
    ];
    const o = buildLandingZonesOverview(hub, true, many, new Set([HUB_SUB]));
    expect(o.landingZones.map((z) => z.domainName)).toEqual(['beta', 'zeta', 'alpha']);
  });
});
