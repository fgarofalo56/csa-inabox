import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classify,
  runControls,
  MUST_FLAG,
  MUST_NOT_FLAG,
  SPLITS_PHYSICAL,
  READS_SHELL_OR_YAML,
  IMPORTS_PRIMITIVE,
  PRAGMA,
} from '../check-guard-logical-lines.mjs';

const CI = dirname(dirname(fileURLToPath(import.meta.url)));

test('the embedded control passes — the classifier still separates the cases', () => {
  assert.deepEqual(runControls(), []);
});

test('the control has both directions, so it cannot pass by never matching', () => {
  assert.ok(MUST_FLAG.length >= 3, 'need fixtures that MUST be flagged');
  assert.ok(MUST_NOT_FLAG.length >= 3, 'need fixtures that MUST NOT be flagged');
});

test('a shell-scanning, physical-splitting guard with neither escape is unclassified', () => {
  const src = "execFileSync('git', ['ls-files', '--', '*.sh'])\ntext.split(/\\r?\\n/).forEach(() => {})\n";
  assert.equal(classify(src), 'unclassified');
});

test('importing the shared primitive is the adoption', () => {
  const src =
    "import { readLogicalLines } from './_logical-lines.mjs';\n" +
    "execFileSync('git', ['ls-files', '--', '*.sh'])\ntext.split(/\\r?\\n/)\n";
  assert.equal(classify(src), 'adopted');
});

test('a PHYSICAL-LINES-OK pragma with a reason is the declared opt-out', () => {
  const src =
    '// PHYSICAL-LINES-OK: judges `uses:` keys, which never continue.\n' +
    "readdirSync('.github/workflows')\nyaml.split('\\n')\n";
  assert.equal(classify(src), 'declared');
});

test('a BARE pragma with no reason does NOT satisfy the rule', () => {
  // Otherwise the opt-out becomes a way to silence the rule without deciding.
  const src = "// PHYSICAL-LINES-OK:\nreaddirSync('.github/workflows')\nyaml.split('\\n')\n";
  assert.equal(classify(src), 'unclassified');
});

test('a guard that never splits lines is out of scope, whatever it reads', () => {
  const src = "execFileSync('git', ['ls-files', '--', '*.sh'])\nif (/foo/.test(text)) fail();\n";
  assert.equal(classify(src), 'out-of-scope');
});

test('a bicep-only or markdown-only scanner is out of scope', () => {
  // Neither language has a backslash line continuation, so a pragma there would
  // be noise rather than a decision.
  assert.equal(classify("files.filter((f) => f.endsWith('.bicep'))\ntext.split('\\n')\n"), 'out-of-scope');
  assert.equal(classify("files.filter((f) => f.endsWith('.md'))\ntext.split('\\n')\n"), 'out-of-scope');
});

test('both split spellings this directory uses are recognised', () => {
  assert.ok(SPLITS_PHYSICAL.test('text.split(/\\r?\\n/)'));
  assert.ok(SPLITS_PHYSICAL.test("text.split('\\n')"));
  assert.ok(SPLITS_PHYSICAL.test('text.split("\\n")'));
  assert.ok(!SPLITS_PHYSICAL.test("p.split(path.sep)"), 'a path split is not a line split');
});

test('each corpus-selection form used in scripts/ci is recognised', () => {
  const forms = [
    "execFileSync('git', ['ls-files', '--', '*.yml', '*.sh'])",
    "readdirSync(join(ROOT, '.github/workflows'))",
    "files.filter((f) => f.endsWith('.sh'))",
    "if (/\\.ya?ml$/.test(name)) out.push(p)",
    "{ dir: 'scripts', exts: ['.mjs', '.sh'] }",
  ];
  for (const f of forms) {
    assert.ok(READS_SHELL_OR_YAML.some((re) => re.test(f)), `not recognised: ${f}`);
  }
});

test('the two escapes are distinguishable from each other', () => {
  assert.ok(IMPORTS_PRIMITIVE.test("from './_logical-lines.mjs'"));
  assert.ok(!IMPORTS_PRIMITIVE.test('// PHYSICAL-LINES-OK: x'));
  assert.ok(PRAGMA.test('// PHYSICAL-LINES-OK: because x'));
  assert.ok(!PRAGMA.test("from './_logical-lines.mjs'"));
});

test('MUTATION — reverting a real adopter to a bare split makes it unclassified', () => {
  // The receipt the issue asks for, taken against a REAL consumer rather than a
  // fixture: strip the primitive import from an adopted guard and the meta-guard
  // must move it back into the failing bucket.
  const adopted = readFileSync(join(CI, 'check-digest-read-chokepoint.mjs'), 'utf8');
  assert.equal(classify(adopted), 'adopted');

  const reverted = adopted
    // CRLF-tolerant: this repo checks out with autocrlf on Windows, and a `\n`
    // anchored replace silently does nothing there — which would make this
    // mutation test pass by not mutating.
    .replace(/^import \{ readLogicalLines \} from '\.\/_logical-lines\.mjs';\r?\n/m, '')
    .replace(/readLogicalLines\(text\)/g, 'text.split(/\\r?\\n/)');
  assert.notEqual(reverted, adopted, 'the mutation must actually change the source');
  assert.ok(!/_logical-lines\.mjs/.test(reverted), 'the import must be gone for the mutation to mean anything');
  assert.equal(classify(reverted), 'unclassified');
});

test('the real scripts/ci tree has NO unclassified guard', () => {
  const unclassified = readdirSync(CI)
    .filter((f) => f.startsWith('check-') && f.endsWith('.mjs'))
    .filter((f) => classify(readFileSync(join(CI, f), 'utf8')) === 'unclassified');
  assert.deepEqual(unclassified, []);
});

test('the in-scope population is NOT zero — a passing verdict must mean something', () => {
  const counts = { adopted: 0, declared: 0, 'out-of-scope': 0, unclassified: 0 };
  for (const f of readdirSync(CI).filter((n) => n.startsWith('check-') && n.endsWith('.mjs'))) {
    counts[classify(readFileSync(join(CI, f), 'utf8'))] += 1;
  }
  assert.ok(counts.adopted + counts.declared > 0, 'zero in-scope guards means the classifier drifted');
});
