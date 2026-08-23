#!/usr/bin/env node
/**
 * deploy-fiab-guard — the az binary is RESOLVED, and the resolution reaches the
 * SPAWN (#3704).
 *
 * ## What was wrong
 *
 * `scripts/ci/deploy-fiab-guard.mjs` decides `deploy_apps_enabled` and
 * `deploy_sub` — the deploy's two most consequential outputs — and it reached
 * Azure through a hardcoded `const AZ = 'az';`. A boundary whose Azure CLI is
 * installed under a different name, wrapped, or pinned to a specific build had
 * no way to say so, and the failure was not loud: a spawn that cannot find the
 * binary lands in countExistingHubs's catch, which returns null; null is
 * UNKNOWN; and UNKNOWN on a dispatch REFUSES the deploy. Fail-closed is correct
 * for an unknown hub count, but "the CLI is not where I assumed" and "Resource
 * Graph refused me" then produce the same verdict from different causes — the
 * deploy-integrity.md R7 shape.
 *
 * ## Why these assertions spawn the script instead of importing it
 *
 * deploy-fiab-guard.mjs runs its whole guard at module scope, so importing it to
 * unit-test the resolver would EXECUTE the guard. More importantly, a unit test
 * of `azBinary()` proves only that a function returns a string — a resolver
 * nothing consults is the same defect wearing a different hat. These tests spawn
 * the real script and assert on text NODE'S OWN SPAWN produced, which can only
 * name the binary the spawn was actually given.
 *
 * ## The observable, and why it is this one
 *
 * The first cut of this suite used an EXECUTABLE stub that printed a hub count,
 * so the arms differed by the guard's whole verdict (PROCEED vs REFUSE). That
 * needed `shell: true` to spawn a `.cmd` on Windows — and measured, that shell
 * makes cmd.exe read the `|` in the guard's KQL pipeline as a SHELL pipe
 * ("'project' is not recognized as an internal or external command"). Turning
 * the shell on to make a TEST pass would have shipped a mangled query into the
 * deploy path. So the guard keeps its documented no-shell behaviour, and the
 * observable here is the one that works identically on every platform: WHICH
 * BINARY THE SPAWN NAMES IN ITS OWN ERROR.
 *
 * ## The controls, and what each one dies to
 *
 *   CLEAN   LOOM_AZ_BIN=<unique fake path> ⇒ the spawn's own error names THAT
 *           path.
 *   CONTROL the same environment against a source mutated back to the hardcoded
 *           `'az'` ⇒ the fake path appears NOWHERE in the output and the spawn
 *           names `az` instead. The measurement MOVES under the exact mutation
 *           #3704 filed.
 *   DEFAULT LOOM_AZ_BIN unset ⇒ still plain `az` / `az.cmd`, and an unreachable
 *           CLI is UNKNOWN ⇒ REFUSE. Pins that the override changed nothing for
 *           existing callers, and that the failure is still fail-CLOSED.
 *
 * PATH is stripped in every arm: on a workstation or runner that HAS the Azure
 * CLI installed, the mutated arm would reach a real `az`, succeed, and the
 * control would prove nothing about which binary was chosen.
 *
 * Run: node --test scripts/ci/__tests__/deploy-fiab-guard.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const CI_DIR = path.join(REPO, 'scripts', 'ci');
const SCRIPT = path.join(CI_DIR, 'deploy-fiab-guard.mjs');
const IS_WIN = process.platform === 'win32';

/**
 * A path that names no executable on any machine.
 *
 * mkdtempSync, not a constant name under os.tmpdir(): a predictable path in a
 * world-writable root can be pre-created or symlinked by another local user
 * (check-temp-artifact-safety.mjs flags exactly that, and flagged this).
 * Nothing is ever WRITTEN to it — the whole point is that the spawn cannot find
 * it — but the guard's rule holds regardless of intent.
 */
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-guard-az-'));
const FAKE_AZ = path.join(SCRATCH, 'loom-not-a-real-cli');
test.after(() => fs.rmSync(SCRATCH, { recursive: true, force: true }));

