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
import { planBuild, readChangedFiles, SHARED_PREFIXES, CONSOLE } from '../plan-image-builds.mjs';

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

test('lifted matrix is the 14-app default set (input: an app dropped from or added to APPS)', () => {
  assert.equal(MATRIX.length, 14, `matrix has ${MATRIX.length} apps; update this pin AND the carry contract if it changed on purpose`);
});

test('a file in EACH matrix context builds exactly that app plus the always-built console', () => {
  for (const app of MATRIX) {
    const p = planBuild({ changedFiles: [`${app.ctx.replace('./', '')}/src/x.ts`], matrix: MATRIX });
    const want = [...new Set([app.name, CONSOLE])].sort();
    assert.deepEqual([...p.build].sort(), want, `file under ${app.ctx}: must build ${want}, got ${p.build}`);
    assert.equal(p.carry.length, 14 - want.length, `file under ${app.ctx}: the rest must be carried, got ${p.carry.length}`);
    assert.equal(p.mode, 'subset', `file under ${app.ctx}: mode must be subset`);
  }
});

test('B1: the console is in the plan for a loom-unity-ONLY push (input: apps/loom-unity/x, no console path)', () => {
  const p = planBuild({ changedFiles: ['apps/loom-unity/src/authz.py'], matrix: MATRIX });
  assert.ok(p.build.includes(CONSOLE), `a carried console strands an unrolled console change when its roll replaces a pending one; build=${p.build}`);
  assert.ok(!p.carry.includes(CONSOLE), 'console must never be in carry');
  assert.ok(p.build.includes('loom-unity'), 'the changed app is still built');
});

test('S2: console-embedded corpus paths alone still yield a plan WITH the console (inputs: each corpus root)', () => {
  for (const f of ['docs/fiab/x.md', 'PRPs/active/a.md', 'PRPs/completed/csa-loom-pillar/b.md', 'PRPs/archive/c.md']) {
    const p = planBuild({ changedFiles: [f], matrix: MATRIX });
    assert.deepEqual(p.build, [CONSOLE], `${f}: the corpus is baked into the console image; plan must build it, got ${p.build}`);
    assert.equal(p.carry.length, 13, `${f}: the other 13 are carried`);
  }
});

test('build and carry partition the matrix: no app lost, none in both (input: two apps changed)', () => {
  const p = planBuild({ changedFiles: ['apps/loom-trino/a', 'apps/fiab-mcp-config/b'], matrix: MATRIX });
  assert.deepEqual([...p.build].sort(), ['loom-console', 'loom-mcp', 'loom-trino'], 'loom-mcp is dir fiab-mcp-config (name != dir stem); console always built');
  assert.deepEqual([...p.build, ...p.carry].sort(), [...names].sort(), 'build+carry must equal the matrix exactly');
  assert.equal(p.build.filter((n) => p.carry.includes(n)).length, 0, 'an app in both lists would be built AND re-tagged over');
});

test('a sibling directory sharing a name prefix does NOT map to the app (input: apps/loom-trino-extra/x)', () => {
  // loom-trino is used (not the console, which is always built and would hide the defect).
  const p = planBuild({ changedFiles: ['apps/loom-trino-extra/x.ts', 'apps/loom-unity/a'], matrix: MATRIX });
  assert.deepEqual([...p.build].sort(), ['loom-console', 'loom-unity'], `prefix match without a trailing slash would add loom-trino; got ${p.build}`);
  assert.ok(p.ignored.includes('apps/loom-trino-extra/x.ts'), 'the unowned path must be listed as ignored');
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
  assert.deepEqual([...p.build].sort(), ['loom-console', 'loom-trino'], `README.md must not widen the build, got ${p.build}`);
  // Root-config match is anchored to the repo root: a nested package.json is the app's own.
  const n = planBuild({ changedFiles: ['apps/loom-trino/package.json'], matrix: MATRIX });
  assert.deepEqual([...n.build].sort(), ['loom-console', 'loom-trino'], 'apps/loom-trino/package.json is that app only, not root config');
});

