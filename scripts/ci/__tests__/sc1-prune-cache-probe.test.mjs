#!/usr/bin/env node
/**
 * loom-unity SC1 cache prune — the reference probe must FAIL CLOSED. (Refs #4471)
 *
 * ── WHAT WAS WRONG ─────────────────────────────────────────────────────────
 * `apps/loom-unity/scripts/sc1-prune-cache.sh` authorised `rm -rf "$EXAMPLES"`
 * from a probe whose ERROR and whose EMPTY RESULT were the same observation:
 *
 *   OTHERS="$(find "$UC_HOME" -type f -name classpath ! -path "${EXAMPLES}/*" -print0 \
 *             | xargs -0 grep -l "${EXAMPLES}/" 2>/dev/null || true)"
 *
 * `grep -l` exits 1 on no-match and >1 on error; `xargs` maps both onto 123;
 * `$?` after a pipe is the LAST stage's, so find's status was never read at all;
 * `2>/dev/null` discarded the evidence; `|| true` erased what was left. That is
 * the `deploy-integrity.md` R7 shape — a message (here, a deletion) asserting a
 * fact the code never established.
 *
 * ── WHY THIS RUNS THE REAL SHELL ───────────────────────────────────────────
 * Same reason as sc1-verify-gate.test.mjs: this repo has a recorded failure
 * class of tests that model the code instead of executing it. So these tests
 * execute the SHIPPED script with `sh` against a synthetic image-shaped fixture.
 * The status-collapsing behaviour being condemned lives in the interaction
 * between find, xargs, grep and the shell — a model of it would just re-assert
 * the author's belief about that interaction, which is exactly what was wrong.
 *
 * ── HOW THE ERROR IS INJECTED ──────────────────────────────────────────────
 * A `grep` shim is placed first on PATH which exits 2 (grep's "an error
 * occurred") only when one of its arguments is the examples-directory needle,
 * and `exec`s the real grep otherwise. It therefore reaches BOTH the head form
 * (through `xargs`) and the fixed form (direct), and leaves every other grep in
 * the script alone. There is no other way to make a probe fail deterministically
 * on every platform: chmod-000 does not deny the owner on Windows, and a
 * directory is invisible to `find -type f`.
 *
 * ── WHAT IS AND IS NOT PROVEN HERE ─────────────────────────────────────────
 * PROVEN: given a reference probe that errors, the shipped script aborts without
 * deleting; given one that completes, it prunes; and a genuine outside reference
 * is reported DIFFERENTLY from an incomplete probe. All measured by running the
 * script.
 * NOT PROVEN: behaviour inside the real unitycatalog base image (864 jars, a
 * real coursier layout, root ownership). That needs a live image build — see the
 * PR for the owed deploy receipt.
 *
 * Run: node --test scripts/ci/__tests__/sc1-prune-cache-probe.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'apps', 'loom-unity', 'scripts', 'sc1-prune-cache.sh');

/** Absolute path to the REAL grep, so the shim can delegate to it. */
function realGrep() {
  const r = spawnSync('sh', ['-c', 'command -v grep'], { encoding: 'utf8' });
  const p = String(r.stdout || '').trim();
  assert.ok(p, 'no grep on PATH — this harness needs a POSIX shell environment');
  return p;
}

/**
 * The shell and node do not agree on path syntax on Windows: node hands back
 * `C:\Users\…` and the POSIX shell (Git Bash / MSYS) needs `/c/Users/…`. The
 * script compares `find` output against strings it reads out of the classpath
 * FILES, so every path written INTO a fixture file, and UC_HOME itself, must be
 * in the shell's syntax — otherwise nothing matches, every classpath entry reads
 * as absent, and the fixture proves nothing. (Measured: the first draft of this
 * harness printed "classpath entries present pre-prune: 0 of 4" and the prune
 * deleted all four jars.) On Linux this is the identity.
 * @param {string} p
 */
