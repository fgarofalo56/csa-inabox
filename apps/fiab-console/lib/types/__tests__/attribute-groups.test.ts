/**
 * F17 — pure-helper unit tests for the attribute-groups schema layer.
 * No Cosmos / network — exercises validation, required-attribute resolution,
 * and slug generation that the API route, admin UI, and wizards depend on.
 */
import { describe, it, expect } from 'vitest';
import {
  kebab,
  validateAttributes,
  missingRequiredAttributes,
  type AttributeDef,
  type AttributeGroup,
} from '@/lib/types/attribute-groups';

function attr(p: Partial<AttributeDef>): AttributeDef {
  return {
    id: p.id || 'a1',
    name: p.name || 'Field',
    fieldType: p.fieldType || 'Text',
    required: !!p.required,
    choices: p.choices,
    description: p.description,
  };
}

function group(attrs: AttributeDef[], domainIds: string[] = []): AttributeGroup {
  return { id: 'g', name: 'G', domainIds, attributes: attrs };
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
      attr({ id: 'a', name: 'Steward', fieldType: 'Text' }),
      attr({ id: 'b', name: 'Tier', fieldType: 'Single choice', choices: ['Gold'] }),
    ])).toBeNull();
  });
  it('rejects a nameless attribute', () => {
    expect(validateAttributes([attr({ name: '  ' })])).toMatch(/name/i);
  });
  it('rejects a choice attribute with no values', () => {
    expect(validateAttributes([attr({ name: 'Tier', fieldType: 'Single choice', choices: [] })])).toMatch(/at least one/i);
  });
  it('rejects an unknown field type', () => {
    expect(validateAttributes([attr({ name: 'X', fieldType: 'bogus' as any })])).toMatch(/invalid/i);
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
    attr({ id: 'r', name: 'Classification', fieldType: 'Single choice', required: true, choices: ['PII', 'Public'] }),
    attr({ id: 'o', name: 'Notes', fieldType: 'Text', required: false }),
  ]);

  it('reports a required attribute with no value', () => {
    expect(missingRequiredAttributes([g], {})).toEqual(['Classification']);
  });
  it('treats blank strings as missing', () => {
    expect(missingRequiredAttributes([g], { r: '   ' })).toEqual(['Classification']);
  });
  it('treats empty multi-choice arrays as missing', () => {
    expect(missingRequiredAttributes([g], { r: [] })).toEqual(['Classification']);
  });
  it('passes once the required value is set', () => {
    expect(missingRequiredAttributes([g], { r: 'PII' })).toEqual([]);
  });
  it('ignores optional attributes', () => {
    expect(missingRequiredAttributes([g], { r: 'Public' })).toEqual([]);
  });
});
