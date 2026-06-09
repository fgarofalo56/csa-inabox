/**
 * Vitest specs for the tenant-settings schema + F2 scope/numeric helpers.
 * Pure data-shape + helper assertions — no Cosmos / Graph.
 */
import { describe, it, expect } from 'vitest';
import {
  TENANT_SETTING_GROUPS,
  defaultSettings,
  numericDefaults,
  numericParamDefs,
  scopableToggleIds,
  numericParamIds,
  isAppliesToMode,
  isValidAppliesTo,
  appliesToEqual,
  APPLIES_TO_MODES,
  type AppliesToConfig,
} from '../tenant-settings';

describe('tenant-settings schema', () => {
  it('defaultSettings covers every toggle id exactly once as a boolean', () => {
    const ids = TENANT_SETTING_GROUPS.flatMap((g) => g.toggles.map((t) => t.id));
    expect(new Set(ids).size).toBe(ids.length); // no duplicate ids
    const defs = defaultSettings();
    for (const id of ids) expect(typeof defs[id]).toBe('boolean');
  });

  it('numericDefaults / numericParamDefs cover every numericParam id as a number', () => {
    const defs = numericDefaults();
    const paramDefs = numericParamDefs();
    for (const id of numericParamIds()) {
      expect(typeof defs[id]).toBe('number');
      expect(paramDefs[id]).toBeDefined();
    }
  });

  it('scopableToggleIds are all valid toggle ids', () => {
    const allIds = new Set(TENANT_SETTING_GROUPS.flatMap((g) => g.toggles.map((t) => t.id)));
    const scopable = scopableToggleIds();
    expect(scopable.size).toBeGreaterThan(0);
    for (const id of scopable) expect(allIds.has(id)).toBe(true);
  });

  it('numericParam min/max/default are coherent for every tagged toggle', () => {
    for (const g of TENANT_SETTING_GROUPS) {
      for (const t of g.toggles) {
        if (t.numericParam) {
          expect(t.numericParam.min).toBeLessThan(t.numericParam.max);
          expect(t.numericParam.default).toBeGreaterThanOrEqual(t.numericParam.min);
          expect(t.numericParam.default).toBeLessThanOrEqual(t.numericParam.max);
        }
      }
    }
  });
});

describe('AppliesTo helpers', () => {
  it('APPLIES_TO_MODES is exactly the three Fabric modes', () => {
    expect(APPLIES_TO_MODES).toEqual(['entire-org', 'specific-groups', 'except-groups']);
  });

  it('isAppliesToMode accepts the three modes and rejects junk', () => {
    expect(isAppliesToMode('entire-org')).toBe(true);
    expect(isAppliesToMode('specific-groups')).toBe(true);
    expect(isAppliesToMode('except-groups')).toBe(true);
    expect(isAppliesToMode('nope')).toBe(false);
    expect(isAppliesToMode(5)).toBe(false);
  });

  it('isValidAppliesTo validates shape', () => {
    expect(isValidAppliesTo({ mode: 'specific-groups', groupIds: ['g1', 'g2'] })).toBe(true);
    expect(isValidAppliesTo({ mode: 'entire-org', groupIds: [] })).toBe(true);
    expect(isValidAppliesTo({ mode: 'bad', groupIds: [] })).toBe(false);
    expect(isValidAppliesTo({ mode: 'specific-groups', groupIds: 'x' })).toBe(false);
    expect(isValidAppliesTo({ mode: 'specific-groups', groupIds: [1, 2] })).toBe(false);
    expect(isValidAppliesTo(null)).toBe(false);
  });

  it('appliesToEqual is order-insensitive on groupIds and ignores display names', () => {
    const a: AppliesToConfig = { mode: 'specific-groups', groupIds: ['g1', 'g2'], groupDisplayNames: ['A', 'B'] };
    const b: AppliesToConfig = { mode: 'specific-groups', groupIds: ['g2', 'g1'], groupDisplayNames: ['x', 'y'] };
    expect(appliesToEqual(a, b)).toBe(true);
    expect(appliesToEqual(a, { mode: 'except-groups', groupIds: ['g1', 'g2'] })).toBe(false);
    expect(appliesToEqual(a, { mode: 'specific-groups', groupIds: ['g1'] })).toBe(false);
    expect(appliesToEqual(null, null)).toBe(true);
    expect(appliesToEqual(a, null)).toBe(false);
  });
});
