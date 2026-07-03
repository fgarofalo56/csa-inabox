/**
 * Tests for the Azure compute-quota pre-flight (rel-T42).
 *
 * Covers the PURE topology→SKU mapping ({@link requiredComputeForDeploy}) and
 * the PURE evaluator ({@link evaluateQuota}) against synthetic Compute usages —
 * proving the live-diagnosed scenario (Total Regional vCPUs = 0 in the target
 * region → hard-fail gate) without a real subscription, and that the two-tier
 * (regional aggregate + VM family) math is correct.
 */
import { describe, it, expect } from 'vitest';
import {
  requiredComputeForDeploy,
  evaluateQuota,
  quotaPortalLink,
  type ComputeUsageEntry,
} from '../quota-preflight';

/** Build a usages entry the ARM Compute usages API would return. */
function usage(value: string, currentValue: number, limit: number): ComputeUsageEntry {
  return { name: { value, localizedValue: value }, currentValue, limit };
}

describe('requiredComputeForDeploy — topology → SKU mapping', () => {
  it('Gov full deploy emits the AKS Ddsv5 family (36 vCPU always-on) + SHIR advisory', () => {
    const reqs = requiredComputeForDeploy({ boundary: 'GCC-High', role: 'full' });
    const aks = reqs.find((r) => r.family === 'standardDDSv5Family');
    expect(aks).toBeDefined();
    expect(aks!.requiredVCores).toBe(36); // 3×D4ds_v5(4) + 3×D8ds_v5(8)
    expect(aks!.scaleToZero).toBeFalsy();
    const shir = reqs.find((r) => r.family === 'standardDSv5Family');
    expect(shir?.scaleToZero).toBe(true);
  });

  it('IL5 is treated as Gov (AKS emitted)', () => {
    const reqs = requiredComputeForDeploy({ boundary: 'IL5', role: 'full' });
    expect(reqs.some((r) => r.family === 'standardDDSv5Family')).toBe(true);
  });

  it('Commercial never emits an AKS row (Container Apps is serverless)', () => {
    const reqs = requiredComputeForDeploy({ boundary: 'Commercial', role: 'full' });
    expect(reqs.some((r) => r.family === 'standardDDSv5Family')).toBe(false);
    // Only the scale-to-0 SHIR advisory remains.
    expect(reqs.every((r) => r.scaleToZero)).toBe(true);
  });

  it('GCC (M365 GCC over Azure Public) is NOT Gov — no AKS row', () => {
    const reqs = requiredComputeForDeploy({ boundary: 'GCC', role: 'full' });
    expect(reqs.some((r) => r.family === 'standardDDSv5Family')).toBe(false);
  });

  it('a spoke target carries only the DLZ increment (no AKS even on Gov)', () => {
    const reqs = requiredComputeForDeploy({ boundary: 'GCC-High', role: 'spoke' });
    expect(reqs.some((r) => r.family === 'standardDDSv5Family')).toBe(false);
    expect(reqs.some((r) => r.family === 'standardDSv5Family')).toBe(true);
  });
});

describe('evaluateQuota — two-tier (regional + family) sufficiency', () => {
  const govFull = requiredComputeForDeploy({ boundary: 'GCC-High', role: 'full' });

  it('flags the live scenario: Total Regional vCPUs = 0 → hard fail', () => {
    const usages = [usage('cores', 0, 0), usage('standardDDSv5Family', 0, 100)];
    const ev = evaluateQuota({ subscriptionId: 's', location: 'usgovvirginia', required: govFull, usages });
    expect(ev.regional.required).toBe(36); // deploy-time (non scale-to-0) subtotal
    expect(ev.regional.sufficient).toBe(false);
    expect(ev.ok).toBe(false);
  });

  it('passes when both the regional aggregate and the AKS family have headroom', () => {
    const usages = [usage('cores', 10, 100), usage('standardDDSv5Family', 4, 100), usage('standardDSv5Family', 0, 50)];
    const ev = evaluateQuota({ subscriptionId: 's', location: 'usgovvirginia', required: govFull, usages });
    expect(ev.regional.sufficient).toBe(true);
    expect(ev.ok).toBe(true);
  });

  it('fails when the AKS family tier is exhausted even if the regional aggregate is fine', () => {
    const usages = [usage('cores', 0, 1000), usage('standardDDSv5Family', 90, 100)]; // 90+36 > 100
    const ev = evaluateQuota({ subscriptionId: 's', location: 'usgovvirginia', required: govFull, usages });
    expect(ev.families.find((f) => f.family === 'standardDDSv5Family')?.sufficient).toBe(false);
    expect(ev.ok).toBe(false);
  });

  it('a scale-to-0 tier that lacks headroom does NOT hard-fail the gate (advisory)', () => {
    const usages = [usage('cores', 0, 1000), usage('standardDDSv5Family', 0, 1000), usage('standardDSv5Family', 49, 50)]; // 49+16 > 50
    const ev = evaluateQuota({ subscriptionId: 's', location: 'usgovvirginia', required: govFull, usages });
    const shir = ev.families.find((f) => f.family === 'standardDSv5Family');
    expect(shir?.sufficient).toBe(false);
    expect(shir?.scaleToZero).toBe(true);
    expect(ev.ok).toBe(true); // advisory only — deploy not blocked
  });

  it('a tier missing from the usages response is unverifiable (undefined), not a failure', () => {
    const usages = [usage('cores', 10, 100)]; // no family entries reported
    const ev = evaluateQuota({ subscriptionId: 's', location: 'usgovvirginia', required: govFull, usages });
    expect(ev.families.find((f) => f.family === 'standardDDSv5Family')?.sufficient).toBeUndefined();
    expect(ev.ok).toBe(true);
  });

  it('matches usages family names case-insensitively', () => {
    const usages = [usage('CORES', 0, 1000), usage('StandardDDSv5Family', 90, 100)];
    const ev = evaluateQuota({ subscriptionId: 's', location: 'usgovvirginia', required: govFull, usages });
    expect(ev.regional.current).toBe(0);
    expect(ev.families.find((f) => f.family === 'standardDDSv5Family')?.current).toBe(90);
  });

  it('Commercial deploy needs 0 always-on vCPU (regional required = 0) → passes', () => {
    const commercial = requiredComputeForDeploy({ boundary: 'Commercial', role: 'full' });
    const usages = [usage('cores', 5, 10), usage('standardDSv5Family', 0, 50)];
    const ev = evaluateQuota({ subscriptionId: 's', location: 'eastus2', required: commercial, usages });
    expect(ev.regional.required).toBe(0);
    expect(ev.ok).toBe(true);
  });
});

describe('quotaPortalLink', () => {
  it('uses the commercial portal host by default', () => {
    expect(quotaPortalLink(false)).toContain('portal.azure.com');
  });
  it('uses the Gov portal host for Gov', () => {
    expect(quotaPortalLink(true)).toContain('portal.azure.us');
  });
});
