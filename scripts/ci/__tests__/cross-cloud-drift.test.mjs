/**
 * Self-tests for check-cross-cloud-drift.mjs and the shared estate registry (#3730).
 *
 * WHAT IS BEING PINNED, AND WHY IT IS PINNED THIS WAY
 * ==================================================
 * The control this suite covers exists because a live estate sat 251 commits and
 * seven days behind main while every dashboard read green. The obvious risk when
 * writing its replacement is to build a second control with the same property —
 * one that runs, prints a table, and cannot actually fail. This repo has shipped
 * that shape often enough to have a name for it, and the honest test for it is
 * not "does the code look right" but "does the VERDICT MOVE when the input
 * moves". So the centrepiece here is an END-TO-END MUTATION PROOF:
 *
 *   the real CLI, as a child process, against a real HTTP server serving a
 *   FABRICATED marker, asserting the real process exit code.
 *
 *   fabricated sha = HEAD            -> exit 0, reported ok
 *   fabricated sha = an old commit   -> exit 1, reported DRIFT
 *   endpoint refuses the connection  -> exit 1, reported UNKNOWN + "could not reach"
 *   endpoint serves an HTML error    -> exit 1, reported UNKNOWN (never DRIFT, never ok)
 *
 * Nothing is stubbed in those four: fetch is real, git is real, the exit code is
 * the process's own. A guard whose verdict does not change under mutation is not
 * watching, and until this file existed that had never been demonstrated for
 * this control — which is precisely the criticism the control itself levels at
 * the deploy paths it monitors.
 *
 * THE THIRD AND FOURTH CASES ARE THE ONES THAT MATTER MOST. deploy-integrity.md
 * R7 exists because on 2026-08-05 a roll reported "the tag does not exist" when
 * the truth was "I could not reach the registry", and that single false sentence
 * cost two investigations. An unreachable estate must therefore land in its OWN
 * state — not "current" (which would be a false green over an estate nobody
 * read) and not "behind" (which would assert a drift nobody measured). Both
 * assertions below check the WORD as well as the exit code, because the exit
 * code alone cannot tell those two failures apart.
 *
 * MUTATIONS THAT MAKE THIS SUITE GO RED (the reason each case is here):
 *   - drop the `error` branch in probeMarker            -> UNREACHABLE case: no
 *     "could not reach", and the row would read as measured.
 *   - let a git failure return commitsBehind 0          -> STALE + not-in-clone
 *     cases: a missing commit would read as 0 behind and exit 0.
 *   - relax GIT_OBJECT_ID, or make parseBuildMarker
 *     return a sha for `unknown` / an HTML page         -> the fixture-corpus
 *     tests and the HTML end-to-end case both go red.
 *   - make decideCrossCloud always return code 0        -> every failing case.
 *   - drop Gov from CLOUD_ESTATES                       -> the registry tests.
 *   - remove the override disclosure                    -> the banner assertion.
 *
 * Run: node --test scripts/ci/__tests__/cross-cloud-drift.test.mjs
 * (Discovered automatically by scripts/ci/check-node-test-suites.mjs, which the
 *  merge-blocking `guardrails` job runs — so these have teeth in CI.)
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyEstate } from '../check-deploy-staleness.mjs';
import {
  CLOUD_ESTATES,
  GIT_OBJECT_ID,
  describeOverrides,
  parseBuildMarker,
} from '../_estate-registry.mjs';
import {
  decideCrossCloud,
  probeMarker,
  probeVersion,
  resolveAgainstGit,
  resolveComparisonRef,
} from '../check-cross-cloud-drift.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const CLI = path.join(REPO_ROOT, 'scripts', 'ci', 'check-cross-cloud-drift.mjs');
const WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'cross-cloud-drift-alarm.yml');

/**
 * The SHARED marker corpus. The console's TypeScript parser asserts against this
 * same file, so the two implementations cannot diverge on format handling
 * without one of the two suites going red. That is the whole point of the file
 * being data rather than inline literals in either suite.
 */
const FIXTURES = JSON.parse(
  readFileSync(path.join(HERE, '..', '__fixtures__', 'build-markers.json'), 'utf8'),
);

// NOTE: there is deliberately no helper that runs git against THIS checkout.
// Every git-dependent assertion below uses the purpose-built fixture repo, so
// nothing in this suite changes meaning with `fetch-depth` or with whether the
// event is a push or a pull_request. See makeFixtureRepo.

// ---------------------------------------------------------------------------
// parseBuildMarker — the two clouds' shapes, and every way a marker can be bad
// ---------------------------------------------------------------------------

