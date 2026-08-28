/**
 * generate-coverage-summary self-test (#4058).
 *
 * WHAT WENT WRONG. `--check` compared the regenerated document — assembled in
 * memory from template literals, so LF-only — against the on-disk copy read
 * verbatim with `'utf8'`. `.gitattributes` does not cover `docs/**`, so with
 * `core.autocrlf=true` Git materialises that path as CRLF on a Windows
 * checkout. Measured on a pristine tree: 3103 bytes / 77 CR / 77 LF on disk vs
 * 3026 bytes / 0 CR / 77 LF in memory — delta exactly the CR count. Every line
 * differed by one byte, the raw `!==` fired, and the gate reported the file
 * "stale" when it was byte-identical to what is committed. CI is Linux, so this
 * only ever bit the developer running the gate locally, i.e. exactly the person
 * the gate exists to help. Worse, the remediation it printed (regenerate)
 * rewrites the file LF-only and attributes 77 lines of line-ending churn to
 * whatever PR they happened to be on.
 *
 * WHY THE FIXTURE IS BUILT, NOT ASSERTED-OVER-THE-REPO. A test that ran
 * `--check` against the real `docs/fiab/coverage-summary.md` would measure
 * whatever line endings THIS checkout happens to have — on a Linux runner that
 * is LF, so the bug is unreachable and the test is green and blind. So the
 * suite builds a throwaway repo root and writes BOTH endings explicitly, and
 * asserts the CRLF fixture really is CRLF before trusting a verdict from it.
 * A fixture that quietly lost its CRs would prove nothing.
 *
 * MUTATION-PROVEN. Restore the raw comparison (drop the `\r\n` -> `\n`
 * normalisation from `strip()`) and "a CRLF checkout is not stale" goes RED.
 * Make the comparison unconditional-pass and the edited-row, deleted-row and
 * missing-file tests all go RED. Delete the population floor and "a collapsed
 * parse refuses" goes RED.
 *
 * Run: node --test scripts/ci/__tests__/coverage-summary.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const SCRIPT_REL = path.join('scripts', 'ci', 'generate-coverage-summary.mjs');
const OUT_REL = path.join('docs', 'fiab', 'coverage-summary.md');

/**
 * The files the generator derives every published number from. If one of these
 * moves, the sandbox stops resembling the repo and this whole suite becomes a
 * test of a fiction — so their presence is asserted, not assumed.
 */
const INPUTS = [
  SCRIPT_REL,
  path.join('.github', 'workflows', 'test.yml'),
  'pyproject.toml',
  path.join('apps', 'fiab-console', 'vitest.config.ts'),
];

