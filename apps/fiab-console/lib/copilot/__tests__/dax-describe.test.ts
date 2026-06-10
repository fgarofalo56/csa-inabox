import { describe, it, expect } from 'vitest';
import { parseDescribeJson } from '../dax-describe';

describe('parseDescribeJson', () => {
  it('parses the {"measures":[...]} shape', () => {
    const raw = JSON.stringify({
      measures: [
        { name: 'Total Sales', description: 'Sum of sales amount across all rows.' },
        { name: 'YoY Growth', description: 'Year-over-year revenue growth percentage.' },
      ],
    });
    const out = parseDescribeJson(raw);
    expect(out).toEqual([
      { name: 'Total Sales', description: 'Sum of sales amount across all rows.' },
      { name: 'YoY Growth', description: 'Year-over-year revenue growth percentage.' },
    ]);
  });

  it('parses the {"tables":[...]} shape', () => {
    const raw = '{"tables":[{"name":"dbo.Sales","description":"Fact table at order-line grain."}]}';
    expect(parseDescribeJson(raw)).toEqual([
      { name: 'dbo.Sales', description: 'Fact table at order-line grain.' },
    ]);
  });

  it('parses a bare array', () => {
    const raw = '[{"name":"A","description":"desc a"}]';
    expect(parseDescribeJson(raw)).toEqual([{ name: 'A', description: 'desc a' }]);
  });

  it('tolerates a code fence the model adds despite json mode', () => {
    const raw = '```json\n{"measures":[{"name":"M","description":"d"}]}\n```';
    expect(parseDescribeJson(raw)).toEqual([{ name: 'M', description: 'd' }]);
  });

  it('drops entries missing a name or description and trims', () => {
    const raw = JSON.stringify({
      measures: [
        { name: '  Good ', description: '  ok  ' },
        { name: 'NoDesc' },
        { description: 'orphan' },
        { name: '', description: 'empty name' },
      ],
    });
    expect(parseDescribeJson(raw)).toEqual([{ name: 'Good', description: 'ok' }]);
  });

  it('dedupes by name (first wins)', () => {
    const raw = JSON.stringify({
      measures: [
        { name: 'X', description: 'first' },
        { name: 'X', description: 'second' },
      ],
    });
    expect(parseDescribeJson(raw)).toEqual([{ name: 'X', description: 'first' }]);
  });

  it('returns [] for malformed JSON (never throws)', () => {
    expect(parseDescribeJson('not json at all')).toEqual([]);
    expect(parseDescribeJson('')).toEqual([]);
    expect(parseDescribeJson('{"measures": "nope"}')).toEqual([]);
  });
});
