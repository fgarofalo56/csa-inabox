import { describe, it, expect } from 'vitest';
import {
  coerceSource, coerceDestination, coerceMapping, coerceSpec, validateForRun,
} from '../types';

describe('activation types — coercion (no freeform config)', () => {
  it('coerces a valid source and defaults an unknown kind to table', () => {
    expect(coerceSource({ kind: 'bogus', container: 'gold', path: 'seg/vip' }))
      .toEqual({ kind: 'table', container: 'gold', path: 'seg/vip' });
    expect(coerceSource({ container: '', path: 'x' })).toBeUndefined();
  });

  it('coerces each destination kind and rejects malformed ones', () => {
    expect(coerceDestination({ kind: 'dataverse', environmentId: 'e', entitySetName: 'contacts', keyAttribute: 'emailaddress1' }))
      .toMatchObject({ kind: 'dataverse', entitySetName: 'contacts' });
    expect(coerceDestination({ kind: 'dataverse', environmentId: 'e' })).toBeUndefined();
    expect(coerceDestination({ kind: 'webhook', url: 'http://insecure' })).toBeUndefined();
    expect(coerceDestination({ kind: 'webhook', url: 'https://ok/h' })).toEqual({ kind: 'webhook', url: 'https://ok/h' });
    expect(coerceDestination({ kind: 'service-bus', namespace: 'ns', entity: 'q' }))
      .toEqual({ kind: 'service-bus', namespace: 'ns', entity: 'q' });
    expect(coerceDestination({ kind: 'unknown' })).toBeUndefined();
  });

  it('sanitizes the mapping to trimmed source/target pairs', () => {
    expect(coerceMapping([{ source: ' a ', target: ' b ' }, { source: '', target: 'x' }, 'junk']))
      .toEqual([{ source: 'a', target: 'b' }]);
  });

  it('coerces a whole spec, dropping unknown fields and bounding runs', () => {
    const spec = coerceSpec({ mode: 'nope', mapping: 'x', evil: 1, runs: new Array(80).fill({ runId: 'r' }) });
    expect(spec.mode).toBe('full');
    expect(spec.mapping).toEqual([]);
    expect((spec as any).evil).toBeUndefined();
    expect(spec.runs!.length).toBe(50);
  });
});

describe('activation types — validateForRun', () => {
  it('requires source, destination, key, and mapping for Dataverse', () => {
    const errs = validateForRun({ mapping: [], mode: 'full' }, 'full');
    expect(errs.map((e) => e.field)).toContain('source');
    expect(errs.map((e) => e.field)).toContain('destination');
  });

  it('passes a complete Dataverse spec', () => {
    const errs = validateForRun({
      source: { kind: 'table', container: 'gold', path: 'seg/vip' },
      destination: { kind: 'dataverse', environmentId: 'e', entitySetName: 'contacts', keyAttribute: 'emailaddress1' },
      keyColumn: 'email',
      mapping: [{ source: 'email', target: 'emailaddress1' }],
      mode: 'incremental',
    }, 'incremental');
    expect(errs).toEqual([]);
  });

  it('requires a key column for an incremental non-Dataverse destination', () => {
    const errs = validateForRun({
      source: { kind: 'table', container: 'gold', path: 'seg/vip' },
      destination: { kind: 'webhook', url: 'https://h' },
      mapping: [],
      mode: 'incremental',
    }, 'incremental');
    expect(errs.map((e) => e.field)).toContain('keyColumn');
  });
});
