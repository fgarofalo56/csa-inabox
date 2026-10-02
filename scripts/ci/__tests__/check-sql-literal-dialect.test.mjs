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
 *   - "planted positive control: an unlisted Databricks-client importer": a
 *     file importing databricks-client with one escapeSqlLiteral( must be
 *     reported. Breaks if the client-import population is removed.
 *   - "planted positive control: an unlisted Resource Graph sender": a file
 *     that posts to Microsoft.ResourceGraph/resources with one escapeSqlLiteral(
 *     must be reported. Breaks if the endpoint-marker population is removed.
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
  ENGINE_CLIENT_MODULES,
  ENGINE_CLIENT_IMPORT_RE,
  ENGINE_CONTENT_MARKERS,
} from '../check-sql-literal-dialect.mjs';
import { codeOnly } from '../_code-only.mjs';

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

// ── Client-import population (tsqlClientFiles) ─────────────────────────────
// A file that imports a Databricks/Kusto statement client and holds a T-SQL-rule
// escape is reported unless allowlisted with the exact count. Module names come
// from ENGINE_CLIENT_MODULES (lifted from the guard, not transcribed).
const C = 'apps/fiab-console/lib/x/client-user.ts';
const clientSrc = (spec, escapes = 1) =>
  `${spec}\nexport const run = (v: string) => executeStatement(\`SELECT '\${v}'\`);\n`
  + 'export const lit = (v: string) => escapeSqlLiteral(v);\n'.repeat(escapes);
const DBX_IMPORT = `import { executeStatement } from '@/lib/azure/${ENGINE_CLIENT_MODULES[0]}';`;
const base = () => [[P, SPARK_OK]];

test('planted positive control: an unlisted Databricks-client importer with one escapeSqlLiteral fails', () => {
  // Breaks if the client-import arm is removed from the unlisted loop, or if
  // ENGINE_CLIENT_IMPORT_RE stops matching `from '@/lib/azure/databricks-client'`.
  assert.equal(ENGINE_CLIENT_MODULES[0], 'databricks-client');
  assert.deepEqual(kinds(evaluate({ sites: [entry()] }, new Map([...base(), [C, clientSrc(DBX_IMPORT)]]))),
    [`unlisted-engine-client ${C}`]);
});

test('negative controls: the importer with no T-SQL escape passes; the escape without the import passes', () => {
  // The second half is the documented blind spot (a file that neither imports a
  // client nor references a dialect helper is outside the population); it is
  // pinned so a change to it is a deliberate one.
  assert.deepEqual(evaluate({ sites: [entry()] }, new Map([...base(), [C, clientSrc(DBX_IMPORT, 0)]])), []);
  assert.deepEqual(evaluate({ sites: [entry()] }, new Map([...base(), [C, clientSrc("import { x } from '@/lib/azure/other-client';")]])), []);
});

test('every client module and import form joins the population', () => {
  // Breaks if any module leaves ENGINE_CLIENT_MODULES, or if the relative
  // (`./`, `../azure/`) or dynamic `import(...)` forms stop matching.
  assert.deepEqual([...ENGINE_CLIENT_MODULES].sort(), ['databricks-client', 'kusto-client', 'monitor-client']);
  for (const m of ENGINE_CLIENT_MODULES) {
    for (const spec of [
      `import { a } from '@/lib/azure/${m}';`,
      `import { a } from './${m}';`,
      `import { a } from "../azure/${m}";`,
      `const { a } = await import('@/lib/azure/${m}');`,
      `import '@/lib/azure/${m}';`,
    ]) {
      assert.match(spec, ENGINE_CLIENT_IMPORT_RE, spec);
      assert.deepEqual(kinds(evaluate({ sites: [entry()] }, new Map([...base(), [C, clientSrc(spec)]]))),
        [`unlisted-engine-client ${C}`], spec);
    }
  }
});

test('a different module with a client-like prefix, or an import only in a comment, does not join', () => {
  // kusto-arm-client is the ARM control-plane client (no statement text); the
  // closing quote in the regex is what keeps `kusto-client-x` out. A comment is
  // masked by the shared lexer, so prose cannot widen the population.
  for (const spec of [
    "import { a } from '@/lib/azure/kusto-arm-client';",
    "import { a } from '@/lib/azure/kusto-client-extra';",
    "// import { a } from '@/lib/azure/kusto-client';",
  ]) {
    assert.doesNotMatch(codeOnly(spec), ENGINE_CLIENT_IMPORT_RE, spec);
    assert.deepEqual(evaluate({ sites: [entry()] }, new Map([...base(), [C, clientSrc(spec)]])), [], spec);
  }
  // Positive pairing: the same shape with the real module name is caught.
  assert.match(codeOnly("import { a } from '@/lib/azure/kusto-client';"), ENGINE_CLIENT_IMPORT_RE);
});

test('module names are [a-z-] only, so joining them unescaped builds the intended alternation', () => {
  // ENGINE_CLIENT_IMPORT_RE joins the names without escaping. Breaks if a name
  // with a regex metacharacter (`.`, `+`, `\`, `(`...) is added: it would match
  // more than the literal module name, so it must be escaped first.
  for (const m of ENGINE_CLIENT_MODULES) assert.match(m, /^[a-z]+(?:-[a-z]+)*$/, m);
});

// ── Endpoint-marker population (Resource Graph, KQL, no client module) ──────
// The marker is lifted from ENGINE_CONTENT_MARKERS, not transcribed.
const R = 'apps/fiab-console/lib/x/arg-user.ts';
const RG = ENGINE_CONTENT_MARKERS.find((m) => m.engine === 'kql');
const argSrc = (urlLine, escapes = 1) =>
  `${urlLine}\nexport const q = (v: string) => \`Resources | where name == '\${v}'\`;\n`
  + 'export const lit = (v: string) => escapeSqlLiteral(v);\n'.repeat(escapes);
const ARG_URL = `const url = \`https://management.azure.com/providers/${RG.name}?api-version=2022-10-01\`;`;

test('planted positive control: an unlisted Resource Graph sender with one escapeSqlLiteral fails', () => {
  // Reviewer arm G3: this file imports no client and references no helper, so
  // before the marker it passed. Breaks if the marker arm is removed from the
  // unlisted loop, or if the marker regex stops matching the endpoint path.
  assert.equal(RG.name, 'Microsoft.ResourceGraph/resources');
  const v = evaluate({ sites: [entry()] }, new Map([...base(), [R, argSrc(ARG_URL)]]));
  assert.deepEqual(kinds(v), [`unlisted-engine-endpoint ${R}`]);
  assert.match(v[0].detail, /Microsoft\.ResourceGraph\/resources \(KQL\)/);
});

test('Resource Graph: no escape passes; the URL only in a comment passes; the allowlist with the exact count passes', () => {
  // Each is paired with the positive control above (same file shape, one
  // change). The comment case breaks if the marker is matched on raw source
  // instead of comment-masked source.
  assert.deepEqual(evaluate({ sites: [entry()] }, new Map([...base(), [R, argSrc(ARG_URL, 0)]])), []);
  assert.deepEqual(evaluate({ sites: [entry()] }, new Map([...base(), [R, argSrc(`// posts to ${RG.name}`)]])), []);
  const allow = { sites: [entry()], tsqlClientFiles: [{ path: R, tsqlEscapes: 1, reason: 'OData filter, quote-doubled' }] };
  assert.deepEqual(evaluate(allow, new Map([...base(), [R, argSrc(ARG_URL)]])), []);
});

test('the real tree has a non-empty Resource Graph population', () => {
  // Breaks if the marker stops matching the way the console writes the URL
  // (the population would silently drop to 0 and the arm would watch nothing).
  // Measured at this change: 28 files carry it in code, 2 more only in comments.
  const n = [...loadFiles().values()].filter((s) => RG.re.test(codeOnly(s))).length;
  assert.ok(n >= 20, `only ${n} files carry ${RG.name} in code`);
});

test('tsqlClientFiles: the exact count passes; one more or one fewer fails', () => {
  const allow = (n) => ({ sites: [entry()], tsqlClientFiles: [{ path: C, tsqlEscapes: n, reason: 'Synapse T-SQL' }] });
  const files = new Map([...base(), [C, clientSrc(DBX_IMPORT, 2)]]);
  assert.equal(countTsqlEscapes(files.get(C)).total, 2);
  assert.deepEqual(evaluate(allow(2), files), []);
  assert.deepEqual(kinds(evaluate(allow(1), files)), [`tsql-client-count ${C}`]);
  assert.deepEqual(kinds(evaluate(allow(3), files)), [`tsql-client-count ${C}`]);
  assert.match(evaluate(allow(1), files)[0].detail, /set tsqlEscapes to 2/);
});

test('tsqlClientFiles: missing file, bad entry and duplicate entry fail', () => {
  const files = new Map(base());
  assert.deepEqual(kinds(evaluate({ sites: [entry()], tsqlClientFiles: [{ path: C, tsqlEscapes: 1, reason: 'T-SQL' }] }, files)),
    [`missing-file ${C}`]);
  const v = evaluate({
    sites: [entry()],
    tsqlClientFiles: [
      { path: 'z0.ts', tsqlEscapes: 0, reason: 'T-SQL' },
      { path: 'z1.ts', tsqlEscapes: 1, reason: ' ' },
      { path: P, tsqlEscapes: 1, reason: 'T-SQL' },
    ],
  }, files);
  assert.deepEqual(kinds(v).sort(), ['bad-entry z0.ts', 'bad-entry z1.ts', `duplicate-entry ${P}`].sort());
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
  // Each import form reaches a real file: `./kusto-client` (access-policy-client),
  // `../azure/kusto-client` (agent-config-tools), dynamic import() (workspace-grants).
  for (const f of ['lib/azure/access-policy-client.ts', 'lib/copilot/agent-config-tools.ts', 'lib/azure/workspace-grants.ts']) {
    assert.ok(k.includes(`unlisted-engine-client apps/fiab-console/${f}`), k.join('\n'));
  }
  // Plus one per tsqlClientFiles entry, each found without the allowlist.
  assert.ok(list.tsqlClientFiles.length >= 3, 'the allowlist is not empty');
  assert.equal(v.length, list.sites.length + list.tsqlClientFiles.length + 1, k.join('\n'));
  assert.equal(k.filter((x) => x.startsWith('unlisted-engine-client ')).length, list.tsqlClientFiles.length, k.join('\n'));
});

test('real tree is clean against the committed list, and the definition file is out of scope', () => {
  const files = loadFiles();
  assert.ok(files.size > 1000, `scanned only ${files.size} files`);
  assert.equal(files.has(DEFINITION_FILE), false);
  const list = JSON.parse(fs.readFileSync(LIST_PATH, 'utf8'));
  assert.deepEqual(evaluate(list, files), []);
});
