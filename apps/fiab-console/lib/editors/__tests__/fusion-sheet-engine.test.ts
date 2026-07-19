import { describe, it, expect } from 'vitest';
import { evaluateSheet, colToIndex, indexToCol, expandRange } from '../fusion-sheet-engine';

const val = (cells: Record<string, string>, ref: string) => evaluateSheet(cells)[ref].value;

describe('A1 addressing', () => {
  it('col <-> index round-trips', () => {
    expect(colToIndex('A')).toBe(0); expect(colToIndex('Z')).toBe(25); expect(colToIndex('AA')).toBe(26);
    expect(indexToCol(0)).toBe('A'); expect(indexToCol(26)).toBe('AA'); expect(indexToCol(701)).toBe('ZZ');
  });
  it('expandRange row-major', () => {
    expect(expandRange('A1', 'B2')).toEqual(['A1', 'B1', 'A2', 'B2']);
    expect(expandRange('B2', 'A1')).toEqual(['A1', 'B1', 'A2', 'B2']); // normalized
  });
});

describe('literals + arithmetic', () => {
  it('numbers and precedence', () => {
    expect(val({ A1: '=1+2*3' }, 'A1')).toBe(7);
    expect(val({ A1: '=(1+2)*3' }, 'A1')).toBe(9);
    expect(val({ A1: '=2^3^2' }, 'A1')).toBe(512); // right-assoc
    expect(val({ A1: '=-5+2' }, 'A1')).toBe(-3);
  });
  it('cell references', () => {
    expect(val({ A1: '10', B1: '=A1*2', C1: '=A1+B1' }, 'C1')).toBe(30);
  });
  it('string literal passthrough', () => {
    expect(val({ A1: 'hello' }, 'A1')).toBe('hello');
    expect(val({ A1: '=CONCAT("a", "b", 1)' }, 'A1')).toBe('ab1');
  });
});

describe('functions over ranges', () => {
  const sheet = { A1: '1', A2: '2', A3: '3', A4: '=SUM(A1:A3)', A5: '=AVG(A1:A3)', A6: '=MAX(A1:A3)', A7: '=MIN(A1:A3)', A8: '=COUNT(A1:A3)' };
  it('SUM/AVG/MIN/MAX/COUNT', () => {
    expect(val(sheet, 'A4')).toBe(6);
    expect(val(sheet, 'A5')).toBe(2);
    expect(val(sheet, 'A6')).toBe(3);
    expect(val(sheet, 'A7')).toBe(1);
    expect(val(sheet, 'A8')).toBe(3);
  });
  it('ROUND / ABS', () => {
    expect(val({ A1: '=ROUND(3.14159, 2)' }, 'A1')).toBe(3.14);
    expect(val({ A1: '=ABS(0-7)' }, 'A1')).toBe(7);
  });
});

describe('comparisons + IF', () => {
  it('comparison operators return booleans', () => {
    expect(val({ A1: '=1<2' }, 'A1')).toBe(true);
    expect(val({ A1: '=2=2' }, 'A1')).toBe(true);
    expect(val({ A1: '=1<>1' }, 'A1')).toBe(false);
  });
  it('IF branches', () => {
    expect(val({ A1: '10', B1: '=IF(A1>5, "big", "small")' }, 'B1')).toBe('big');
    expect(val({ A1: '2', B1: '=IF(A1>5, "big", "small")' }, 'B1')).toBe('small');
    expect(val({ A1: '5', B1: '=IF(A1>5, 1, 0)' }, 'B1')).toBe(0);
  });
});

describe('errors', () => {
  it('#DIV/0!', () => { expect(val({ A1: '=1/0' }, 'A1')).toBe('#DIV/0!'); });
  it('#CYCLE! on self/mutual reference', () => {
    expect(val({ A1: '=A1' }, 'A1')).toBe('#CYCLE!');
    const m = evaluateSheet({ A1: '=B1', B1: '=A1' });
    expect(m.A1.value).toBe('#CYCLE!');
    expect(m.A1.isError).toBe(true);
  });
  it('#NAME? on unknown function', () => { expect(val({ A1: '=BOGUS(1)' }, 'A1')).toBe('#NAME?'); });
  it('#VALUE! coercing a non-numeric string in arithmetic', () => { expect(val({ A1: 'abc', B1: '=A1+1' }, 'B1')).toBe('#VALUE!'); });
  it('#ERROR! on malformed formula', () => { expect(val({ A1: '=1+' }, 'A1')).toBe('#ERROR!'); });
});

describe('dependency ordering', () => {
  it('resolves a chain regardless of key order', () => {
    const s = { C1: '=B1+1', B1: '=A1+1', A1: '1' };
    const r = evaluateSheet(s);
    expect(r.A1.value).toBe(1); expect(r.B1.value).toBe(2); expect(r.C1.value).toBe(3);
  });
  it('memoizes shared dependencies (diamond)', () => {
    const s = { A1: '2', B1: '=A1*2', C1: '=A1*3', D1: '=B1+C1' };
    expect(val(s, 'D1')).toBe(10);
  });
});
