/**
 * LU-5 — governance-overlay MODEL tests.
 *
 * The bugs these are written to catch (per test, in order):
 *   1. identity drift between the overlay and unified-lineage — an overlay row
 *      that no longer joins to its lineage node / Purview asset.
 *   2. a governed tag accepting a value outside its vocabulary (the whole point
 *      of "governed"), or rejecting a legitimate case-variant.
 *   3. free tags being wrongly forced through the vocabulary gate.
 *   4. tag upsert losing a prior tag, or duplicating one on case change.
 *   5. certification silently accepting a bogus rung, or forgetting the signer.
 *   6. attribute values persisting under ids no attribute group defines
 *      (orphans the wizards would never render).
 *   7. the mutation reducer mutating its input (React/state aliasing bugs).
 *   8. the Purview projection putting a governed tag in business metadata (it
 *      must be a classification) or emitting an Atlas-illegal typedef name.
 */
import { describe, it, expect } from 'vitest';
import {
  applyOverlayMutation, assertValidFullName, atlasSafeName, defaultSecurableType,
  emptyOverlay, findGovernedTag, normalizeGovernedTagDefs, overlayIdentity,
  projectOverlayToPurview, ucColumnIdentity, ucSecurableIdentity, UcOverlayError,
  validateGovernedTagDefs, validateTagAssignment,
  type UcGovernedTagDef,
} from '../model';
import { ucIdentity, columnIdentity } from '@/lib/azure/unified-lineage';
import type { AttributeGroup } from '@/lib/types/attribute-groups';

const VOCAB: UcGovernedTagDef[] = [
  { key: 'data-sensitivity', allowedValues: ['Public', 'Internal', 'Restricted'] },
  { key: 'pii', description: 'Contains personal data', allowedValues: ['yes', 'no'] },
];

const GROUPS: AttributeGroup[] = [
  {
    id: 'finance',
    name: 'Finance',
    attributes: [
      { id: 'cost-center', name: 'Cost center', fieldType: 'Text' },
      { id: 'tier', name: 'Tier', fieldType: 'Single choice', choices: ['gold', 'silver'] },
    ],
  },
];

function base() {
  return emptyOverlay({ tenantId: 't1', fullName: 'Main.Sales.Orders', now: '2026-07-28T00:00:00.000Z' });
}

describe('identity — pinned to unified-lineage (drift guard)', () => {
  it('ucSecurableIdentity produces the SAME string as unified-lineage.ucIdentity', () => {
    for (const n of ['main.sales.orders', 'Main.Sales.Orders', 'MAIN.BRONZE.customers_v2']) {
      expect(ucSecurableIdentity(n)).toBe(ucIdentity(n));
    }
  });

  it('ucColumnIdentity produces the SAME string as unified-lineage.columnIdentity', () => {
    expect(ucColumnIdentity('main.sales.orders', 'Email'))
      .toBe(columnIdentity('main.sales.orders', 'Email'));
    expect(ucColumnIdentity('Main.Sales.Orders', 'EMAIL'))
      .toBe(columnIdentity('Main.Sales.Orders', 'EMAIL'));
  });

  it('overlayIdentity routes to the column form only when a column is given', () => {
    expect(overlayIdentity('main.sales.orders')).toBe('uc:main.sales.orders');
    expect(overlayIdentity('main.sales.orders', 'email')).toBe('col:uc:main.sales.orders::email');
  });

  it('rejects a fullName that would break the Cosmos id', () => {
    expect(() => assertValidFullName('main/sales.orders')).toThrow(UcOverlayError);
    expect(() => assertValidFullName('  ')).toThrow(/required/);
  });

  it('defaultSecurableType follows the dotted arity', () => {
    expect(defaultSecurableType('main')).toBe('catalog');
    expect(defaultSecurableType('main.sales')).toBe('schema');
    expect(defaultSecurableType('main.sales.orders')).toBe('table');
  });
});

