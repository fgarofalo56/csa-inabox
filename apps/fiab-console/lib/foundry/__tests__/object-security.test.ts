/**
 * Unit tests for the WS-4.3 ontology object-level security marking model —
 * normalization, clearance, property masking (CLS analogue), row visibility
 * (RLS analogue), instance securing, and action ACL. Pure — no I/O.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeObjectSecurity, normalizeGroupRef, isCleared, objectTypeSecurity,
  actionSecurity, hasAnyMarkings, maskProperties, isRowVisible, secureInstances,
  isActionAllowed,
} from '../object-security';

describe('normalizeGroupRef', () => {
  it('accepts a bare id string, {id}, {objectId}, {id,displayName}', () => {
    expect(normalizeGroupRef('g1')).toEqual({ id: 'g1' });
    expect(normalizeGroupRef({ id: 'g1', displayName: 'Team' })).toEqual({ id: 'g1', name: 'Team' });
    expect(normalizeGroupRef({ objectId: 'g2' })).toEqual({ id: 'g2' });
    expect(normalizeGroupRef({})).toBeNull();
    expect(normalizeGroupRef('  ')).toBeNull();
  });
});

describe('normalizeObjectSecurity', () => {
  it('coerces a persisted config, dedupes groups, drops invalid entries', () => {
    const cfg = normalizeObjectSecurity({
      objectTypes: [
        { objectType: 'Customer', propertyMarkings: [{ property: 'ssn', allowGroups: ['g1', 'g1', { id: 'g2' }] }], rowMarking: { markingProperty: 'tier', clearances: [{ value: 'secret', allowGroups: ['g3'] }, { value: 'secret', allowGroups: ['g9'] }] } },
        { propertyMarkings: [] }, // no objectType → dropped
      ],
      actions: [{ action: 'delete', allowGroups: ['g4'] }, { allowGroups: [] }],
    });
    expect(cfg.objectTypes).toHaveLength(1);
    expect(cfg.objectTypes![0].propertyMarkings![0].allowGroups).toEqual([{ id: 'g1' }, { id: 'g2' }]);
    // duplicate clearance value collapsed to the first
    expect(cfg.objectTypes![0].rowMarking!.clearances).toHaveLength(1);
    expect(cfg.actions).toHaveLength(1);
    expect(hasAnyMarkings(cfg)).toBe(true);
    expect(hasAnyMarkings({})).toBe(false);
  });
});

describe('isCleared', () => {
  it('empty allow-list is unrestricted; else requires group intersection', () => {
    expect(isCleared([], [])).toBe(true);
    expect(isCleared([], [{ id: 'g1' }])).toBe(false);
    expect(isCleared(['g1'], [{ id: 'g1' }])).toBe(true);
    expect(isCleared(['gX'], [{ id: 'g1' }, { id: 'g2' }])).toBe(false);
    expect(isCleared(['g2', 'gX'], [{ id: 'g1' }, { id: 'g2' }])).toBe(true);
  });
});

const cfg = normalizeObjectSecurity({
  objectTypes: [{
    objectType: 'Customer',
    propertyMarkings: [{ property: 'ssn', allowGroups: [{ id: 'g-pii' }] }],
    rowMarking: { markingProperty: 'tier', clearances: [{ value: 'secret', allowGroups: [{ id: 'g-secret' }] }] },
  }],
  actions: [{ action: 'purge', allowGroups: [{ id: 'g-admin' }] }],
});
const sec = objectTypeSecurity(cfg, 'Customer');

describe('maskProperties (CLS analogue)', () => {
  const props = { name: 'A', ssn: '111', tier: 'public' };
  it('drops the gated value for an uncleared caller and reports it', () => {
    const m = maskProperties(sec, ['g-other'], props);
    expect(m.properties.ssn).toBeUndefined();
    expect(m.properties.name).toBe('A');
    expect(m.maskedProperties).toEqual(['ssn']);
  });
  it('keeps the value for a cleared caller', () => {
    const m = maskProperties(sec, ['g-pii'], props);
    expect(m.properties.ssn).toBe('111');
    expect(m.maskedProperties).toEqual([]);
  });
  it('bypass sees everything', () => {
    const m = maskProperties(sec, [], props, true);
    expect(m.properties.ssn).toBe('111');
  });
});

describe('isRowVisible (RLS analogue)', () => {
  it('hides a secret row from an uncleared caller, shows it to a cleared one', () => {
    expect(isRowVisible(sec, ['g-other'], { tier: 'secret' })).toBe(false);
    expect(isRowVisible(sec, ['g-secret'], { tier: 'secret' })).toBe(true);
  });
  it('an unlisted marking value is visible by default', () => {
    expect(isRowVisible(sec, ['g-other'], { tier: 'public' })).toBe(true);
  });
  it('hideUnclassified hides an unlisted value from non-bypass callers', () => {
    const strict = objectTypeSecurity(normalizeObjectSecurity({
      objectTypes: [{ objectType: 'Customer', rowMarking: { markingProperty: 'tier', clearances: [{ value: 'secret', allowGroups: [{ id: 'g-secret' }] }], hideUnclassified: true } }],
    }), 'Customer');
    expect(isRowVisible(strict, ['g-other'], { tier: 'public' })).toBe(false);
    expect(isRowVisible(strict, ['g-other'], { tier: 'public' }, true)).toBe(true); // bypass
  });
});

describe('secureInstances', () => {
  const insts = [
    { id: '1', objectType: 'Customer', properties: { name: 'A', ssn: '111', tier: 'public' } },
    { id: '2', objectType: 'Customer', properties: { name: 'B', ssn: '222', tier: 'secret' } },
  ];
  it('filters the secret row and masks ssn for an uncleared caller', () => {
    const r = secureInstances(sec, ['g-other'], insts);
    expect(r.objects).toHaveLength(1);
    expect(r.objects[0].id).toBe('1');
    expect(r.objects[0].properties.ssn).toBeUndefined();
    expect(r.objects[0].maskedProperties).toEqual(['ssn']);
    expect(r.filteredCount).toBe(1);
    expect(r.restricted).toBe(true);
  });
  it('a fully-cleared caller sees all rows + properties, restricted=false', () => {
    const r = secureInstances(sec, ['g-pii', 'g-secret'], insts);
    expect(r.objects).toHaveLength(2);
    expect(r.objects[1].properties.ssn).toBe('222');
    expect(r.restricted).toBe(false);
  });
});

describe('isActionAllowed', () => {
  it('gates a marked action but allows an unmarked one', () => {
    expect(isActionAllowed(cfg, 'purge', ['g-other'])).toBe(false);
    expect(isActionAllowed(cfg, 'purge', ['g-admin'])).toBe(true);
    expect(isActionAllowed(cfg, 'create', ['g-other'])).toBe(true); // unmarked
    expect(isActionAllowed(cfg, 'purge', [], true)).toBe(true); // bypass
    expect(actionSecurity(cfg, 'purge')?.allowGroups[0].id).toBe('g-admin');
  });
});
