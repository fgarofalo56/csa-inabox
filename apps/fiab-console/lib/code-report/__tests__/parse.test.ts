/**
 * parse.test.ts — golden + failure-mode coverage for the N16 code-report parser.
 *
 * The parser is the trust boundary for the whole item type (editor pre-check,
 * server render, and the `loom report validate` CI hook all run it), so it must
 * (a) fold a real document losslessly into the AST and (b) THROW on every
 * malformed shape — a silent pass here would let a broken dashboard merge.
 */
import { describe, it, expect } from 'vitest';
import {
  parseCodeReport,
  queryByName,
  assertReadOnlyQuery,
  engineDialect,
  CodeReportParseError,
  RawQueryUnsafeError,
  type MetricQueryDef,
  type RawQueryDef,
} from '../parse';

const GOLDEN = `# Revenue overview

Some **prose** describing the report.

\`\`\`sql loom revenue_by_month
metric: revenue
dimensions: order_month, region
grain: month
engine: synapse
filter: is_refund = 0
filter: region in West, East
\`\`\`

{line query=revenue_by_month x=order_month y=revenue title="Revenue by month"}

## Detail

\`\`\`sql top_products
SELECT product_name, SUM(amount) AS revenue
FROM analytics.sales
GROUP BY product_name
\`\`\`

{table query=top_products}
{bignumber query=top_products value=revenue label="Total"}
`;

describe('parseCodeReport — golden document', () => {
  const ast = parseCodeReport(GOLDEN);

  it('interleaves markdown, query, and visual nodes in document order', () => {
    const kinds = ast.nodes.map((n) => n.kind);
    expect(kinds).toEqual([
      'markdown', // title + prose
      'query',    // revenue_by_month
      'visual',   // line
      'markdown', // ## Detail
      'query',    // top_products
      'visual',   // table
      'visual',   // bignumber
    ]);
  });

  it('parses a metric block into a governed MetricQueryDef', () => {
    const q = queryByName(ast, 'revenue_by_month') as MetricQueryDef;
    expect(q.kind).toBe('metric');
    expect(q.metric).toBe('revenue');
    expect(q.dimensions).toEqual(['order_month', 'region']);
    expect(q.grain).toBe('month');
    expect(q.engine).toBe('synapse');
    // Two filters — a scalar equality (numeric-coerced) and an `in` list.
    expect(q.filters).toEqual([
      { dimension: 'is_refund', op: '=', value: 0 },
      { dimension: 'region', op: 'in', value: ['West', 'East'] },
    ]);
  });

  it('parses a raw block verbatim', () => {
    const q = queryByName(ast, 'top_products') as RawQueryDef;
    expect(q.kind).toBe('raw');
    expect(q.sql).toContain('SELECT product_name');
    expect(q.sql).toContain('GROUP BY product_name');
  });

  it('parses visual directives with attributes (quoted titles kept)', () => {
    const visuals = ast.nodes.filter((n) => n.kind === 'visual').map((n) => (n as any).visual);
    expect(visuals[0]).toMatchObject({ type: 'line', query: 'revenue_by_month', x: 'order_month', y: 'revenue', title: 'Revenue by month' });
    expect(visuals[1]).toMatchObject({ type: 'table', query: 'top_products' });
    expect(visuals[2]).toMatchObject({ type: 'bignumber', query: 'top_products', value: 'revenue', label: 'Total' });
  });

  it('keeps a non-sql fenced block inside markdown (not a query)', () => {
    const src = 'intro\n\n```mermaid\ngraph TD; A-->B;\n```\n\nafter';
    const a = parseCodeReport(src);
    expect(a.queries).toHaveLength(0);
    const md = a.nodes.map((n) => (n.kind === 'markdown' ? n.text : '')).join('\n');
    expect(md).toContain('```mermaid');
    expect(md).toContain('graph TD');
  });

  it('leaves a non-directive {…} line as markdown, not an error', () => {
    const a = parseCodeReport('text {not_a_visual foo=bar} more');
    expect(a.nodes.every((n) => n.kind === 'markdown')).toBe(true);
  });
});

