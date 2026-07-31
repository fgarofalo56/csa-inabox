/**
 * js/remote-property-injection regression suite.
 *
 * Each test drives a REAL production sanitizer/store with a crafted
 * `__proto__` / `constructor` / `prototype` key and asserts the outcome the
 * plain-object-literal version could not give: an OWN key that survives
 * `Object.keys` + `JSON.stringify`, and a lookup that never inherits.
 *
 * The class is NOT just `__proto__`. Round 2 of the review pointed out that the
 * original "the value is a string, so it is inert" argument only ever held for
 * `__proto__` (whose setter ignores a non-object operand) and said nothing about
 * `toString` / `valueOf` / `hasOwnProperty` / `constructor`, which a string
 * shadows perfectly well. Those tests are below, and the four previously
 * dismissed string-valued sites now use the null-prototype record too.
 */
import { describe, it, expect } from 'vitest';
import { safeRecord, safeGet, safeSet, isUnsafeKey, toSafeStringMap } from '../safe-object';
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
   * WITHDRAWN DISMISSAL (was: alerts 619 / 577 / 504 / 503 are inert because the
   * value is a string).
   *
   * The original argument — `Object.prototype.__proto__`'s setter ignores a
   * non-object operand, so assigning a string swaps no prototype — is true, and
   * covers exactly ONE key. It says nothing about the rest of
   * `Object.prototype`. This test proves the hazard the argument missed: on a
   * plain object literal, a STRING at `toString` / `valueOf` / `hasOwnProperty`
   * shadows the inherited method, and the next consumer that calls it throws.
   * That is a 500 reachable from a caller-chosen map key, not a blank field.
   */
  it('a STRING at toString/valueOf/hasOwnProperty on a LITERAL breaks the object (the hazard the string dismissal missed)', () => {
    const bag: Record<string, string> = {};
    bag['toString'] = 'attacker';
    bag['valueOf'] = 'attacker';
    bag['hasOwnProperty'] = 'attacker';
    // The write is NOT a no-op: these are own keys shadowing real methods.
    expect(Object.keys(bag).sort()).toEqual(['hasOwnProperty', 'toString', 'valueOf']);
    expect(() => String(bag)).toThrow(TypeError);
    expect(() => `${bag}`).toThrow(TypeError);
    // eslint-disable-next-line no-prototype-builtins
    expect(() => (bag as any).hasOwnProperty('toString')).toThrow(TypeError);
    // `constructor` shadowing turns a normal reflection read into a throw too.
    const bag2: Record<string, string> = {};
    bag2['constructor'] = 'attacker';
    expect(() => new (bag2 as any).constructor()).toThrow(TypeError);
  });

  it('the same keys on a null-prototype record are inert data (the structural fix)', () => {
    const safe = safeRecord<string>();
    safe['toString'] = 'attacker';
    safe['valueOf'] = 'attacker';
    safe['hasOwnProperty'] = 'attacker';
    safe['constructor'] = 'attacker';
    safe['__proto__'] = 'attacker';
    // Every key is present as plain data, and nothing was shadowed because there
    // was nothing to shadow.
    expect(Object.keys(safe).sort()).toEqual([
      '__proto__', 'constructor', 'hasOwnProperty', 'toString', 'valueOf',
    ]);
    expect(Object.getPrototypeOf(safe)).toBeNull();
    // The payload round-trips through JSON with every key intact. (The expected
    // value must itself be built with JSON.parse: an object LITERAL containing
    // `__proto__:` sets the prototype at parse time and has no such own key —
    // the same footgun this module exists to remove.)
    expect(JSON.parse(JSON.stringify(safe))).toEqual(
      JSON.parse(
        '{"__proto__":"attacker","constructor":"attacker","hasOwnProperty":"attacker",'
        + '"toString":"attacker","valueOf":"attacker"}',
      ),
    );
  });

  /**
   * Drives the SHARED coercion now used by the three string-map sites that were
   * previously dismissed: Unity-Catalog catalog `properties`/`options`
   * (#504/#503 → app/api/databricks/unity-catalog/{catalogs,schemas}/route.ts
   * `toStringMap`) and Purview business-metadata custom tags (#577 →
   * app/api/items/[type]/[id]/business-metadata/route.ts `attributes`).
   */
  it('toSafeStringMap keeps every caller key as data and stays callable', () => {
    const map = toSafeStringMap(
      JSON.parse('{"__proto__":"a","toString":"b","constructor":"c"," ok ":"d","":"dropped"}'),
    )!;
    expect(Object.getPrototypeOf(map)).toBeNull();
    expect(Object.keys(map).sort()).toEqual(['__proto__', 'constructor', 'ok', 'toString']);
    expect(map['ok']).toBe('d');
    // Blank keys are dropped; an all-blank bag becomes undefined so the caller
    // can omit the field entirely.
    expect(toSafeStringMap({ '  ': 'x' })).toBeUndefined();
    expect(toSafeStringMap('not an object')).toBeUndefined();
    // A consumer can still stringify the outgoing body — the literal version of
    // this map could not (see the previous test).
    expect(() => JSON.stringify({ properties: map })).not.toThrow();
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