test('parses BOTH clouds\' real markers — 40-hex Commercial and 8-hex Gov', () => {
  // Population guard first. An empty or one-sided corpus would make every
  // assertion below vacuous while still printing green — the hollow-gate shape.
  assert.ok(FIXTURES.real.length >= 5, `expected a real-marker corpus, got ${FIXTURES.real.length}`);
  const estates = new Set(FIXTURES.real.map((c) => c.estate));
  assert.ok(estates.has('Commercial') && estates.has('Azure Government'),
    `the corpus must carry a REAL marker from each cloud; got ${[...estates].join(', ')}`);

  for (const c of FIXTURES.real) {
    const got = parseBuildMarker(c.text);
    assert.equal(got.error, null, `${c.id}: expected a clean parse, got ${got.error}`);
    assert.equal(got.sha, c.expect.sha, `${c.id}: sha`);
    assert.equal(got.stamp, c.expect.stamp, `${c.id}: stamp`);
  }
});

test('the two clouds genuinely differ in shape — the corpus is not two copies', () => {
  // If a future edit normalised both fixtures to the same shape, every
  // "handles both formats" claim in this suite would become untested while
  // still passing. So the DIFFERENCE itself is asserted.
  const commercial = FIXTURES.real.find((c) => c.id === 'commercial-2026-08-18');
  const gov = FIXTURES.real.find((c) => c.id === 'gov-2026-08-11');
  assert.ok(commercial && gov, 'both live-measured fixtures must be present');
  assert.equal(commercial.expect.sha.length, 40, 'Commercial passes ${{ github.sha }} — a full object id');
  assert.equal(gov.expect.sha.length, 8, 'Gov passes `git rev-parse --short=8 HEAD`');
  assert.notEqual(commercial.expect.sha.length, gov.expect.sha.length);
  // Stamps differ too: basic ISO vs extended ISO.
  assert.ok(!commercial.expect.stamp.includes('-'), 'Commercial stamp is basic ISO (20260818T152007Z)');
  assert.ok(gov.expect.stamp.includes('-'), 'Gov stamp is extended ISO (2026-08-11T09:23:46Z)');
});

test('an unreadable marker FAILS LOUDLY and never yields a sha', () => {
  assert.ok(FIXTURES.unparseable.length >= 8,
    `expected a populated malformed corpus, got ${FIXTURES.unparseable.length}`);
  for (const c of FIXTURES.unparseable) {
    const got = parseBuildMarker(c.text);
    // THE INVARIANT. A null sha with a null error would let a caller compute
    // "0 commits behind" for an estate it never read — a broken estate
    // rendering as a current one, which is the exact defect this whole change
    // exists to close.
    assert.equal(got.sha, null, `${c.id}: must not produce a sha`);
    assert.ok(typeof got.error === 'string' && got.error.length > 20,
      `${c.id}: must carry a reason naming what was served, got ${JSON.stringify(got.error)}`);
  }
});

test('the malformed reasons are DISTINCT — they name different causes', () => {
  // R7: an error must state what was established. "no sha= field", "sha=unknown"
  // and "not a git object id" have three different fixes (check the ingress,
  // check the build-arg, check the producer), so collapsing them into one
  // message would be a true-but-useless error.
  const reason = (id) => parseBuildMarker(FIXTURES.unparseable.find((c) => c.id === id).text).error;
  const html = reason('front-door-error-page');
  const unknown = reason('sha-unknown');
  const notHex = reason('sha-not-hex');
  assert.match(html, /HTML|ingress|WAF/i, 'an HTML body must be named as an ingress/error page, not as a bad field');
  assert.match(unknown, /LOOM_BUILD_SHA|build-arg/, 'sha=unknown must point at the missing build-arg');
  assert.match(notHex, /git object id/, 'a non-hex value must be named as such');
  assert.equal(new Set([html, unknown, notHex]).size, 3, 'three causes must produce three messages');
});

test('the path-traversal marker is rejected and its bytes never become a sha', () => {
  // The console interpolates this value into an api.github.com path; the WHATWG
  // URL parser collapses ../ BEFORE the request goes out, so an accepted value
  // here chooses the endpoint. Containment is that `sha` stays null.
  const c = FIXTURES.unparseable.find((x) => x.id === 'sha-path-traversal');
  const got = parseBuildMarker(c.text);
  assert.equal(got.sha, null);
  assert.ok(!GIT_OBJECT_ID.test('../../../../user/repos?x='));
});

test('GIT_OBJECT_ID bounds are exactly 7..40 hex, both cases', () => {
  assert.ok(GIT_OBJECT_ID.test('28de89f'), '7 hex is git\'s own abbreviation floor');
  assert.ok(GIT_OBJECT_ID.test('28DE89FB'), 'git accepts uppercase object ids');
  assert.ok(GIT_OBJECT_ID.test('a'.repeat(40)), '40 hex is a full object id');
  assert.ok(!GIT_OBJECT_ID.test('28de89'), '6 hex is too ambiguous to name a commit');
  assert.ok(!GIT_OBJECT_ID.test('a'.repeat(41)), '41 hex is not an object id');
  assert.ok(!GIT_OBJECT_ID.test('main'), 'a ref name is not an object id');
});