/** Node's spawn failure text, across platforms. */
const SPAWN_FAILED = /ENOENT|not recognized|cannot find|No such file/i;

/**
 * Spawn the guard with a deterministic, CLI-free environment.
 *
 * PATH is stripped of everything that could hold a real Azure CLI. On Windows it
 * is narrowed to System32 rather than emptied: an empty PATH there breaks
 * cmd.exe's own helpers and every arm fails for a reason that has nothing to do
 * with the subject. The Azure CLI installs to its own directory, not System32,
 * so the narrowed PATH still cannot reach it — and if it somehow could, the
 * DEFAULT arm asserts a REFUSAL and goes red rather than silently passing.
 */
function runGuard(extraEnv = {}, script = SCRIPT) {
  const scrubbedPath = IS_WIN
    ? [
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'),
      process.env.SystemRoot || 'C:\\Windows',
    ].join(';')
    : '';
  const env = {
    PATH: scrubbedPath,
    Path: scrubbedPath,
    ...(IS_WIN
      ? { ComSpec: process.env.ComSpec, SystemRoot: process.env.SystemRoot, TEMP: os.tmpdir() }
      : {}),
    // A dispatch, not a schedule: on a schedule an UNKNOWN hub count PROCEEDS
    // with a warning, which would collapse two of the arms onto one verdict.
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    CSA_LOOM_TOPOLOGY: 'tenant',
    CSA_LOOM_TARGET_SUBSCRIPTION: '',
    CSA_LOOM_SUBSCRIPTION_OVERRIDE: '',
    INPUT_ALLOW_EXISTING_HUB: 'false',
    INPUT_PURVIEW_ENABLED: 'true',
    INPUT_AZURE_MAPS_ENABLED: 'true',
    INPUT_FIREWALL_ENABLED: 'false',
    INPUT_DEPLOY_APPS_ENABLED: 'true',
    INPUT_SKIP_ROLE_GRANTS: 'false',
    INPUT_FRONT_DOOR_ENABLED: 'true',
    ...extraEnv,
  };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8', env, cwd: REPO });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

test('CLEAN — LOOM_AZ_BIN reaches the SPAWN: the spawn error names the OVERRIDDEN binary', () => {
  const r = runGuard({ LOOM_AZ_BIN: FAKE_AZ });

  assert.match(r.out, /hub-count query failed/, `the guard never attempted a query:\n${r.out}`);
  // The label is this repo's own interpolation, so on its own it would prove
  // nothing — a hardcoded spawn with a resolved label would still print it.
  assert.ok(r.out.includes(`az binary: ${FAKE_AZ}`), `the warning did not name the binary it tried:\n${r.out}`);
  // THIS is the load-bearing assertion: the text after the label is Node's own
  // spawn failure, and it can only carry FAKE_AZ if FAKE_AZ is what was spawned.
  const after = r.out.slice(r.out.indexOf(`az binary: ${FAKE_AZ}`) + `az binary: ${FAKE_AZ}`.length);
  assert.match(after, SPAWN_FAILED, `no spawn failure followed the label:\n${r.out}`);
  assert.ok(
    after.includes(FAKE_AZ) || after.includes(path.basename(FAKE_AZ)),
    `the SPAWN's own error did not name the resolved binary — the resolver was interpolated into a message while something else was spawned:\n${r.out}`,
  );
});

/**
 * `from './x'` / `import './x'` / `import('./x')` — every RELATIVE specifier.
 * Deliberately not keyed to the one import this guard has today: a second one
 * added later must be rewritten too, or the mutant would resolve it against the
 * temp directory and die with ERR_MODULE_NOT_FOUND instead of measuring.
 */
const REL_SPECIFIER = /\b(from|import)(\s*\(?\s*)(['"])(\.{1,2}\/[^'"]+)\3/g;

/**
 * Is `target` inside the repo tree?
 *
 * `path.relative()`, NOT `startsWith(path.resolve(REPO) + path.sep)`, which is
 * what this used to be. A prefix test compares strings CASE-SENSITIVELY and
 * NTFS is case-INSENSITIVE, so `…\scripts\ci` and `…\SCRIPTS\CI` name the same
 * directory while only one of them trips the prefix. Measured on this file with
 * the OLD prefix test restored and a poller sampling `scripts/ci` every 3ms:
 * `mkdtempSync(path.join(CI_DIR.toLowerCase(), 'loom-guard-control-'))` left
 * the CONTROL test at RC=0, pass=1, fail=0 while the poller OBSERVED
 * `loom-guard-control-XXXXXX/deploy-fiab-guard.__control__.mjs` inside
 * `scripts/ci`
 * — the precise artifact this suite was changed to stop writing, back in the
 * precise directory, on a green run. `path.win32.relative()` lower-cases both
 * sides before comparing, so it sees through that; the POSIX build is
 * unaffected because there the two names really are different directories.
 *
 * realpathSync.native() first, so a junction or symlink whose target is inside
 * the tree is resolved rather than taken at face value. It throws on a path
 * that does not exist yet, so only the DIRECTORY is canonicalised and the
 * basename is rejoined — canonicalising `path.resolve(target)` directly would
 * silently fall back to the uncanonicalised string for every not-yet-written
 * file, i.e. for every call this function actually gets.
 */
function insideRepo(target) {
  const canon = (p) => {
    try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
  };
  const abs = path.resolve(target);
  const canonAbs = path.join(canon(path.dirname(abs)), path.basename(abs));
  const rel = path.relative(canon(REPO), canonAbs);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * Assert `prefix` names a location OUTSIDE the repo tree, then return it.
 *
 * Wrapped around the mkdtemp argument rather than checked on the following
 * line so the check runs BEFORE anything is created: a prefix pointed back at
 * the tree then never creates a directory there at all. The assertion this
 * replaces sat AFTER mkdtempSync, so it could only complain about a directory
 * it had already made — and because it threw before `dir` was returned, the
 * caller's `finally` never ran and a FIRING guard stranded the very artifact
 * it exists to keep out of the tree.
 *
 * Inline for a second reason: check-temp-artifact-safety.mjs reads LINE BY
 * LINE, so hoisting the `path.join(os.tmpdir(), …)` onto its own line reads to
 * that guard as a constant shared-temp path with no mkdtemp — measured, it
 * turned that guard from RC=0 to RC=1 with five hits. Keeping the join inside
 * the mkdtempSync call keeps both guards honest instead of trading one for the
 * other.
 */
function outOfTree(prefix) {
  assert.ok(
    !insideRepo(`${prefix}probe`),
    `the scratch root for the mutated copy is inside the repo tree (${prefix}) — a concurrent suite walks `
      + 'scripts/ci and opens what it lists, so anything transient in there is a race',
  );
  return prefix;
}

/**
 * Write a mutated copy of a `scripts/ci` guard OUTSIDE the repo tree.
 *
 * ── WHY OUT OF TREE ────────────────────────────────────────────────────────
 * The copy used to be written to `scripts/ci/deploy-fiab-guard.__control__.mjs`
 * — i.e. INSIDE a directory that another suite in the same `node --test`
 * invocation walks. check-role-guid-consistency's scan() lists `scripts/ci` and
 * then opens what it listed; node:test runs suites concurrently; so the listing
 * could name this transient file and the open could land after the `finally`
 * below had already removed it:
 *
 *   not ok - the repo is clean — every resolved binding carries its documented id
 *     error: "ENOENT: no such file or directory, open '…/deploy-fiab-guard.__control__.mjs'"
 *
 * That reddened PRs which touch no JavaScript at all (#3892, run 32613872830).
 * Reproduced locally at 1 run in 20. It is the #3459 class: a suite transiently
 * writing where other tooling reads.
 *
 * A unique per-run NAME would NOT have fixed it — the scanner would still list
 * the file and it would still vanish before the read. The cause is the
 * LOCATION, so the copy leaves the scanned tree entirely.
 *
 * ── WHY THAT IS SAFE FOR THIS SUBJECT (measured, not assumed) ──────────────
 * deploy-fiab-guard.mjs derives NOTHING from its own location: no
 * `import.meta.url`, no `__dirname`. Its only location dependency is the
 * relative specifier `./deploy-trigger-policy.mjs`, rewritten below to an
 * absolute `file:` URL of the REAL sibling — so the mutant runs against the
 * same module the in-tree copy did, and the two arms still differ by exactly
 * the mutation and by nothing else. cwd is not a variable either: runGuard()
 * pins `cwd: REPO` for every arm. The CONTROL test re-establishes the
 * location-independence property on every run, so an edit that makes the guard
 * location-aware fails loudly rather than quietly neutering this arm.
 *
 * Precedent in this same directory: check-licenses-cannot-run.test.mjs builds a
 * whole temp "repo" for a guard that IS location-derived.
 */
function writeMutantOutsideTheTree(text, basename) {
  const rewritten = text.replace(REL_SPECIFIER, (_m, kw, gap, q, spec) => {
    const abs = path.resolve(CI_DIR, spec);
    assert.ok(fs.existsSync(abs), `the control rewrote \`${spec}\` to ${abs}, which does not exist`);
    return `${kw}${gap}${q}${pathToFileURL(abs).href}${q}`;
  });
  assert.doesNotMatch(
    rewritten,
    new RegExp(REL_SPECIFIER.source),
    'a relative import survived the rewrite, so the mutant would resolve it against the TEMP directory and '
      + 'this arm would fail to load instead of measuring anything',
  );

  // mkdtempSync, not a fixed name: a predictable path in a world-writable root
  // can be pre-created or symlinked by another local user, which is exactly
  // what check-temp-artifact-safety.mjs flags. outOfTree() asserts the prefix
  // is out of tree BEFORE mkdtemp creates anything.
  const dir = fs.mkdtempSync(outOfTree(path.join(os.tmpdir(), 'loom-guard-control-')));
  const file = path.join(dir, basename);
  // Re-checked on the path that was actually created. mkdtempSync could land
  // somewhere the prefix did not name — a TMPDIR that is a junction into the
  // tree is the realistic case, and insideRepo() resolves it. Cleaned up BEFORE
  // failing, so this path cannot strand anything either.
  if (insideRepo(file)) {
    fs.rmSync(dir, { recursive: true, force: true });
    assert.fail(
      `the mutated copy must not be written inside the repo tree (${file}) — a concurrent suite walks `
        + 'scripts/ci and opens what it lists, so anything transient in there is a race',
    );
  }
  fs.writeFileSync(file, rewritten);
  return { dir, file };
}

/**
 * Every way an ES module can derive a path from its OWN location.
 *
 * Keyed to the SHAPE — the whole `import.meta` property-access family — not to
 * a list of spellings. The list it replaces was `/import\.meta\.url|__dirname/`,
 * and `import.meta.dirname` matches NEITHER alternative. Measured, with the old
 * pattern restored and the CONTROL test run in isolation: a subject given
 * `const SELF_DIR = import.meta.dirname;` left it at RC=0, pass=1, fail=0 —
 * fully blind. With this pattern the same mutation is RC=1, pass=0, fail=1, and
 * so are the `new URL('.', import.meta.url)` and `import.meta.filename`
 * spellings.
 *
 * That spelling is not hypothetical. `import.meta.dirname` / `.filename` appear
 * 12 times across 4 files under `scripts/ci` — including the production script
 * `deploy-retry.mjs:328`, whose own comment gives the rationale ("resolved from
 * this module rather than `process.cwd()`"). It is the idiom of this directory,
 * so it is the spelling a future edit is MOST likely to reach for.
 *
 * Matching `import.meta` wholesale rather than named properties also covers
 * `import.meta.resolve()` and whatever Node adds to `import.meta` next. No `\b`
 * anywhere on purpose: over-matching costs a loud, trivially-fixed red, and
 * under-matching is the failure this pattern exists to stop.
 */
const LOCATION_DERIVED = /import\.meta|__dirname|__filename/;

test('EMBEDDED CONTROL — the location-independence pattern sees every spelling', () => {
  // POPULATION. On a clean tree the assertion in the CONTROL test below is a
  // doesNotMatch against a subject that contains none of these, so it cannot
  // move and on its own proves nothing about what the pattern can SEE. These
  // fixtures are its population.
  for (const shape of [
    "const SELF_DIR = new URL('.', import.meta.url).pathname;",
    'const SELF_DIR = import.meta.dirname;',
    'const SELF_FILE = import.meta.filename;',
    "const SIB = import.meta.resolve('./x.mjs');",
    "const d = require('path').dirname(__filename);",
    'const here = __dirname;',
  ]) {
    assert.match(shape, LOCATION_DERIVED, `the pattern is blind to: ${shape}`);
  }
  for (const safe of [
    'const root = process.cwd();',
    "const p = path.resolve('a', 'b');",
    'const importantMetadata = 1;',
  ]) {
    assert.doesNotMatch(safe, LOCATION_DERIVED, `the pattern over-matches: ${safe}`);
  }
});

test('EMBEDDED CONTROL — the containment check is not fooled by case or a sibling prefix', () => {
  // POPULATION. writeMutantOutsideTheTree() calls insideRepo() exactly once per
  // run and, on a clean run, always gets `false` — so that call site can never
  // exercise the true branch and proves nothing on its own. These fixtures are
  // the population; three of them are the shapes that defeated the startsWith()
  // this replaced.
  assert.equal(insideRepo(path.join(CI_DIR, 'x.__control__.mjs')), true, 'an in-tree path must be seen');
  // The system temp root itself, with no constructed child: a `path.join` onto
  // `os.tmpdir()` on this line would read to check-temp-artifact-safety.mjs as
  // a constant shared-temp artifact path, and this predicate never creates or
  // writes anything. Non-existent paths are covered by the two cases below.
  assert.equal(insideRepo(os.tmpdir()), false, 'the system temp root must be allowed');

  // The sibling-directory trap: `startsWith(REPO)` without a separator accepts
  // `<repo>-other`, which is a different tree.
  assert.equal(insideRepo(`${REPO}-other${path.sep}x.mjs`), false, 'a sibling of the repo is not inside it');

  // The case dodge. Whether the lower-cased path is the SAME directory is a
  // property of the filesystem, so it is PROBED rather than assumed: on NTFS it
  // is the same directory and containment must hold; on a case-sensitive
  // filesystem it is genuinely a different path and `false` is the correct
  // answer, not a miss. Probing also stays correct if the repo is checked out
  // at an already-lower-case path, where the two arms collapse.
  const loweredDir = CI_DIR.toLowerCase();
  const sameDirWhenLowered = fs.existsSync(loweredDir);
  assert.equal(
    insideRepo(path.join(loweredDir, 'x.__control__.mjs')),
    sameDirWhenLowered,
    'a case-folded in-tree path must be judged by whether the filesystem treats it as the same directory — '
      + 'this is the exact dodge that put deploy-fiab-guard.__control__.mjs back into scripts/ci on a green run',
  );
});

test('CONTROL — re-hardcoding the binary makes the measurement MOVE', () => {
  // The exact mutation #3704 filed, applied to a COPY: a suite that rewrites a
  // deploy script in place can leave the tree dirty if it dies mid-test.
  const original = fs.readFileSync(SCRIPT, 'utf8');

  // The mutant runs from a temp directory (see writeMutantOutsideTheTree), so
  // anything this guard derived from its OWN location would differ between the
  // arms for a reason that is not the mutation. It derives nothing today; this
  // pins that rather than assuming it. cwd is not in this set on purpose —
  // runGuard() passes `cwd: REPO` to every arm, so a cwd-derived path is
  // identical either way.
  assert.doesNotMatch(
    original,
    LOCATION_DERIVED,
    'deploy-fiab-guard.mjs now derives a path from its own location, so a copy running from a temp directory '
      + 'is no longer the same subject and this control would be measuring something else. Give the copy the '
      + 'same root (see check-licenses-cannot-run.test.mjs) — do NOT move it back into scripts/ci, which a '
      + 'concurrent suite scans.',
  );

  const nl = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.split(nl);
  const at = lines.findIndex((l) => /^\s*if \(env\.LOOM_AZ_BIN\) return env\.LOOM_AZ_BIN;\s*$/.test(l));
  assert.ok(at >= 0, 'the mutation did not apply — the resolver line was not found, so this control proves NOTHING');
  lines[at] = "  return 'az'; // MUTATED BY THE CONTROL";

  const { dir, file } = writeMutantOutsideTheTree(lines.join(nl), 'deploy-fiab-guard.__control__.mjs');
  try {
    const r = runGuard({ LOOM_AZ_BIN: FAKE_AZ }, file);
    assert.match(r.out, /hub-count query failed/, `the mutant never attempted a query:\n${r.out}`);
    assert.ok(
      !r.out.includes(FAKE_AZ),
      `the mutated guard still named the override — this control cannot distinguish the two arms:\n${r.out}`,
    );
    assert.match(r.out, /az binary: az(\.cmd)?\)/, `the mutant did not fall back to the hardcoded binary:\n${r.out}`);
  } finally {
    // try/finally, and a whole directory rather than one file: a crash between
    // mkdtemp and here must not be able to strand an artifact.
    fs.rmSync(dir, { recursive: true, force: true });
  }

  assert.equal(fs.readFileSync(SCRIPT, 'utf8'), original, 'the real guard must be untouched by this control');
});

test('DEFAULT — with LOOM_AZ_BIN unset the guard still looks for plain az, and fails CLOSED', () => {
  // Two claims in one: the default did not change for existing callers, and an
  // unreachable CLI is UNKNOWN (refuse), never a permissive zero. The second is
  // the whole reason this file replaced an inline `2>/dev/null || echo "0"`.
  const r = runGuard({});
  assert.equal(r.status, 1, `an unreachable az must REFUSE, never proceed; output:\n${r.out}`);
  assert.match(r.out, /hub-count query failed \(az binary: az(\.cmd)?\)/, r.out);
  assert.match(r.out, /could not determine whether a CSA Loom hub already exists/, r.out);
});

test('the ONLY az invocation in this guard goes through the resolver', () => {
  // Keyed to the SAFE state, not to the removed `const AZ = 'az'` literal: a
  // guard keyed to the unsafe pattern goes green the moment someone renames it.
  // This asserts the property that must hold — every execFileSync in the file
  // spawns `azBinary()`'s result — so a SECOND, un-resolved az call added later
  // fails here even though the old literal is long gone.
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const spawns = [...src.matchAll(/execFileSync\(\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
  assert.ok(spawns.length > 0, 'no execFileSync call was found — this assertion has a ZERO population and proves nothing');
  assert.deepEqual(
    [...new Set(spawns)],
    ['bin'],
    `every execFileSync must spawn the resolved binary; found: ${spawns.join(', ')}`,
  );
  assert.match(src, /function azBinary\(\)/, 'the resolver itself is gone');
  assert.match(src, /env\.LOOM_AZ_BIN/, 'the resolver no longer reads the documented override');
});