test('only unowned paths build JUST the console and carry the other 13 (input: docs + an unmatrixed app)', () => {
  const p = planBuild({ changedFiles: ['docs/x.md', 'apps/fiab-dbt-runner/main.py'], matrix: MATRIX });
  assert.equal(p.mode, 'subset');
  assert.deepEqual(p.build, [CONSOLE], 'no matrix context changed, so only the always-built console');
  assert.equal(p.carry.length, 13, 'every other app must still receive the new SHA tag');
  assert.ok(p.ignored.includes('apps/fiab-dbt-runner/main.py'), 'the unowned path is reported as ignored');
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
const okRun = (calls = []) => (cmd, args) => { calls.push([cmd, ...args]); return args.includes('diff') ? 'apps/loom-trino/a\0scripts/x \r\0' : ''; };

test('readChangedFiles: success splits the diff on NUL and uses base..sha (input: a good base)', () => {
  const calls = [];
  const r = readChangedFiles({ base: BASE, sha: SHA, run: okRun(calls) });
  assert.deepEqual(r.files, ['apps/loom-trino/a', 'scripts/x \r'], 'NUL-separated names kept verbatim (a trailing space/CR is part of the name)');
  assert.ok(calls.some((c) => c.includes(`${BASE}..${SHA}`)), 'diff must be base..sha; a swapped range would list the reverse change');
  const d = calls.find((c) => c.includes('diff'));
  assert.ok(d.includes('-z'), 'without -z git C-quotes odd names and the path maps to no app');
  assert.ok(d.includes('core.quotepath=false'), 'quotepath must be off so non-ASCII names are not octal-escaped');
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
    if (args.includes(verb)) throw new Error(`boom ${verb}`);
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
    assert.deepEqual([...p.build].sort(), ['loom-console', 'loom-trino'], 'only loom-trino changed between c1 and c2 (+ always-built console)');
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
  assert.match(body, /scripts\/ci\/carry-forward-retag\.sh/, 'the re-tag + digest verification live in the tested script; inline logic would be untested (see carry-forward-retag.test.mjs)');
  assert.doesNotMatch(body, /imagetools create/, 'imagetools create rewrites the manifest (new digest, run 39820244128)');
  assert.match(body, /carry_apps != '\[\]'/, 'carry job must be skipped when nothing is carried (dispatch)');
  assert.match(jobBody(wfText, 'acr_restore'), /needs: \[resolve, build, acr_enable, carry_forward\]/, 'registry must not be re-locked under a running carry');
  assert.match(jobBody(wfText, 'build'), /build_count != '0'/, 'an all-carry push has an empty matrix; build must be skipped, not fail on it');
});

test('workflow: the guard-read default matrix literal is still the first APPS=[...] line', () => {
  const first = /APPS='(\[[^']*\])'/.exec(wfText);
  assert.ok(first && JSON.parse(first[1]).length === 14, 'check-build-trigger-covers-matrix reads this literal; the plan must not replace it');
});

test('roll gate has NO carried-forward skip: every push run builds and rolls the console (B1)', () => {
  // Pair: absence of the skip + presence of the unchanged success path.
  assert.doesNotMatch(rollText, /carried-forward/, 'a skip for a carried console strands an unrolled console change when its roll replaces a pending one');
  assert.match(rollText, /if \[ "\$CONCLUSION" = 'success' \]; then\s+echo "proceed=true"/, 'the success path must still proceed');
});

test('S1: odd file names (double quote, non-ASCII) map to the right app via a real git diff -z', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plan-odd-'));
  const idx = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    idx(dir, 'init', '-q', '-b', 'main');
    idx(dir, 'config', 'user.email', 't@example.invalid');
    idx(dir, 'config', 'user.name', 't');
    idx(dir, 'config', 'commit.gpgsign', 'false');
    idx(dir, 'config', 'core.protectNTFS', 'false'); // Windows git otherwise refuses a name with a quote
    const blob = (txt) => execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, input: txt, encoding: 'utf8' }).trim();
    // Built through the index: a double quote is not a legal file name on Windows.
    idx(dir, 'update-index', '--add', '--cacheinfo', `100644,${blob('1')},apps/loom-unity/seed`);
    idx(dir, 'commit', '-q', '-m', 'one');
    const c1 = idx(dir, 'rev-parse', 'HEAD');
    const odd = 'apps/loom-trino/we"ird é.txt';
    idx(dir, 'update-index', '--add', '--cacheinfo', `100644,${blob('2')},${odd}`);
    idx(dir, 'commit', '-q', '-m', 'two');
    const c2 = idx(dir, 'rev-parse', 'HEAD');
    // Control: what the pre-fix invocation returns for this name (C-quoted, leading quote).
    const quoted = idx(dir, 'diff', '--name-only', `${c1}..${c2}`);
    assert.ok(quoted.startsWith('"'), `positive control: plain git diff must C-quote this name, got ${quoted}`);
    const p = plan(dir, c1, c2);
    assert.equal(p.mode, 'subset', `odd name must not trip fail-closed: ${p.reason}`);
    assert.ok(p.build.includes('loom-trino'), `${odd} lives under apps/loom-trino; a quoted name starts with " and matches no context, so it would be ignored. build=${p.build}`);
    assert.ok(!p.build.includes('loom-unity'), 'the unchanged loom-unity must not be built');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
