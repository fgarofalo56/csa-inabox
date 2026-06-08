import { describe, it, expect } from 'vitest';
import { serialiseRule, deserialiseRule, type LifecycleRule } from '../lifecycle-policy-shapes';

describe('lifecycle policy (de)serialisation — OneLake Lifecycle Management', () => {
  it('serialises a tier-to-cool rule to the ARM baseBlob shape', () => {
    const rule: LifecycleRule = {
      name: 'tier-cool-30d',
      enabled: true,
      conditionField: 'daysAfterModificationGreaterThan',
      conditionDays: 30,
      actions: ['tierToCool'],
    };
    const arm = serialiseRule(rule);
    expect(arm).toMatchObject({
      name: 'tier-cool-30d',
      enabled: true,
      type: 'Lifecycle',
      definition: {
        actions: { baseBlob: { tierToCool: { daysAfterModificationGreaterThan: 30 } } },
        filters: { blobTypes: ['blockBlob'] },
      },
    });
    // No prefixMatch when whole-account scope.
    expect(arm.definition.filters.prefixMatch).toBeUndefined();
  });

  it('serialises enableAutoTierToHotFromCool as a boolean, not a date object', () => {
    const rule: LifecycleRule = {
      name: 'auto-tier',
      enabled: true,
      conditionField: 'daysAfterLastAccessTimeGreaterThan',
      conditionDays: 30,
      actions: ['tierToCool', 'enableAutoTierToHotFromCool'],
    };
    const arm = serialiseRule(rule);
    expect(arm.definition.actions.baseBlob.enableAutoTierToHotFromCool).toBe(true);
    expect(arm.definition.actions.baseBlob.tierToCool).toEqual({ daysAfterLastAccessTimeGreaterThan: 30 });
  });

  it('emits prefixMatch (leading slash stripped) when scoped to a path prefix', () => {
    const rule: LifecycleRule = {
      name: 'landing-cleanup',
      enabled: false,
      prefixMatch: ['/landing/', 'bronze/raw/'],
      conditionField: 'daysAfterModificationGreaterThan',
      conditionDays: 7,
      actions: ['delete'],
    };
    const arm = serialiseRule(rule);
    expect(arm.enabled).toBe(false);
    expect(arm.definition.filters.prefixMatch).toEqual(['landing/', 'bronze/raw/']);
  });

  it('round-trips a rule through serialise → deserialise', () => {
    const rule: LifecycleRule = {
      name: 'archive-90d',
      enabled: true,
      prefixMatch: ['gold/'],
      conditionField: 'daysAfterCreationGreaterThan',
      conditionDays: 90,
      actions: ['tierToArchive'],
    };
    const back = deserialiseRule(serialiseRule(rule));
    expect(back).toEqual(rule);
  });

  it('deserialises a disabled (paused) rule as enabled:false', () => {
    const arm = {
      name: 'paused-rule',
      enabled: false,
      type: 'Lifecycle',
      definition: {
        actions: { baseBlob: { delete: { daysAfterModificationGreaterThan: 180 } } },
        filters: { blobTypes: ['blockBlob'] },
      },
    };
    const rule = deserialiseRule(arm);
    expect(rule?.enabled).toBe(false);
    expect(rule?.actions).toEqual(['delete']);
    expect(rule?.conditionDays).toBe(180);
  });

  it('drops a rule with no actionable baseBlob actions', () => {
    const arm = {
      name: 'empty',
      enabled: true,
      definition: { actions: { baseBlob: {} }, filters: { blobTypes: ['blockBlob'] } },
    };
    expect(deserialiseRule(arm)).toBeNull();
  });
});
