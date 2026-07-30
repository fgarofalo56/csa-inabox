/**
 * #2657 — prototype pollution must be impossible through the shared helpers, and
 * the underlying mechanism must be DEMONSTRATED, not asserted.
 */
import { describe, it, expect } from 'vitest';
import {
  isDangerousKey,
  safeAssign,
  safeRecordFrom,
  assertSafeKey,
  UnsafeKeyError,
} from '../safe-keys';

const PAYLOADS = ['__proto__', 'constructor', 'prototype'];

describe('the vulnerability is real (baseline, no helper)', () => {
  it('a raw obj[k] = v REPLACES the prototype instead of adding a key', () => {
    const out: Record<string, unknown> = {};
    const body = JSON.parse('{"__proto__": {"isAdmin": true}}');
    for (const [k, v] of Object.entries(body)) out[k] = v;

    // The key the user "sent" is NOT there...
    expect(Object.keys(out)).not.toContain('__proto__');
    // ...because it went to the prototype slot instead.
    expect(Object.getPrototypeOf(out)).toEqual({ isAdmin: true });
    // Which is exactly how an unrelated read sees a flag it was never given.
    expect((out as { isAdmin?: boolean }).isAdmin).toBe(true);
  });
});

describe('isDangerousKey', () => {
  it.each(PAYLOADS)('flags %j', (k) => expect(isDangerousKey(k)).toBe(true));

  it.each(['name', 'proto', '__proto', 'proto__', '_proto_', 'Constructor', 'PROTOTYPE', ''])(
    'does NOT flag the benign key %j',
    (k) => expect(isDangerousKey(k)).toBe(false),
  );
});

describe('safeAssign', () => {
  it('writes an ordinary key', () => {
    const o: Record<string, string> = {};
    safeAssign(o, 'owner', 'frank');
    expect(o.owner).toBe('frank');
  });

  it.each(PAYLOADS)('THROWS on %j rather than silently dropping it', (k) => {
    const o: Record<string, unknown> = {};
    expect(() => safeAssign(o, k, { isAdmin: true })).toThrow(UnsafeKeyError);
    // And nothing was mutated.
    expect(Object.getPrototypeOf(o)).toBe(Object.prototype);
    expect((o as { isAdmin?: boolean }).isAdmin).toBeUndefined();
  });
});

describe('safeRecordFrom', () => {
  it('builds a NULL-prototype record', () => {
    const r = safeRecordFrom([['a', 1], ['b', 2]]);
    expect(Object.getPrototypeOf(r)).toBeNull();
    expect(r.a).toBe(1);
    // No inherited members to confuse a later lookup.
    expect((r as unknown as { toString?: unknown }).toString).toBeUndefined();
  });

  it('is still JSON-serialisable and spreadable', () => {
    const r = safeRecordFrom([['a', 1]]);
    expect(JSON.stringify(r)).toBe('{"a":1}');
    expect({ ...r }).toEqual({ a: 1 });
  });

  it.each(PAYLOADS)('refuses a payload containing %j', (k) => {
    expect(() => safeRecordFrom(Object.entries(JSON.parse(`{"ok":1,"${k}":{"isAdmin":true}}`))))
      .toThrow(UnsafeKeyError);
  });

  it('the resulting record CANNOT be polluted afterwards', () => {
    const r = safeRecordFrom<unknown>([['a', 1]]);
    // With a null prototype there is no prototype slot to hijack: this becomes an
    // ordinary own property rather than a prototype swap.
    (r as Record<string, unknown>)['__proto__'] = { isAdmin: true };
    expect((r as { isAdmin?: boolean }).isAdmin).toBeUndefined();
  });
});

describe('assertSafeKey', () => {
  it('returns a benign key unchanged so it reads inline', () => {
    expect(assertSafeKey('model-1')).toBe('model-1');
  });

  it.each(PAYLOADS)('throws on %j', (k) => {
    expect(() => assertSafeKey(k)).toThrow(UnsafeKeyError);
  });

  it('names the offending key in the message (all three are fixed strings)', () => {
    expect(() => assertSafeKey('__proto__')).toThrow(/__proto__/);
  });
});
