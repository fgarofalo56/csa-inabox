/**
 * Tests for scripts/update-locks.sh — the CVE-remediation path (refs #3491).
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * `update-locks.sh` is the command `requirements/README.md` and
 * `docs/SUPPLY_CHAIN.md` §6.2 tell a CVE responder to run after raising a
 * floor. It could not perform that remediation: pip-compile reuses the
 * existing lock as constraints, the script passed no `--upgrade` flag of any
 * kind, and so a floor whose fix requires a transitive dependency to move
 * failed `ResolutionImpossible` — reporting "no solution exists" when the
 * truth was "I forbade the solution".
 *
 * Everything here drives the REAL script. Nothing re-implements its logic,
 * because a test that models the code cannot catch the code being wrong
 * (`csa_loom_fixtures_that_model_the_code`).
 *
 * EVERY ASSERTION IS PAIRED WITH ITS OPPOSITE. A test that only checks the
 * good case cannot tell you the check is capable of a different answer, which
 * is this repo's dominant defect class. So each capability is asserted
 * present under one input and ABSENT under a neighbouring one.
 *
 * The two network-bound facts — that the container path reproduces the
 * committed lock byte-identically, and that a real `--upgrade-package` run
 * resolves cryptography 50.0.0 / msal 1.37.0 — are NOT asserted here. They
 * need Docker and PyPI, and a unit suite that silently skips when they are
 * absent would be a gate that measures nothing. They are receipts on the PR
 * instead. What this suite owns is everything decidable offline: that the
 * flags reach pip-compile at all, that the platform pin is in the invocation,
 * and that a ResolutionImpossible is diagnosed against the lock's real pins.
 *
 * Run: node --test scripts/ci/__tests__/update-locks-upgrade.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = 'scripts/update-locks.sh';

/** Run the real script under bash and return the raw result. */
function run(args, { env = {}, pathPrefix = null } = {}) {
  const childEnv = { ...process.env, ...env };
  if (pathPrefix) {
    childEnv.PATH = `${pathPrefix}${path.delimiter}${childEnv.PATH}`;
  }
  const r = spawnSync('bash', [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: childEnv,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', all: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** Write an executable shim into a fresh temp dir and return both paths. */
function shim(name, body) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ulk-'));
  const file = path.join(dir, name);
  writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`, 'utf8');
  chmodSync(file, 0o755);
  return { dir, file };
}

/* -------------------------------------------------------------------------- */
/* 1. The flags that make a floor bump possible reach pip-compile.             */
/* -------------------------------------------------------------------------- */

test('--upgrade-package reaches the pip-compile invocation, and a plain run carries none', () => {
  const withFlag = run(['--print-plan', 'portal', '--upgrade-package', 'cryptography', '--upgrade-package', 'msal']);
  assert.equal(withFlag.status, 0, withFlag.all);
  assert.match(withFlag.stdout, /--upgrade-package cryptography/);
  assert.match(withFlag.stdout, /--upgrade-package msal/);

  // The opposite input. Without this half, the assertion above would pass
  // against a script that hard-codes the flag and ignores the argument.
  const plain = run(['--print-plan', 'portal']);
  assert.equal(plain.status, 0, plain.all);
  assert.doesNotMatch(plain.stdout, /--upgrade-package/);
  assert.doesNotMatch(plain.stdout, /--upgrade\b/);
});

test('--upgrade reaches the invocation and is distinct from --upgrade-package', () => {
  const all = run(['--print-plan', 'portal', '--upgrade']);
  assert.equal(all.status, 0, all.all);
  assert.match(all.stdout, /--upgrade\b/);
  assert.doesNotMatch(all.stdout, /--upgrade-package/);
});

test('--upgrade-package requires a value rather than swallowing the next flag', () => {
  const missing = run(['--upgrade-package']);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /--upgrade-package requires a package name/);

  const swallowed = run(['--upgrade-package', '--print-plan', 'portal']);
  assert.notEqual(swallowed.status, 0, swallowed.all);
});

/* -------------------------------------------------------------------------- */
/* 2. The compile platform is pinned in the invocation, not left to the host.  */
/* -------------------------------------------------------------------------- */

test('the default plan pins the compile image by DIGEST and pip-tools by version', () => {
  const plan = run(['--print-plan', 'portal']);
  assert.equal(plan.status, 0, plan.all);
  // A digest, not a floating tag: `python:3.12-slim` alone would let the base
  // move under the lock and reintroduce "the output depends on who ran it".
  assert.match(plan.stdout, /python:3\.12-slim@sha256:[0-9a-f]{64}/);
  assert.match(plan.stdout, /pip-tools==\d+\.\d+\.\d+/);

  // And that digest is the one the shipped backend image is built FROM. The
  // lock describes what that image installs; resolving it under a different
  // base describes a different install.
  const dockerfile = readFileSync(
    path.join(REPO_ROOT, 'portal/kubernetes/docker/backend/Dockerfile'),
    'utf8'
  );
  const planDigest = /python:3\.12-slim@(sha256:[0-9a-f]{64})/.exec(plan.stdout)[1];
  assert.ok(
    dockerfile.includes(planDigest),
    `the plan pins ${planDigest}, which portal/kubernetes/docker/backend/Dockerfile does not build FROM`
  );
});

test('--native is REFUSED on a non-Linux host and accepted on Linux (uname decides, and the verdict moves)', () => {
  const windows = shim('uname', 'echo "MINGW64_NT-10.0-26200"');
  const linux = shim('uname', 'echo "Linux"');
  try {
    const onWindows = run(['--native', '--print-plan', 'portal'], { pathPrefix: windows.dir });
    assert.notEqual(onWindows.status, 0, onWindows.all);
    assert.match(onWindows.stderr, /--native is refused on MINGW64/);
    // The refusal names the measured consequence, not a vague warning.
    assert.match(onWindows.stderr, /colorama/);
    assert.match(onWindows.stderr, /uvloop/);

    // Same flag, same repo, one fact changed: the host OS. If the verdict did
    // not move, the refusal above would not be reading uname at all.
    const onLinux = run(['--native', '--print-plan', 'portal'], { pathPrefix: linux.dir });
    assert.doesNotMatch(onLinux.stderr, /--native is refused/);
  } finally {
    rmSync(windows.dir, { recursive: true, force: true });
    rmSync(linux.dir, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- */
/* 3. ResolutionImpossible is DIAGNOSED against the lock's real pins.          */
/*                                                                            */
/* The stub stands in for docker, so the resolver text is fixed and the only  */
/* thing under test is the script's reading of it. The pins it is checked     */
/* against are the REAL requirements/locks/bff/requirements.txt, so this      */
/* cannot pass against a script that merely echoes the package name back.     */
/*                                                                            */
/* The blocker's VERSION is read out of that lock rather than hard-coded. The */
/* shape is what is under test, and a literal `1.36.0` would quietly stop     */
/* being a real pin the moment msal moves — leaving a test that still passes  */
/* while asserting nothing about the lock. (It did: #3492 moved msal to       */
/* 1.37.0 within the hour.)                                                   */
/* -------------------------------------------------------------------------- */

const BFF_LOCK = 'requirements/locks/bff/requirements.txt';
const PINNED_MSAL = /^msal==(\S+?)\s*\\?$/m.exec(readFileSync(path.join(REPO_ROOT, BFF_LOCK), 'utf8'))?.[1];

test('the fixtures below are built from a REAL pin, not a remembered one', () => {
  assert.ok(PINNED_MSAL, `${BFF_LOCK} does not pin msal; the fixtures below would assert nothing`);
});

const RESOLUTION_IMPOSSIBLE = [
  `ERROR: Cannot install msal==${PINNED_MSAL} and cryptography>=50.0.0 because these package versions have conflicting dependencies.`,
  'The conflict is caused by:',
  '    The user requested cryptography>=50.0.0',
  `    msal ${PINNED_MSAL} depends on cryptography<49,>=2.5`,
  'ERROR: ResolutionImpossible: for help visit https://pip.pypa.io/en/latest/topics/dependency-resolution/',
].join('\n');

test('a ResolutionImpossible naming a version PINNED in the lock is attributed to the reused constraint', () => {
  const docker = shim('docker', `printf '%s\\n' ${JSON.stringify(RESOLUTION_IMPOSSIBLE)}\nexit 1`);
  try {
    const r = run(['bff'], { env: { DOCKER: docker.file } });
    assert.notEqual(r.status, 0, r.all);
    assert.match(r.stderr, /ALREADY PINNED in\s+requirements\/locks\/bff\/requirements\.txt: .*msal/s);
    // And the remediation is the exact command, not a description of one.
    assert.match(r.stderr, /scripts\/update-locks\.sh bff --upgrade-package msal/);
    assert.doesNotMatch(r.stderr, /cannot attribute the conflict/);
  } finally {
    rmSync(docker.dir, { recursive: true, force: true });
  }
});

test('the blocker is found when the resolver names it ONLY as a wheel URL (the real #3492 failure)', () => {
  // The shape is VERBATIM from the real `update-locks.sh bff` failure on
  // 2026-08-15, after the cryptography floor was declared. pip-tools raised the
  // conflict from inside resolvelib, so `msal <version>` NEVER appears with a
  // space — the version exists only inside a wheel filename. The first draft of
  // the extractor read one shape, found nothing here, and printed "NONE of the
  // versions the resolver named is a pin" over a lock that pins msal. A
  // diagnosis keyed to a shape the defect does not take.
  const wheelOnly = [
    'ERROR: Cannot install cryptography<51.0.0 and >=50.0.0 and csa-inabox (pyproject.toml) because these package versions have conflicting dependencies.',
    "pip._vendor.resolvelib.resolvers.ResolutionImpossible: [RequirementInformation(requirement=SpecifierRequirement('cryptography<51.0.0,>=50.0.0'), parent=None), " +
      "RequirementInformation(requirement=SpecifierRequirement('cryptography<49,>=2.5'), parent=LinkCandidate(" +
      `'https://files.pythonhosted.org/packages/2a/d3/414d1f0a5f6f4fe5313c2b002c54e78a3332970feb3f5fed14237aa17064/msal-${PINNED_MSAL}-py3-none-any.whl ` +
      "(from https://pypi.org/simple/msal/) (requires-python:>=3.8)'))]",
    'pip._internal.exceptions.DistributionNotFound: ResolutionImpossible: for help visit https://pip.pypa.io/',
  ].join('\n');
  assert.doesNotMatch(
    wheelOnly,
    new RegExp(`msal ${PINNED_MSAL.replace(/\./g, '\\.')}`),
    'fixture must not contain the space-separated shape'
  );

  const docker = shim('docker', `printf '%s\\n' ${JSON.stringify(wheelOnly)}\nexit 1`);
  try {
    const r = run(['bff'], { env: { DOCKER: docker.file } });
    assert.notEqual(r.status, 0, r.all);
    assert.match(r.stderr, /ALREADY PINNED in\s+requirements\/locks\/bff\/requirements\.txt: .*msal/s);
    assert.match(r.stderr, /scripts\/update-locks\.sh bff --upgrade-package msal/);
  } finally {
    rmSync(docker.dir, { recursive: true, force: true });
  }
});

