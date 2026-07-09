/**
 * AIF-11 — deployment-type catalog + PTU validation (pure logic).
 */
import { describe, it, expect } from 'vitest';
import {
  deploymentTypeFor, isProvisioned, isBatch, capacityUnitFor,
  offeredDeploymentTypes, validateCapacity, DEPLOYMENT_TYPES,
  isModelRouterModel, modelRouterAvailability, MODEL_ROUTER_MODEL, ROUTER_MODES,
} from '../deployment-types';

describe('deploymentTypeFor / kinds', () => {
  it('resolves case-insensitively', () => {
    expect(deploymentTypeFor('globalprovisioned')?.sku).toBe('GlobalProvisioned');
    expect(deploymentTypeFor('GLOBALBATCH')?.kind).toBe('batch');
    expect(deploymentTypeFor('nope')).toBeUndefined();
    expect(deploymentTypeFor(undefined)).toBeUndefined();
  });
  it('classifies provisioned vs batch', () => {
    expect(isProvisioned('GlobalProvisioned')).toBe(true);
    expect(isProvisioned('ProvisionedManaged')).toBe(true);
    expect(isProvisioned('GlobalStandard')).toBe(false);
    expect(isBatch('DataZoneBatch')).toBe(true);
    expect(isBatch('Standard')).toBe(false);
  });
  it('marks provisioned SKUs hourly-billed with a PTU unit + floor', () => {
    const g = deploymentTypeFor('GlobalProvisioned')!;
    expect(g.hourlyBilled).toBe(true);
    expect(g.capacityUnit).toBe('PTU');
    expect(g.minCapacity).toBeGreaterThanOrEqual(1);
    expect(capacityUnitFor('GlobalProvisioned')).toBe('PTU');
    expect(capacityUnitFor('Standard')).toBe('K-TPM');
    expect(capacityUnitFor('unknown')).toBe('K-TPM');
  });
  it('never marks a standard SKU as hourly-billed', () => {
    for (const t of DEPLOYMENT_TYPES.filter((d) => d.kind === 'standard')) {
      expect(t.hourlyBilled).toBe(false);
    }
  });
});

describe('offeredDeploymentTypes', () => {
  it('offers the model SKUs first, then always-offered Standard defaults, deduped', () => {
    const offered = offeredDeploymentTypes(['GlobalProvisioned', 'GlobalStandard'], { isGov: false });
    const skus = offered.map((o) => o.sku);
    expect(skus[0]).toBe('GlobalProvisioned');
    expect(skus).toContain('Standard');       // always-offered default appended
    expect(new Set(skus).size).toBe(skus.length); // deduped
    expect(offered.every((o) => o.govGated === false)).toBe(true);
  });
  it('always offers a deployable default even when the model reports no SKUs', () => {
    const offered = offeredDeploymentTypes([], { isGov: false });
    expect(offered.map((o) => o.sku)).toEqual(expect.arrayContaining(['GlobalStandard', 'Standard']));
  });
  it('gov-gates non-GA types in a Gov boundary but still returns them (honest gate, not hidden)', () => {
    const offered = offeredDeploymentTypes(['GlobalProvisioned', 'ProvisionedManaged', 'GlobalBatch'], { isGov: true });
    const byId = Object.fromEntries(offered.map((o) => [o.sku, o]));
    expect(byId['GlobalProvisioned'].govGated).toBe(true);  // Global not Gov-GA
    expect(byId['GlobalBatch'].govGated).toBe(true);         // Batch not Gov-supported
    expect(byId['ProvisionedManaged'].govGated).toBe(false); // Regional Provisioned IS Gov-GA
    expect(byId['Standard'].govGated).toBe(false);           // Regional Standard IS Gov-GA
  });
});

describe('validateCapacity', () => {
  it('rejects non-positive / non-integer capacity', () => {
    expect(validateCapacity('Standard', 0).ok).toBe(false);
    expect(validateCapacity('Standard', -5).ok).toBe(false);
    expect(validateCapacity('Standard', 3.5).ok).toBe(false);
    expect(validateCapacity('Standard', NaN).ok).toBe(false);
  });
  it('enforces the PTU floor for provisioned SKUs', () => {
    const below = validateCapacity('GlobalProvisioned', 5);
    expect(below.ok).toBe(false);
    expect(below.error).toMatch(/PTU/);
    expect(validateCapacity('GlobalProvisioned', 15).ok).toBe(true);
  });
  it('accepts a small positive capacity for standard SKUs', () => {
    expect(validateCapacity('GlobalStandard', 1).ok).toBe(true);
    expect(validateCapacity('Standard', 10).ok).toBe(true);
  });
});

describe('AIF-12 — model-router', () => {
  it('detects the model-router model name case-insensitively', () => {
    expect(isModelRouterModel('model-router')).toBe(true);
    expect(isModelRouterModel('MODEL-ROUTER')).toBe(true);
    expect(isModelRouterModel(' model-router ')).toBe(true);
    expect(isModelRouterModel('gpt-4o')).toBe(false);
    expect(isModelRouterModel(undefined)).toBe(false);
    expect(isModelRouterModel(null)).toBe(false);
    expect(MODEL_ROUTER_MODEL).toBe('model-router');
  });
  it('is available in Commercial but honest-gated in Gov', () => {
    expect(modelRouterAvailability(false).available).toBe(true);
    const gov = modelRouterAvailability(true);
    expect(gov.available).toBe(false);
    expect(gov.reason).toMatch(/Azure Government/);
    expect(gov.reason).toMatch(/tier router/i);
  });
  it('offers Quality and Cost routing modes', () => {
    expect(ROUTER_MODES.map((m) => m.value)).toEqual(['quality', 'cost']);
  });
});