describe('parseCodeReport — malformed inputs THROW (never silent-pass)', () => {
  const cases: Array<[string, string, RegExp]> = [
    ['unnamed sql block', '```sql\nSELECT 1\n```', /requires a name/],
    ['unnamed metric block', '```sql loom\nmetric: revenue\n```', /requires a name/],
    ['metric block missing metric:', '```sql loom m\ndimensions: a\n```', /missing a required "metric:"/],
    ['unknown metric key', '```sql loom m\nmetric: revenue\nbogus: x\n```', /unknown key "bogus"/],
    ['bad engine', '```sql loom m\nmetric: r\nengine: postgres\n```', /engine must be one of/],
    ['empty raw block', '```sql q\n\n```', /is empty/],
    ['duplicate query name', '```sql q\nSELECT 1\n```\n```sql q\nSELECT 2\n```', /duplicate query name/],
    ['unclosed fence', '```sql q\nSELECT 1', /unclosed/],
    ['visual missing query', '{table x=a}', /missing a query/],
    ['visual undefined query', '{table query=ghost}', /undefined query "ghost"/],
    ['chart missing axis', '```sql q\nSELECT 1\n```\n{bar query=q x=a}', /requires a y column/],
    ['bignumber missing value', '```sql q\nSELECT 1\n```\n{bignumber query=q}', /requires a value column/],
    ['typed visual missing type', '```sql q\nSELECT 1\n```\n{visual query=q}', /needs a type/],
    ['unknown visual attribute', '```sql q\nSELECT 1\n```\n{table query=q bogus=1}', /unknown attribute "bogus"/],
    ['bad filter predicate', '```sql loom m\nmetric: r\nfilter: not a predicate\n```', /not a "<dimension> <op> <value>"/],
  ];

  for (const [name, src, re] of cases) {
    it(`throws for: ${name}`, () => {
      expect(() => parseCodeReport(src)).toThrow(CodeReportParseError);
      expect(() => parseCodeReport(src)).toThrow(re);
    });
  }
});

describe('assertReadOnlyQuery — injection / mutation guard', () => {
  it('allows a single SELECT / WITH', () => {
    expect(() => assertReadOnlyQuery('SELECT * FROM t', 'synapse')).not.toThrow();
    expect(() => assertReadOnlyQuery('WITH c AS (SELECT 1 x) SELECT * FROM c', 'synapse')).not.toThrow();
    expect(() => assertReadOnlyQuery('SELECT 1;', 'synapse')).not.toThrow(); // one trailing ;
  });

  it('rejects mutating and stacked statements', () => {
    for (const bad of [
      'DELETE FROM t',
      'DROP TABLE t',
      'UPDATE t SET x=1',
      'INSERT INTO t VALUES (1)',
      'SELECT 1; DROP TABLE t',
      "SELECT 1; DELETE FROM t WHERE x='a'",
      'EXEC sp_who',
      'TRUNCATE TABLE t',
    ]) {
      expect(() => assertReadOnlyQuery(bad, 'synapse'), bad).toThrow(RawQueryUnsafeError);
    }
  });

  it('does not trip on a keyword inside a string literal', () => {
    expect(() => assertReadOnlyQuery("SELECT 'delete from here' AS note", 'synapse')).not.toThrow();
  });

  it('rejects KQL control commands but allows a query pipeline', () => {
    expect(() => assertReadOnlyQuery('.drop table t', 'kql')).toThrow(RawQueryUnsafeError);
    expect(() => assertReadOnlyQuery('Sales | summarize sum(amount)', 'kql')).not.toThrow();
  });

  it('maps engines to dialects', () => {
    expect(engineDialect('synapse')).toBe('synapse');
    expect(engineDialect('lakehouse')).toBe('synapse');
    expect(engineDialect('adx')).toBe('kql');
  });
});