function toPosix(p) {
  if (process.platform !== 'win32') return p;
  return p
    .replace(/\\/g, '/')
    .replace(/^([A-Za-z]):\//, (_m, d) => `/${String(d).toLowerCase()}/`);
}

/**
 * A loom-unity-shaped fixture: one server classpath, one examples-CLI classpath,
 * and a coursier cache holding one referenced jar plus three unreferenced ones
 * (bouncycastle, the awssdk fat jar, mockito).
 *
 * `outsideRef: true` makes the SERVER classpath name the examples tree — the
 * genuine regression the guard exists to catch, as distinct from a broken probe.
 *
 * Returns BOTH syntaxes: `home`/`*Jar` are native (for node's fs) and `shHome`
 * is what the script is handed.
 * @param {{outsideRef?: boolean}} [opts]
 */
function makeFixture(opts = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'sc1-uc-'));
  const shHome = toPosix(home);
  const rel = (...parts) => path.join(home, ...parts);
  const shRel = (...parts) => `${shHome}/${parts.join('/')}`;

  const cacheParts = ['.cache', 'coursier', 'https', 'maven-proxy.example', 'repo'];
  const jars = {
    keptJar: [...cacheParts, 'io', 'netty', 'netty-handler', '4.1.137.Final', 'netty-handler-4.1.137.Final.jar'],
    bcJar: [...cacheParts, 'org', 'bouncycastle', 'bcprov-jdk18on', '1.80', 'bcprov-jdk18on-1.80.jar'],
    bundleJar: [...cacheParts, 'software', 'amazon', 'awssdk', 'bundle', '2.29.52', 'bundle-2.29.52.jar'],
    mockitoJar: [...cacheParts, 'org', 'mockito', 'mockito-core', '5.0.0', 'mockito-core-5.0.0.jar'],
  };

  mkdirSync(rel('bin'), { recursive: true });
  mkdirSync(rel('server', 'target', 'classes'), { recursive: true });
  mkdirSync(rel('examples', 'cli', 'target'), { recursive: true });
  for (const parts of Object.values(jars)) {
    const j = rel(...parts);
    mkdirSync(path.dirname(j), { recursive: true });
    writeFileSync(j, 'jar');
    writeFileSync(`${j}.sha1`, 'sha');
  }
  writeFileSync(rel('bin', 'uc'), 'uc');
  writeFileSync(rel('examples', 'cli', 'target', 'lib.jar'), 'jar');

  // sbt writes a classpath as ONE colon-separated line with NO trailing newline.
  // The script's own comment says so and appends a separator between files; a
  // fixture with trailing newlines would not exercise that.
  const entries = [shRel(...jars.keptJar), shRel('server', 'target', 'classes')];
  if (opts.outsideRef) entries.push(shRel('examples', 'cli', 'target', 'lib.jar'));
  writeFileSync(rel('server', 'target', 'classpath'), entries.join(':'));
  writeFileSync(
    rel('examples', 'cli', 'target', 'classpath'),
    `${shRel(...jars.bundleJar)}:${shRel(...jars.keptJar)}`,
  );

  return {
    home,
    shHome,
    keptJar: rel(...jars.keptJar),
    bcJar: rel(...jars.bcJar),
    bundleJar: rel(...jars.bundleJar),
    classesDir: rel('server', 'target', 'classes'),
  };
}

/** Write the error-injecting grep shim into a fresh dir and return that dir. */
function makeGrepShim() {
  const dir = mkdtempSync(path.join(tmpdir(), 'sc1-shim-'));
  const p = path.join(dir, 'grep');
  writeFileSync(
    p,
    [
      '#!/bin/sh',
      '# Exit 2 ("an error occurred") ONLY for the examples-reference needle, so',
      '# every other grep in the script under test behaves normally.',
      'for a in "$@"; do',
      '  case "$a" in',
      '    */examples/) echo "grep: simulated read error (injected)" >&2; exit 2 ;;',
      '  esac',
      'done',
      `exec ${realGrep()} "$@"`,
      '',
    ].join('\n'),
  );
  chmodSync(p, 0o755);
  return dir;
}

/**
 * Run a prune script against a fixture.
 * @param {string} script
 * @param {{shHome: string}} fixture
 * @param {{inject?: boolean}} [opts]
 */
