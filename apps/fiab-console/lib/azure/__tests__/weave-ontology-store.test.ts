import { describe, it, expect } from 'vitest';
import { isAgeNotBootstrapped, parseAgtype } from '../weave-ontology-store';

describe('isAgeNotBootstrapped (AGE self-heal trigger)', () => {
  it('triggers on a never-bootstrapped server', () => {
    expect(isAgeNotBootstrapped(new Error('schema "ag_catalog" does not exist'))).toBe(true);
    expect(isAgeNotBootstrapped(new Error('ERROR: relation ag_catalog.cypher does not exist'))).toBe(true);
    expect(isAgeNotBootstrapped(new Error('graph "loom_ontology" does not exist'))).toBe(true);
  });
  it('does NOT trigger on ordinary query errors (so we never loop)', () => {
    expect(isAgeNotBootstrapped(new Error('syntax error at or near "MATCH"'))).toBe(false);
    expect(isAgeNotBootstrapped(new Error('permission denied for database'))).toBe(false);
    expect(isAgeNotBootstrapped(new Error('connection timeout'))).toBe(false);
  });
});

describe('parseAgtype', () => {
  it('strips ::vertex and parses', () => {
    const v = parseAgtype('{"id": 844, "label": "Customer", "properties": {"name": "Acme"}}::vertex') as any;
    expect(v.label).toBe('Customer');
    expect(v.properties.name).toBe('Acme');
  });
  it('returns null / raw on non-strings and parse failures', () => {
    expect(parseAgtype(null)).toBeNull();
    expect(parseAgtype('not json')).toBe('not json');
  });
});
