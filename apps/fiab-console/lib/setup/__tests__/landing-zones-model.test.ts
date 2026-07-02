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
  rgKey,
  type DlzRgRow,
  type HubCoords,
} from '../landing-zones-model';

const HUB_SUB = '11111111-1111-1111-1111-111111111111';
const TARGET_SUB = '22222222-2222-2222-2222-222222222222';

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

  it('marks attached when the DLZ RG is writable (RG-scoped Contributor) even though the sub is Reader-only', () => {
    // The least-privilege multi-sub case: UAMI has Contributor on the DLZ RG,
    // only Reader at the subscription. The DLZ must be healthy, NOT "needs repair".
    const o = buildLandingZonesOverview(hub, true, rows, {
      writableSubs: new Set([HUB_SUB]), // sub is NOT writable
      writableRgs: new Set([rgKey(TARGET_SUB, 'rg-csa-loom-dlz-default-centralus')]),
    });
    expect(o.landingZones[0].attachState).toBe('attached');
  });

  it('marks detached only when NEITHER the RG nor the sub is writable', () => {
    const o = buildLandingZonesOverview(hub, true, rows, {
      writableSubs: new Set([HUB_SUB]),
      writableRgs: new Set<string>(), // RG not writable either
    });
    expect(o.landingZones[0].attachState).toBe('detached');
  });

  it('multi-sub: RG-scoped Contributor in the DLZ OWN sub → attached, no re-attach warning (the live false-positive fix)', () => {
    // Live: DLZ in sub 363ef5d1…, hub/admin in e093f4fd…. The UAMI holds
    // Contributor scoped to rg-csa-loom-dlz-default-centralus IN THE DLZ SUB and
    // only Reader at the subscription scope. Evaluated in the DLZ's own sub, the
    // RG is writable → attached. No 'detached' → the overview shows no warning.
    const o = buildLandingZonesOverview(hub, true, rows, {
      writableSubs: new Set([HUB_SUB]), // Reader-only at the DLZ subscription scope
      writableRgs: new Set([rgKey(TARGET_SUB, 'rg-csa-loom-dlz-default-centralus')]),
    });
    expect(o.landingZones[0].crossSubscription).toBe(true);
    expect(o.landingZones[0].attachState).toBe('attached');
    expect(o.landingZones.some((z) => z.attachState === 'detached')).toBe(false);
  });

  it('reports unknown (not detached) when the RG permission read could not be determined', () => {
    // A cross-sub 403/transient read failure must not masquerade as Reader-only.
    const o = buildLandingZonesOverview(hub, true, rows, {
      writableSubs: new Set([HUB_SUB]),
      writableRgs: new Set<string>(),
      unknownRgs: new Set([rgKey(TARGET_SUB, 'rg-csa-loom-dlz-default-centralus')]),
    });
    expect(o.landingZones[0].attachState).toBe('unknown');
  });

  it('writable RG still wins over an unknown signal for the same RG', () => {
    const key = rgKey(TARGET_SUB, 'rg-csa-loom-dlz-default-centralus');
    const o = buildLandingZonesOverview(hub, true, rows, {
      writableSubs: new Set([HUB_SUB]),
      writableRgs: new Set([key]),
      unknownRgs: new Set([key]),
    });
    expect(o.landingZones[0].attachState).toBe('attached');
  });

  it('still accepts the legacy bare Set<string> of writable subs', () => {
    const o = buildLandingZonesOverview(hub, true, rows, new Set([HUB_SUB, TARGET_SUB]));
    expect(o.landingZones[0].attachState).toBe('attached');
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