// ---------------------------------------------------------------------------
// the registry
// ---------------------------------------------------------------------------

test('CLOUD_ESTATES carries BOTH clouds, over https, with no commit-count band', () => {
  const ids = CLOUD_ESTATES.map((e) => e.id);
  // The founding defect was a one-entry list. Asserting the Gov entry exists is
  // the regression test for the whole issue.
  assert.ok(ids.includes('commercial'), `expected a Commercial estate, got ${ids.join(', ')}`);
  assert.ok(ids.includes('gov'), `expected an Azure Government estate, got ${ids.join(', ')}`);

  for (const e of CLOUD_ESTATES) {
    assert.match(e.markerUrl, /^https:\/\/.+\/build-marker\.txt$/, `${e.id}: marker URL`);
    assert.match(e.versionUrl, /^https:\/\/.+\/api\/version$/, `${e.id}: version URL`);
    // The band that made the first cut of this control unable to fire on the
    // real estate must not come back under any name.
    assert.equal(e.maxCommitsBehind, undefined,
      `${e.id}: a commit-count tolerance is what let a 13-behind estate read ok`);
    assert.ok(e.behindGraceMinutes > 0 && e.behindGraceMinutes <= 240,
      `${e.id}: the roll-in-flight allowance must stay small (got ${e.behindGraceMinutes}min)`);
    assert.ok(e.maxAgeDays > 0 && e.maxAgeDays <= 14, `${e.id}: maxAgeDays`);
  }
});

test('the Gov allowance cannot absorb the drift it was written for', () => {
  // #3730 measured 251 commits / 7 days. A window that tolerated that would be a
  // band that cannot fire on its own founding condition — the exact mistake the
  // Commercial entry made with maxCommitsBehind:20. Pinned as a number so a
  // future "just widen it a bit" has to argue with a failing test.
  const gov = CLOUD_ESTATES.find((e) => e.id === 'gov');
  const SEVEN_DAYS_MIN = 7 * 24 * 60;
  assert.ok(gov.behindGraceMinutes < SEVEN_DAYS_MIN / 10,
    `the Gov window (${gov.behindGraceMinutes}min) must stay far below the 7 days of drift it exists to catch`);
});

test('describeOverrides reports an override, and reports none when there is none', () => {
  // The disclosure is the only thing standing between "an endpoint override
  // exists so the alarm can be proved" and "an endpoint override exists so the
  // alarm can be silenced".
  const before = describeOverrides([{ id: 'x', markerUrlEnv: 'LOOM_TEST_ABSENT_A', versionUrlEnv: 'LOOM_TEST_ABSENT_B' }]);
  assert.deepEqual(before, [], 'no env set ⇒ nothing disclosed');
  process.env.LOOM_TEST_PRESENT_A = 'http://example.invalid/build-marker.txt';
  try {
    const after = describeOverrides([{
      id: 'x', markerUrl: 'http://example.invalid/build-marker.txt',
      markerUrlEnv: 'LOOM_TEST_PRESENT_A', versionUrlEnv: 'LOOM_TEST_ABSENT_B',
    }]);
    assert.equal(after.length, 1);
    assert.equal(after[0].env, 'LOOM_TEST_PRESENT_A');
  } finally {
    delete process.env.LOOM_TEST_PRESENT_A;
  }
});

// ---------------------------------------------------------------------------
// decideCrossCloud — the exit decision
// ---------------------------------------------------------------------------

test('decideCrossCloud separates DRIFT from UNKNOWN and fails on either', () => {
  const ok = { state: 'current', stale: false };
  const behind = { state: 'behind', stale: true };
  const unknown = { state: 'unknown', stale: true };

  assert.deepEqual(decideCrossCloud([ok, ok]), { drifted: [], unknown: [], code: 0 });

  const d = decideCrossCloud([ok, behind]);
  assert.equal(d.code, 1);
  assert.equal(d.drifted.length, 1);
  assert.equal(d.unknown.length, 0, 'a behind estate is not an unmeasured one');

  const u = decideCrossCloud([ok, unknown]);
  assert.equal(u.code, 1, 'an estate nobody could measure must not buy a green');
  assert.equal(u.unknown.length, 1);
  assert.equal(u.drifted.length, 0, 'an unmeasured estate must not be reported as drifted');

  // Divergent is drift, not unknown: the build IS identified, it is just not on
  // this history.
  const v = decideCrossCloud([{ state: 'divergent', stale: true }]);
  assert.equal(v.code, 1);
  assert.equal(v.drifted.length, 1);
});

// ---------------------------------------------------------------------------
// resolveAgainstGit — real git, against a PURPOSE-BUILT repo
// ---------------------------------------------------------------------------

