import { describe, it, expect } from 'vitest';
import { parseScimFilter, evaluateScimFilter } from '../filter';

describe('parseScimFilter', () => {
  it('returns null for empty/absent input', () => {
    expect(parseScimFilter('')).toBeNull();
    expect(parseScimFilter(null)).toBeNull();
    expect(parseScimFilter(undefined)).toBeNull();
  });

  it('parses the canonical Entra userName eq filter', () => {
    const f = parseScimFilter('userName eq "alice@contoso.com"');
    expect(f).toEqual({ kind: 'compare', attribute: 'userName', op: 'eq', value: 'alice@contoso.com' });
  });

  it('parses a presence (pr) filter with no value', () => {
    const f = parseScimFilter('externalId pr');
    expect(f).toEqual({ kind: 'compare', attribute: 'externalId', op: 'pr' });
  });

  it('parses and/or composition', () => {
    const f = parseScimFilter('userName eq "a" and active eq "true"');
    expect(f?.kind).toBe('logical');
    const g = parseScimFilter('displayName co "eng" or displayName co "data"');
    expect(g?.kind).toBe('logical');
  });

  it('tolerates wrapping parentheses', () => {
    const f = parseScimFilter('(userName eq "x")');
    expect(f).toEqual({ kind: 'compare', attribute: 'userName', op: 'eq', value: 'x' });
  });

  it('returns null on malformed input rather than throwing', () => {
    expect(parseScimFilter('userName eq')).toBeNull();
    expect(parseScimFilter('bogus')).toBeNull();
  });
});

describe('evaluateScimFilter', () => {
  const alice = { userName: 'alice@contoso.com', displayName: 'Alice Eng', active: true, externalId: 'ext-1' };
  const bob = { userName: 'bob@contoso.com', displayName: 'Bob', active: false };

  it('matches eq case-insensitively', () => {
    const f = parseScimFilter('userName eq "ALICE@contoso.com"')!;
    expect(evaluateScimFilter(f, alice)).toBe(true);
    expect(evaluateScimFilter(f, bob)).toBe(false);
  });

  it('evaluates co / sw / ew', () => {
    expect(evaluateScimFilter(parseScimFilter('displayName co "eng"')!, alice)).toBe(true);
    expect(evaluateScimFilter(parseScimFilter('userName sw "alice"')!, alice)).toBe(true);
    expect(evaluateScimFilter(parseScimFilter('userName ew ".com"')!, alice)).toBe(true);
  });

  it('evaluates pr against present + absent attributes', () => {
    expect(evaluateScimFilter(parseScimFilter('externalId pr')!, alice)).toBe(true);
    expect(evaluateScimFilter(parseScimFilter('externalId pr')!, bob)).toBe(false);
  });

  it('evaluates and / or', () => {
    const andF = parseScimFilter('userName eq "alice@contoso.com" and active eq "true"')!;
    expect(evaluateScimFilter(andF, alice)).toBe(true);
    expect(evaluateScimFilter(andF, bob)).toBe(false);
    const orF = parseScimFilter('userName eq "bob@contoso.com" or userName eq "alice@contoso.com"')!;
    expect(evaluateScimFilter(orF, alice)).toBe(true);
    expect(evaluateScimFilter(orF, bob)).toBe(true);
  });
});
