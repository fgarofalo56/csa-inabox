/**
 * dax-parser.test.ts — exhaustive unit tests for the A1 DAX tokenizer + parser.
 *
 * A1 is a PURE front end: no surface behavior changes. These tests pin the token
 * stream and AST shape the A2/A3 SQL-fold planner will consume, including the
 * exact DAX queries the UI already emits (SUMMARIZECOLUMNS / COUNTROWS /
 * DISTINCTCOUNT / DEFINE MEASURE … EVALUATE ROW) that the current 3-regex
 * translator rejects.
 */
import { describe, it, expect } from 'vitest';
import {
  tokenize, DaxLexError,
  parseDax, parseDaxExpression, DaxParseError,
  type Expr, type Query, type FunctionCall, type Binary,
} from '../dax';

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

describe('dax tokenizer', () => {
  const types = (s: string) => tokenize(s).map((t) => t.type);
  const vals = (s: string) => tokenize(s).map((t) => t.value);

  it('lexes numbers incl. decimals, leading-dot and exponents', () => {
    expect(tokenize('123')[0]).toMatchObject({ type: 'number', num: 123 });
    expect(tokenize('1.5')[0]).toMatchObject({ type: 'number', num: 1.5 });
    expect(tokenize('.5')[0]).toMatchObject({ type: 'number', num: 0.5 });
    expect(tokenize('1.2E-3')[0]).toMatchObject({ type: 'number', num: 0.0012 });
  });

  it('lexes strings with "" escapes', () => {
    expect(tokenize('"hello"')[0]).toMatchObject({ type: 'string', value: 'hello' });
    expect(tokenize('"a""b"')[0]).toMatchObject({ type: 'string', value: 'a"b' });
  });

  it('lexes bracketed columns and quoted tables with escapes', () => {
    expect(tokenize('[Amount Due]')[0]).toMatchObject({ type: 'bracket', value: 'Amount Due' });
    expect(tokenize('[a]]b]')[0]).toMatchObject({ type: 'bracket', value: 'a]b' });
    expect(tokenize("'Fact Sales'")[0]).toMatchObject({ type: 'quoted', value: 'Fact Sales' });
    expect(tokenize("'O''Brien'")[0]).toMatchObject({ type: 'quoted', value: "O'Brien" });
  });

  it('lexes two-char and one-char operators', () => {
    expect(vals('a <= b <> c && d || e')).toEqual(['a', '<=', 'b', '<>', 'c', '&&', 'd', '||', 'e', '']);
  });

  it('skips // -- and block comments', () => {
    expect(types('1 // c\n+ 2')).toEqual(['number', 'op', 'number', 'eof']);
    expect(types('1 -- c\n+ 2')).toEqual(['number', 'op', 'number', 'eof']);
    expect(types('1 /* c */ + 2')).toEqual(['number', 'op', 'number', 'eof']);
  });

  it('throws on unterminated constructs', () => {
    expect(() => tokenize('"oops')).toThrow(DaxLexError);
    expect(() => tokenize('[oops')).toThrow(DaxLexError);
    expect(() => tokenize("'oops")).toThrow(DaxLexError);
    expect(() => tokenize('1 @ 2')).toThrow(DaxLexError);
  });
});

// ---------------------------------------------------------------------------
// Expression parsing
// ---------------------------------------------------------------------------