function run(script, fixture, opts = {}) {
  const env = { ...process.env, UC_HOME: fixture.shHome };
  if (opts.inject) env.PATH = `${makeGrepShim()}${path.delimiter}${env.PATH}`;
  const r = spawnSync('sh', [script], { encoding: 'utf8', env });
  return { status: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') };
}

test('a reference probe that ERRORS aborts the prune and leaves examples/ intact', () => {
  // FAILS IF: the probe is written so grep's >1 (error) is indistinguishable
  // from its 1 (no match) — i.e. the head form
  //   `find ... | xargs -0 grep -l ... 2>/dev/null || true`.
  // Measured against that exact text on 2026-09-16: exit 0, examples/ DELETED,
  // output byte-identical to the clean run. This assertion pins the EXIT STATUS
  // and the SURVIVAL OF THE DIRECTORY, not the wording.
  const fx = makeFixture();
  const r = run(SCRIPT, fx, { inject: true });

  assert.notEqual(r.status, 0, `an incomplete probe must abort; got exit ${r.status}\n${r.stdout}${r.stderr}`);
  assert.ok(
    existsSync(path.join(fx.home, 'examples')),
    'examples/ was deleted on the strength of a probe that never finished',
  );
  // Pins the MESSAGE separately: R7 requires it to say what it does NOT know.
  assert.match(r.stderr, /could not be COMPLETED/);
  assert.match(r.stderr, /NOT 'nothing matched'/);
  // The probe's stderr must be SURFACED, not discarded. FAILS IF a `2>/dev/null`
  // is reintroduced anywhere on the path from grep to the operator.
  assert.match(r.stderr, /simulated read error \(injected\)/);
});

test('a reference probe that COMPLETES with no match still prunes (positive control)', () => {
  // The paired positive assertion for the test above (assertion-design.md §4):
  // without it, "aborts on error" is satisfied by a script that aborts always.
  // FAILS IF: the status classification is over-tightened — `-ge 1` or `-ne 0`
  // instead of `-gt 1` — because grep exits 1 on the NORMAL no-match path, so
  // the whole prune would abort. That is the likeliest regression of this fix
  // and the one arm that catches it.
  const fx = makeFixture();
  const r = run(SCRIPT, fx);

  assert.equal(r.status, 0, `clean run must succeed\n${r.stdout}${r.stderr}`);
  assert.ok(!existsSync(path.join(fx.home, 'examples')), 'examples/ should have been removed');
  assert.ok(!existsSync(path.join(fx.home, 'bin', 'uc')), 'bin/uc should have been removed');
  // The prune's whole point: the unreferenced CVE carriers go.
  assert.ok(!existsSync(fx.bundleJar), 'the awssdk fat jar should have been pruned');
  assert.ok(!existsSync(fx.bcJar), 'the bouncycastle jar should have been pruned');
  // ...and the referenced ones do NOT. FAILS IF the keep-set derivation is
  // truncated (the `find | sort` and `grep ... || true` collapses, same class).
  assert.ok(existsSync(fx.keptJar), 'a jar named by the server classpath was destroyed');
  assert.ok(existsSync(fx.classesDir), 'a non-jar classpath root was destroyed');
  // Pins that the keep-set was DERIVED, not empty-by-accident: 2 entries present
  // pre-prune (the netty jar + server/target/classes) and both survive. FAILS IF
  // the fixture's paths stop reaching the script — the first draft of this
  // harness read "0 of 4" here while every assertion above still passed.
  assert.match(r.stdout, /classpath entries present pre-prune: 2 of 2/);
  assert.match(r.stdout, /SC1 loom-unity cache prune complete/);
});

test('a GENUINE outside reference aborts with a different message than a broken probe', () => {
  // Two distinct facts must stay distinct — collapsing them back into one
  // message is how "I could not check" becomes "I checked and it is fine".
  // FAILS IF: the guard falls through to `rm -rf` when grep exits 0 (a match),
  // or reports a real reference using the incomplete-probe wording.
  const fx = makeFixture({ outsideRef: true });
  const r = run(SCRIPT, fx);

  assert.notEqual(r.status, 0, `an outside reference must abort\n${r.stdout}${r.stderr}`);
  assert.ok(existsSync(path.join(fx.home, 'examples')), 'examples/ was removed despite a live reference');
  assert.match(r.stderr, /now references it/);
  assert.doesNotMatch(
    r.stderr,
    /could not be COMPLETED/,
    'a completed probe that FOUND something must not be reported as an incomplete probe',
  );
});

test('no executable line in the script discards a status or a stderr', () => {
  // A SOURCE guard, not a behavioural one: it pins that the collapse idioms are
  // not reintroduced at a site the three fixtures above happen not to reach.
  //
  // Comment lines are stripped FIRST because the script quotes the defective
  // line verbatim in its own rationale — a guard matching raw source would be
  // satisfied (here, falsely tripped) by a comment. `\r` is stripped first too:
  // `.` in a JS regex does not match `\r`, so a line guard no-ops on CRLF.
  // FAILS IF: the file is reverted to head — line 108 carries both idioms on an
  // executable line — or a new `2>/dev/null` / `|| true` lands on one.
  const src = readFileSync(SCRIPT, 'utf8').replace(/\r/g, '');
  const offenders = src
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => !/^\s*#/.test(line))
    .filter(({ line }) => /2>\s*\/dev\/null/.test(line) || /\|\|\s*true\b/.test(line));
  assert.deepEqual(
    offenders.map(({ n, line }) => `${n}: ${line.trim()}`),
    [],
    'a probe status or stderr is being discarded on an executable line',
  );

  // Paired positive: prove the guard is reading real content and the replacement
  // idiom is actually present, so the check above cannot pass over an empty or
  // wrong file. FAILS IF the script is emptied, renamed, or the status-on-its-
  // own-line form is removed.
  assert.match(src, /\|\| _p_rc=\$\?/, 'probe_find no longer reads find\'s own status');
  assert.match(src, /\|\| _g_rc=\$\?/, 'the grep probes no longer read grep\'s own status');
});
