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
  emptyOverlay, findGovernedTag, hasPurviewResidue, isEmptyOverlay, normalizeGovernedTagDefs,
  normalizeUcIdentity, overlayIdentity, projectOverlayToPurview, tenantTypedefPrefix,
  ucColumnIdentity, ucSecurableIdentity, UcOverlayError, validateAttributeValues,
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
    // The real join key routes the table through `normalizeIdentity`, which only
    // prefixes `uc:` for EXACTLY three dot-parts. An unconditional `uc:` prefix
    // diverges for every other shape, so the pin has to span the arities — the
    // 3-part-only version of this test could not see the divergence at all.
    const names = [
      'main.sales.orders', 'Main.Sales.Orders', 'MAIN.BRONZE.customers_v2',
      'main', 'Main.Sales', 'main.sales.orders.v2', 'main.sales.orders ',
    ];
    for (const n of names) {
      for (const col of ['Email', 'EMAIL', 'order_id']) {
        expect(ucColumnIdentity(n, col)).toBe(columnIdentity(n.trim(), col));
      }
    }
    // `normalizeIdentity` also maps storage/JDBC URLs to `path:…`, which the
    // overlay can never produce — `assertValidFullName` rejects anything with
    // `/ \ ? #` before an identity is built. That boundary is asserted, so the
    // narrower pure restatement is complete for every input that can reach it.
    expect(() => assertValidFullName('abfss://c@a.dfs.core.windows.net/x')).toThrow(UcOverlayError);
    expect(() => assertValidFullName('mssql://host/db')).toThrow(UcOverlayError);
  });

  it('normalizeUcIdentity restates unified-lineage.normalizeIdentity for bare UC names', () => {
    expect(normalizeUcIdentity('Main.Sales.Orders')).toBe('uc:main.sales.orders');
    expect(normalizeUcIdentity('main.sales')).toBe('main.sales');   // NOT uc:-prefixed
    expect(normalizeUcIdentity('main')).toBe('main');
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

  it('ATTACK on provenance: editing only the NOTE does not transfer the attestation', () => {
    // The "Save note" button re-posts the CURRENT rung. Re-stamping by/at on
    // every non-none write silently makes the last note-editor the certifier.
    const certified = applyOverlayMutation(base(), { certification: { rung: 'certified' } }, ctx);
    const laterCtx = { ...ctx, actorUpn: 'mallory@contoso.com', now: '2027-01-01T00:00:00.000Z' };
    const noteEdited = applyOverlayMutation(certified, { certification: { rung: 'certified', note: 'lgtm' } }, laterCtx);
    expect(noteEdited.certification.by).toBe('ana@contoso.com');
    expect(noteEdited.certification.at).toBe(ctx.now);
    expect(noteEdited.certification.note).toBe('lgtm');
  });

  it('but MOVING the rung does re-stamp the signer', () => {
    const certified = applyOverlayMutation(base(), { certification: { rung: 'certified' } }, ctx);
    const laterCtx = { ...ctx, actorUpn: 'bob@contoso.com', now: '2027-01-01T00:00:00.000Z' };
    const promoted = applyOverlayMutation(certified, { certification: { rung: 'promoted' } }, laterCtx);
    expect(promoted.certification.by).toBe('bob@contoso.com');
    expect(promoted.certification.at).toBe(laterCtx.now);
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
  const T1 = tenantTypedefPrefix('t1');

  it('governed tags become Atlas CLASSIFICATIONS, free tags become business metadata', () => {
    const o = applyOverlayMutation(base(), {
      setTags: [{ key: 'data-sensitivity', value: 'Restricted' }, { key: 'cost center', value: 'CC-42' }],
    }, ctx);
    const p = projectOverlayToPurview(o);
    expect(p.classifications).toEqual([`Loom_${T1}_data_sensitivity_Restricted`]);
    expect(p.businessMetadata.cost_center).toBe('CC-42');
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
      expect(c.length).toBeLessThanOrEqual(96);
    }
  });

  it('an untouched overlay projects no classifications and a de-certified TOMBSTONE', () => {
    // `loom_certification: none` is emitted deliberately — omitting it is what
    // left a stale `certified` label on the Atlas entity forever.
    const p = projectOverlayToPurview(base());
    expect(p.classifications).toEqual([]);
    expect(p.businessMetadata.loom_certification).toBe('none');
    expect(p.businessMetadata.loom_certified_by).toBe('');
  });

  it('ATTACK: one tenant cannot squat another tenant’s account-global typedef name', () => {
    const o = applyOverlayMutation(base(), { setTags: [{ key: 'pii', value: 'yes' }] }, ctx);
    const other = projectOverlayToPurview({ ...o, tenantId: 'tenant-two' });
    expect(projectOverlayToPurview(o).classifications[0])
      .not.toBe(other.classifications[0]);
    expect(tenantTypedefPrefix('t1')).toMatch(/^[0-9a-f]{8}$/);
    expect(tenantTypedefPrefix('t1')).toBe(tenantTypedefPrefix('t1')); // stable
  });

  it('ATTACK: colliding free-tag keys are REFUSED, not silently last-writer-wins', () => {
    const o = {
      ...base(),
      tags: [
        { key: 'cost center', value: 'A', governed: false },
        { key: 'cost-center', value: 'B', governed: false },
      ],
    };
    expect(() => projectOverlayToPurview(o)).toThrow(/both normalize to the Purview attribute "cost_center"/);
  });

  it('ATTACK: a key that normalizes to nothing is refused, not written under the literal name "tag"', () => {
    const o = { ...base(), tags: [{ key: '???', value: 'x', governed: false }] };
    expect(() => projectOverlayToPurview(o)).toThrow(/normalizes to an empty name/);
  });
});

describe('validateAttributeValues — typed + bounded (the attribute half of the vocabulary thesis)', () => {
  it('ATTACK: a value outside a Single choice is refused, exactly like a governed tag', () => {
    expect(() => validateAttributeValues({ tier: 'platinum' }, GROUPS))
      .toThrow(/not an allowed value for attribute "Tier"/);
  });

  it('canonicalises choice casing', () => {
    expect(validateAttributeValues({ tier: 'GOLD' }, GROUPS)).toEqual({ tier: 'gold' });
  });

  it('ATTACK: unbounded strings and arrays are refused before they reach Cosmos', () => {
    expect(() => validateAttributeValues({ 'cost-center': 'x'.repeat(100_000) }, GROUPS))
      .toThrow(/too long/);
    const many: Record<string, string> = {};
    for (let i = 0; i < 500; i++) many[`k${i}`] = 'v';
    expect(() => validateAttributeValues(many, GROUPS)).toThrow(/too many attributes/);
  });

  it('ATTACK: a non-object body is refused rather than cast', () => {
    expect(() => validateAttributeValues('nope', GROUPS)).toThrow(/must be an object/);
    expect(() => validateAttributeValues(['a'], GROUPS)).toThrow(/must be an object/);
  });

  it('ATTACK: the wrong JS type for a field is refused', () => {
    const typed: AttributeGroup[] = [{
      id: 'g', name: 'G', attributes: [
        { id: 'flag', name: 'Flag', fieldType: 'Boolean' },
        { id: 'count', name: 'Count', fieldType: 'Integer' },
        { id: 'when', name: 'When', fieldType: 'Date' },
        { id: 'many', name: 'Many', fieldType: 'Multiple choice', choices: ['a', 'b'] },
      ],
    }];
    expect(() => validateAttributeValues({ flag: { deep: { deeper: 1 } } }, typed)).toThrow(/Boolean/);
    expect(() => validateAttributeValues({ count: 1.5 }, typed)).toThrow(/Integer/);
    expect(() => validateAttributeValues({ when: 'not-a-date' }, typed)).toThrow(/Date/);
    expect(() => validateAttributeValues({ many: 'a' }, typed)).toThrow(/Multiple choice/);
    expect(() => validateAttributeValues({ many: ['c'] }, typed)).toThrow(/not an allowed value/);
    expect(validateAttributeValues({ many: ['A', 'b'] }, typed)).toEqual({ many: ['a', 'b'] });
  });

  it('empty / null clear the value', () => {
    expect(validateAttributeValues({ tier: null, 'cost-center': '' }, GROUPS))
      .toEqual({ tier: null, 'cost-center': null });
  });
});

describe('isEmptyOverlay / hasPurviewResidue (the delete rule)', () => {
  it('an untouched overlay is empty; any single fact makes it non-empty', () => {
    expect(isEmptyOverlay(base())).toBe(true);
    expect(isEmptyOverlay({ ...base(), tags: [{ key: 'a', value: 'b' }] })).toBe(false);
    expect(isEmptyOverlay({ ...base(), certification: { rung: 'promoted' } })).toBe(false);
    expect(isEmptyOverlay({ ...base(), attributes: { tier: 'gold' } })).toBe(false);
  });

  it('residue is a CLASSIFICATION or a real business-metadata key — not the mere presence of a stamp', () => {
    expect(hasPurviewResidue(base())).toBe(false);
    expect(hasPurviewResidue({ ...base(), purview: { guid: 'g', syncedAt: 'x' } })).toBe(false);
    expect(hasPurviewResidue({ ...base(), purview: { businessMetadataKeys: ['loom_certification'] } })).toBe(false);
    expect(hasPurviewResidue({ ...base(), purview: { classifications: ['Loom_x_pii_yes'] } })).toBe(true);
    expect(hasPurviewResidue({ ...base(), purview: { businessMetadataKeys: ['cost_center'] } })).toBe(true);
  });
});
