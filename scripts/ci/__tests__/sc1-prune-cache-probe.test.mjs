#!/usr/bin/env node
/**
 * loom-unity SC1 cache prune — every probe must FAIL CLOSED. (Refs #4471)
 *
 * ── WHAT WAS WRONG ─────────────────────────────────────────────────────────
 * `apps/loom-unity/scripts/sc1-prune-cache.sh` authorised `rm -rf "$EXAMPLES"`
 * from a guard whose ERROR and whose EMPTY RESULT were the same observation:
 *
 *   OTHERS="$(find "$UC_HOME" -type f -name classpath ! -path "${EXAMPLES}/*" -print0 \
 *             | xargs -0 grep -l "${EXAMPLES}/" 2>/dev/null || true)"
 *
 * `grep -l` exits 1 on no-match and >1 on error; `xargs` maps both onto 123;
 * `$?` after a pipe is the LAST stage's, so find's status was never read at all;
 * `2>/dev/null` discarded the evidence; `|| true` erased what was left. That is
 * the `deploy-integrity.md` R7 shape — a destructive step authorised by a fact
 * the code never established.
 *
 * ── WHY THIS RUNS THE REAL SHELL ───────────────────────────────────────────
 * Same reason as sc1-verify-gate.test.mjs: this repo has a recorded failure
 * class of tests that model the code instead of executing it. These tests
 * execute the SHIPPED script with `sh` against a synthetic image-shaped fixture.
 * The behaviour being condemned lives in the interaction between find, xargs,
 * grep and the shell — a model of it would just re-assert the author's belief
 * about that interaction, which is exactly what was wrong.
 *
 * ── WHAT THE FIXTURE MUST BE, AND WHY ──────────────────────────────────────
 * THREE classpath files outside `examples/`, plus one inside it. An earlier
 * revision used ONE, and a reviewer showed that a one-element population makes
 * "each file is searched on its own and owns its status" true BY CONSTRUCTION:
 * mutants that broke after the first iteration, that checked the status only on
 * iteration 1, or that narrowed the enumeration, all stayed green while the
 * script printed a searched-count it had not established and deleted on it.
 * So the grep shim fails on the *Nth* call, not on a named file — which is what
 * makes "every iteration is judged" a claim with a counterexample.
 *
 * ── WHAT IS AND IS NOT PROVEN HERE ─────────────────────────────────────────
 * PROVEN, by execution: a probe that errors (grep or find, at any of the five
 * call sites) aborts without deleting; a probe that completes prunes; a probe
 * that warns has its stderr surfaced; a local transform that truncates silently
 * is caught by an arithmetic invariant; a genuine outside reference is reported
 * DIFFERENTLY from an incomplete probe.
 * NOT PROVEN: behaviour inside the real unitycatalog base image (864 jars, a
 * real coursier layout, root ownership). That needs a live image build — see the
 * PR for the owed deploy receipt.
 *
 * Run: node --test scripts/ci/__tests__/sc1-prune-cache-probe.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'apps', 'loom-unity', 'scripts', 'sc1-prune-cache.sh');

/** Absolute path to a REAL tool, so a shim can delegate to it. */
function realTool(name) {
  const r = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
  const p = String(r.stdout || '').trim();
  assert.ok(p, `no ${name} on PATH — this harness needs a POSIX shell environment`);
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

/** How many classpath files the fixture puts OUTSIDE examples/. Pinned below. */
const OUTSIDE_CLASSPATHS = 3;

/**
 * A loom-unity-shaped fixture.
 *
 * - THREE classpath files outside `examples/` (server, java client, CLI), each
 *   naming a DIFFERENT referenced jar, so a truncated keep-set drops a jar that
 *   a later classpath file names.
 * - ONE inside `examples/`, naming the awssdk fat jar. It is load-bearing: it is
 *   what makes "the enumeration excludes the examples tree" falsifiable, since
 *   dropping the exclusion changes the searched-count from 3 to 4.
 * - Four unreferenced jars in the coursier cache, including the bouncycastle and
 *   awssdk carriers the prune exists to remove.
 *
 * `outsideRef: true` makes the SERVER classpath name the examples tree — the
 * genuine regression the guard exists to catch, as distinct from a broken probe.
 * @param {{outsideRef?: boolean}} [opts]
 */
function makeFixture(opts = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'sc1-uc-'));
  const shHome = toPosix(home);
  const rel = (...parts) => path.join(home, ...parts);
  const shRel = (...parts) => `${shHome}/${parts.join('/')}`;

  const c = ['.cache', 'coursier', 'https', 'maven-proxy.example', 'repo'];
  const jars = {
    serverJar: [...c, 'io', 'netty', 'netty-handler', '4.1.137.Final', 'netty-handler-4.1.137.Final.jar'],
    clientJar: [...c, 'com', 'fasterxml', 'jackson-core', '2.17.0', 'jackson-core-2.17.0.jar'],
    cliJar: [...c, 'org', 'slf4j', 'slf4j-api', '2.0.13', 'slf4j-api-2.0.13.jar'],
    bcJar: [...c, 'org', 'bouncycastle', 'bcprov-jdk18on', '1.80', 'bcprov-jdk18on-1.80.jar'],
    bundleJar: [...c, 'software', 'amazon', 'awssdk', 'bundle', '2.29.52', 'bundle-2.29.52.jar'],
    mockitoJar: [...c, 'org', 'mockito', 'mockito-core', '5.0.0', 'mockito-core-5.0.0.jar'],
  };

  mkdirSync(rel('bin'), { recursive: true });
  mkdirSync(rel('server', 'target', 'classes'), { recursive: true });
  mkdirSync(rel('clients', 'java', 'target'), { recursive: true });
  mkdirSync(rel('cli', 'target'), { recursive: true });
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
  //
  // `content` shapes the two legitimate NO-MATCH cases. They are the only way to
  // distinguish a `-gt 1` status classification from a `-ge 1` one: both abort,
  // but `-ge 1` reports a grep that FINISHED as "could not be COMPLETED", which
  // is false — an R7 falsehood, and the reason these two arms are killable
  // rather than merely equivalent.
  //   'noJars' — no entry ends in .jar, so the .jar filter legitimately exits 1
  //   'empty'  — every field is blank, so the blank filter legitimately exits 1
  const content = opts.content || 'normal';
  const serverEntries =
    content === 'noJars'
      ? [shRel('server', 'target', 'classes')]
      : [shRel(...jars.serverJar), shRel('server', 'target', 'classes')];
  if (opts.outsideRef) serverEntries.push(shRel('examples', 'cli', 'target', 'lib.jar'));
  if (content === 'empty') {
    for (const p of [
      rel('server', 'target', 'classpath'),
      rel('clients', 'java', 'target', 'classpath'),
      rel('cli', 'target', 'classpath'),
    ]) {
      writeFileSync(p, '');
    }
  } else {
    writeFileSync(rel('server', 'target', 'classpath'), serverEntries.join(':'));
    writeFileSync(
      rel('clients', 'java', 'target', 'classpath'),
      content === 'noJars' ? shRel('clients', 'java', 'target') : shRel(...jars.clientJar),
    );
    writeFileSync(
      rel('cli', 'target', 'classpath'),
      content === 'noJars' ? shRel('cli', 'target') : shRel(...jars.cliJar),
    );
  }
  writeFileSync(rel('examples', 'cli', 'target', 'classpath'), shRel(...jars.bundleJar));

  const native = {};
  for (const [k, parts] of Object.entries(jars)) native[k] = rel(...parts);
  return { home, shHome, ...native, classesDir: rel('server', 'target', 'classes') };
}

