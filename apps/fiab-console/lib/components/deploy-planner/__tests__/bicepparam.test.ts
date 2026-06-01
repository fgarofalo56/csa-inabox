/**
 * Deploy-planner bicepparam generation — pure logic (no render), so it runs in
 * the default node vitest env. Confirms the visual plan maps to the real bicep
 * knobs (no drift = no vaporware).
 */
import { describe, it, expect } from 'vitest';
import {
  flagsForServices, serviceByKey, serviceVisual,
  SERVICE_CATALOG, SERVICE_COUNT, TOGGLEABLE_SERVICE_COUNT,
} from '../service-catalog';
import { planToBicepparam } from '../bicepparam';
import type { PlanSubscription } from '../types';

describe('service-catalog flag mapping', () => {
  it('maps toggleable services to their bicep flags', () => {
    const flags = flagsForServices(['aiFoundry', 'apim', 'adx']);
    expect(flags).toEqual({ aiFoundryEnabled: true, apimEnabled: true, adxEnabled: true });
  });

  it('omits core (always-on) services from the flag set', () => {
    expect(serviceByKey('storage')?.bicepFlag).toBeNull();
    expect(flagsForServices(['storage', 'cosmos', 'keyvault'])).toEqual({});
  });

  it('ignores unknown service keys', () => {
    expect(flagsForServices(['nope', 'apim'])).toEqual({ apimEnabled: true });
  });
});

describe('planToBicepparam', () => {
  const sub: PlanSubscription = {
    id: 'sub-1', name: 'Gov Primary', boundary: 'GCC-High',
    domains: [
      { domainId: 'finance', name: 'Finance', services: ['aiFoundry', 'apim'] },
      { domainId: 'ops', name: 'Operations', services: ['adx', 'apim'] },
    ],
  };

  it('emits boundary, region default, and dlzDomainNames from the plan', () => {
    const out = planToBicepparam(sub);
    expect(out).toContain("param boundary = 'GCC-High'");
    expect(out).toContain("param location = 'usgovvirginia'");
    expect(out).toContain("param dlzDomainNames = ['finance', 'ops']");
  });

  it('unions selected services across domains into true flags, others false', () => {
    const out = planToBicepparam(sub);
    expect(out).toContain('param aiFoundryEnabled = true');
    expect(out).toContain('param apimEnabled = true');
    expect(out).toContain('param adxEnabled = true');
    expect(out).toContain('param aiSearchEnabled = false'); // not selected anywhere
    expect(out).toContain("using '../main.bicep'");
  });

  it('honours an explicit region override', () => {
    const out = planToBicepparam({ ...sub, region: 'usgovarizona' });
    expect(out).toContain("param location = 'usgovarizona'");
  });
});

describe('catalog coverage + honesty', () => {
  it('covers a broad set of Azure service types across all six categories', () => {
    expect(SERVICE_COUNT).toBeGreaterThanOrEqual(40);
    const cats = new Set(SERVICE_CATALOG.map((s) => s.category));
    expect([...cats].sort()).toEqual(
      ['ai', 'compute', 'data', 'governance', 'integration', 'networking'],
    );
    expect(TOGGLEABLE_SERVICE_COUNT).toBeGreaterThan(0);
  });

  it('has unique keys and every entry resolves a glyph + color', () => {
    const keys = SERVICE_CATALOG.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const s of SERVICE_CATALOG) {
      const v = serviceVisual(s.key);
      expect(v.glyph).toBeTruthy();
      expect(v.color).toMatch(/^#/);
    }
  });

  it('plan-only services never emit a bicep flag (no fake knobs)', () => {
    const planOnly = SERVICE_CATALOG.filter((s) => s.planOnly);
    expect(planOnly.length).toBeGreaterThan(0);
    for (const s of planOnly) expect(s.bicepFlag).toBeNull();
    // a subscription full of plan-only services produces zero true flags
    const flags = flagsForServices(planOnly.map((s) => s.key));
    expect(Object.keys(flags)).toHaveLength(0);
  });

  it('serviceVisual falls back gracefully for unknown keys', () => {
    const v = serviceVisual('does-not-exist');
    expect(v.glyph).toBeTruthy();
    expect(v.color).toMatch(/^#/);
  });
});
