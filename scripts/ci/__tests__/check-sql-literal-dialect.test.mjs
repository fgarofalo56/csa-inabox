/**
 * Tests for scripts/ci/check-sql-literal-dialect.mjs.
 *
 * What breaks each test is stated at the test. The load-bearing ones:
 *   - "planted positive control": a Spark file with ONE escapeSqlLiteral( and an
 *     allowance of 0 must be reported. Breaks if the over-allowance arm or the
 *     escapeSqlLiteral shape is removed.
 *   - "emptied list over the real tree": with no entries, the real console tree
 *     must still produce named violations (shortcut-engines unlisted, kql-escape
 *     unlisted with a T-SQL escape). Breaks if population discovery is removed,
 *     i.e. if the guard only ever checks what the list already names.
 *   - "real tree is clean": the committed list matches the tree exactly. Breaks
 *     on any drift between the list and the code (in either direction).
 *
 * Every regex is imported from the guard, not transcribed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  countTsqlEscapes,
  evaluate,
  loadFiles,
  LIST_PATH,
  DEFINITION_FILE,
} from '../check-sql-literal-dialect.mjs';

const SPARK_OK = [
  "import { escapeSparkSqlLiteral } from '@/lib/sql/quoting';",
  'export const q = (v: string) => `SELECT * FROM t WHERE c = \'${escapeSparkSqlLiteral(v)}\'`;',
  '',
].join('\n');
const SPARK_ONE_TSQL = SPARK_OK + "export const bad = (v: string) => `'${escapeSqlLiteral(v)}'`;\n";
const P = 'apps/fiab-console/lib/x/spark-builder.ts';
const entry = (over = {}) => ({ path: P, engine: 'spark', tsqlEscapeAllowance: 0, reason: 'Databricks SQL', ...over });
const kinds = (v) => v.map((x) => `${x.kind} ${x.path}`);

test('countTsqlEscapes counts each T-SQL-rule shape once', () => {
  const src = [
    'a(escapeSqlLiteral(x));',
    "b(x.replace(/'/g, \"''\"));",
    'c(quoteLiteral(x));',
    'd(escapeLiteralFor(x));',
    '',
  ].join('\n');
  const r = countTsqlEscapes(src);
  // Breaks if any shape is dropped, or if the masker blanks regex-literal bodies
  // (the inline shape would then count 0).
  assert.equal(r.total, 4);
  assert.deepEqual(Object.values(r.byShape), [1, 1, 1, 1]);
});

test('countTsqlEscapes does not count dialect-carrying calls or comments', () => {
  const src = [
    "a(quoteLiteral(x, 'databricks-sql'));",
    'b(escapeLiteralFor(v, dialect));',
    '// escapeSqlLiteral(x) mentioned in prose',
    '/* x.replace(/\'/g, "\'\'") */',
    'c(escapeSqlLiteral(y));',
    '',
  ].join('\n');
  // Exactly the one live call. Breaks (count 2+) if comments stop being masked
  // or if the one-argument shapes start matching two-argument calls; breaks
  // (count 0) if the live call is missed.
  assert.equal(countTsqlEscapes(src).total, 1);
});

test('planted positive control: one escapeSqlLiteral in a Spark file at allowance 0 fails', () => {
  const v = evaluate({ sites: [entry()] }, new Map([[P, SPARK_ONE_TSQL]]));
  assert.deepEqual(kinds(v), [`over-allowance ${P}`]);
  assert.match(v[0].detail, /^1 T-SQL-rule escapes, allowance 0/);
});

test('negative control: the same file without the doubling passes', () => {
  // Paired with the positive control: pins that a dialect-correct file is clean,
  // so the positive result above is caused by the planted call, not the fixture.
  assert.deepEqual(evaluate({ sites: [entry()] }, new Map([[P, SPARK_OK]])), []);
});

test('stale allowance (count below allowance) fails', () => {
  const v = evaluate({ sites: [entry({ tsqlEscapeAllowance: 2 })] }, new Map([[P, SPARK_ONE_TSQL]]));
  assert.deepEqual(kinds(v), [`under-allowance ${P}`]);
  assert.match(v[0].detail, /lower the allowance to 1/);
});