describe('governed-tag vocabulary', () => {
  it('rejects a definition with no allowed values (an unenforceable "governed" tag)', () => {
    expect(validateGovernedTagDefs([{ key: 'pii', allowedValues: [] }]))
      .toMatch(/at least one allowed value/);
  });

  it('rejects duplicate keys and duplicate values', () => {
    expect(validateGovernedTagDefs([
      { key: 'pii', allowedValues: ['yes'] }, { key: 'PII', allowedValues: ['no'] },
    ])).toMatch(/duplicate governed tag key/);
    expect(validateGovernedTagDefs([{ key: 'pii', allowedValues: ['yes', 'Yes'] }]))
      .toMatch(/duplicate allowed value/);
  });

  it('accepts a well-formed vocabulary', () => {
    expect(validateGovernedTagDefs(VOCAB)).toBeNull();
  });

  it('normalizes keys to slugs and de-dupes values case-insensitively', () => {
    const [d] = normalizeGovernedTagDefs([{ key: 'Data Sensitivity', allowedValues: [' Public ', 'public', 'Internal'] }]);
    expect(d.key).toBe('data-sensitivity');
    expect(d.allowedValues).toEqual(['Public', 'Internal']);
  });

  it('findGovernedTag is case-insensitive', () => {
    expect(findGovernedTag(VOCAB, 'PII')?.key).toBe('pii');
    expect(findGovernedTag(VOCAB, 'unknown')).toBeUndefined();
  });
});

describe('validateTagAssignment — the controlled-vocabulary gate', () => {
  it('REJECTS a value outside a governed tag vocabulary', () => {
    expect(() => validateTagAssignment([{ key: 'data-sensitivity', value: 'Secret' }], VOCAB))
      .toThrow(/"Secret" is not an allowed value for governed tag "data-sensitivity"/);
  });

  it('REJECTS an empty value on a governed tag', () => {
    expect(() => validateTagAssignment([{ key: 'pii', value: '' }], VOCAB))
      .toThrow(/requires a value from its vocabulary/);
  });

  it('accepts a case-variant and restores the canonical casing', () => {
    const [t] = validateTagAssignment([{ key: 'DATA-SENSITIVITY', value: 'restricted' }], VOCAB);
    expect(t).toEqual({ key: 'data-sensitivity', value: 'Restricted', governed: true });
  });

  it('lets an ungoverned key through as a free-form tag', () => {
    const [t] = validateTagAssignment([{ key: 'cost-center', value: 'CC-42' }], VOCAB);
    expect(t).toEqual({ key: 'cost-center', value: 'CC-42', governed: false });
  });

  it('rejects an empty key', () => {
    expect(() => validateTagAssignment([{ key: '  ', value: 'x' }], VOCAB)).toThrow(/needs a key/);
  });
});

