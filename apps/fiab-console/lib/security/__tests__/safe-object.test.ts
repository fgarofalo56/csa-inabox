/**
 * js/remote-property-injection regression suite.
 *
 * Each test drives a REAL production sanitizer/store with a crafted
 * `__proto__` / `constructor` / `prototype` key and asserts the outcome the
 * plain-object-literal version could not give: an OWN key that survives
 * `Object.keys` + `JSON.stringify`, and a lookup that never inherits.
 */
import { describe, it, expect } from 'vitest';
import { safeRecord, safeGet, safeSet, isUnsafeKey } from '../safe-object';
import { sanitizePageConfig, sanitizeBookmarks } from '@/lib/report/report-definition-sanitizer';
import { serialiseRule, type LifecycleRule } from '@/lib/azure/lifecycle-policy-shapes';

describe('safe-object primitives', () => {
  it('a null-prototype record takes __proto__ as an OWN key (a literal cannot)', () => {
    const evil = { pwned: true };

    const literal: Record<string, unknown> = {};
    literal['__proto__'] = evil;
    // The bug being prevented: the literal's PROTOTYPE was replaced, the key is
    // absent from own-keys, and JSON.stringify silently drops the write.
    expect(Object.keys(literal)).toHaveLength(0);
    expect((literal as any).pwned).toBe(true);
    expect(JSON.parse(JSON.stringify(literal))).toEqual({});

    const safe = safeRecord<unknown>();
    safe['__proto__'] = evil;
    expect(Object.keys(safe)).toEqual(['__proto__']);
    expect((safe as any).pwned).toBeUndefined();
    expect(Object.getPrototypeOf(safe)).toBeNull();
  });

  it('safeGet never inherits Object.prototype members', () => {
    const rehydrated: Record<string, unknown> = JSON.parse('{"a":1}');
    // A plain map from storage DOES inherit — a truthiness check on it lies.
    expect((rehydrated as any).constructor).toBeTruthy();
    expect(safeGet(rehydrated, 'constructor')).toBeUndefined();
    expect(safeGet(rehydrated, '__proto__')).toBeUndefined();
    expect(safeGet(rehydrated, 'a')).toBe(1);
  });

  it('safeSet reports the rejection instead of silently dropping', () => {
    const t: Record<string, number> = {};
    expect(safeSet(t, '__proto__', 1)).toBe(false);
    expect(safeSet(t, 'ok', 1)).toBe(true);
    expect(isUnsafeKey('prototype')).toBe(true);
    expect(isUnsafeKey('page-1')).toBe(false);
  });

  /**
   * The DISMISSAL evidence for the four string-valued CodeQL sites (alerts 619,
   * 577, 504, 503 — ai-functions/table `values[f]`, business-metadata
   * `attributes[key]`, and the two Unity-Catalog `toStringMap` bags). Those
   * write a STRING, and `Object.prototype.__proto__`'s setter ignores a
   * non-object operand: no prototype swap, no own key, no pollution — the write
   * is a silent no-op, so the only consequence is a tag/field literally named
   * `__proto__` rendering blank. Left unfixed on purpose; this test pins the
   * language behaviour the dismissal rests on so a future runtime change is
   * caught rather than assumed.
   */
  it('a STRING assigned at __proto__ is a no-op (basis for the string-valued dismissals)', () => {
    const bag: Record<string, string> = {};
    bag['__proto__'] = 'attacker';
    expect(Object.keys(bag)).toHaveLength(0);
    expect(Object.getPrototypeOf(bag)).toBe(Object.prototype);
    expect(Object.getPrototypeOf({})).toBe(Object.prototype); // nothing global moved
    // …whereas an OBJECT value at the same key DOES swap the prototype — which
    // is why the object/array-valued sites in this PR were fixed and these were not.
    const bag2: Record<string, unknown> = {};
    bag2['__proto__'] = { attacker: true };
    expect(Object.getPrototypeOf(bag2)).not.toBe(Object.prototype);
  });
});

describe('report-definition sanitizer — dynamic key maps', () => {
  /**
   * `{ __proto__: … }` in an object LITERAL sets the prototype at parse time, so
   * the crafted payload must be built the way it actually arrives: through
   * JSON.parse (which produces an own `__proto__` key), exactly like a request
   * body reaching the definition route.
   */
  const payload = (json: string) => JSON.parse(json);

  it('keeps a __proto__ visual-interaction source as data instead of a prototype', () => {
    const cfg = sanitizePageConfig(
      payload('{"interactions":{"__proto__":{"v2":"filter"},"v1":{"v2":"highlight"}}}'),
    ) as any;
    const inter = cfg.interactions;
    // Pre-fix `inter` had NO own '__proto__' key: the write replaced the map's
    // PROTOTYPE with the attacker bucket, so `inter.v2` read back 'filter' for a
    // source id that was never named, and JSON dropped the entry on persist.
    expect(Object.prototype.hasOwnProperty.call(inter, '__proto__')).toBe(true);
    expect(inter.v1).toEqual({ v2: 'highlight' });
    expect(Object.keys(JSON.parse(JSON.stringify(inter)))).toContain('__proto__');
  });

  it('keeps a __proto__ bookmark page-id bucket as an own key', () => {
    const bms = sanitizeBookmarks(
      payload('[{"name":"bm","state":{"pageFilters":{"__proto__":[{"column":"c","op":"in","values":["x"]}]}}}]'),
    ) as any[];
    const pf = bms[0].state.pageFilters;
    expect(Object.prototype.hasOwnProperty.call(pf, '__proto__')).toBe(true);
    expect(Array.isArray(Object.getPrototypeOf(pf))).toBe(false);
  });

  it('keeps __proto__ / constructor keys in the bookmark visibility + z-order maps', () => {
    const bms = sanitizeBookmarks(
      payload('[{"name":"bm","state":{"visibility":{"__proto__":true,"constructor":false,"v1":true},"zOrder":{"__proto__":5,"v1":2}}}]'),
    ) as any[];
    const st = bms[0].state;
    expect(Object.keys(st.visibility).sort()).toEqual(['__proto__', 'constructor', 'v1']);
    expect(Object.keys(st.zOrder).sort()).toEqual(['__proto__', 'v1']);
    // `constructor` no longer shadows a Function on the sanitized map.
    expect(typeof st.visibility.constructor).toBe('boolean');
  });
});

describe('lifecycle policy — action/condition keys are enforced in the shape module', () => {
  const base: LifecycleRule = {
    name: 'r1',
    enabled: true,
    conditionField: 'daysAfterModificationGreaterThan',
    conditionDays: 30,
    actions: ['tierToCool'],
  };

  it('drops an action name outside the closed set instead of writing it as a key', () => {
    const arm = serialiseRule({ ...base, actions: ['tierToCool', '__proto__' as any, 'evil' as any] });
    expect(Object.keys(arm.definition.actions.baseBlob)).toEqual(['tierToCool']);
  });

  it('falls back to a known condition field rather than emitting an arbitrary key', () => {
    const arm = serialiseRule({ ...base, conditionField: '__proto__' as any });
    expect(arm.definition.actions.baseBlob.tierToCool).toEqual({ daysAfterModificationGreaterThan: 30 });
  });

  it('still serialises a valid rule byte-identically', () => {
    const arm = serialiseRule({ ...base, actions: ['tierToCool', 'enableAutoTierToHotFromCool'] });
    expect(arm.definition.actions.baseBlob).toEqual({
      tierToCool: { daysAfterModificationGreaterThan: 30 },
      enableAutoTierToHotFromCool: true,
    });
  });
});