test('a listed file that is missing fails', () => {
  assert.deepEqual(kinds(evaluate({ sites: [entry()] }, new Map())), [`missing-file ${P}`]);
});

test('a listed file reverted wholesale (no Spark helper left) fails', () => {
  const reverted = "import { escapeSqlLiteral } from '@/lib/sql/quoting';\nexport const q = (v: string) => `'${escapeSqlLiteral(v)}'`;\n";
  const v = evaluate({ sites: [entry({ tsqlEscapeAllowance: 1 })] }, new Map([[P, reverted]]));
  // The count matches the allowance (1 == 1), so only the helper check can see it.
  assert.deepEqual(kinds(v), [`no-dialect-helper ${P}`]);
});

test('an unlisted file that uses the Spark helper fails, even with zero T-SQL escapes', () => {
  assert.deepEqual(kinds(evaluate({ sites: [entry()] }, new Map([[P, SPARK_OK], ['apps/fiab-console/lib/y.ts', SPARK_OK]]))),
    ['unlisted-spark-kql apps/fiab-console/lib/y.ts']);
});

test('an unlisted kql-escape importer with a T-SQL escape fails; without one it passes', () => {
  const k = "import { kqlEscapeSingle } from '@/lib/azure/kql-escape';\nexport const a = (v: string) => kqlEscapeSingle(v);\n";
  const kBad = k + 'export const b = (v: string) => escapeSqlLiteral(v);\n';
  const base = [[P, SPARK_OK]];
  assert.deepEqual(kinds(evaluate({ sites: [entry()] }, new Map([...base, ['apps/fiab-console/lib/k.ts', kBad]]))),
    ['unlisted-tsql-escape apps/fiab-console/lib/k.ts']);
  assert.deepEqual(evaluate({ sites: [entry()] }, new Map([...base, ['apps/fiab-console/lib/k.ts', k]])), []);
});

test('malformed and duplicate entries fail', () => {
  const v = evaluate({ sites: [entry(), entry(), { path: 'a.ts', engine: 'tsql', tsqlEscapeAllowance: 0, reason: 'x' }] }, new Map([[P, SPARK_OK]]));
  assert.deepEqual(kinds(v).sort(), ['bad-entry a.ts', `duplicate-entry ${P}`].sort());
});

test('emptied list over the real tree reports named violations, not just "empty"', () => {
  const files = loadFiles();
  const v = evaluate({ sites: [] }, files);
  const k = kinds(v);
  assert.ok(k.includes('empty-list scripts/ci/sql-literal-dialect-sites.json'), k.join('\n'));
  // Population discovery, independent of the list. Breaks if the guard only
  // checks what the list names.
  assert.ok(k.includes('unlisted-spark-kql apps/fiab-console/lib/azure/shortcut-engines.ts'), k.join('\n'));
  assert.ok(k.includes('unlisted-tsql-escape apps/fiab-console/lib/azure/kql-escape.ts'), k.join('\n'));
  // One violation per listed file plus the empty-list row: every listed file is
  // discoverable without the list (m-script reaches the Spark rule only through
  // escapeLiteralFor, which is why that helper is in the population regex).
  const list = JSON.parse(fs.readFileSync(LIST_PATH, 'utf8'));
  assert.ok(k.includes('unlisted-spark-kql apps/fiab-console/lib/components/pipeline/dataflow/m-script.ts'), k.join('\n'));
  assert.equal(v.length, list.sites.length + 1, k.join('\n'));
});

test('real tree is clean against the committed list, and the definition file is out of scope', () => {
  const files = loadFiles();
  assert.ok(files.size > 1000, `scanned only ${files.size} files`);
  assert.equal(files.has(DEFINITION_FILE), false);
  const list = JSON.parse(fs.readFileSync(LIST_PATH, 'utf8'));
  assert.deepEqual(evaluate(list, files), []);
});
