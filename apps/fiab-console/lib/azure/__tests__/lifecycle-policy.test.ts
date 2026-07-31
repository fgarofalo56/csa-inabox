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

/**
 * CodeQL js/remote-property-injection flags `baseBlob[a] = …` in
 * `serialiseRule` (lifecycle-policy-shapes.ts:114) because `a` and
 * `conditionField` originate in the `PUT /api/onelake/lifecycle` body.
 *
 * The query does not model `Set.has()` as a sanitiser, so it cannot see that
 * both key sources are constrained to CLOSED, file-local literal allowlists
 * before the write:
 *
 *   ACTION_KEYS    = TIER_ACTIONS (4 literals) + 'enableAutoTierToHotFromCool'
 *   CONDITION_KEYS = CONDITION_FIELDS (3 literals)
 *
 * …and the target is `Object.create(null)`, which has no prototype to pollute.
 * These tests are the evidence for that dismissal: they attack the exact sink
 * the alert names. If a future edit widens either allowlist, drops the
 * `Set.has` guard, or swaps the null-prototype bag for `{}`, they go red — so
 * the dismissal cannot silently outlive the reasoning behind it.
 */
describe('serialiseRule — hostile keys cannot reach the ARM object (CodeQL js/remote-property-injection)', () => {
  const hostile = (over: Partial<LifecycleRule>): LifecycleRule => ({
    name: 'r', enabled: true,
    conditionField: 'daysAfterModificationGreaterThan',
    conditionDays: 1, actions: ['tierToCool'],
    ...over,
  });

  it('drops a __proto__ action instead of writing it', () => {
    const arm = serialiseRule(hostile({ actions: ['__proto__' as any] }));
    const bag = arm.definition.actions.baseBlob;
    expect(Object.keys(bag)).toEqual([]);
    expect(Object.getPrototypeOf(bag)).toBeNull();
    // The global prototype is untouched.
    expect(({} as any).polluted).toBeUndefined();
  });

  it('drops constructor / prototype actions too, and keeps the legitimate one', () => {
    const arm = serialiseRule(hostile({ actions: ['constructor' as any, 'prototype' as any, 'delete'] }));
    expect(Object.keys(arm.definition.actions.baseBlob)).toEqual(['delete']);
  });

  it('falls back to the default condition when conditionField is __proto__', () => {
    const arm = serialiseRule(hostile({ conditionField: '__proto__' as any }));
    const inner = arm.definition.actions.baseBlob.tierToCool;
    expect(Object.keys(inner)).toEqual(['daysAfterModificationGreaterThan']);
    expect(({} as any).polluted).toBeUndefined();
  });

  it('does not pollute Object.prototype even when every field is hostile', () => {
    serialiseRule(hostile({
      actions: ['__proto__' as any, 'constructor' as any],
      conditionField: 'constructor' as any,
    }));
    expect(({} as any).daysAfterModificationGreaterThan).toBeUndefined();
    expect(Object.prototype.hasOwnProperty('tierToCool')).toBe(false);
  });
});