/**
 * Write shims onto a fresh PATH directory.
 *
 * Every shim delegates to the real tool unless its trigger matches, so the rest
 * of the script runs normally — a blanket-failing tool would abort somewhere
 * else and the test would prove nothing about the site under examination.
 *
 * @param {{
 *   grepFailOnCall?: {needle: string, call: number},
 *   grepPartial?: {needle: string, keep: number, status: number},
 *   grepDropExtra?: {needle: string},
 *   findFail?: {needle: string, exclude?: string, status: number},
 *   findWarn?: {needle: string},
 *   findNewline?: {needle: string},
 *   sedTruncate?: {status: number},
 *   trTruncate?: boolean,
 *   wcFail?: {status: number},
 * }} spec
 */
function makeShims(spec) {
  const dir = mkdtempSync(path.join(tmpdir(), 'sc1-shim-'));
  const w = (name, body) => {
    const p = path.join(dir, name);
    writeFileSync(p, `${body}\n`);
    chmodSync(p, 0o755);
  };

  if (spec.wcFail) {
    // Two distinct failure modes of the MEASUREMENT itself, which is what
    // R2-2 was about: a non-zero status, and a zero status with no output.
    // Both yield an empty `[` operand; only the second survives a status read.
    w(
      'wc',
      spec.wcFail.status === 0
        ? '#!/bin/sh\nexit 0'
        : `#!/bin/sh\necho "wc: simulated measurement failure (injected)" >&2\nexit ${spec.wcFail.status}`,
    );
  }

  const grepCases = [];
  if (spec.grepFailOnCall) {
    const { needle, call } = spec.grepFailOnCall;
    const counter = toPosix(path.join(dir, 'grep.count'));
    // Fails on the Nth matching invocation, NOT on a named file. `find`'s
    // traversal order is not guaranteed, and more importantly a per-file trigger
    // would be satisfied by a loop that only ever judges iteration 1.
    grepCases.push(
      [
        `case "$*" in`,
        `  *'${needle}'*)`,
        `    n=0`,
        `    if [ -f '${counter}' ]; then n=$(cat '${counter}'); fi`,
        `    n=$((n + 1)); echo "$n" > '${counter}'`,
        `    if [ "$n" -eq ${call} ]; then`,
        `      echo "grep: simulated read error (injected on call $n)" >&2`,
        `      exit 2`,
        `    fi`,
        `    ;;`,
        `esac`,
      ].join('\n'),
    );
  }
  if (spec.grepPartial) {
    // Emits a PARTIAL result and then reports its status. This is the case a
    // `! -s` emptiness check cannot see: the output is non-empty, just short.
    const { needle, keep, status } = spec.grepPartial;
    grepCases.push(
      [
        `case "$*" in`,
        `  *'${needle}'*)`,
        `    ${realTool('grep')} "$@" | ${realTool('head')} -n ${keep}`,
        `    echo "grep: simulated partial read (injected)" >&2`,
        `    exit ${status}`,
        `    ;;`,
        `esac`,
      ].join('\n'),
    );
  }
  if (spec.grepDropExtra) {
    // Removes exactly ONE line more than the real grep would. This is the
    // distance-1 boundary: a bound of "at most one line removed" cannot tell
    // this from the legitimate removal of the single blank line, which is why
    // the script checks WHICH lines went (via `comm`) rather than how many.
    grepCases.push(
      [
        `case "$*" in`,
        `  *'${spec.grepDropExtra.needle}'*)`,
        `    ${realTool('grep')} "$@" | ${realTool('head')} -n -1`,
        `    exit 0`,
        `    ;;`,
        `esac`,
      ].join('\n'),
    );
  }
  if (grepCases.length) w('grep', ['#!/bin/sh', ...grepCases, `exec ${realTool('grep')} "$@"`].join('\n'));

  const findCases = [];
  const guard = (needle, exclude, body) => {
    const ex = exclude ? `case "$*" in *'${exclude}'*) exec ${realTool('find')} "$@" ;; esac` : '';
    findCases.push(`case "$*" in\n  *'${needle}'*)\n    ${ex}\n${body}\n    ;;\nesac`);
  };
  if (spec.findFail) {
    const { needle, exclude, status } = spec.findFail;
    guard(
      needle,
      exclude,
      `    echo "find: simulated traversal failure (injected)" >&2\n    exit ${status}`,
    );
  }
  if (spec.findWarn) {
    guard(
      spec.findWarn.needle,
      undefined,
      `    echo "find: a directory was unreadable (injected warning)" >&2\n    exec ${realTool('find')} "$@"`,
    );
  }
  if (spec.findNewline) {
    // Emits a NUL-delimited record that CONTAINS a newline. A real path like
    // this cannot be created on Windows, so injecting it at the producer is the
    // only portable way to reach the script's newline refusal.
    //
    // The literal below is deliberately NOT under /tmp (or any shared temp
    // root): nothing ever creates or opens it — it exists only as bytes in the
    // shim's stdout — but a fixed path under a world-writable root is a shape
    // `check-temp-artifact-safety.mjs` rightly bans, and a reader should not
    // have to know it is inert to tell that it is safe.
    guard(
      spec.findNewline.needle,
      undefined,
      `    printf '%s\\n%s\\000' "/loom-sc1-newline-probe/one" "two"\n    exit 0`,
    );
  }
  if (findCases.length) w('find', ['#!/bin/sh', ...findCases, `exec ${realTool('find')} "$@"`].join('\n'));

  if (spec.sedTruncate) {
    // Fires only on the trailing-space trim, so probe_failed's own `sed 's/^/…/'`
    // indentation still works and the abort message stays readable. `status: 0`
    // is the interesting case: every status read in the file passes and only the
    // line-count invariant can see it.
    w(
      'sed',
      [
        '#!/bin/sh',
        `case "$1" in`,
        `  *'[[:space:]]*$'*)`,
        `    ${realTool('head')} -n 1 "$2"`,
        `    if [ ${spec.sedTruncate.status} -ne 0 ]; then`,
        `      echo "sed: simulated write failure (injected)" >&2`,
        `    fi`,
        `    exit ${spec.sedTruncate.status}`,
        `    ;;`,
        `esac`,
        `exec ${realTool('sed')} "$@"`,
      ].join('\n'),
    );
  }
  if (spec.trTruncate) {
    // Truncates the colon split and exits ZERO — the case a status read alone
    // cannot catch, and the reason that stage carries a byte-count invariant.
    w(
      'tr',
      [
        '#!/bin/sh',
        `if [ "$1" = ":" ]; then`,
        `  ${realTool('head')} -c 20`,
        `  exit 0`,
        `fi`,
        `exec ${realTool('tr')} "$@"`,
      ].join('\n'),
    );
  }
  return dir;
}

