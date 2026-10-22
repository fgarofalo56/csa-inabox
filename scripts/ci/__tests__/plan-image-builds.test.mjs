/**
 * Tests for scripts/ci/plan-image-builds.mjs and its wiring in
 * build-fiab-images-acr-tasks.yml / loom-roll-and-validate.yml.
 *
 * Every assertion names, in its message, the input that turns it red
 * (.claude/rules/assertion-design.md). The app matrix is LIFTED from the
 * workflow at runtime, never transcribed, so a drift between the planner's
 * view and the shipped matrix cannot hide.
 *
 * Run: node --test scripts/ci/__tests__/plan-image-builds.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planBuild, readChangedFiles, SHARED_PREFIXES } from '../plan-image-builds.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const PLANNER = join(ROOT, 'scripts', 'ci', 'plan-image-builds.mjs');
const WF = join(ROOT, '.github', 'workflows', 'build-fiab-images-acr-tasks.yml');
const ROLL = join(ROOT, '.github', 'workflows', 'loom-roll-and-validate.yml');
const wfText = readFileSync(WF, 'utf8').replace(/\r\n/g, '\n');
const rollText = readFileSync(ROLL, 'utf8').replace(/\r\n/g, '\n');

// Same extraction the check-build-trigger-covers-matrix guard uses.
const MATRIX = JSON.parse(/APPS='(\[[^']*\])'/.exec(wfText)[1]);
const names = MATRIX.map((a) => a.name);
const SHA = 'a'.repeat(40);
const BASE = 'b'.repeat(40);

test('lifted matrix is the 13-app default set (input: an app dropped from or added to APPS)', () => {
  assert.equal(MATRIX.length, 13, `matrix has ${MATRIX.length} apps; update this pin AND the carry contract if it changed on purpose`);
});

test('a file in EACH matrix context builds exactly that app and carries the other 12', () => {
  for (const app of MATRIX) {
    const p = planBuild({ changedFiles: [`${app.ctx.replace('./', '')}/src/x.ts`], matrix: MATRIX });
    assert.deepEqual(p.build, [app.name], `file under ${app.ctx}: must build only ${app.name}, got ${p.build}`);
    assert.equal(p.carry.length, 12, `file under ${app.ctx}: 12 others must be carried, got ${p.carry.length}`);
    assert.equal(p.mode, 'subset', `file under ${app.ctx}: mode must be subset`);
  }
});

test('build and carry partition the matrix: no app lost, none in both (input: two apps changed)', () => {
  const p = planBuild({ changedFiles: ['apps/loom-trino/a', 'apps/fiab-mcp-config/b'], matrix: MATRIX });
  assert.deepEqual([...p.build].sort(), ['loom-mcp', 'loom-trino'], 'loom-mcp is dir fiab-mcp-config (name != dir stem)');
  assert.deepEqual([...p.build, ...p.carry].sort(), [...names].sort(), 'build+carry must equal the matrix exactly');
  assert.equal(p.build.filter((n) => p.carry.includes(n)).length, 0, 'an app in both lists would be built AND re-tagged over');
});

test('a sibling directory sharing a name prefix does NOT map to the app (input: apps/fiab-console-extra/x)', () => {
  const p = planBuild({ changedFiles: ['apps/fiab-console-extra/x.ts', 'apps/loom-trino/a'], matrix: MATRIX });
  assert.deepEqual(p.build, ['loom-trino'], `prefix match without a trailing slash would add loom-console; got ${p.build}`);
  assert.ok(p.ignored.includes('apps/fiab-console-extra/x.ts'), 'the unowned path must be listed as ignored');
});

test('every shared build input forces ALL (input: each SHARED_PREFIXES entry plus one file)', () => {
  assert.ok(SHARED_PREFIXES.includes('.github/workflows/build-fiab-images-acr-tasks.yml'), 'the producer workflow must be a shared input');
  assert.ok(SHARED_PREFIXES.some((p) => p.startsWith('scripts/ci/acr-')), 'scripts/ci/acr-* must be a shared input');
  assert.ok(SHARED_PREFIXES.includes('packages/'), 'packages/ must be a shared input');
  for (const p of SHARED_PREFIXES) {
    const f = p.endsWith('/') || p.endsWith('-') || !p.includes('.') ? `${p}x.mjs` : p;
    const plan = planBuild({ changedFiles: ['apps/loom-trino/a', f], matrix: MATRIX });
    assert.equal(plan.mode, 'all', `${f} (prefix ${p}) alongside a single-app change must still build ALL, got ${plan.mode}`);
    assert.deepEqual(plan.build, names, `${f}: ALL must list every matrix app`);
    assert.deepEqual(plan.carry, [], `${f}: ALL carries nothing`);
  }
});

test('root build config forces ALL, a root README does not (inputs: package.json vs README.md)', () => {
  for (const f of ['package.json', 'pnpm-lock.yaml', 'pyproject.toml', 'Makefile', '.dockerignore', 'requirements-dev.txt']) {
    assert.equal(planBuild({ changedFiles: [f], matrix: MATRIX }).mode, 'all', `${f} is root build config`);
  }
  const p = planBuild({ changedFiles: ['README.md', 'apps/loom-trino/a'], matrix: MATRIX });
  assert.deepEqual(p.build, ['loom-trino'], `README.md must not widen the build, got ${p.build}`);
  // Root-config match is anchored to the repo root: a nested package.json is the app's own.
  const n = planBuild({ changedFiles: ['apps/loom-trino/package.json'], matrix: MATRIX });
  assert.deepEqual(n.build, ['loom-trino'], 'apps/loom-trino/package.json is that app only, not root config');
});

test('only unowned paths (docs) build NOTHING and carry ALL 13 (input: docs/x.md)', () => {
  const p = planBuild({ changedFiles: ['docs/x.md', 'apps/fiab-dbt-runner/main.py'], matrix: MATRIX });
  assert.equal(p.mode, 'subset');
  assert.deepEqual(p.build, [], 'no matrix context changed');
  assert.equal(p.carry.length, 13, 'every app must still receive the new SHA tag');
});

test('FAIL CLOSED: null diff, empty diff, empty/odd inputs all build ALL with a reason', () => {
  const a = planBuild({ changedFiles: null, matrix: MATRIX, unknown: 'base missing' });
  assert.equal(a.mode, 'all', 'changedFiles=null (diff not computable) must build ALL');
  assert.match(a.reason, /base missing/, 'the reason must carry WHY, so the log says so');
  const b = planBuild({ changedFiles: [], matrix: MATRIX });
  assert.equal(b.mode, 'all', 'an EMPTY diff is what a wrong base looks like; must build ALL, not nothing');
  assert.throws(() => planBuild({ changedFiles: ['x'], matrix: [] }), /matrix is empty/, 'empty matrix must throw, not plan');
});

// ---- readChangedFiles: each failure branch must yield null + a reason ----------
const okRun = (calls = []) => (cmd, args) => { calls.push([cmd, ...args]); return args[0] === 'diff' ? 'apps/loom-trino/a\n\nscripts/x\r\n' : ''; };

test('readChangedFiles: success returns the diff lines and uses base..sha (input: a good base)', () => {
  const calls = [];
  const r = readChangedFiles({ base: BASE, sha: SHA, run: okRun(calls) });
  assert.deepEqual(r.files, ['apps/loom-trino/a', 'scripts/x'], 'blank lines dropped, CR stripped');
  assert.ok(calls.some((c) => c.includes(`${BASE}..${SHA}`)), 'diff must be base..sha; a swapped range would list the reverse change');
});

test('readChangedFiles: every unestablished base returns files=null (inputs: blank, zeros, short, non-hex)', () => {
  const never = () => { throw new Error('git must not be called for an invalid base'); };
  for (const [label, base] of [['blank', ''], ['undefined', undefined], ['zero sha', '0'.repeat(40)], ['short', 'abc123'], ['non-hex', 'z'.repeat(40)]]) {
    const r = readChangedFiles({ base, sha: SHA, run: never });
    assert.equal(r.files, null, `base ${label}: must be null (=> ALL), got ${JSON.stringify(r.files)}`);
    assert.ok(r.unknown, `base ${label}: must say why`);
  }
  assert.equal(readChangedFiles({ base: BASE, sha: 'nope', run: never }).files, null, 'a bad sha must be null');
});

test('readChangedFiles: base absent from checkout, non-ancestor, and git diff failure each return null', () => {
  const failOn = (verb) => (cmd, args) => {
    if (args[0] === verb) throw new Error(`boom ${verb}`);
    return '';
  };
  const missing = readChangedFiles({ base: BASE, sha: SHA, run: failOn('cat-file') });
  assert.equal(missing.files, null, 'force push / shallow: cat-file failing must be null');
  assert.match(missing.unknown, /not in this checkout/);
  const nonAnc = readChangedFiles({ base: BASE, sha: SHA, run: failOn('merge-base') });
  assert.equal(nonAnc.files, null, 'history rewrite: merge-base failing must be null');
  assert.match(nonAnc.unknown, /not an ancestor/);
  const diff = readChangedFiles({ base: BASE, sha: SHA, run: failOn('diff') });
  assert.equal(diff.files, null, 'diff failing must be null, not an empty list');
  assert.match(diff.unknown, /git diff failed/);
});

// ---- CLI against a REAL git repo (no injected runner) ---------------------------
function sh(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function plan(cwd, base, sha) {
  const out = execFileSync(process.execPath, [PLANNER, '--matrix', JSON.stringify(MATRIX), '--sha', sha, '--base', base], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out.trim().split('\n').pop());
}

test('CLI on a real repo: one-app commit builds one app; unknown/rewritten base builds ALL', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plan-img-'));
  try {
    sh(dir, 'init', '-q', '-b', 'main');
    sh(dir, 'config', 'user.email', 't@example.invalid');
    sh(dir, 'config', 'user.name', 't');
    sh(dir, 'config', 'commit.gpgsign', 'false');
    mkdirSync(join(dir, 'apps', 'loom-trino'), { recursive: true });
    mkdirSync(join(dir, 'apps', 'fiab-mcp-bridge'), { recursive: true });
    writeFileSync(join(dir, 'apps', 'loom-trino', 'f'), '1');
    writeFileSync(join(dir, 'apps', 'fiab-mcp-bridge', 'f'), '1');
    sh(dir, 'add', '-A'); sh(dir, 'commit', '-q', '-m', 'one');
    const c1 = sh(dir, 'rev-parse', 'HEAD');
    writeFileSync(join(dir, 'apps', 'loom-trino', 'f'), '2');
    sh(dir, 'add', '-A'); sh(dir, 'commit', '-q', '-m', 'two');
    const c2 = sh(dir, 'rev-parse', 'HEAD');

    const p = plan(dir, c1, c2);
    assert.equal(p.mode, 'subset', `c1..c2 touched only apps/loom-trino: ${p.reason}`);
    assert.deepEqual(p.build, ['loom-trino'], 'only loom-trino changed between c1 and c2');
    assert.equal(p.carry.length, 12);

    const absent = plan(dir, 'c'.repeat(40), c2);
    assert.equal(absent.mode, 'all', 'a base sha that is not in the repo (force push) must build ALL');
    assert.match(absent.reason, /not in this checkout/);

    sh(dir, 'checkout', '-q', '--orphan', 'other');
    writeFileSync(join(dir, 'apps', 'loom-trino', 'f'), '3');
    sh(dir, 'add', '-A'); sh(dir, 'commit', '-q', '-m', 'unrelated');
    const c3 = sh(dir, 'rev-parse', 'HEAD');
    const nonAnc = plan(dir, c1, c3);
    assert.equal(nonAnc.mode, 'all', 'c1 is not an ancestor of the orphan commit c3 (history rewrite) so ALL');
    assert.match(nonAnc.reason, /not an ancestor/);

    const noBase = plan(dir, '', c2);
    assert.equal(noBase.mode, 'all', 'no prior successful run (empty base) must build ALL');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI exits 1 on an unusable matrix (input: --matrix not JSON)', () => {
  assert.throws(
    () => execFileSync(process.execPath, [PLANNER, '--matrix', 'nope', '--sha', SHA], { stdio: 'pipe' }),
    (e) => e.status === 1,
    'a non-JSON matrix cannot be planned and must exit 1',
  );
});

// ---- workflow wiring ------------------------------------------------------------
function jobBody(text, id) {
  const lines = text.slice(text.indexOf('\njobs:\n') + 6).split('\n');
  let cur = null; const out = {};
  for (const l of lines) {
    const m = /^  ([a-z0-9_-]+):\s*$/.exec(l);
    if (m) { cur = m[1]; out[cur] = ''; continue; }
    if (cur) out[cur] += `${l}\n`;
  }
  return out[id];
}

test('workflow: the plan is gated to a DIRECT push with apps=all (inputs: dispatch, workflow_call, apps=x)', () => {
  const body = jobBody(wfText, 'resolve');
  assert.match(body, /GITHUB_EVENT_NAME" == "push"/, 'dispatch must not be planned: a non-push event would drop requested apps');
  assert.match(body, /GITHUB_WORKFLOW" == "build-fiab-images-acr-tasks"/, 'a reusable-workflow call from a push-triggered caller must not be planned (github.workflow is the caller)');
  assert.match(body, /"\$INPUT" == "all"/, 'an explicit apps list must be built as asked');
  assert.match(body, /plan-image-builds\.mjs --matrix "\$APPS" --sha "\$GITHUB_SHA" --base "\$BASE"/, 'the resolve step must call the planner');
  assert.match(body, /building ALL \(fail closed\)/, 'a planner failure must fall back to ALL, loudly');
  assert.match(body, /fetch-depth: 0/, 'without full history the base is never an ancestor-checkable object');
  assert.match(body, /actions: read/, 'listing workflow runs needs actions: read; without it the base lookup fails and every push builds ALL');
});

test('workflow: carry_forward exists, re-tags and VERIFIES, and is awaited by acr_restore and gated on carry list', () => {
  const body = jobBody(wfText, 'carry_forward');
  assert.ok(body, 'job carry_forward must exist: unchanged apps would have no <app>:<sha> tag and the rolls would reference a missing tag');
  assert.match(body, /imagetools create --tag/, 'the re-tag must copy the manifest');
  assert.match(body, /"\$DST" != "\$SRC"/, 'the new tag digest must be compared to the source digest (no unverified tag)');
  assert.match(body, /carry_apps != '\[\]'/, 'carry job must be skipped when nothing is carried (dispatch)');
  assert.match(jobBody(wfText, 'acr_restore'), /needs: \[resolve, build, acr_enable, carry_forward\]/, 'registry must not be re-locked under a running carry');
  assert.match(jobBody(wfText, 'build'), /build_count != '0'/, 'an all-carry push has an empty matrix; build must be skipped, not fail on it');
});

test('workflow: the guard-read default matrix literal is still the first APPS=[...] line', () => {
  const first = /APPS='(\[[^']*\])'/.exec(wfText);
  assert.ok(first && JSON.parse(first[1]).length === 13, 'check-build-trigger-covers-matrix reads this literal; the plan must not replace it');
});

test('roll gate: a push run that did not build loom-console and carried it forward does not roll', () => {
  assert.match(rollText, /console_build=carried-forward/, 'without this the roll marker gate (expected=head_sha) fails on a carried console and rolls back a healthy estate');
  assert.match(rollText, /\^Carry forward unchanged images/, 'must key off the producer carry job name');
  assert.ok(wfText.includes('name: Carry forward unchanged images'), 'the job name the roll greps for must match the producer');
});
