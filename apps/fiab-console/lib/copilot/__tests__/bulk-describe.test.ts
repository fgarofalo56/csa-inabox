import { describe, it, expect } from 'vitest';
import { parseDescribeReply } from '../describe-parse';

describe('parseDescribeReply', () => {
  it('parses the canonical { items: [...] } shape', () => {
    const out = parseDescribeReply('{"items":[{"name":"Total Revenue","description":"Sum of sales."}]}');
    expect(out).toEqual([{ name: 'Total Revenue', description: 'Sum of sales.' }]);
  });

  it('accepts the legacy { measures: [...] } shape', () => {
    const out = parseDescribeReply('{"measures":[{"name":"M1","description":"d1"}]}');
    expect(out).toEqual([{ name: 'M1', description: 'd1' }]);
  });

  it('accepts a bare array', () => {
    const out = parseDescribeReply('[{"name":"Fact.Amount","description":"The transaction amount."}]');
    expect(out).toEqual([{ name: 'Fact.Amount', description: 'The transaction amount.' }]);
  });

  it('trims descriptions and coerces names to strings', () => {
    const out = parseDescribeReply('{"items":[{"name":"X","description":"  padded  "}]}');
    expect(out).toEqual([{ name: 'X', description: 'padded' }]);
  });

  it('drops entries missing a name or description', () => {
    const out = parseDescribeReply('{"items":[{"name":"ok","description":"d"},{"name":"no-desc"},{"description":"no-name"}]}');
    expect(out).toEqual([{ name: 'ok', description: 'd' }]);
  });

  it('returns [] for non-JSON / empty', () => {
    expect(parseDescribeReply('not json')).toEqual([]);
    expect(parseDescribeReply('')).toEqual([]);
    expect(parseDescribeReply('{}')).toEqual([]);
  });
});