describe('dax expression parsing', () => {
  it('parses column refs and bare table refs', () => {
    expect(parseDaxExpression('Sales[Amount]')).toEqual({ type: 'ColumnRef', table: 'Sales', column: 'Amount' });
    expect(parseDaxExpression("'Fact Sales'[Amount]")).toEqual({ type: 'ColumnRef', table: 'Fact Sales', column: 'Amount' });
    expect(parseDaxExpression('Sales')).toEqual({ type: 'TableRef', name: 'Sales' });
    expect(parseDaxExpression('[Total Sales]')).toEqual({ type: 'MeasureRef', name: 'Total Sales' });
  });

  it('parses literals', () => {
    expect(parseDaxExpression('42')).toEqual({ type: 'NumberLiteral', value: 42 });
    expect(parseDaxExpression('"hi"')).toEqual({ type: 'StringLiteral', value: 'hi' });
    expect(parseDaxExpression('TRUE')).toEqual({ type: 'BooleanLiteral', value: true });
    expect(parseDaxExpression('FALSE')).toEqual({ type: 'BooleanLiteral', value: false });
    expect(parseDaxExpression('BLANK()')).toEqual({ type: 'BlankLiteral' });
  });

  it('honours arithmetic precedence and left-associativity', () => {
    const e = parseDaxExpression('1 + 2 * 3') as Binary;
    expect(e.op).toBe('+');
    expect(e.left).toEqual({ type: 'NumberLiteral', value: 1 });
    expect((e.right as Binary).op).toBe('*');
  });

  it('binds unary minus tighter than +, looser than ^', () => {
    // -2^2 === -(2^2) in DAX
    const e = parseDaxExpression('-2 ^ 2');
    expect(e.type).toBe('Unary');
    expect(((e as any).operand as Binary).op).toBe('^');
  });

  it('makes ^ right-associative', () => {
    const e = parseDaxExpression('2 ^ 3 ^ 2') as Binary;
    expect(e.op).toBe('^');
    expect(e.left).toEqual({ type: 'NumberLiteral', value: 2 });
    expect((e.right as Binary).op).toBe('^'); // 3 ^ 2 grouped on the right
  });

  it('orders logical < comparison < concat < additive', () => {
    // a || b && c = a > 1  →  a || (b && (c = (a > 1)))
    const e = parseDaxExpression('a || b && c') as Binary;
    expect(e.op).toBe('||');
    expect((e.right as Binary).op).toBe('&&');
    const cmp = parseDaxExpression('x & y = z') as Binary;
    // '=' (30) binds looser than '&' (40): (x & y) = z
    expect(cmp.op).toBe('=');
    expect((cmp.left as Binary).op).toBe('&');
  });

  it('parses NOT and IN {set}', () => {
    const not = parseDaxExpression('NOT TRUE');
    expect(not).toMatchObject({ type: 'Unary', op: 'NOT' });
    const inExpr = parseDaxExpression("Sales[Region] IN { \"East\", \"West\" }") as Binary;
    expect(inExpr.op).toBe('IN');
    expect((inExpr.right as FunctionCall).name).toBe('__SET__');
    expect((inExpr.right as FunctionCall).args).toHaveLength(2);
  });

  it('parses nested function calls with mixed arg kinds', () => {
    const e = parseDaxExpression('CALCULATE(SUM(Sales[Amount]), FILTER(Sales, Sales[Amount] > 100))') as FunctionCall;
    expect(e.name).toBe('CALCULATE');
    expect(e.args).toHaveLength(2);
    expect((e.args[0] as FunctionCall).name).toBe('SUM');
    const filter = e.args[1] as FunctionCall;
    expect(filter.name).toBe('FILTER');
    expect(filter.args[0]).toEqual({ type: 'TableRef', name: 'Sales' });
    expect((filter.args[1] as Binary).op).toBe('>');
  });

  it('parses a zero-arg call', () => {
    expect(parseDaxExpression('NOW()')).toEqual({ type: 'FunctionCall', name: 'NOW', args: [] });
  });

  it('rejects trailing garbage and malformed input', () => {
    expect(() => parseDaxExpression('1 + ')).toThrow(DaxParseError);
    expect(() => parseDaxExpression('SUM(Sales[Amount]) extra')).toThrow(DaxParseError);
    expect(() => parseDaxExpression('CALCULATE(')).toThrow(DaxParseError);
  });
});

// ---------------------------------------------------------------------------
// Query parsing — the EVALUATE / DEFINE surface the fold planner consumes
// ---------------------------------------------------------------------------