/** A throwaway repo root carrying only what the generator reads. */
function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-summary-'));
  for (const rel of INPUTS) {
    const from = path.join(REPO, rel);
    assert.ok(
      fs.existsSync(from),
      `generator input ${rel} is missing from the repo — this suite would be testing a fiction`,
    );
    const to = path.join(root, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
  fs.mkdirSync(path.join(root, 'docs', 'fiab'), { recursive: true });
  return root;
}

function run(root, args) {
  const r = spawnSync(process.execPath, [path.join(root, SCRIPT_REL), ...args], {
    cwd: root,
    encoding: 'utf8',
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

/** Generate the doc inside the sandbox and return it LF-normalised. */
function seed(root) {
  const gen = run(root, []);
  assert.equal(gen.code, 0, `generator failed in the sandbox: ${gen.err}`);
  const lf = fs.readFileSync(path.join(root, OUT_REL), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(lf.includes('# CSA Loom — Coverage Summary'), 'sandbox doc does not look like the real doc');
  return lf;
}

const writeLF = (root, text) => fs.writeFileSync(path.join(root, OUT_REL), text);
const writeCRLF = (root, text) => fs.writeFileSync(path.join(root, OUT_REL), text.replace(/\n/g, '\r\n'));
const bytesOf = (root) => fs.readFileSync(path.join(root, OUT_REL));
const count = (buf, byte) => {
  let n = 0;
  for (const b of buf) if (b === byte) n++;
  return n;
};

test('a CRLF checkout of an UNCHANGED doc is not reported stale (#4058)', () => {
  const root = makeSandbox();
  try {
    const lf = seed(root);
    writeCRLF(root, lf);

    // FIXTURE FLOOR: if this file is not actually CRLF the verdict below is
    // vacuous, so prove the CRs are there before believing the RC.
    const buf = bytesOf(root);
    const cr = count(buf, 0x0d);
    const nl = count(buf, 0x0a);
    assert.ok(cr > 50, `fixture lost its CRs (CR=${cr}) — it cannot reach the bug it exists to reproduce`);
    assert.equal(cr, nl, `fixture is half-converted (CR=${cr}, LF=${nl})`);

    const r = run(root, ['--check']);
    assert.equal(
      r.code,
      0,
      `--check must pass on a CRLF checkout whose CONTENT is identical. stderr:\n${r.err}`,
    );
    assert.match(r.out, /is up to date/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an LF checkout of an unchanged doc also passes (the fix is not endian-swapped)', () => {
  const root = makeSandbox();
  try {
    const lf = seed(root);
    writeLF(root, lf);
    assert.equal(count(bytesOf(root), 0x0d), 0, 'LF fixture unexpectedly carries CRs');
    const r = run(root, ['--check']);
    assert.equal(r.code, 0, `stderr:\n${r.err}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an EDITED coverage row still fails, on both line endings', () => {
  for (const [label, write] of [
    ['CRLF', writeCRLF],
    ['LF', writeLF],
  ]) {
    const root = makeSandbox();
    try {
      const lf = seed(root);
      const edited = lf.replace(/^\| statements \| \d+% \|$/m, '| statements | 99% |');
      assert.notEqual(edited, lf, 'the statements floor row was not found — fixture drifted');
      write(root, edited);
      const r = run(root, ['--check']);
      assert.equal(r.code, 1, `${label}: an edited row must fail. stdout:\n${r.out}`);
      assert.match(r.err, /does not match the live coverage config/);
      // The message must name WHAT differs — "is stale" alone sent this exact
      // investigation down a line-ending rabbit hole once (deploy-integrity R7).
      assert.match(r.err, /first difference at line \d+/);
      assert.match(r.err, /statements/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('a DELETED coverage row still fails — the check is sensitive to the population, not only to bytes', () => {
  const root = makeSandbox();
  try {
    const lf = seed(root);
    const deleted = lf.replace(/^\| branches \| \d+% \|\n/m, '');
    assert.notEqual(deleted, lf, 'the branches floor row was not found — fixture drifted');
    writeCRLF(root, deleted);
    const r = run(root, ['--check']);
    assert.equal(r.code, 1, `a deleted row must fail. stdout:\n${r.out}`);
    assert.match(r.err, /does not match the live coverage config/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the Generated-on line is still ignored — it changes every run by design', () => {
  const root = makeSandbox();
  try {
    const lf = seed(root);
    const redated = lf.replace(/Generated-on: \d{4}-\d{2}-\d{2}/, 'Generated-on: 1999-01-01');
    assert.notEqual(redated, lf, 'no Generated-on line in the sandbox doc — fixture drifted');
    writeCRLF(root, redated);
    const r = run(root, ['--check']);
    assert.equal(r.code, 0, `only the date changed, so --check must pass. stderr:\n${r.err}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a MISSING doc fails, and says so rather than claiming staleness', () => {
  const root = makeSandbox();
  try {
    seed(root);
    fs.rmSync(path.join(root, OUT_REL));
    const r = run(root, ['--check']);
    assert.equal(r.code, 1);
    assert.match(r.err, /does not exist/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a COLLAPSED parse refuses instead of publishing placeholders (population floor)', () => {
  const root = makeSandbox();
  try {
    seed(root);
    // Reformat the vitest config past the generator's matcher — the shape a
    // routine refactor produces. Without the floor the doc renders
    // "_thresholds not parsed_", someone commits it, and --check is green
    // forever over a summary that states nothing.
    const cfgPath = path.join(root, 'apps', 'fiab-console', 'vitest.config.ts');
    const cfg = fs.readFileSync(cfgPath, 'utf8');
    const broken = cfg.replace(/thresholds:/g, 'coverageThresholds:');
    assert.notEqual(broken, cfg, 'no thresholds block in the vitest config — fixture drifted');
    fs.writeFileSync(cfgPath, broken);

    const chk = run(root, ['--check']);
    assert.equal(chk.code, 1, `--check must refuse a collapsed parse. stdout:\n${chk.out}`);
    assert.match(chk.err, /REFUSING to render or judge/);
    assert.match(chk.err, /Vitest floors/);

    // And the WRITE path refuses too — otherwise the placeholder doc gets
    // committed and the check has nothing left to object to.
    const gen = run(root, []);
    assert.equal(gen.code, 1, 'the generator must refuse to WRITE a placeholder doc');
    assert.match(gen.err, /REFUSING to render or judge/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
