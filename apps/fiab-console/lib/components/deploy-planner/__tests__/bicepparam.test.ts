/**
 * Deploy-planner bicepparam generation — pure logic (no render), so it runs in
 * the default node vitest env. Confirms the visual plan maps to the real bicep
 * knobs (no drift = no vaporware).
 */
import { describe, it, expect } from 'vitest';
import { flagsForServices, serviceByKey } from '../service-catalog';
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