/**
 * A throwaway git repo with a known, back-dated history.
 *
 * WHY NOT THIS CHECKOUT, which is what the first cut used. Asserting against
 * `HEAD~5` of the repo under test broke in CI twice, for two unrelated reasons,
 * neither of which had anything to do with the behaviour being tested:
 *
 *   1. `6 !== 5` — a `pull_request` build checks out a MERGE COMMIT
 *      (refs/pull/N/merge). `HEAD~5` walks FIRST-PARENT while `rev-list --count`
 *      counts everything reachable, so on a merge the two disagree. Measured on
 *      this repo: at a merge commit, `HEAD~5..HEAD` counts 304, not 5.
 *   2. `fatal: ambiguous argument 'HEAD~5': unknown revision` — the
 *      `node:test suites` lane checks out SHALLOW, so there is no HEAD~5 at all.
 *
 * Both are the fixture depending on how CI happens to clone, and the second is
 * the sharper lesson: a test that needs history is a test that silently changes
 * meaning with `fetch-depth`. A fixture repo removes the dependency entirely —
 * history shape, depth and commit DATES are all controlled here, so the
 * ">240 minutes" precondition of the staleness proof is guaranteed by
 * construction rather than hoped for.
 */
function makeFixtureRepo(commits = 6) {
  const dir = mkdtempSync(join(tmpdir(), 'loom-drift-'));
  const g = (args, env) => execFileSync('git', args, {
    cwd: dir, encoding: 'utf8', env: { ...process.env, ...env },
  }).trim();
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.email', 'drift-test@example.invalid']);
  g(['config', 'user.name', 'drift test']);
  g(['config', 'commit.gpgsign', 'false']);
  const shas = [];
  for (let i = 0; i < commits; i += 1) {
    writeFileSync(join(dir, 'f.txt'), `commit ${i}\n`);
    g(['add', 'f.txt']);
    // Commit i is (commits - i) DAYS old. Every commit after the first is
    // therefore days behind — far past any roll window — so the staleness case
    // cannot accidentally stop testing staleness.
    const when = new Date(Date.now() - (commits - i) * 86_400_000).toISOString();
    g(['commit', '-q', '-m', `c${i}`], { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when });
    shas.push(g(['rev-parse', 'HEAD']));
  }
  return { dir, shas, head: shas[shas.length - 1] };
}

