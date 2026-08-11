/**
 * check-github-script-syntax self-test (2026-08-09, loom-synthetic-monitor).
 *
 * The guard exists because a github-script body that does not COMPILE never
 * runs a single statement — and when that body is an alert, its silence is
 * indistinguishable from "nothing to report". A GUARD that cannot fail is the
 * same defect one level up, so this drives it against synthetic workflow
 * fixtures and pins both verdicts.
 *
 * MUTATION-PROVEN: the "detects" tests below reproduce the exact production
 * defect (`const exec = …` in loom-synthetic-monitor.yml, which threw
 * `SyntaxError: Identifier 'exec' has already been declared` on 83 consecutive
 * red runs while ZERO issues were filed). The "does not flag" tests pin that an
 * over-broad guard — one that flagged every block, or choked on `${{ }}` — is
 * equally visible.
 *
 * Run: node --test scripts/ci/__tests__/github-script-syntax.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GUARD = resolve(HERE, '..', 'check-github-script-syntax.mjs');

/** Run the guard over a throwaway directory containing `files`. */
function runOn(files) {
  const dir = mkdtempSync(join(tmpdir(), 'gsyntax-'));
  try {
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    const r = spawnSync(process.execPath, [GUARD, dir], { encoding: 'utf8' });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const wf = (steps) => `name: fixture
on: workflow_dispatch
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
${steps}
`;

// ---------------------------------------------------------------------------
// DETECTS — the production defect, and its siblings
// ---------------------------------------------------------------------------
test('detects a const redeclaring an injected name (the loom-synthetic-monitor defect)', () => {
  const r = runOn({
    'bad.yml': wf(`      - name: File / update dedup issue on failure
        uses: actions/github-script@v7
        with:
          script: |
            const exec = \`x\` || '<unknown>';
            core.info(exec);`),
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /Identifier 'exec' has already been declared/);
  assert.match(r.out, /bad\.yml/);
});

test('detects the same defect on the `- uses:` spelling (dash shares the key line)', () => {
  // This spelling was invisible to the first draft of the guard: anchoring on
  // /^\s*uses:/ skipped 2 of this repo's 20 real blocks.
  const r = runOn({
    'bad2.yml': wf(`      - uses: actions/github-script@v7
        with:
          script: |
            const io = 1;`),
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /Identifier 'io' has already been declared/);
});

test('detects an ordinary syntax error too', () => {
  const r = runOn({
    'bad3.yml': wf(`      - name: broken
        uses: actions/github-script@v7
        with:
          script: |
            const a = ;`),
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /SyntaxError/);
});

// ---------------------------------------------------------------------------
// DOES NOT FLAG — an over-broad guard would fail these
// ---------------------------------------------------------------------------
test('does not flag a valid body that USES the injected names', () => {
  const r = runOn({
    'ok.yml': wf(`      - name: fine
        uses: actions/github-script@v7
        with:
          script: |
            core.info(context.repo.repo);
            await github.rest.issues.listForRepo({ owner: 'o', repo: 'r' });
            const execName = 'renamed-local';
            core.info(execName);`),
  });
  assert.equal(r.code, 0);
  assert.match(r.out, /OK/);
});

test('does not choke on ${{ }} expressions in any position', () => {
  const r = runOn({
    'expr.yml': wf(`      - name: expressions
        uses: actions/github-script@v7
        with:
          script: |
            const s = \`\${{ steps.x.outputs.y }}\` || 'fallback';
            const n = \${{ github.run_number }};
            core.info(s + n);`),
  });
  assert.equal(r.code, 0);
});

test('ignores steps that are not github-script', () => {
  const r = runOn({
    'other.yml': wf(`      - name: shell
        run: |
          const exec = broken syntax here (((`),
    // one real block so the vacuous-pass guard is satisfied for the fixture dir
    'real.yml': wf(`      - name: fine
        uses: actions/github-script@v7
        with:
          script: |
            core.info('ok');`),
  });
  assert.equal(r.code, 0);
});

// ---------------------------------------------------------------------------
// SELF-DEFENCE — the guard must not pass vacuously on the REAL directory
// ---------------------------------------------------------------------------
test('refuses to pass vacuously when scanning the real workflow dir finds nothing', () => {
  // An empty dir is only treated as vacuous for the DEFAULT path; a fixture dir
  // with zero blocks is a legitimate self-test input. Pin that distinction so a
  // future refactor cannot quietly make the real-directory check toothless.
  const r = runOn({ 'none.yml': wf(`      - name: nothing\n        run: echo hi`) });
  assert.equal(r.code, 0, 'fixture dirs with no blocks are allowed');

  const real = spawnSync(process.execPath, [GUARD], { encoding: 'utf8' });
  assert.equal(real.status, 0, 'the real .github/workflows must compile');
  assert.match(real.stdout, /\d+ inline github-script block\(s\)/);
  const n = Number(real.stdout.match(/(\d+) inline github-script block/)?.[1] ?? 0);
  assert.ok(n >= 15, `expected the repo's many github-script blocks to be found, saw ${n}`);
});
