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
import os from 'node:os';
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

/**
 * Build a throwaway app-shaped tree: { 'lib/components/x.tsx': '…' }.
 * Returns the fixture root to hand to the guard via NO_RAW_PX_APP_ROOT.
 */
function fixtureRoot(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'no-raw-px-fixture-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return root;
}

const CLEAN_TSX = [
  "'use client';",
  "import { tokens } from '@fluentui/react-components';",
  'export function Ok() {',
  '  return <div style={{ padding: tokens.spacingVerticalL, gap: tokens.spacingHorizontalM }}>ok</div>;',
  '}',
  '',
].join('\n');

const DIRTY_TSX = [
  "'use client';",
  'export function Bad() {',
  '  return <div style={{ padding: 16, gap: 12 }}>bad</div>;',
  '}',
  '',
].join('\n');

test('the guard still FAILS CLOSED on a raw-px violation (fail-closed, not just quiet)', () => {
  // Driven against a FIXTURE TREE, not the real source tree.
  //
  // Two earlier versions of this test proved the same property by mutating the
  // repo, and both were wrong in ways worth recording:
  //
  //   v1 CREATED a probe .tsx under lib/components and `git add -N`-ed it so the
  //      guard's `git ls-files` would see it. That mutated the shared GIT INDEX.
  //      Many agents share git state in this repo; a run that dies between the
  //      write and its cleanup leaves a foreign file staged in somebody else's
  //      commit. Its create/delete window also raced check-insecure-randomness
  //      into an ENOENT, reddening an unrelated guard in the required job. It
  //      also carried a TOCTOU (`existsSync` then `readFileSync`) that CodeQL
  //      flagged as js/file-system-race.
  //   v2 edited an existing file (loom-logo.tsx) in place. No index mutation and
  //      no ENOENT window — but still a write into the source tree, which is
  //      still a shared-state hazard if the process dies mid-test.
  //
  // A fixture tree removes the entire class: nothing outside os.tmpdir() is
  // touched, so no crash can leave the repo dirty and no sibling can observe it.
  const root = fixtureRoot({
    'lib/components/clean.tsx': CLEAN_TSX,
    'lib/components/dirty.tsx': DIRTY_TSX,
  });
  const r = spawnSync(process.execPath, [SCRIPT], {
    cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, NO_RAW_PX_APP_ROOT: root },
  });
  assert.equal(
    r.status, 1,
    `guard must exit 1 on a raw-px violation, got ${r.status}.\n${r.stdout}${r.stderr}`,
  );
  assert.match(r.stderr, /FAIL — NEW raw-px/);
  assert.match(r.stderr, /dirty\.tsx/);
  assert.doesNotMatch(r.stderr, /clean\.tsx/, 'a tokened file must not be reported');
});

test('the fixture lane is not a rubber stamp — a clean fixture tree PASSES', () => {
  // The complement of the test above. Without it, a guard that failed on
  // EVERYTHING would satisfy the fail-closed assertion and look correct.
  const root = fixtureRoot({ 'lib/components/clean.tsx': CLEAN_TSX });
  const r = spawnSync(process.execPath, [SCRIPT], {
    cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, NO_RAW_PX_APP_ROOT: root },
  });
  assert.equal(r.status, 0, `a tokened fixture must pass\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /current: 0 across 0 files/);
});

test('the fixture root reaches lib/components — the override does not silently scan nothing', () => {
  // A fixture tree is not a git repo, so the guard's `git ls-files` discovery
  // returns nothing there. If the override did not switch to a direct walk, the
  // scan would cover only app/**/page.tsx and the fail-closed test above would
  // pass while exercising HALF the guard. This pins the file that proves it.
  const root = fixtureRoot({ 'lib/components/dirty.tsx': DIRTY_TSX });
  const r = spawnSync(process.execPath, [SCRIPT], {
    cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, NO_RAW_PX_APP_ROOT: root },
  });
  assert.match(r.stdout, /current: 2 across 1 files/, `expected both px values counted:\n${r.stdout}`);
});

test('CI never sets the override — it cannot be used to neuter the guard', () => {
  // The override exists for THIS file. If a workflow ever set it, the merge-
  // blocking lane would scan a directory of someone's choosing and pass
  // trivially. That is the "gate that measures nothing" shape, so it is pinned.
  const wfDir = path.join(REPO_ROOT, '.github', 'workflows');
  const offenders = [];
  for (const name of fs.readdirSync(wfDir)) {
    if (!/\.ya?ml$/.test(name)) continue;
    const src = fs.readFileSync(path.join(wfDir, name), 'utf8');
    if (/NO_RAW_PX_APP_ROOT/.test(src)) offenders.push(name);
  }
  assert.deepEqual(offenders, [], `NO_RAW_PX_APP_ROOT must not appear in any workflow: ${offenders.join(', ')}`);

  // …and the guardrails lane must still invoke the guard plainly.
  const guardrails = fs.readFileSync(path.join(wfDir, 'loom-guardrails.yml'), 'utf8');
  assert.match(guardrails, /node scripts\/ci\/check-no-raw-px\.mjs/);
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
