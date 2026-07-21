import { describe, it, expect } from 'vitest';
import {
  POLICY_CODE_API_VERSION,
  normalizePolicyCodeSet,
  validatePolicyCodeSet,
  parsePolicyCodeSet,
  backendsInSet,
  toYaml,
  emptyPolicyCodeSet,
  type PolicyCodeSet,
} from '../dsl';

const sample: PolicyCodeSet = {
  apiVersion: POLICY_CODE_API_VERSION,
  name: 'test',
  statements: [
    {
      id: 's1',
      principals: [{ kind: 'group', id: 'g1', name: 'Finance' }],
      resources: [
        { backend: 'synapse', object: 'dbo.Sales' },
        { backend: 'adx', object: 'Db/Events' },
      ],
      actions: ['read'],
      condition: { rowFilter: '[Region] = USERPRINCIPALNAME()', maskColumns: ['Email'] },
    },
  ],
};

describe('policy-code DSL', () => {
  it('normalizes arbitrary JSON, dropping bad principals/resources/actions', () => {
    const set = normalizePolicyCodeSet({
      name: 'x',
      statements: [
        {
          id: 'a',
          principals: [{ id: 'g1', kind: 'group' }, { kind: 'user' /* no id */ }],
          resources: [{ backend: 'synapse', object: 'dbo.T' }, { backend: 'bogus', object: 'y' }, { backend: 'adx' /* no object */ }],
          actions: ['read', 'nope', 'deny'],
        },
      ],
    });
    expect(set.statements[0].principals).toHaveLength(1);
    expect(set.statements[0].resources).toHaveLength(1);
    expect(set.statements[0].actions).toEqual(['read', 'deny']);
  });

  it('validate flags empty statements + duplicate ids', () => {
    const bad = normalizePolicyCodeSet({ name: 'x', statements: [{ id: 'd' }, { id: 'd', principals: [{ id: 'g', kind: 'group' }], resources: [{ backend: 'synapse', object: 'a.b' }], actions: ['read'] }] });
    const v = validatePolicyCodeSet(bad);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes('Duplicate'))).toBe(true);
  });

  it('validate passes a well-formed set', () => {
    expect(validatePolicyCodeSet(sample).ok).toBe(true);
  });

  it('backendsInSet lists the backends used (+ purview when a marking is set)', () => {
    expect(backendsInSet(sample)).toEqual(['synapse', 'adx']);
    const withMark: PolicyCodeSet = {
      ...sample,
      statements: [{ ...sample.statements[0], condition: { marking: 'Confidential' } }],
    };
    expect(backendsInSet(withMark)).toContain('purview');
  });

  it('toYaml → fromYaml round-trips the shape', () => {
    const yaml = toYaml(sample);
    const back = parsePolicyCodeSet(yaml);
    expect(back.name).toBe('test');
    expect(back.statements[0].id).toBe('s1');
    expect(back.statements[0].resources.map((r) => r.backend).sort()).toEqual(['adx', 'synapse']);
    expect(back.statements[0].actions).toEqual(['read']);
    expect(back.statements[0].condition?.rowFilter).toContain('USERPRINCIPALNAME');
    expect(back.statements[0].condition?.maskColumns).toEqual(['Email']);
  });

  it('parsePolicyCodeSet accepts JSON strings and objects', () => {
    expect(parsePolicyCodeSet(JSON.stringify(sample)).name).toBe('test');
    expect(parsePolicyCodeSet(sample).name).toBe('test');
    expect(parsePolicyCodeSet('').statements).toHaveLength(0);
  });

  it('emptyPolicyCodeSet carries the api version', () => {
    expect(emptyPolicyCodeSet().apiVersion).toBe(POLICY_CODE_API_VERSION);
  });
});
