import { describe, it, expect } from 'vitest';
import { mergeDataProductPatch, type DataProductDoc } from '../store';
import { pickStepFields, STEP_FIELDS } from '../steps';

const base: DataProductDoc = {
  id: 'dp-1',
  governanceDomainId: 'finance',
  name: 'Customer 360',
  description: 'Unified customer view',
  type: 'Dataset',
  audience: ['Data analysts'],
  owners: ['owner@contoso.com'],
  endorsed: false,
  useCase: 'Churn modelling',
  customAttributes: { tier: 'gold' },
  status: 'Published',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  createdBy: 'admin@contoso.com',
  _etag: '"old"',
};

describe('pickStepFields — per-step PATCH body contains ONLY that step', () => {
  const state: Partial<DataProductDoc> = {
    name: 'Renamed',
    description: 'd',
    type: 'Dataset',
    audience: ['Data analysts'],
    owners: ['o@contoso.com'],
    endorsed: true,
    governanceDomainId: 'finance',
    useCase: 'uc',
    customAttributes: { tier: 'gold' },
  };

  it('basic step carries only Basic fields and NO Business fields', () => {
    const body = pickStepFields('basic', state);
    expect(Object.keys(body).sort()).toEqual([...STEP_FIELDS.basic].sort());
    expect('useCase' in body).toBe(false);
    expect('governanceDomainId' in body).toBe(false);
    expect('customAttributes' in body).toBe(false);
    expect(body.endorsed).toBe(true);
  });

  it('business step carries only Business fields and NO Basic fields', () => {
    const body = pickStepFields('business', state);
    expect(Object.keys(body).sort()).toEqual([...STEP_FIELDS.business].sort());
    expect('name' in body).toBe(false);
    expect('endorsed' in body).toBe(false);
  });

  it('custom step carries only customAttributes', () => {
    const body = pickStepFields('custom', state);
    expect(Object.keys(body)).toEqual(['customAttributes']);
  });

  it('omits undefined fields from the body', () => {
    const body = pickStepFields('basic', { name: 'only-name' });
    expect(Object.keys(body)).toEqual(['name']);
  });
});

describe('mergeDataProductPatch — partial merge leaves other steps untouched', () => {
  it('saving Basic does not change Business fields (useCase)', () => {
    const next = mergeDataProductPatch(base, { name: 'New name', endorsed: true });
    expect(next.name).toBe('New name');
    expect(next.endorsed).toBe(true);
    // Business field is preserved exactly.
    expect(next.useCase).toBe('Churn modelling');
    expect(next.governanceDomainId).toBe('finance');
  });

  it('never overwrites identity / system fields', () => {
    const next = mergeDataProductPatch(base, {
      // @ts-expect-error — id is not a patchable key; merge must ignore it.
      id: 'hacked',
      name: 'x',
    } as any);
    expect(next.id).toBe('dp-1');
    expect(next.createdAt).toBe(base.createdAt);
    expect(next.createdBy).toBe(base.createdBy);
    expect(next.governanceDomainId).toBe('finance');
  });

  it('bumps updatedAt', () => {
    const next = mergeDataProductPatch(base, { endorsed: true }, '2026-06-07T12:00:00.000Z');
    expect(next.updatedAt).toBe('2026-06-07T12:00:00.000Z');
  });

  it('toggling endorsed persists the flag', () => {
    expect(mergeDataProductPatch(base, { endorsed: true }).endorsed).toBe(true);
    expect(mergeDataProductPatch({ ...base, endorsed: true }, { endorsed: false }).endorsed).toBe(false);
  });
});
