/**
 * F17 — pure-helper unit tests for the attribute-groups schema layer.
 * No Cosmos / network — exercises validation, required-attribute resolution,
 * and slug generation that the API route and admin UI both depend on.
 */
import { describe, it, expect } from 'vitest';
import {
  kebab,
  validateAttributes,
  missingRequiredAttributes,
  type AttributeDef,
  type AttributeGroupDoc,
} from '@/lib/types/attribute-groups';

function attr(p: Partial<AttributeDef>): AttributeDef {
  return { id: p.id || 'a1', name: p.name || 'Field', type: p.type || 'string', required: !!p.required, order: p.order ?? 0, enumValues: p.enumValues, description: p.description };
}

function group(attrs: AttributeDef[], domainIds: string[] = []): AttributeGroupDoc {
  return {
    id: 'attr-group:t:g', tenantId: 't', groupId: 'g', name: 'G', domainIds, attributes: attrs,
    createdAt: 'x', createdBy: 'u', updatedAt: 'x', updatedBy: 'u',
  };
}

describe('kebab', () => {
  it('slugifies display names', () => {
    expect(kebab('Data Governance')).toBe('data-governance');
    expect(kebab('  Mix3d & Match!  ')).toBe('mix3d-match');
  });
  it('falls back to "group" for empty input', () => {
    expect(kebab('!!!')).toBe('group');
    expect(kebab('')).toBe('group');
  });
});

describe('validateAttributes', () => {
  it('accepts a clean set', () => {
    expect(validateAttributes([
      attr({ id: 'a', name: 'Steward', type: 'string' }),
      attr({ id: 'b', name: 'Tier', type: 'enum', enumValues: ['Gold'] }),
    ])).toBeNull();
  });
  it('rejects a nameless attribute', () => {
    expect(validateAttributes([attr({ name: '  ' })])).toMatch(/name/i);
  });
  it('rejects an enum with no values', () => {
    expect(validateAttributes([attr({ name: 'Tier', type: 'enum', enumValues: [] })])).toMatch(/at least one/i);
  });
  it('rejects an unknown type', () => {
    expect(validateAttributes([attr({ name: 'X', type: 'bogus' as any })])).toMatch(/invalid/i);
  });
  it('rejects duplicate names case-insensitively', () => {
    expect(validateAttributes([
      attr({ id: 'a', name: 'Tier' }),
      attr({ id: 'b', name: 'tier' }),
    ])).toMatch(/duplicate/i);
  });
});

describe('missingRequiredAttributes', () => {
  const g = group([
    attr({ id: 'r', name: 'Classification', type: 'enum', required: true, enumValues: ['PII', 'Public'] }),
    attr({ id: 'o', name: 'Notes', type: 'string', required: false }),
  ]);

  it('reports a required attribute with no value', () => {
    expect(missingRequiredAttributes([g], {})).toEqual(['Classification']);
  });
  it('treats blank strings as missing', () => {
    expect(missingRequiredAttributes([g], { r: '   ' })).toEqual(['Classification']);
  });
  it('passes once the required value is set', () => {
    expect(missingRequiredAttributes([g], { r: 'PII' })).toEqual([]);
  });
  it('ignores optional attributes', () => {
    expect(missingRequiredAttributes([g], { r: 'Public' })).toEqual([]);
  });
});