test('a ResolutionImpossible naming NO pinned version REFUSES to blame reused constraints', () => {
  // Same failure class, but every version named is one the lock does not pin.
  // deploy-integrity.md R7: an error must not assert a cause it did not
  // establish. This is the half that proves the message above was measured.
  const unrelated = [
    'ERROR: Cannot install nonexistentpkg==9.9.9 because these package versions have conflicting dependencies.',
    'The conflict is caused by:',
    '    nonexistentpkg 9.9.9 depends on alsomissing<1',
    'ERROR: ResolutionImpossible: for help visit https://pip.pypa.io/',
  ].join('\n');
  const docker = shim('docker', `printf '%s\\n' ${JSON.stringify(unrelated)}\nexit 1`);
  try {
    const r = run(['bff'], { env: { DOCKER: docker.file } });
    assert.notEqual(r.status, 0, r.all);
    assert.match(r.stderr, /NONE of the versions the resolver named is a pin/);
    assert.doesNotMatch(r.stderr, /ALREADY PINNED/);
  } finally {
    rmSync(docker.dir, { recursive: true, force: true });
  }
});

test('a failure that is NOT a resolution conflict is not dressed up as one', () => {
  const docker = shim('docker', `printf '%s\\n' "Error response from daemon: pull access denied"\nexit 125`);
  try {
    const r = run(['bff'], { env: { DOCKER: docker.file } });
    assert.notEqual(r.status, 0, r.all);
    assert.match(r.stderr, /does not recognise that failure and will not guess/);
    assert.doesNotMatch(r.stderr, /ALREADY PINNED/);
    // The real exit code and the real output are both surfaced.
    assert.match(r.stderr, /pip-compile exited 125/);
    assert.match(r.stderr, /pull access denied/);
  } finally {
    rmSync(docker.dir, { recursive: true, force: true });
  }
});