/** Fixture repo shared by the git + end-to-end cases. */
const REPO_FIXTURE = makeFixtureRepo(6);
after(() => {
  // force + retries: on Windows a git pack file can still be briefly held.
  rmSync(REPO_FIXTURE.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('CONTROL — the fixture repo is what these tests think it is', () => {
  // A control on the HARNESS. If the fixture ever stopped producing the history
  // it claims, every assertion below would be measuring something else while
  // still reading green — the hollow-gate shape, one level down.
  assert.equal(REPO_FIXTURE.shas.length, 6);
  assert.equal(new Set(REPO_FIXTURE.shas).size, 6, 'six DISTINCT commits');
  const count = execFileSync('git', ['rev-list', '--count', `${REPO_FIXTURE.shas[0]}..HEAD`], {
    cwd: REPO_FIXTURE.dir, encoding: 'utf8',
  }).trim();
  assert.equal(count, '5', 'the first commit must be exactly 5 behind HEAD');
});

test('HEAD resolves to zero commits behind', () => {
  const r = resolveAgainstGit(REPO_FIXTURE.head, { cwd: REPO_FIXTURE.dir });
  assert.equal(r.error, null, `expected HEAD to resolve, got ${r.error}`);
  assert.equal(r.ancestor, true);
  assert.equal(r.commitsBehind, 0);
});

test('an ABBREVIATED sha resolves — the Gov marker shape must work', () => {
  // This is the case that would have silently produced "unknown" for the entire
  // sovereign boundary if the code had assumed 40-hex.
  const short = execFileSync('git', ['rev-parse', '--short=8', 'HEAD'], {
    cwd: REPO_FIXTURE.dir, encoding: 'utf8',
  }).trim();
  assert.equal(short.length, 8);
  const r = resolveAgainstGit(short, { cwd: REPO_FIXTURE.dir });
  assert.equal(r.error, null, `an 8-hex abbreviation must resolve, got ${r.error}`);
  assert.equal(r.commitsBehind, 0);
});

test('an older commit resolves to a POSITIVE distance', () => {
  const r = resolveAgainstGit(REPO_FIXTURE.shas[0], { cwd: REPO_FIXTURE.dir });
  assert.equal(r.error, null, `expected the first commit to resolve, got ${r.error}`);
  // The property that matters: an ancestor is BEHIND. A mutation returning 0 or
  // null for an older commit — the arithmetic that would render a stale estate
  // as current — goes red here.
  assert.ok(r.commitsBehind > 0, `an ancestor must be behind by at least one commit, got ${r.commitsBehind}`);
  assert.equal(r.commitsBehind, 5);
  assert.ok(r.behindSince, 'the oldest unapplied commit date must be measured');
  // Back-dated by days, so this is guaranteed past every roll window.
  assert.ok(r.behindForMinutes > 240, `expected a days-old wait, got ${r.behindForMinutes}min`);
});

test('a sha NOT in this clone is an ERROR, never zero commits behind', () => {
  // THE INVARIANT THE WHOLE CONTROL RESTS ON. A shallow checkout, a force-push,
  // or an image built off a deleted branch must not be able to render as "on
  // main". `deadbeef...` is valid hex and therefore passes GIT_OBJECT_ID; only
  // git can say it is absent.
  const r = resolveAgainstGit('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', { cwd: REPO_FIXTURE.dir });
  assert.equal(r.commitsBehind, null, 'an unresolvable commit must not yield a distance');
  assert.ok(typeof r.error === 'string' && r.error.length > 0, 'it must say why');
  // The message must carry git's OWN words, not an inference about them.
  assert.match(r.error, /not resolvable in this checkout/);
});

test('the comparison ref prefers the DEFAULT BRANCH over whatever is checked out', () => {
  // R7 REGRESSION TEST. This defaulted to `HEAD`, which is main in the scheduled
  // workflow and a feature branch anywhere else. Run from a branch, the live
  // Commercial sha is not an ancestor of that branch, so a HEALTHY, just-rolled
  // estate was reported as:
  //
  //   Commercial [divergent] — the running build 649526d4 is NOT an ancestor of
  //   main — it was built from a branch, a revert, or a force-pushed history
  //
  // Every clause after the dash is a cause the code never established. Measured
  // live, on a good estate.
  //
  // The fixture repo has `main` but no `origin/main`, so the fallback chain is
  // exercised rather than asserted about: it must skip the missing remote-
  // tracking ref and land on the local default branch, NOT on HEAD.
  assert.equal(resolveComparisonRef(REPO_FIXTURE.dir), 'main');

  // An explicit override wins, so an operator can pin a ref deliberately.
  process.env.LOOM_DRIFT_BRANCH = 'HEAD';
  try {
    assert.equal(resolveComparisonRef(REPO_FIXTURE.dir), 'HEAD');
  } finally {
    delete process.env.LOOM_DRIFT_BRANCH;
  }
});

// ---------------------------------------------------------------------------
// probeMarker / probeVersion — transport failures are named as transport failures
// ---------------------------------------------------------------------------

test('probeMarker says "could not reach" on a transport failure', async () => {
  const estate = { markerUrl: 'https://estate.invalid/build-marker.txt' };
  const boom = async () => { throw new Error('getaddrinfo ENOTFOUND estate.invalid'); };
  const r = await probeMarker(estate, boom);
  assert.equal(r.sha, null);
  assert.match(r.error, /could not reach/, 'the message must say we could not look');
  assert.doesNotMatch(r.error, /behind|stale|up to date/i,
    'a transport failure must not assert anything about the estate\'s freshness');
});

test('probeMarker reports a non-200 as a read failure with the status', async () => {
  const estate = { markerUrl: 'https://estate.invalid/build-marker.txt' };
  const five03 = async () => ({ ok: false, status: 503 });
  const r = await probeMarker(estate, five03);
  assert.equal(r.sha, null);
  assert.match(r.error, /HTTP 503/);
});

test('a failed version probe cannot change a verdict — it is display metadata', async () => {
  const estate = { versionUrl: 'https://estate.invalid/api/version' };
  const boom = async () => { throw new Error('ECONNREFUSED'); };
  const r = await probeVersion(estate, boom);
  assert.equal(r.version, null);
  assert.ok(r.error, 'the failure is recorded');
  // …and nothing else. probeVersion returns no `stale` and no `state`, so there
  // is no path by which a slow /api/version can redden a healthy estate.
  assert.deepEqual(Object.keys(r).sort(), ['error', 'version']);
});

// ---------------------------------------------------------------------------
// END-TO-END MUTATION PROOF — the real CLI, a real server, a real exit code
// ---------------------------------------------------------------------------

/** Serve one fabricated marker + version payload on an ephemeral local port. */
async function withMarkerServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const { port } = server.address();
  try {
    return await fn(port);
  } finally {
    await new Promise((res) => server.close(res));
  }
}

/**
 * Point BOTH estates at `origin` and run the real CLI as a child process.
 *
 * `cwd` is the FIXTURE repo, not this checkout: the CLI asks git for commit
 * distances relative to its own working directory, so running it there is what
 * makes the end-to-end proof independent of how CI clones this repository (see
 * makeFixtureRepo for the two CI breakages that taught this).
 *
 * ASYNCHRONOUS, AND THAT IS NOT A STYLE CHOICE. The first cut used spawnSync,
 * which blocks this process's event loop for the whole child run — so the
 * fixture HTTP server above, which lives in THIS process, could never accept a
 * connection. Every request timed out and all three end-to-end cases reported
 * UNKNOWN. The suite still went red (the assertions are on the exit code AND the
 * reported state, so a wrong-reason failure could not pass), but a suite
 * asserting only `status === 1` would have read GREEN for the stale case while
 * proving nothing about staleness at all — a control confirming itself against
 * a broken harness.
 */
function runCli(origin, cwd = REPO_FIXTURE.dir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI], {
      cwd,
      env: {
        ...process.env,
        LOOM_ESTATE_MARKER_URL: `${origin}/build-marker.txt`,
        LOOM_ESTATE_VERSION_URL: `${origin}/api/version`,
        LOOM_GOV_ESTATE_MARKER_URL: `${origin}/build-marker.txt`,
        LOOM_GOV_ESTATE_VERSION_URL: `${origin}/api/version`,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

/** A handler serving `markerText` at /build-marker.txt and a version at /api/version. */
const serve = (markerText, version = '9.9.9') => (req, res) => {
  if (req.url.startsWith('/api/version')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ current: version }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(markerText);
};

test('MUTATION PROOF — a CURRENT fabricated marker PASSES (exit 0)', async () => {
  const marker = `loom-build-marker sha=${REPO_FIXTURE.head} stamp=20260818T152007Z token=LOOM_LIVE_BUILD\n`;
  await withMarkerServer(serve(marker), async (port) => {
    const r = await runCli(`http://127.0.0.1:${port}`);
    const out = `${r.stdout}${r.stderr}`;
    assert.equal(r.status, 0, `expected exit 0 for an on-main estate; got ${r.status}\n${out}`);
    assert.match(out, /every live estate was MEASURED and is running main/);
    // The anti-silencing disclosure must fire — this run did NOT read production.
    assert.match(out, /NON-PRODUCTION ENDPOINTS IN USE/,
      'an overridden endpoint must be announced, or the override becomes a mute button');
  });
});

test('MUTATION PROOF — a STALE fabricated marker FAILS (exit 1, reported as DRIFT)', async () => {
  // The fixture's FIRST commit: five behind HEAD and back-dated by days, so the
  // oldest unapplied commit is guaranteed past the widest per-estate roll
  // window (240 min) by construction rather than by luck.
  const base = REPO_FIXTURE.shas[0];
  const measured = resolveAgainstGit(base, { cwd: REPO_FIXTURE.dir });
  assert.equal(measured.error, null, `the fixture base must resolve: ${measured.error}`);
  assert.ok(measured.behindForMinutes > 240,
    `precondition: the oldest unapplied commit must be older than the widest roll window; `
    + `measured ${measured.behindForMinutes}min. This test is not exercising staleness otherwise.`);

  const marker = `loom-build-marker sha=${base} stamp=2026-08-11T09:23:46Z token=LOOM_LIVE_BUILD\n`;
  await withMarkerServer(serve(marker, '0.90.2'), async (port) => {
    const r = await runCli(`http://127.0.0.1:${port}`);
    const out = `${r.stdout}${r.stderr}`;
    // THE VERDICT MOVED. Same code, same server, same everything but the sha.
    assert.equal(r.status, 1, `expected exit 1 for a behind estate; got ${r.status}\n${out}`);
    assert.match(out, /DRIFT/, 'a behind estate must be reported as drift');
    assert.match(out, /live estate\(s\) are NOT running main/);
    assert.match(out, /5 commit\(s\) behind main/, 'the reported distance must be the fixture distance');
    assert.doesNotMatch(out, /could NOT BE MEASURED/,
      'a measured-and-behind estate must NOT be reported as unmeasurable');
  });
});

test('MUTATION PROOF — a STALE ABBREVIATED sha (the Gov shape) also FAILS', async () => {
  // Belt and braces on the format that #3730 is actually about: the sovereign
  // console publishes 8 hex, and a control that only ever saw 40 would have
  // reported the entire boundary as unmeasurable rather than as behind.
  const short = execFileSync('git', ['rev-parse', '--short=8', REPO_FIXTURE.shas[0]], {
    cwd: REPO_FIXTURE.dir, encoding: 'utf8',
  }).trim();
  const marker = `loom-build-marker sha=${short} stamp=2026-08-11T09:23:46Z token=LOOM_LIVE_BUILD\n`;
  await withMarkerServer(serve(marker, '0.90.2'), async (port) => {
    const r = await runCli(`http://127.0.0.1:${port}`);
    const out = `${r.stdout}${r.stderr}`;
    assert.equal(r.status, 1, `expected exit 1 for an abbreviated stale sha; got ${r.status}\n${out}`);
    assert.match(out, /DRIFT/);
    assert.match(out, /5 commit\(s\) behind main/);
  });
});

test('MUTATION PROOF — an UNREACHABLE endpoint is UNKNOWN, not stale and not current', async () => {
  // Bind a port, then close it, so the address is almost certainly refused.
  const port = await withMarkerServer(serve(''), async (p) => p);
  const r = await runCli(`http://127.0.0.1:${port}`);
  const out = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 1, `an unmeasured estate must not exit 0; got ${r.status}\n${out}`);
  assert.match(out, /UNKNOWN/, 'the state must be UNKNOWN');
  assert.match(out, /could not reach/, 'R7: the message must say we could not look');
  assert.match(out, /could NOT BE MEASURED/);
  // The two claims it must NOT make.
  assert.doesNotMatch(out, /is running main/,
    'an unreachable estate must never be reported as current');
  assert.doesNotMatch(out, /are NOT running main/,
    'an unreachable estate must never be reported as drifted — that asserts a fact nobody measured');
});

test('MUTATION PROOF — a 200 carrying an HTML error page is UNKNOWN, not current', async () => {
  // The realistic ingress failure: Front Door answers 200 with an interstitial.
  // Reading it as "no sha, therefore no drift" would report a DOWN estate as a
  // healthy one.
  const html = FIXTURES.unparseable.find((c) => c.id === 'front-door-error-page').text;
  await withMarkerServer(serve(html), async (port) => {
    const r = await runCli(`http://127.0.0.1:${port}`);
    const out = `${r.stdout}${r.stderr}`;
    assert.equal(r.status, 1, `expected exit 1 for an unparseable marker; got ${r.status}\n${out}`);
    assert.match(out, /UNKNOWN/);
    assert.match(out, /HTML|ingress|WAF/i, 'the reason must name what was actually served');
    assert.doesNotMatch(out, /is running main/);
  });
});

test('an estate AHEAD of the ref is reported as ahead, not accused of a force-push', () => {
  // R7 REGRESSION TEST (found live during review). The old message asserted the
  // build "was built from a branch, a revert, or a force-pushed history" for any
  // non-ancestor — three causes it never verified — while the cause that
  // actually fires, "the estate is ahead of the ref I compared against", was not
  // in the list. Commercial reported divergent while running origin/main's tip.
  //
  // Compare an OLD commit as the ref against a NEWER live sha: the live build is
  // then genuinely ahead of the ref, which is the shape a not-yet-fetched ref
  // produces.
  const r = resolveAgainstGit(REPO_FIXTURE.head, {
    cwd: REPO_FIXTURE.dir,
    branch: REPO_FIXTURE.shas[0],
  });
  assert.equal(r.error, null, `expected the head sha to resolve, got ${r.error}`);
  assert.equal(r.ancestor, false, 'HEAD is not an ancestor of the first commit');
  assert.equal(r.aheadOfRef, true, 'the other direction must be measured, not assumed');

  const verdict = classifyEstate({
    name: 'Commercial', liveSha: REPO_FIXTURE.head,
    ancestor: r.ancestor, aheadOfRef: r.aheadOfRef,
    commitsBehind: r.commitsBehind, ageDays: r.ageDays,
    behindGraceMinutes: 90, maxAgeDays: 7,
  });
  assert.equal(verdict.state, 'ahead');
  assert.equal(verdict.stale, true, 'ahead is still not "running main"');
  assert.match(verdict.detail, /is AHEAD of the compared ref/);
  // The three unverified causes must be gone.
  assert.doesNotMatch(verdict.detail, /force-pushed/);
  assert.doesNotMatch(verdict.detail, /a revert/);
});

test('a GENUINELY divergent build says so without enumerating causes', () => {
  // Neither direction is an ancestor. The message may say the histories
  // diverged — that IS established — but must still not invent a mechanism.
  const verdict = classifyEstate({
    name: 'Commercial', liveSha: 'abcdef1234567890',
    ancestor: false, aheadOfRef: false,
    commitsBehind: null, ageDays: 1,
    behindGraceMinutes: 90, maxAgeDays: 7,
  });
  assert.equal(verdict.state, 'divergent');
  assert.equal(verdict.stale, true);
  assert.match(verdict.detail, /genuinely diverged/);
  assert.doesNotMatch(verdict.detail, /force-pushed/);
});

// ---------------------------------------------------------------------------
// the workflow that runs it
// ---------------------------------------------------------------------------

/**
 * Everything about a workflow body that would stop the alarm from failing.
 * PURE, over the workflow TEXT, so these assertions can be mutation-proved
 * against sabotaged fixtures instead of only ever seeing a compliant file.
 *
 * COMMENTS DO NOT COUNT, and the first cut getting that wrong is worth
 * recording: the workflow's own header explains that it uses none of these
 * constructs, so scanning the raw text matched its PROSE and failed a compliant
 * file. A check that cannot tell an executed line from a line describing one is
 * the guard-keyed-to-the-pattern shape.
 */
function workflowFailureModes(text) {
  const executable = text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
  const problems = [];
  if (/continue-on-error/.test(executable)) problems.push('continue-on-error');
  if (/\|\|\s*true/.test(executable)) problems.push('|| true');
  if (/2>\s*\/dev\/null/.test(executable)) problems.push('2>/dev/null');
  // THE ONE THE WORKFLOW WARNS ABOUT MOST, AND THE ONE THIS TEST ORIGINALLY
  // COULD NOT SEE. `node … | tee -a "$GITHUB_STEP_SUMMARY"` reports TEE's exit
  // status, not the checker's: GitHub's default shell is `bash -e {0}` and sets
  // no pipefail. The workflow spends twelve lines explaining exactly that, and
  // until now nothing asserted it — so the protection was a comment. A reviewer
  // applied precisely that mutation and this suite stayed green at 22/22.
  if (/check-cross-cloud-drift\.mjs[^\n]*\|/.test(executable)) problems.push('piped invocation');
  // The captured status must actually be re-raised. Capturing `rc` and never
  // exiting with it is the same defect wearing a different hat.
  if (!/exit "\$rc"/.test(executable)) problems.push('missing exit "$rc"');
  // The estate comparison is a commit distance, so a shallow checkout would
  // make every row UNKNOWN for a reason unrelated to either estate.
  if (!/fetch-depth:\s*0/.test(executable)) problems.push('missing fetch-depth: 0');
  // A scheduled workflow that does not run the check is the "control that does
  // not run at all" shape.
  if (!/node scripts\/ci\/check-cross-cloud-drift\.mjs/.test(executable)) problems.push('does not invoke the checker');
  return problems;
}

test('the alarm workflow exists, is scheduled off-minute, and can fail', () => {
  const text = readFileSync(WORKFLOW, 'utf8');

  // Scheduled, and NOT on the top or half hour: GitHub drops and delays
  // schedules that pile onto the scheduler surge, and a dropped run is a
  // control that silently did not execute.
  const crons = [...text.matchAll(/cron:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(crons.length > 0, 'the alarm must carry a schedule — a dispatch-only alarm is not an alarm');
  for (const c of crons) {
    const minute = c.trim().split(/\s+/)[0];
    assert.ok(/^\d+$/.test(minute), `cron "${c}": minute must be a fixed value`);
    assert.notEqual(minute, '0', `cron "${c}": minute 0 lands in the top-of-hour scheduler surge`);
    assert.notEqual(minute, '30', `cron "${c}": minute 30 lands in the half-hour scheduler surge`);
  }

  assert.deepEqual(workflowFailureModes(text), [],
    'the committed workflow must carry none of the constructs that stop a step failing');
});

test('CONTROL — the can-fail check DETECTS each way the alarm could be muted', () => {
  // An assertion that has only ever seen a compliant file is an assertion
  // nobody has watched fail — the same criticism this whole PR levels at the
  // deploy paths it monitors. Each mutation below is applied to the REAL
  // workflow text and must be caught.
  const real = readFileSync(WORKFLOW, 'utf8');
  assert.deepEqual(workflowFailureModes(real), [], 'precondition: the real file is clean');

  // The pipe. Pinned first because a reviewer demonstrated it slipping through.
  const piped = real.replace(
    /node scripts\/ci\/check-cross-cloud-drift\.mjs > "\$RUNNER_TEMP\/cross-cloud-drift\.txt" 2>&1/,
    'node scripts/ci/check-cross-cloud-drift.mjs | tee -a "$GITHUB_STEP_SUMMARY"',
  );
  assert.notEqual(piped, real, 'precondition: the pipe mutation must actually apply');
  assert.ok(workflowFailureModes(piped).includes('piped invocation'),
    'a piped checker reports tee\'s status, not the check\'s, and must be caught');

  assert.ok(workflowFailureModes(real.replace('exit "$rc"', 'true')).includes('missing exit "$rc"'),
    'capturing rc and never re-raising it must be caught');
  assert.ok(workflowFailureModes(`${real}\n        continue-on-error: true\n`).includes('continue-on-error'));
  assert.ok(workflowFailureModes(real.replace('exit "$rc"', 'exit "$rc" || true')).includes('|| true'));
  assert.ok(workflowFailureModes(real.replace('fetch-depth: 0', 'fetch-depth: 1')).includes('missing fetch-depth: 0'));
  assert.ok(workflowFailureModes(real.replace('node scripts/ci/check-cross-cloud-drift.mjs', 'echo skipped'))
    .includes('does not invoke the checker'));

  // …and the comment strip must not be what is doing the work: the workflow's
  // header NAMES these constructs in prose, and a compliant file must stay
  // compliant with that prose present. Without this, a strip bug that ate the
  // whole file would make every assertion above vacuously true.
  assert.ok(real.includes('continue-on-error'),
    'precondition: the header discusses these constructs, so the comment strip is load-bearing');
});