describe('applyOverlayMutation', () => {
  const ctx = { vocabulary: VOCAB, attributeGroups: GROUPS, actorUpn: 'ana@contoso.com', now: '2026-07-28T12:00:00.000Z' };

  it('upserts on key (case-insensitive) instead of duplicating, and keeps other tags', () => {
    const a = applyOverlayMutation(base(), { setTags: [{ key: 'pii', value: 'yes' }, { key: 'owner-team', value: 'sales' }] }, ctx);
    const b = applyOverlayMutation(a, { setTags: [{ key: 'PII', value: 'no' }] }, ctx);
    expect(b.tags).toHaveLength(2);
    expect(b.tags.find((t) => t.key === 'pii')!.value).toBe('no');
    expect(b.tags.find((t) => t.key === 'owner-team')!.value).toBe('sales');
  });

  it('removes a tag case-insensitively', () => {
    const a = applyOverlayMutation(base(), { setTags: [{ key: 'pii', value: 'yes' }] }, ctx);
    const b = applyOverlayMutation(a, { removeTagKeys: ['PII'] }, ctx);
    expect(b.tags).toHaveLength(0);
  });

  it('does NOT mutate the input overlay', () => {
    const original = base();
    const snapshot = JSON.parse(JSON.stringify(original));
    applyOverlayMutation(original, { setTags: [{ key: 'pii', value: 'yes' }] }, ctx);
    expect(original).toEqual(snapshot);
  });

  it('stamps the signer + timestamp when certifying, and clears them on none', () => {
    const certified = applyOverlayMutation(base(), { certification: { rung: 'certified', note: 'reviewed' } }, ctx);
    expect(certified.certification).toEqual({
      rung: 'certified', by: 'ana@contoso.com', at: ctx.now, note: 'reviewed',
    });
    const cleared = applyOverlayMutation(certified, { certification: { rung: 'none' } }, ctx);
    expect(cleared.certification.by).toBeUndefined();
    expect(cleared.certification.at).toBeUndefined();
  });

  it('rejects a bogus certification rung', () => {
    expect(() => applyOverlayMutation(base(), { certification: { rung: 'gold' as never } }, ctx))
      .toThrow(/certification rung must be one of/);
  });

  it('rejects an attribute id no attribute group defines', () => {
    expect(() => applyOverlayMutation(base(), { attributes: { 'not-a-field': 'x' } }, ctx))
      .toThrow(/unknown attribute "not-a-field"/);
  });

  it('merges known attributes and deletes on null/empty', () => {
    const a = applyOverlayMutation(base(), { attributes: { 'cost-center': 'CC-42', tier: 'gold' } }, ctx);
    expect(a.attributes).toEqual({ 'cost-center': 'CC-42', tier: 'gold' });
    const b = applyOverlayMutation(a, { attributes: { tier: null } }, ctx);
    expect(b.attributes).toEqual({ 'cost-center': 'CC-42' });
  });

  it('propagates the governed-tag rejection (the reducer does not bypass the gate)', () => {
    expect(() => applyOverlayMutation(base(), { setTags: [{ key: 'pii', value: 'maybe' }] }, ctx))
      .toThrow(/not an allowed value/);
  });
});

describe('projectOverlayToPurview', () => {
  const ctx = { vocabulary: VOCAB, attributeGroups: GROUPS, actorUpn: 'ana@contoso.com', now: '2026-07-28T12:00:00.000Z' };

  it('governed tags become Atlas CLASSIFICATIONS, free tags become business metadata', () => {
    const o = applyOverlayMutation(base(), {
      setTags: [{ key: 'data-sensitivity', value: 'Restricted' }, { key: 'cost center', value: 'CC-42' }],
    }, ctx);
    const p = projectOverlayToPurview(o);
    expect(p.classifications).toEqual(['Loom_data_sensitivity_Restricted']);
    expect(p.businessMetadata).toEqual({ cost_center: 'CC-42' });
  });

  it('certification rides along as business metadata with the signer', () => {
    const o = applyOverlayMutation(base(), { certification: { rung: 'certified' } }, ctx);
    const p = projectOverlayToPurview(o);
    expect(p.businessMetadata.loom_certification).toBe('certified');
    expect(p.businessMetadata.loom_certified_by).toBe('ana@contoso.com');
    expect(p.classifications).toEqual([]);
  });

  it('emits only Atlas-legal typedef names', () => {
    expect(atlasSafeName('data sensitivity/level!')).toBe('data_sensitivity_level');
    const o = applyOverlayMutation(base(), { setTags: [{ key: 'pii', value: 'yes' }] }, ctx);
    for (const c of projectOverlayToPurview(o).classifications) {
      expect(c).toMatch(/^[A-Za-z0-9_]+$/);
    }
  });

  it('an untouched overlay projects to nothing (so the sync short-circuits honestly)', () => {
    const p = projectOverlayToPurview(base());
    expect(p.classifications).toEqual([]);
    expect(p.businessMetadata).toEqual({});
  });
});
