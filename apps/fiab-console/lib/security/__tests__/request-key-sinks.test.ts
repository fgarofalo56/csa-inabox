/**
 * #2657 — request-derived keys must land on a prototype-less record.
 *
 * These tests pin the DIFFERENCE between the two available fixes, because that
 * difference is the whole reason this class stayed open:
 *
 *   a denylist  — rejects __proto__ / constructor / prototype (3 names)
 *   safeRecord  — Object.create(null): there is no prototype to pollute or
 *                 shadow, so toString / valueOf / hasOwnProperty are ordinary
 *                 keys too
 *
 * A denylist leaves `out['toString'] = 'x'` intact, and the next `String(out)`
 * throws a TypeError — a 500 any authenticated caller can trigger. The
 * structural fix closes the whole surface, which is why the six sites in this
 * change use it rather than an assertion.
 */
import { describe, it, expect } from 'vitest';
import { safeRecord } from '@/lib/security/safe-object';

/** What the six patched sites used to do. */
function plainRecordFrom(entries: Array<[string, unknown]>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of entries) out[k] = v;
  return out;
}

/** What they do now. */
function safeRecordFromEntries(entries: Array<[string, unknown]>): Record<string, unknown> {
  const out = safeRecord<unknown>();
  for (const [k, v] of entries) out[k] = v;
  return out;
}

describe('the bug, reproduced on a plain object literal', () => {
  it('__proto__ REPLACES the prototype instead of storing the key', () => {
    const out = plainRecordFrom([['__proto__', { injected: true }]]);
    // The key the caller sent is not there…
    expect(Object.keys(out)).toEqual([]);
    expect(JSON.stringify(out)).toBe('{}');
    // …and an unrelated lookup now resolves through attacker-supplied data.
    expect((out as Record<string, unknown>).injected).toBe(true);
  });

  it('a STRING value at toString still breaks the object', () => {
    // The "the value is only a string, so it is inert" dismissal covers exactly
    // one key. Every other inherited member is shadowed by a string just fine.
    const out = plainRecordFrom([['toString', 'not a function']]);
    expect(() => String(out)).toThrow(TypeError);
  });

  it('a missing key can return a Function rather than undefined', () => {
    const out = plainRecordFrom([]);
    expect(typeof out.constructor).toBe('function');
  });
});

describe('safeRecord — the structural fix', () => {
  it('stores __proto__ as an ordinary own property', () => {
    const out = safeRecordFromEntries([['__proto__', { injected: true }]]);
    expect(Object.keys(out)).toEqual(['__proto__']);
    expect(out['__proto__']).toEqual({ injected: true });
    // No pollution: the unrelated lookup stays undefined.
    expect((out as Record<string, unknown>).injected).toBeUndefined();
  });

  it('survives what a 3-key denylist would let through', () => {
    const out = safeRecordFromEntries([
      ['toString', 'x'],
      ['valueOf', 'y'],
      ['hasOwnProperty', 'z'],
    ]);
    // Stored as data, and nothing inherits a broken member.
    expect(out.toString).toBe('x');
    expect(Object.keys(out).sort()).toEqual(['hasOwnProperty', 'toString', 'valueOf']);
  });

  it('returns undefined for any key it does not own', () => {
    const out = safeRecordFromEntries([['a', 1]]);
    expect(out.constructor).toBeUndefined();
    expect(out['prototype']).toBeUndefined();
    expect(out['nope']).toBeUndefined();
  });

  it('serialises exactly like an object literal (persisted shapes unchanged)', () => {
    const out = safeRecordFromEntries([['a', 1], ['b', 'two']]);
    expect(JSON.stringify(out)).toBe('{"a":1,"b":"two"}');
    expect({ ...out }).toEqual({ a: 1, b: 'two' });
  });

  it('the loom-app-runtime path filter does NOT exclude __proto__', () => {
    // The import route filters uploaded paths with /^[\w.\-/]+$/ and rejects
    // '..', leading '/', and 'Dockerfile'. Underscores are \w, so the dangerous
    // key sails through — which is why the record itself has to be safe.
    const PATH_OK = /^[\w.\-/]+$/;
    expect(PATH_OK.test('__proto__')).toBe(true);
    expect(PATH_OK.test('constructor')).toBe(true);
  });
});