test('a compile that exits 0 without writing the lock is a FAILURE, not a success', () => {
  // The "exits 0 having produced nothing" shape. Without this, a broken
  // container path would print "Done." over an untouched tree.
  const target = path.join(REPO_ROOT, 'requirements', 'locks', 'base', 'requirements.txt');
  const before = readFileSync(target, 'utf8');
  const docker = shim('docker', `: > "${target.split(path.sep).join('/')}"\nexit 0`);
  try {
    const r = run(['base'], { env: { DOCKER: docker.file } });
    assert.notEqual(r.status, 0, r.all);
    assert.match(r.stderr, /exited 0 but requirements\/locks\/base\/requirements\.txt is missing or empty/);
  } finally {
    writeFileSync(target, before, 'utf8');
    rmSync(docker.dir, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- */
/* 4. Input validation — a typo must not overwrite a real lock.               */
/* -------------------------------------------------------------------------- */

test('an unknown extra is refused instead of compiling the base set over a real lock', () => {
  const r = run(['porta']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /'porta' is not an extra with a committed lock/);
  assert.match(r.stderr, /portal/); // the known list is printed

  const ok = run(['--print-plan', 'portal']);
  assert.equal(ok.status, 0, ok.all);
});

test('an unknown flag is refused rather than treated as an extra', () => {
  const r = run(['--upgrade-everything', 'portal']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown flag '--upgrade-everything'/);
});