describe('dax query parsing', () => {
  it('parses EVALUATE <Table>', () => {
    const q = parseDax('EVALUATE Sales');
    expect(q.defines).toEqual([]);
    expect(q.evaluate).toEqual({ type: 'TableRef', name: 'Sales' });
  });

  it('parses EVALUATE TOPN(5, Sales)', () => {
    const q = parseDax('EVALUATE TOPN(5, Sales)');
    const call = q.evaluate as FunctionCall;
    expect(call.name).toBe('TOPN');
    expect(call.args[0]).toEqual({ type: 'NumberLiteral', value: 5 });
    expect(call.args[1]).toEqual({ type: 'TableRef', name: 'Sales' });
  });

  it('parses EVALUATE ROW("Total", CALCULATE(SUM(Sales[Amount])))', () => {
    const q = parseDax('EVALUATE ROW("Total", CALCULATE(SUM(Sales[Amount])))');
    const row = q.evaluate as FunctionCall;
    expect(row.name).toBe('ROW');
    expect(row.args[0]).toEqual({ type: 'StringLiteral', value: 'Total' });
    const calc = row.args[1] as FunctionCall;
    expect(calc.name).toBe('CALCULATE');
    expect((calc.args[0] as FunctionCall).name).toBe('SUM');
  });

  it('parses the UI-emitted SUMMARIZECOLUMNS the regex translator rejects today', () => {
    const q = parseDax('EVALUATE SUMMARIZECOLUMNS(Customer[Region], "Amt", CALCULATE(SUM(Sales[Amount])))');
    const sc = q.evaluate as FunctionCall;
    expect(sc.name).toBe('SUMMARIZECOLUMNS');
    expect(sc.args[0]).toEqual({ type: 'ColumnRef', table: 'Customer', column: 'Region' });
    expect(sc.args[1]).toEqual({ type: 'StringLiteral', value: 'Amt' });
    expect((sc.args[2] as FunctionCall).name).toBe('CALCULATE');
  });

  it('parses COUNTROWS / DISTINCTCOUNT wrapped in ROW', () => {
    expect(((parseDax('EVALUATE ROW("R", COUNTROWS(Sales))').evaluate as FunctionCall).args[1] as FunctionCall).name).toBe('COUNTROWS');
    expect(((parseDax('EVALUATE ROW("D", DISTINCTCOUNT(Sales[CustomerId]))').evaluate as FunctionCall).args[1] as FunctionCall).name).toBe('DISTINCTCOUNT');
  });

  it('parses DEFINE MEASURE + VAR then EVALUATE', () => {
    const q: Query = parseDax(
      'DEFINE MEASURE Sales[YTD] = TOTALYTD(SUM(Sales[Amount]), \'Date\'[Date]) ' +
      'VAR threshold = 100 ' +
      'EVALUATE ROW("m", [YTD])',
    );
    expect(q.defines).toHaveLength(2);
    expect(q.defines[0]).toMatchObject({ type: 'MeasureDefinition', table: 'Sales', name: 'YTD' });
    expect((q.defines[0] as any).expression.name).toBe('TOTALYTD');
    expect(q.defines[1]).toMatchObject({ type: 'VarDefinition', name: 'threshold' });
    expect((q.evaluate as FunctionCall).name).toBe('ROW');
  });

  it('parses ORDER BY with directions', () => {
    const q = parseDax('EVALUATE Sales ORDER BY Sales[Amount] DESC, Sales[Date] ASC');
    expect(q.orderBy).toHaveLength(2);
    expect(q.orderBy[0]).toMatchObject({ direction: 'DESC' });
    expect(q.orderBy[0].expression).toEqual({ type: 'ColumnRef', table: 'Sales', column: 'Amount' });
    expect(q.orderBy[1]).toMatchObject({ direction: 'ASC' });
  });

  it('rejects a query without EVALUATE, and empty DEFINE', () => {
    expect(() => parseDax('Sales')).toThrow(DaxParseError);
    expect(() => parseDax('DEFINE EVALUATE Sales')).toThrow(DaxParseError);
    expect(() => parseDax('')).toThrow(DaxParseError);
  });

  it('round-trips a SUMX iterator body (A3 target)', () => {
    const q = parseDax('EVALUATE ROW("Rev", SUMX(Sales, Sales[Amount] * Sales[Quantity]))');
    const sumx = (q.evaluate as FunctionCall).args[1] as FunctionCall;
    expect(sumx.name).toBe('SUMX');
    expect(sumx.args[0]).toEqual({ type: 'TableRef', name: 'Sales' });
    expect((sumx.args[1] as Binary).op).toBe('*');
  });
});
