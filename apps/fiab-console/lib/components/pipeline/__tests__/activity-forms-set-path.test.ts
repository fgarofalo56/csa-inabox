/**
 * `setPath` — the prototype-pollution guard on the pipeline activity form's
 * dotted-path writer (CodeQL js/prototype-pollution-utility, alert #374).
 *
 * WHY THIS TEST EXISTS IN THIS SHAPE. #2773 already fixed this function, using
 * the shared `isDangerousKey` predicate from lib/util/safe-keys. That is the
 * right RULE and it shipped to main — and CodeQL kept reporting alert #374 on
 * the same head commit, because `js/prototype-pollution-utility`'s only
 * denylist barrier is `DenyListEqualityGuard`: an equality test whose operand
 * is the LITERAL string `__proto__` / `constructor`. A predicate behind an
 * import is invisible to it.
 *
 * So the check is now written inline with string literals. That creates the
 * risk the shared-helper approach was designed to avoid — a second copy of the
 * rule that can drift — and the last test here is what removes it: the local
 * literals are asserted against `UNSAFE_OBJECT_KEYS`, the audited list.
 */
import { describe, it, expect } from 'vitest';
import { setPath } from '../activity-forms';
import { UNSAFE_OBJECT_KEYS } from '@/lib/security/safe-object';

describe('setPath — prototype pollution', () => {
  it.each(['__proto__', 'constructor', 'prototype'])(
    'refuses a top-level %s segment and leaves the returned object\'s prototype alone',
    (key) => {
      const before = ({} as Record<string, unknown>).polluted;
      const out = setPath({ a: 1 }, key, { polluted: 'yes' });
      expect(({} as Record<string, unknown>).polluted).toBe(before);
      // The whole write is refused, not partially applied.
      expect(out).toEqual({ a: 1 });
      // toEqual alone does NOT catch this: `root['__proto__'] = {…}` swaps the
      // prototype rather than adding a key, so Object.keys / toEqual still read
      // `{a: 1}`. Mutation-testing this file found both `__proto__` cases
      // passing with the guard removed. Assert the prototype itself.
      expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    },
  );

  it.each(['__proto__', 'constructor', 'prototype'])(
    'refuses a NESTED %s segment (the walk assigns at every level, not just the last)',
    (key) => {
      const out = setPath({ a: 1 }, `outer.${key}.inner`, { polluted: 'yes' });
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(out).toEqual({ a: 1 });
      // Nothing half-written: `outer` was never created.
      expect((out as Record<string, unknown>).outer).toBeUndefined();
    },
  );

  it('refuses a dangerous segment reached through an array index', () => {
    const out = setPath({ list: [{ x: 1 }] }, 'list[0].__proto__', { polluted: 'yes' });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(out).toEqual({ list: [{ x: 1 }] });
    // Same trap as the top-level case: the swap is invisible to toEqual.
    expect(Object.getPrototypeOf((out as { list: object[] }).list[0])).toBe(Object.prototype);
  });

  it('the drift test\'s own premise: an UNGUARDED write really would swap the prototype', () => {
    // Without this, "the guard refused it" and "the write was harmless anyway"
    // look identical, and the tests above would pass against a no-op guard.
    const victim: Record<string, unknown> = { a: 1 };
    victim['__proto__'] = { polluted: 'yes' };
    expect(Object.getPrototypeOf(victim)).not.toBe(Object.prototype);
    expect((victim as { polluted?: string }).polluted).toBe('yes');
    expect(Object.keys(victim)).toEqual(['a']); // …and toEqual would never notice
  });

  // ── CONTROL — must pass with OR without the guard. If the guard is ever
  // widened (e.g. to reject every key containing an underscore) these go red,
  // which is what stops the fix from breaking real field paths.
  it('CONTROL: still writes an ordinary nested path', () => {
    expect(setPath({}, 'source.datasetSettings.name', 'ds1')).toEqual({
      source: { datasetSettings: { name: 'ds1' } },
    });
  });

  it('CONTROL: still writes through an array index', () => {
    expect(setPath({}, 'inputs[0].referenceName', 'ds1')).toEqual({
      inputs: [{ referenceName: 'ds1' }],
    });
  });

  it('CONTROL: still accepts underscore-leading and reserved-adjacent names', () => {
    expect(setPath({}, '_loomKind', 'copy')).toEqual({ _loomKind: 'copy' });
    expect(setPath({}, 'constructorName', 'x')).toEqual({ constructorName: 'x' });
    expect(setPath({}, 'proto', 'x')).toEqual({ proto: 'x' });
  });

  it('CONTROL: does not mutate the input object', () => {
    const original = { source: { name: 'a' } };
    const out = setPath(original, 'source.name', 'b');
    expect(original.source.name).toBe('a');
    expect(out.source.name).toBe('b');
  });

  // ── drift ──────────────────────────────────────────────────────────────
  it('the LOCAL literal list matches the audited UNSAFE_OBJECT_KEYS', () => {
    // Every audited key is refused by the inline check…
    for (const key of UNSAFE_OBJECT_KEYS) {
      expect(setPath({ a: 1 }, key, { polluted: 'yes' })).toEqual({ a: 1 });
    }
    // …and the audited list is exactly the three prototype-slot names, so a key
    // ADDED there later fails the loop above until setPath's literals catch up.
    expect([...UNSAFE_OBJECT_KEYS].sort()).toEqual(['__proto__', 'constructor', 'prototype']);
  });
});