/**
 * Run the prune script against a fixture.
 *
 * `SC1_WORK_PARENT` is unique per run. The script's scratch root used to be a
 * fixed `/tmp/loom-sc1` with an `rm -rf` at entry; on a host harness that spawns
 * it repeatedly that raced, and both reviewers measured random REDs from it —
 * one of them reading `examples/ was removed despite a live reference`, i.e. a
 * false failure whose text is the defect under fix. A flaky gate cannot
 * distinguish a kill from noise, so the harness supplies its own scratch root.
 * @param {string} script
 * @param {{shHome: string}} fixture
 * @param {{shims?: object}} [opts]
 */
function run(script, fixture, opts = {}) {
  const env = {
    ...process.env,
    UC_HOME: fixture.shHome,
    SC1_WORK_PARENT: toPosix(mkdtempSync(path.join(tmpdir(), 'sc1-work-'))),
  };
  if (opts.shims) env.PATH = `${makeShims(opts.shims)}${path.delimiter}${env.PATH}`;
  const r = spawnSync('sh', [script], { encoding: 'utf8', env });
  return { status: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') };
}

const EXAMPLES_NEEDLE = '/examples/';

// ───────────────────────────────────────────────────────────────────────────
// The examples-reference probe — the site that authorises `rm -rf`.
// ───────────────────────────────────────────────────────────────────────────

test('an errored reference probe on the LAST classpath file aborts the prune', () => {
  // FAILS IF: grep's >1 (error) is not distinguished from its 1 (no match) — the
  // head form `… | xargs -0 grep -l … 2>/dev/null || true`. Measured against
  // that exact text: exit 0, examples/ DELETED, output identical to a clean run.
  //
  // FAILS ALSO IF the loop judges only SOME iterations: the error is injected on
  // call 3 of 3, so a mutant that breaks after the first file, that reads the
  // status only on the first file, or that narrows the enumeration, never
  // reaches the injected error, deletes examples/, and turns this red. A
  // one-element fixture could not make any of those claims.
  const fx = makeFixture();
  const r = run(SCRIPT, fx, {
    shims: { grepFailOnCall: { needle: EXAMPLES_NEEDLE, call: OUTSIDE_CLASSPATHS } },
  });

  assert.notEqual(r.status, 0, `an incomplete probe must abort; got exit ${r.status}\n${r.stdout}${r.stderr}`);
  assert.ok(
    existsSync(path.join(fx.home, 'examples')),
    'examples/ was deleted on the strength of a probe that never finished',
  );
  assert.match(r.stderr, /could not be COMPLETED/);
  assert.match(r.stderr, /NOT 'nothing matched'/);
  // The probe's stderr must be SURFACED, not discarded. FAILS IF a `2>/dev/null`
  // (or its `2>>` / `2>&-` variants) is reintroduced on the path to the operator.
  assert.match(r.stderr, /simulated read error \(injected on call 3\)/);
  // Pins that the abort came from the LAST call, not an early bail: the counter
  // reached 3. FAILS IF the enumeration is narrowed or the loop short-circuits.
  assert.doesNotMatch(
    r.stdout,
    /examples-reference check:/,
    'the summary line must not print when the check did not complete',
  );
});

test('a reference probe that COMPLETES with no match prunes, and searches EVERY outside classpath', () => {
  // The paired positive control (assertion-design.md §4): without it, "aborts on
  // error" is satisfied by a script that aborts always.
  //
  // FAILS IF the status classification is over-tightened — `-ge 1` or `-ne 0`
  // instead of `-gt 1` — because grep exits 1 on the NORMAL no-match path, so the
  // whole prune would abort. That is the likeliest regression of this fix.
  //
  // The searched-count FAILS IF the enumeration's population changes: adding an
  // exclusion drops it below 3, and dropping the `! -path "${EXAMPLES}/*"`
  // self-exclusion raises it to 4 (the fixture keeps a classpath inside
  // examples/ precisely so that mutation has a counterexample).
  const fx = makeFixture();
  const r = run(SCRIPT, fx);

  assert.equal(r.status, 0, `clean run must succeed\n${r.stdout}${r.stderr}`);
  assert.match(
    r.stdout,
    new RegExp(`examples-reference check: ${OUTSIDE_CLASSPATHS} classpath file\\(s\\) searched, 0 reference`),
  );
  assert.ok(!existsSync(path.join(fx.home, 'examples')), 'examples/ should have been removed');
  assert.ok(!existsSync(path.join(fx.home, 'bin', 'uc')), 'bin/uc should have been removed');
  // The prune's whole point: the unreferenced CVE carriers go.
  assert.ok(!existsSync(fx.bundleJar), 'the awssdk fat jar should have been pruned');
  assert.ok(!existsSync(fx.bcJar), 'the bouncycastle jar should have been pruned');
  assert.ok(!existsSync(fx.mockitoJar), 'an unreferenced test jar should have been pruned');
  // ...and every referenced one does NOT, including the two named only by the
  // SECOND and THIRD classpath files. FAILS IF the keep-set is truncated.
  assert.ok(existsSync(fx.serverJar), 'a jar named by the server classpath was destroyed');
  assert.ok(existsSync(fx.clientJar), 'a jar named by the java-client classpath was destroyed');
  assert.ok(existsSync(fx.cliJar), 'a jar named by the CLI classpath was destroyed');
  assert.ok(existsSync(fx.classesDir), 'a non-jar classpath root was destroyed');
  // Pins that the keep-set was DERIVED, not empty-by-accident: 4 entries present
  // pre-prune (three jars + server/target/classes) and all four survive. FAILS IF
  // the fixture's paths stop reaching the script — the first draft of this
  // harness read "0 of 4" here while every assertion above still passed.
  assert.match(r.stdout, /classpath entries present pre-prune: 4 of 4/);
  assert.match(r.stdout, /SC1 loom-unity cache prune complete/);
});

test('a GENUINE outside reference aborts with a different message than a broken probe', () => {
  // Two distinct facts must stay distinct — collapsing them back into one message
  // is how "I could not check" becomes "I checked and it is fine".
  // FAILS IF: the guard falls through to `rm -rf` when grep exits 0 (a match), or
  // reports a real reference using the incomplete-probe wording.
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

test('an EMPTY search population does not authorise the delete', () => {
  // FAILS IF the emptiness guard is removed: a successful walk that enumerated
  // nothing would print "0 classpath file(s) searched, 0 reference …" and delete
  // on it. Reached by making the enumeration return an empty (but successful)
  // result set.
  const fx = makeFixture();
  const r = run(SCRIPT, fx, {
    shims: { findFail: { needle: '! -path', status: 0 } },
  });

  assert.notEqual(r.status, 0, `an empty population must abort\n${r.stdout}${r.stderr}`);
  assert.ok(existsSync(path.join(fx.home, 'examples')), 'examples/ was deleted with nothing searched');
  assert.match(r.stderr, /nothing to\s+search|An empty population/);
});

// ───────────────────────────────────────────────────────────────────────────
// probe_find — the helper the whole fix rests on. Five call sites; before this
// block, NO test made `find` itself fail, so deleting its fail-closed abort left
// the suite green while the mutant shipped a dead CVE gate.
// ───────────────────────────────────────────────────────────────────────────

const FIND_SITES = [
  {
    label: 'the bouncycastle survivor scan',
    needle: 'bcprov-*.jar',
    expect: /the bouncycastle survivor scan .* could not be COMPLETED/s,
  },
  {
    label: 'the awssdk-bundle survivor scan',
    needle: 'bundle-*.jar',
    expect: /the awssdk-bundle survivor scan .* could not be COMPLETED/s,
  },
  {
    label: 'the coursier cache scan',
    needle: '*.jar',
    expect: /the coursier cache scan .* could not be COMPLETED/s,
  },
  {
    label: 'the classpath enumeration',
    needle: '-name classpath',
    exclude: '! -path',
    expect: /the classpath enumeration .* could not be COMPLETED/s,
  },
];

for (const site of FIND_SITES) {
  test(`a find that FAILS during ${site.label} aborts the prune`, () => {
    // FAILS IF `probe_find`'s `if [ "$_p_rc" -ne 0 ]` abort is deleted or
    // weakened. Measured against that mutant on the bouncycastle arm: exit 0 and
    // "assertions passed … prune complete" over a scan that died — i.e. the image
    // ships with its CRITICAL-CVE absence claim made by a probe that never ran.
    // Each site gets its own arm because reverting any ONE of them to a bare
    // `find … | sort > file` pipe is invisible to the others.
    const fx = makeFixture();
    const r = run(SCRIPT, fx, {
      shims: { findFail: { needle: site.needle, exclude: site.exclude, status: 1 } },
    });

    assert.notEqual(r.status, 0, `a failed ${site.label} must abort\n${r.stdout}${r.stderr}`);
    assert.match(r.stderr, site.expect);
    // The scan's own stderr, surfaced rather than discarded.
    assert.match(r.stderr, /simulated traversal failure \(injected\)/);
  });
}

test('a find that COMPLETES but writes to stderr surfaces the warning and still prunes', () => {
  // The paired positive for the four arms above: they are satisfied by a helper
  // that aborts on every find. This one pins that a SUCCESSFUL scan proceeds.
  // FAILS IF the WARN branch is removed or stderr is discarded (`2>>/dev/null`
  // and `2>&-` both make the `-s` test false, so the warning never prints).
  const fx = makeFixture();
  const r = run(SCRIPT, fx, { shims: { findWarn: { needle: 'bcprov-*.jar' } } });

  assert.equal(r.status, 0, `a warning must not abort\n${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /completed \(exit 0\) but wrote to stderr/);
  assert.match(r.stderr, /a directory was unreadable \(injected warning\)/);
  assert.match(r.stdout, /SC1 loom-unity cache prune complete/);
});

test('a path containing a newline aborts rather than silently shortening the keep-set', () => {
  // FAILS IF `probe_find`'s embedded-newline refusal is deleted. `find -print0`
  // is kept precisely so this is DETECTABLE; converting NUL→newline without the
  // check would split one path into two, under-report the keep-set, and delete
  // MORE. Injected at the producer because such a path cannot be created on
  // Windows, which would otherwise make this arm unrunnable on half the fleet.
  const fx = makeFixture();
  const r = run(SCRIPT, fx, { shims: { findNewline: { needle: '! -path' } } });

  assert.notEqual(r.status, 0, `an ambiguous path list must abort\n${r.stdout}${r.stderr}`);
  assert.ok(existsSync(path.join(fx.home, 'examples')), 'examples/ was deleted on an ambiguous path list');
  assert.match(r.stderr, /returned a path containing a newline/);
});

// ───────────────────────────────────────────────────────────────────────────
// The keep-set derivation. `entries.txt` feeds BOTH the keep-set and the
// post-prune integrity check, so a truncation shrinks the protection and its
// control in lockstep — which is why each stage carries an arithmetic invariant
// and not merely a status read.
// ───────────────────────────────────────────────────────────────────────────

test('a trim stage that truncates and ERRORS aborts before anything is deleted', () => {
  // FAILS IF the four-stage `tr | sed | grep -vE | sort -u` pipeline is restored:
  // its status belongs to `sort -u`, so a sed exiting 2 is invisible. A reviewer
  // measured exactly that on the pre-round-2 text — a jar named by the server
  // classpath was DELETED at exit 0 with empty stderr and "assertions passed".
  const fx = makeFixture();
  const r = run(SCRIPT, fx, { shims: { sedTruncate: { status: 2 } } });

  assert.notEqual(r.status, 0, `a failed trim must abort\n${r.stdout}${r.stderr}`);
  assert.ok(existsSync(fx.clientJar), 'a referenced jar was deleted from a truncated keep-set');
  assert.ok(existsSync(fx.cliJar), 'a referenced jar was deleted from a truncated keep-set');
  assert.doesNotMatch(r.stdout, /assertions passed/);
});

test('a trim stage that truncates at exit ZERO is caught by the line invariant', () => {
  // The companion to the arm above and the reason a status read is not enough
  // here: this sed exits 0, so `set -eu` and every rc check pass.
  // FAILS IF the lines-in == lines-out invariant on the trim is deleted — the
  // keep-set is then derived from one line of the field list and referenced jars
  // are deleted while the run reports success.
  const fx = makeFixture();
  const r = run(SCRIPT, fx, { shims: { sedTruncate: { status: 0 } } });

  assert.notEqual(r.status, 0, `a silent trim truncation must abort\n${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /the trailing-space trim lost lines/);
  assert.ok(existsSync(fx.clientJar), 'a referenced jar was deleted from a truncated keep-set');
  assert.doesNotMatch(r.stdout, /assertions passed/);
});

test('a blank-field filter that truncates at exit ZERO is caught by the removed-line identity check', () => {
  // The sharpest of the keep-set arms. `entries.txt` feeds BOTH $KEEP and
  // $PRESENT, so a truncation here removes a referenced jar from the keep-set
  // AND from the integrity check that would notice — in lockstep. Nothing
  // downstream can see it.
  // FAILS IF the `comm`-based identity check is deleted: measured on that
  // mutant, a jar named by the java-client classpath is DELETED at exit 0 with
  // "assertions passed" printed.
  const fx = makeFixture();
  const r = run(SCRIPT, fx, { shims: { grepPartial: { needle: '^$', keep: 2, status: 0 } } });

  assert.notEqual(r.status, 0, `a silent blank-filter truncation must abort\n${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /the blank-field filter removed/);
  assert.ok(existsSync(fx.clientJar), 'a referenced jar was deleted from a truncated keep-set');
  assert.ok(existsSync(fx.cliJar), 'a referenced jar was deleted from a truncated keep-set');
  assert.doesNotMatch(r.stdout, /assertions passed/);
});

test('a PARTIAL failure of the .jar filter is attributed to the filter, not to a downstream symptom', () => {
  // FAILS IF the `.jar` filter's `-gt 1` classification is neutered (`-gt 99`,
  // or the `|| :` form). A total failure would still be caught by the empty
  // keep-set check, so only a PARTIAL one distinguishes the fix from the defect:
  // the filter writes some lines, then errors.
  //
  // This pins the MESSAGE, deliberately. Both the fix and the mutant abort — the
  // mutant only later, via "classpath entry destroyed by the prune". Attributing
  // a failed probe to its downstream symptom is the R7 error in miniature: the
  // operator is told the prune broke a classpath when the truth is that the
  // filter never finished.
  const fx = makeFixture();
  const r = run(SCRIPT, fx, { shims: { grepPartial: { needle: '\\.jar$', keep: 1, status: 2 } } });

  assert.notEqual(r.status, 0, `a failed .jar filter must abort\n${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /the \.jar filter over the classpath entries could not be COMPLETED/);
  assert.doesNotMatch(
    r.stderr,
    /classpath entry destroyed by the prune/,
    'the abort must name the probe that failed, not the damage it would have caused',
  );
  assert.ok(existsSync(fx.clientJar), 'a referenced jar was deleted from a truncated keep-set');
});

// ───────────────────────────────────────────────────────────────────────────
// The MEASUREMENTS themselves. Round 2 read every count as
// `_n="$(wc -c < f | tr -d ' ')"` and used it directly as a `[` operand — the
// same collapse this script exists to remove, committed in the fix for it. The
// pipeline hides wc's status from errexit; the substitution yields ""; `[ "" -ne
// 5 ]` is an ERROR, not false; and a command that fails inside an `if` CONDITION
// is exempt from errexit, so the condition reads FALSE and the invariant it
// guards is SKIPPED. Reproduced independently before fixing: same truncation,
// wc working -> abort at "the colon split lost bytes (580 in, 172 out)" with
// every referenced jar intact; wc failing -> `[: : integer expected` and exit 0
// having DELETED two jars the server classpath names.
// ───────────────────────────────────────────────────────────────────────────

test('a MEASUREMENT that fails with a non-zero status aborts the prune', () => {
  // FAILS IF the count is read through a pipeline again (`wc … | tr -d ' '`),
  // because the pipeline's status is `tr`'s and errexit never sees wc die.
  // Paired with a truncation so the run has something to catch: with the fix the
  // measurement aborts first; without it, the invariant is skipped and the
  // truncated keep-set deletes referenced jars.
  const fx = makeFixture();
  const r = run(SCRIPT, fx, { shims: { wcFail: { status: 1 }, trTruncate: true } });

  assert.notEqual(r.status, 0, `a failed measurement must abort\n${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /count .* could not be COMPLETED/s);
  assert.ok(existsSync(fx.clientJar), 'a referenced jar was deleted while an invariant was skipped');
  assert.ok(existsSync(fx.cliJar), 'a referenced jar was deleted while an invariant was skipped');
  // The tell of the round-2 defect, which must never appear again.
  assert.doesNotMatch(r.stderr, /integer expected/);
});

test('a MEASUREMENT that succeeds but returns nothing aborts the prune', () => {
  // The half a status read cannot catch, and the reason `require_number` exists
  // separately from the status check: this `wc` exits 0 and prints nothing, so
  // `_m_rc` is 0 and only operand validation can see it.
  // FAILS IF `require_number` is deleted — the empty operand then reaches `[`,
  // which exits 2 inside an `if` condition, which reads as false.
  const fx = makeFixture();
  const r = run(SCRIPT, fx, { shims: { wcFail: { status: 0 }, trTruncate: true } });

  assert.notEqual(r.status, 0, `an empty measurement must abort\n${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /produced no usable number/);
  assert.match(r.stderr, /SKIP the check it guards/);
  assert.ok(existsSync(fx.clientJar), 'a referenced jar was deleted while an invariant was skipped');
  assert.doesNotMatch(r.stderr, /integer expected/);
});

test('the blank filter dropping exactly ONE real line is caught (the distance-1 boundary)', () => {
  // A BOUND of "at most one line removed" passes this: one blank kept, one real
  // line dropped, difference still 1. A reviewer measured a referenced jar
  // deleted at exit 0 through exactly that gap. The script therefore checks
  // WHICH lines went, via `comm`, not how many.
  // FAILS IF the identity check is replaced by any count-based bound.
  const fx = makeFixture();
  const r = run(SCRIPT, fx, { shims: { grepDropExtra: { needle: '^$' } } });

  assert.notEqual(r.status, 0, `a one-line truncation must abort\n${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /the blank-field filter removed \d+ bytes/);
  assert.match(r.stderr, /dropped real classpath entries/);
  assert.ok(existsSync(fx.clientJar), 'a referenced jar was deleted from a keep-set short by one');
  assert.ok(existsSync(fx.cliJar), 'a referenced jar was deleted from a keep-set short by one');
  assert.doesNotMatch(r.stdout, /assertions passed/);
});

test('a .jar filter that legitimately matches NOTHING is reported as empty, not as incomplete', () => {
  // The arm that makes `-gt 1` vs `-ge 1` distinguishable at this site. Both
  // abort; only `-ge 1` calls a grep that FINISHED "could not be COMPLETED",
  // which is an R7 falsehood about a probe that did its job.
  // FAILS IF the classification is loosened to `-ge 1` / `-ne 0`.
  const fx = makeFixture({ content: 'noJars' });
  const r = run(SCRIPT, fx);

  assert.notEqual(r.status, 0, `an empty keep-set must abort\n${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /derived an EMPTY keep-set/);
  assert.doesNotMatch(
    r.stderr,
    /\.jar filter .* could not be COMPLETED/s,
    'a grep that completed with no match must not be reported as an incomplete probe',
  );
});

test('a blank filter that legitimately matches NOTHING is reported as empty, not as incomplete', () => {
  // Same shape at the sibling site: with every classpath field blank, the
  // blank filter's no-match exit of 1 is the CORRECT outcome.
  // FAILS IF that classification is loosened to `-ge 1` / `-ne 0`.
  const fx = makeFixture({ content: 'empty' });
  const r = run(SCRIPT, fx);

  assert.notEqual(r.status, 0, `an all-blank field list must abort\n${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /derived an EMPTY keep-set/);
  assert.doesNotMatch(
    r.stderr,
    /blank-field filter .* could not be COMPLETED/s,
    'a grep that completed with no match must not be reported as an incomplete probe',
  );
});

test('the fixture carries the elements the mutation arms depend on', () => {
  // is here because a reviewer showed a fixture element can be deleted with
  // nothing going red, which silently disarms the arm that element exists for.
  //
  // FAILS IF the in-examples classpath file is dropped: the searched-count
  // assertion in the positive control would then read 3 whether or not the
  // `! -path "${EXAMPLES}/*"` self-exclusion is present, and that mutation would
  // become undetectable. Same for the three outside classpaths, which are what
  // make "every iteration is judged" falsifiable.
  const fx = makeFixture();
  const outside = [
    path.join(fx.home, 'server', 'target', 'classpath'),
    path.join(fx.home, 'clients', 'java', 'target', 'classpath'),
    path.join(fx.home, 'cli', 'target', 'classpath'),
  ];
  assert.equal(outside.length, OUTSIDE_CLASSPATHS, 'the pinned count and the fixture disagree');
  for (const p of outside) assert.ok(existsSync(p), `missing outside classpath: ${p}`);
  assert.ok(
    existsSync(path.join(fx.home, 'examples', 'cli', 'target', 'classpath')),
    'the in-examples classpath is what makes the self-exclusion falsifiable',
  );
  // Each outside classpath must name a DIFFERENT jar, or a truncated keep-set
  // could drop one without any of them becoming unreferenced.
  const named = outside.map((p) => readFileSync(p, 'utf8'));
  assert.equal(new Set(named).size, OUTSIDE_CLASSPATHS, 'two classpath files name the same entries');
});

test('a split stage that truncates at exit ZERO is caught by the byte invariant', () => {
  // The arm that proves the invariant is not decoration: this mutant's `tr`
  // exits 0, so EVERY status read in the file passes and only the
  // bytes-in == bytes-out check can see it.
  // FAILS IF that invariant is deleted — the keep-set is then derived from 20
  // bytes of a several-hundred-byte field list and the prune deletes referenced
  // jars while reporting success.
  const fx = makeFixture();
  const r = run(SCRIPT, fx, { shims: { trTruncate: true } });

  assert.notEqual(r.status, 0, `a silent truncation must abort\n${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /the colon split lost bytes/);
  assert.ok(existsSync(fx.clientJar), 'a referenced jar was deleted from a truncated keep-set');
  assert.doesNotMatch(r.stdout, /assertions passed/);
});

// ───────────────────────────────────────────────────────────────────────────
// Source guard. Keyed to the SHAPE — a status discarded, a stderr discarded, or
// errexit disabled — rather than to a list of spellings. An earlier revision
// watched exactly two literals and was evaded by `|| :`, by `2>>/dev/null`, and
// by a `set +e` carrying no banned idiom at all.
// ───────────────────────────────────────────────────────────────────────────

/** Shapes that make a failure indistinguishable from an answer. */
const COLLAPSE_SHAPES = [
  { name: 'stderr redirected to the null device', re: /2>>?\s*\/dev\/null/ },
  { name: 'stderr closed outright', re: /2>&-/ },
  { name: 'a status swallowed by a short-circuit', re: /\|\|\s*(true|:|exit\s+0|return\s+0)(\s|;|\)|$)/ },
  { name: 'errexit disabled', re: /^\s*set\s+\+/ },
  { name: 'a find whose status is taken by a pipeline', re: /\bfind\b[^|]*\|(?!\|)/ },
  { name: 'xargs collapsing a child status', re: /\bxargs\b/ },
];

test('no executable line in the script lets a failure masquerade as an answer', () => {
  // Comment lines are stripped FIRST because the script quotes the defective line
  // verbatim in its own rationale — a guard matching raw source would be falsely
  // TRIPPED by a comment. `\r` is stripped first too: `.` in a JS regex does not
  // match `\r`, so a line guard no-ops on a CRLF checkout.
  //
  // FAILS IF the file is reverted to head (line 108 carries three of these
  // shapes at once), or if any one of them lands on an executable line later:
  // `|| :`, `2>>/dev/null`, `2>&-`, `set +e`, a restored `find … | sort > f`, or
  // a restored `xargs` are each independently caught.
  const src = readFileSync(SCRIPT, 'utf8').replace(/\r/g, '');
  const executable = src
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => line.trim() !== '' && !/^\s*#/.test(line));

  const offenders = [];
  for (const { line, n } of executable) {
    for (const shape of COLLAPSE_SHAPES) {
      if (shape.re.test(line)) offenders.push(`${n}: [${shape.name}] ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, [], 'a probe status or stderr is being discarded on an executable line');

  // The population this guard actually scanned, pinned POSITIONALLY at both
  // ends. The previous revision listed five content anchors — and a reviewer
  // showed they all sat between lines 143 and 411 of a 421-line file, so
  // `.slice(120, 412)` kept every one of them while a `set +e` at :65 and
  // discards at :79 and :420 went green. Content anchors cannot bracket a file
  // they do not sit at the edges of; the FIRST and LAST executable lines can.
  // FAILS IF the scanned list is narrowed from either end, or the file is
  // emptied, or its first/last executable statement changes without this being
  // reconsidered.
  const first = executable[0];
  const last = executable[executable.length - 1];
  assert.match(
    first.line,
    /^set -eu$/,
    `the first executable line scanned was line ${first.n} (${first.line.trim()}), not the script's 'set -eu'`,
  );
  assert.match(
    last.line,
    /SC1 loom-unity cache prune complete/,
    `the last executable line scanned was line ${last.n} (${last.line.trim()}), not the script's closing echo`,
  );

  // Paired positive: the replacement idioms are present, so the shape scan above
  // cannot pass over a file that no longer reads any status at all.
  const scanned = executable.map(({ line }) => line);
  for (const a of [
    { what: 'find reading its own status', re: /\|\| _p_rc=\$\?/ },
    { what: 'grep reading its own status', re: /\|\| _g_rc=\$\?/ },
    { what: 'wc reading its own status', re: /\|\| _m_rc=\$\?/ },
    { what: 'the operand validation', re: /require_number/ },
  ]) {
    assert.ok(
      scanned.some((l) => a.re.test(l)),
      `${a.what} was not among the ${scanned.length} lines this guard scanned`,
    );
  }
});
