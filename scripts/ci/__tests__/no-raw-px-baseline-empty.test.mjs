/**
 * no-raw-px baseline-is-EMPTY lock (FINISHLINE C4 / B-U12 final drain).
 *
 * `check-no-raw-px.mjs` shipped as a RATCHET: a grandfathered per-file backlog
 * of raw-px inline styles was frozen in BASELINE and CI failed only when a
 * file's count ROSE. That backlog is now fully drained (rel-T56 codemod 18 ->
 * B-U12 sweep 7 -> C4 final drain 0), so BASELINE is `{}` and the guard is
 * ABSOLUTE rather than ratcheting: the first raw `padding: 16` / `gap: 12` /
 * `fontSize: 22` re-introduced anywhere in scope fails the build.
 *
 * That property is worth exactly as much as it is hard to undo. Re-running
 * `--update-baseline` and pasting the output back is a two-command way to
 * re-grandfather new debt while every guard stays green — the ratchet-lowering
 * this repo has been bitten by before. This suite makes that require deleting a
 * test, which is loud in review, instead of editing a data blob, which is not.
 *
 * It also asserts the guard still FAILS CLOSED on a synthetic violation. An
 * empty baseline is only meaningful if a non-empty scan still exits non-zero;
 * a guard whose verdict cannot change is the "measures nothing" class of defect
 * (`csa_loom_gates_that_measure_nothing`), and an empty BASELINE would be its
 * most convincing possible disguise — the console prints "0 across 0 files"
 * whether the scan is clean or the scanner is broken.
 *
 * MUTATION-PROVEN (see PR body):
 *   - re-add one entry to BASELINE            -> test 1 RED
 *   - make main() exit 0 on regressions       -> test 3 RED
 *   - make countViolations() always return 0  -> test 3 RED (fixture undetected)
 *
 * Run: node --test scripts/ci/__tests__/no-raw-px-baseline-empty.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '..', 'check-no-raw-px.mjs');
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

const SRC = fs.readFileSync(SCRIPT, 'utf8');

/** The literal BASELINE object as written in the guard source. */
function baselineLiteral() {
  const m = SRC.match(/__BASELINE_START__[\s\S]*?const BASELINE = (\{[\s\S]*?\});\s*\/\/ __BASELINE_END__/);
  assert.ok(m, 'could not locate the BASELINE literal between the sentinel comments');
  return m[1].trim();
}

test('BASELINE is empty — the raw-px ratchet is fully drained and now absolute', () => {
  assert.equal(
    baselineLiteral(),
    '{}',
    'check-no-raw-px.mjs BASELINE must stay `{}`. Re-populating it re-grandfathers ' +
    'raw-px debt and silently lowers a ratchet. Convert the new value to a Loom ' +
    'token (tokens.spacing* / tokens.fontSize*) instead.',
  );
});

test('the guard reports a clean tree against the real repo', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, `expected a clean scan, got exit ${r.status}\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /current: 0 across 0 files/);
});

test('the guard still FAILS CLOSED on a raw-px violation (fail-closed, not just quiet)', (t) => {
  // Plant a synthetic violation inside the real scope, run the guard, remove it.
  // Using the real tree (not a fixture) is deliberate: it also proves the file
  // discovery + scope globs still reach lib/components at all.
  const victim = path.join(
    REPO_ROOT, 'apps', 'fiab-console', 'lib', 'components', '__rawpx_guard_probe__.tsx',
  );
  const original = fs.existsSync(victim) ? fs.readFileSync(victim, 'utf8') : null;
  t.after(() => {
    if (original === null) { try { fs.unlinkSync(victim); } catch { /* already gone */ } }
    else fs.writeFileSync(victim, original);
  });

  fs.writeFileSync(victim, [
    "'use client';",
    'export function Probe() {',
    "  return <div style={{ padding: 16, gap: 12 }}>probe</div>;",
    '}',
    '',
  ].join('\n'));

  // The guard enumerates lib/components via `git ls-files`, so an untracked
  // probe would be invisible. Stage it (index only — never committed; the
  // t.after above restores the worktree and we reset the index here).
  const add = spawnSync('git', ['add', '-N', victim], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(add.status, 0, `git add -N failed: ${add.stderr}`);
  t.after(() => { spawnSync('git', ['reset', '--', victim], { cwd: REPO_ROOT, encoding: 'utf8' }); });

  const r = spawnSync(process.execPath, [SCRIPT], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(
    r.status, 1,
    `guard must exit 1 on a planted raw-px violation, got ${r.status}.\n${r.stdout}${r.stderr}`,
  );
  assert.match(r.stderr, /FAIL — NEW raw-px/);
  assert.match(r.stderr, /__rawpx_guard_probe__/);
});

test('--update-baseline emits {} — nothing left to grandfather', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--update-baseline'], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /0 files, 0 grandfathered/);
  assert.equal(r.stdout.trim().split('\n').pop().trim(), '{}');
});

test('the drained-baseline rationale is documented at the BASELINE sentinel', () => {
  // A bare `const BASELINE = {};` reads like an oversight and invites someone to
  // "restore" it. The comment block is the durable explanation.
  const header = SRC.slice(SRC.indexOf('__BASELINE_START__'), SRC.indexOf('const BASELINE'));
  assert.match(header, /ABSOLUTE/, 'the sentinel comment must say the guard is no longer a ratchet');
  assert.match(header, /DO NOT re-populate/, 'the sentinel comment must warn against re-populating');
});
