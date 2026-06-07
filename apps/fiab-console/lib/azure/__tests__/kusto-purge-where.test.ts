/**
 * buildPurgeWhere — guided GDPR purge predicate builder.
 *
 * Per no-vaporware.md, the claim "no freeform JSON; structured predicate parts
 * are validated and safely quoted" must be backed by a test. These exercise the
 * quoting rules + operator validation that the .purge route relies on before it
 * sends a command to the ADX Data Management endpoint.
 */
import { describe, it, expect } from 'vitest';
import { buildPurgeWhere, PURGE_ALLOWED_OPS, PurgePredicateError } from '@/lib/azure/kusto-purge-predicate';

describe('buildPurgeWhere', () => {
  it('quotes a string equality predicate and brackets the column', () => {
    expect(buildPurgeWhere([{ column: 'UserId', op: '==', value: 'user-42' }]))
      .toBe('where ["UserId"] == "user-42"');
  });

  it('emits numeric literals bare', () => {
    expect(buildPurgeWhere([{ column: 'Amount', op: '>=', value: '100' }]))
      .toBe('where ["Amount"] >= 100');
    expect(buildPurgeWhere([{ column: 'Ratio', op: '<', value: '-1.5e3' }]))
      .toBe('where ["Ratio"] < -1.5e3');
  });

  it('keeps a string RHS for contains / startswith even if numeric-looking', () => {
    expect(buildPurgeWhere([{ column: 'Phone', op: 'contains', value: '555' }]))
      .toBe('where ["Phone"] contains "555"');
    expect(buildPurgeWhere([{ column: 'Sku', op: 'startswith', value: 'AB' }]))
      .toBe('where ["Sku"] startswith "AB"');
  });

  it('joins multiple conditions with AND', () => {
    expect(buildPurgeWhere([
      { column: 'UserId', op: '==', value: 'u1' },
      { column: 'Region', op: '!=', value: 'EU' },
    ])).toBe('where ["UserId"] == "u1" and ["Region"] != "EU"');
  });

  it('escapes embedded double quotes in values and column names', () => {
    expect(buildPurgeWhere([{ column: 'Na"me', op: '==', value: 'a"b' }]))
      .toBe('where ["Na\\"me"] == "a\\"b"');
  });

  it('rejects an empty predicate list', () => {
    expect(() => buildPurgeWhere([])).toThrow(PurgePredicateError);
  });

  it('rejects an unsupported operator (no pipes / functions allowed)', () => {
    // `=~` is a real KQL op but not in the allow-list — must be refused.
    expect(() => buildPurgeWhere([{ column: 'x', op: '=~' as any, value: 'y' }])).toThrow(/Unsupported operator/);
  });

  it('rejects a blank column', () => {
    expect(() => buildPurgeWhere([{ column: '  ', op: '==', value: 'y' }])).toThrow(/column/);
  });

  it('exposes exactly the eight scalar comparison operators', () => {
    expect([...PURGE_ALLOWED_OPS]).toEqual(['==', '!=', '>', '<', '>=', '<=', 'contains', 'startswith']);
  });
});
