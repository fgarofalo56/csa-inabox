import { describe, it, expect } from 'vitest';
import { toYaml } from '../src/output.js';
import { isKnownItemType, suggestItemTypes, ITEM_TYPES } from '../src/item-types.js';

describe('toYaml', () => {
  it('emits scalars', () => {
    expect(toYaml('hello')).toBe('hello');
    expect(toYaml(42)).toBe('42');
    expect(toYaml(true)).toBe('true');
    expect(toYaml(null)).toBe('null');
  });

  it('quotes strings that look like other scalars', () => {
    expect(toYaml('a: b')).toBe('"a: b"');
    expect(toYaml('')).toBe('""');
  });

  it('emits a flat object', () => {
    expect(toYaml({ id: '1', name: 'WS' })).toBe('id: 1\nname: WS');
  });

  it('emits arrays of scalars', () => {
    expect(toYaml(['a', 'b'])).toBe('- a\n- b');
    expect(toYaml([])).toBe('[]');
  });

  it('emits nested objects', () => {
    const y = toYaml({ a: { b: 'c' } });
    expect(y).toBe('a:\n  b: c');
  });
});

describe('item-types', () => {
  it('recognizes known types', () => {
    expect(isKnownItemType('lakehouse')).toBe(true);
    expect(isKnownItemType('warehouse')).toBe(true);
    expect(isKnownItemType('eventstream')).toBe(true);
  });

  it('rejects unknown types', () => {
    expect(isKnownItemType('not-a-real-type')).toBe(false);
  });

  it('suggests close matches for typos', () => {
    const s = suggestItemTypes('lakhouse');
    expect(s[0]).toBe('lakehouse');
  });

  it('has a non-trivial taxonomy', () => {
    expect(ITEM_TYPES.length).toBeGreaterThan(50);
  });
});
