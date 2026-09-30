/**
 * Self-test for scripts/ci/check-runner-version-pin.mjs (RVP0).
 *
 * Every load-bearing assertion below names, in its message or the comment
 * above it, the input that turns it red (assertion-design.md). The release
 * fixture is the REAL actions/runner release list as read from
 * GET /repos/actions/runner/releases on 2026-09-29 (tag + published_at,
 * v2.328.0..v2.337.0), so the ages the tests compute are the ages that
 * actually happened -- the 350-day case is the outage this guard exists for.
 *
 * Run: node --test scripts/ci/__tests__/check-runner-version-pin.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  KNOWN_FLOOR,
  WARN_DAYS,
  FAIL_DAYS,
  DOCKERFILE_REL,
  PROVISION_REL,
  compareSemver,
  readPin,
  scriptVersionDefaults,
  checkOffline,
  evaluateAge,
  fetchReleases,
  main,
  FETCH_ATTEMPTS,
  FAILURE_KINDS,
  buildFailureRecord,
  SPLIT_TOKEN_SEAM,
} from '../check-runner-version-pin.mjs';
import { parseWorkflow } from '../_workflow-yaml.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const CHECKER = join(HERE, '..', 'check-runner-version-pin.mjs');
const DAY = 86_400_000;

// Measured 2026-09-29 from the GitHub releases API (not transcribed from memory).
const RELEASES = [
  ['v2.337.0', '2026-08-26T14:33:29Z'],
  ['v2.336.0', '2026-07-20T17:45:55Z'],
  ['v2.335.1', '2026-06-09T01:32:05Z'],
  ['v2.335.0', '2026-06-08T17:08:55Z'],
  ['v2.334.0', '2026-04-21T18:54:03Z'],
  ['v2.333.1', '2026-03-27T17:01:07Z'],
  ['v2.333.0', '2026-03-18T17:30:37Z'],
  ['v2.332.0', '2026-02-25T13:52:08Z'],
  ['v2.331.0', '2026-01-09T17:26:04Z'],
  ['v2.330.0', '2025-11-19T14:38:48Z'],
  ['v2.329.0', '2025-10-14T14:57:30Z'],
  ['v2.328.0', '2025-08-13T16:49:24Z'],
].map(([tag_name, published_at]) => ({ tag_name, published_at, draft: false, prerelease: false }));

const OUTAGE = Date.parse('2026-09-29T19:04:00Z');
const SHA = '70920811a4f8ad4328818682bca5c6469c1c942fab52448868071d0063816613';
const dockerfile = (version, sha = SHA) =>
  [
    'FROM ubuntu:22.04',
    '# For an arm64 build, pass the matching linux-arm64 hash, e.g. v2.300.0:',
    '#   RUNNER_SHA256=9b1dc70626422526e3c94767cf024896beb15da5342a3f4819bf2feac13e0393',
    `ARG RUNNER_VERSION=${version}`,
    `ARG RUNNER_SHA256=${sha}`,
    'ARG TARGETARCH=amd64',
  ].join('\n');

// ---------------------------------------------------------------------------
// The real tree
// ---------------------------------------------------------------------------

test('the real Dockerfile + provision script pass the offline check', () => {
  const dockerfileText = readFileSync(join(REPO_ROOT, DOCKERFILE_REL), 'utf8');
  const scriptText = readFileSync(join(REPO_ROOT, PROVISION_REL), 'utf8');
  const { pin, errors } = checkOffline({ dockerfileText, scriptText });
  // RED if the Dockerfile pin goes back to 2.328.0 (below the floor), or if the
  // provision script regains a `${RUNNER_VERSION:-2.328.0}` default.
  assert.deepEqual(errors, [], `real tree must be clean; got: ${errors.join(' | ')}`);
  // RED if the pin is dropped below the floor even with the error list somehow empty.
  assert.ok(compareSemver(pin.version, KNOWN_FLOOR) >= 0, `pin ${pin.version} must be >= ${KNOWN_FLOOR}`);
});

// ---------------------------------------------------------------------------
// readPin
// ---------------------------------------------------------------------------

test('readPin reads the ARG lines and ignores version-shaped comments', () => {
  const r = readPin(dockerfile('2.337.0'));
  // RED if a commented `RUNNER_SHA256=` line were counted (sha would be the
  // arm64 hash, or the count would be 2 and sha null).
  assert.equal(r.sha256, SHA);
  assert.equal(r.version, '2.337.0');
  assert.deepEqual(r.errors, []);
});

test('readPin fails on a missing, duplicated, malformed version or sha', () => {
  // RED if a missing ARG is treated as "no pin to check" instead of an error.
  assert.match(readPin('FROM x\nARG RUNNER_SHA256=' + SHA).errors.join('|'), /exactly one 'ARG RUNNER_VERSION/);
  // RED if the second ARG silently wins.
  assert.match(
    readPin(dockerfile('2.337.0') + '\nARG RUNNER_VERSION=2.328.0').errors.join('|'),
    /found 2/,
  );
  // RED if a floating value like `latest` were accepted as a version.
  assert.match(readPin(dockerfile('latest')).errors.join('|'), /not a plain x\.y\.z/);
  // RED if a 63-char sha (one digit dropped in a copy-paste) were accepted.
  assert.match(readPin(dockerfile('2.337.0', SHA.slice(1))).errors.join('|'), /not 64 lowercase hex/);
});

// ---------------------------------------------------------------------------
// checkOffline: floor + script default
// ---------------------------------------------------------------------------

test('a pin below the known floor fails; the floor itself passes', () => {
  // 2.328.0 is the version GitHub refused on 2026-09-29. RED if the floor
  // comparison is removed or inverted.
  const below = checkOffline({ dockerfileText: dockerfile('2.328.0'), scriptText: '' });
  assert.equal(below.errors.length, 1, `2.328.0 must produce exactly one error; got ${below.errors.join(' | ')}`);
  assert.match(below.errors[0], /below 2\.329\.0/);
  // Boundary: RED if the comparison is `<=` instead of `<`.
  const at = checkOffline({ dockerfileText: dockerfile(KNOWN_FLOOR), scriptText: '' });
  assert.deepEqual(at.errors, []);
});

test('a provision-script default that disagrees with the Dockerfile fails', () => {
  const pinned = dockerfile('2.337.0');
  // The exact line the script carried before this fix. RED if the script scan is dropped.
  const stale = 'RUNNER_VERSION="${RUNNER_VERSION:-2.328.0}"\n';
  const bad = checkOffline({ dockerfileText: pinned, scriptText: stale });
  assert.equal(bad.errors.length, 1);
  assert.match(bad.errors[0], /sets RUNNER_VERSION to '2\.328\.0'.*pins '2\.337\.0'/);
  // Positive pairs, so the absence above is not satisfied by a scan that
  // matches everything: an EMPTY default (the fixed form) and an AGREEING
  // default both pass. RED if every `${RUNNER_VERSION:-…}` were flagged.
  assert.deepEqual(checkOffline({ dockerfileText: pinned, scriptText: 'RUNNER_VERSION="${RUNNER_VERSION:-}"' }).errors, []);
  assert.deepEqual(
    checkOffline({ dockerfileText: pinned, scriptText: 'RUNNER_VERSION="${RUNNER_VERSION:-2.337.0}"' }).errors,
    [],
  );
  // A comment quoting the old line is prose, not a pin. RED if comments were scanned.
  assert.deepEqual(scriptVersionDefaults('# was: ${RUNNER_VERSION:-2.328.0}\n'), []);
  // And the scan does see a live one (positive control for the line above).
  assert.deepEqual(scriptVersionDefaults('  V="${RUNNER_VERSION:-2.1.0}"\n'), ['2.1.0']);
});

test('the script scan sees every literal form, and skips references', () => {
  // Each row is RED if its form is dropped from the scan: the fixture would
  // return [] and a stale literal would pass the offline check (review #6).
  const seen = [
    ['${RUNNER_VERSION:=2.328.0}', ': "${RUNNER_VERSION:=2.328.0}"'],
    ['${RUNNER_VERSION-2.328.0} (no colon)', 'V="${RUNNER_VERSION-2.328.0}"'],
    ['plain assignment', 'RUNNER_VERSION=2.328.0'],
    ['quoted plain assignment', 'RUNNER_VERSION="2.328.0"'],
    ['export', 'export RUNNER_VERSION=2.328.0'],
    ['hard-coded --build-arg', '  az acr build --build-arg RUNNER_VERSION=2.328.0 \\'],
    ['quoted --build-arg', '  --build-arg "RUNNER_VERSION=2.328.0" \\'],
    ['array element', 'BUILD_ARGS=( "RUNNER_VERSION=2.328.0" )'],
  ];
  for (const [form, line] of seen) {
    assert.deepEqual(scriptVersionDefaults(line), ['2.328.0'], `form not seen: ${form} -- ${line}`);
    // And it reaches the ERROR, not just the list.
    assert.equal(checkOffline({ dockerfileText: dockerfile('2.337.0'), scriptText: line }).errors.length, 1, form);
  }
  // References are not literals. RED if the `$` skip is dropped: each of these
  // would then report a bogus default ('${RUNNER_VERSION}"', '$V', ...).
  const skipped = [
    '  --build-arg "RUNNER_VERSION=${RUNNER_VERSION}" --build-arg "RUNNER_SHA256=${RUNNER_SHA256}" )',
    'RUNNER_VERSION="${RUNNER_VERSION:-}"',
    'RUNNER_VERSION=$V',
    'echo "[x][FATAL] RUNNER_VERSION=$RUNNER_VERSION is set without RUNNER_SHA256." >&2',
    'MY_RUNNER_VERSION=2.1.0',
  ];
  for (const line of skipped) assert.deepEqual(scriptVersionDefaults(line), [], line);
  // The real provision script, which contains all of the skipped shapes above,
  // yields nothing. RED if the scan over-matches its override pass-through.
  const real = readFileSync(join(REPO_ROOT, PROVISION_REL), 'utf8');
  assert.deepEqual(scriptVersionDefaults(real), []);
});

// ---------------------------------------------------------------------------
// evaluateAge: the recurrence alarm
// ---------------------------------------------------------------------------

test('the outage itself: 2.328.0 on 2026-09-29 is FAIL, superseded 350 days', () => {
  const r = evaluateAge({ pin: '2.328.0', releases: RELEASES, now: OUTAGE });
  // RED if the fail threshold were missing, or age were measured from the pin's
  // own release date (411 days) or from the latest release (33 days -> warn).
  assert.equal(r.verdict, 'fail', r.message);
  assert.equal(r.supersededBy, '2.329.0');
  assert.equal(r.ageDays, 350);
});

test('the clock starts at the OLDEST newer release, and a patch release starts it', () => {
  // pin 2.335.0 on the outage date: oldest newer = 2.335.1 (a PATCH, 112 days)
  // -> fail. If the code measured from the LATEST newer (2.337.0, 34 days) it
  // would say warn; if it skipped patch releases it would pick 2.336.0 (71
  // days). Only the correct rule gives fail + 2.335.1 + 112.
  const r = evaluateAge({ pin: '2.335.0', releases: RELEASES, now: OUTAGE });
  assert.equal(r.verdict, 'fail', r.message);
  assert.equal(r.supersededBy, '2.335.1');
  assert.equal(r.ageDays, 112);
});

test('thresholds: ok through day 30, warn 31..60, fail from day 61', () => {
  const t0 = Date.parse('2026-08-26T14:33:29Z'); // v2.337.0 published; pin 2.336.0
  const at = (days) => evaluateAge({ pin: '2.336.0', releases: RELEASES, now: t0 + days * DAY + 1000 });
  assert.equal(WARN_DAYS, 30);
  assert.equal(FAIL_DAYS, 60);
  // Each boundary pair is RED under an off-by-one (`>=` for `>`) on that threshold.
  assert.equal(at(30).verdict, 'ok');
  assert.equal(at(31).verdict, 'warn');
  assert.equal(at(60).verdict, 'warn');
  assert.equal(at(61).verdict, 'fail');
});

test('the latest release is ok; drafts and prereleases do not start the clock', () => {
  assert.equal(evaluateAge({ pin: '2.337.0', releases: RELEASES, now: OUTAGE }).verdict, 'ok');
  const withPre = [
    { tag_name: 'v2.338.0', published_at: '2026-06-01T00:00:00Z', draft: false, prerelease: true },
    { tag_name: 'v2.339.0', published_at: '2026-06-01T00:00:00Z', draft: true, prerelease: false },
    ...RELEASES,
  ];
  // Both non-stable releases are 120 days old. RED if either filter is dropped
  // (the verdict becomes fail).
  const r = evaluateAge({ pin: '2.337.0', releases: withPre, now: OUTAGE });
  assert.equal(r.verdict, 'ok', r.message);
  assert.equal(r.latest, '2.337.0');
});

test('fails closed when nothing was established or the pin is not a release', () => {
  // RED if an empty list read as "nothing newer, so up to date".
  assert.equal(evaluateAge({ pin: '2.337.0', releases: [], now: OUTAGE }).verdict, 'fail');
  // RED if an error-object payload (e.g. {message:'rate limited'}) read as up to date.
  assert.equal(evaluateAge({ pin: '2.337.0', releases: { message: 'x' }, now: OUTAGE }).verdict, 'fail');
  // A typo'd future version: RED if "nothing newer" were accepted as ok.
  const future = evaluateAge({ pin: '2.340.0', releases: RELEASES, now: OUTAGE });
  assert.equal(future.verdict, 'fail');
  assert.match(future.message, /NEWER than the latest/);
  // A version inside the range that was never published (tarball would 404).
  const ghost = evaluateAge({ pin: '2.330.5', releases: RELEASES, now: OUTAGE });
  assert.equal(ghost.verdict, 'fail');
  assert.match(ghost.message, /not a published actions\/runner release/);
});

// ---------------------------------------------------------------------------
// fetchReleases: an unreadable API is a failure, not a pass
// ---------------------------------------------------------------------------

test('fetchReleases retries a 5xx, then throws naming the failure', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: false, status: 503 };
  };
  // RED if a failed read resolved to [] (which evaluateAge would then have to catch).
  await assert.rejects(fetchReleases({ fetchImpl, backoffMs: 1 }), /could not read.*HTTP 503/);
  // RED if the retry loop were removed (calls = 1).
  assert.equal(calls, 3);
});

test('fetchReleases does not retry a 404, and returns the body on 200', async () => {
  let calls = 0;
  await assert.rejects(
    fetchReleases({
      fetchImpl: async () => {
        calls += 1;
        return { ok: false, status: 404 };
      },
      backoffMs: 1,
    }),
    /HTTP 404/,
  );
  // RED if 4xx were treated as transient (calls = 3).
  assert.equal(calls, 1);
  const body = await fetchReleases({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => RELEASES }) });
  assert.equal(body.length, RELEASES.length);
});

test('fetchReleases retries the rate-limit statuses 429 and 403', async () => {
  // RED if either status is dropped from the retry set (calls = 1): a
  // rate-limited read would then fail the alarm on its first attempt (review #4).
  for (const status of [429, 403]) {
    let calls = 0;
    await assert.rejects(
      fetchReleases({
        fetchImpl: async () => {
          calls += 1;
          return { ok: false, status };
        },
        backoffMs: 1,
      }),
      new RegExp(`HTTP ${status}`),
    );
    assert.equal(calls, 3, `status ${status} must be retried`);
  }
  // Recovery: a 429 followed by a 200 returns the body. RED if the loop gave
  // up after the first rate-limited response.
  let n = 0;
  const body = await fetchReleases({
    fetchImpl: async () => (++n === 1 ? { ok: false, status: 429 } : { ok: true, status: 200, json: async () => RELEASES }),
    backoffMs: 1,
  });
  assert.equal(body.length, RELEASES.length);
  assert.equal(n, 2);
});

// ---------------------------------------------------------------------------
// CLI wiring: main() must turn an error into a non-zero exit
// ---------------------------------------------------------------------------

function sandbox(version, scriptText) {
  const root = mkdtempSync(join(tmpdir(), 'rvp0-'));
  mkdirSync(join(root, 'scripts', 'ci'), { recursive: true });
  mkdirSync(join(root, 'scripts', 'csa-loom'), { recursive: true });
  mkdirSync(join(root, 'platform', 'runners', 'github-actions'), { recursive: true });
  copyFileSync(CHECKER, join(root, 'scripts', 'ci', 'check-runner-version-pin.mjs'));
  // The checker imports its logical-line reader; without it the CLI crashes and
  // the exit-1 assertion below would pass for the wrong reason (and exit-0 fail).
  copyFileSync(join(HERE, '..', '_logical-lines.mjs'), join(root, 'scripts', 'ci', '_logical-lines.mjs'));
  writeFileSync(join(root, DOCKERFILE_REL), dockerfile(version));
  writeFileSync(join(root, PROVISION_REL), scriptText);
  return join(root, 'scripts', 'ci', 'check-runner-version-pin.mjs');
}

function run(checker) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [checker], { encoding: 'utf8', stdio: 'pipe' }) };
  } catch (e) {
    return { code: e.status, out: `${e.stdout}${e.stderr}` };
  }
}

test('CLI exits 1 with an ::error:: for the outage pin, 0 for a good pin', () => {
  // RED if main() printed the errors but returned 0 -- the gate-that-cannot-fail shape.
  const bad = run(sandbox('2.328.0', ''));
  assert.equal(bad.code, 1, bad.out);
  assert.match(bad.out, /::error file=platform\/runners\/github-actions\/Dockerfile::runner-version-pin: RUNNER_VERSION 2\.328\.0 is below 2\.329\.0/);
  const good = run(sandbox('2.337.0', 'RUNNER_VERSION="${RUNNER_VERSION:-}"\n'));
  assert.equal(good.code, 0, good.out);
  assert.match(good.out, /OK \(offline\)/);
});

// ---------------------------------------------------------------------------
// main() --online: the EXIT CODE is the alarm (review #2)
// ---------------------------------------------------------------------------
//
// The workflow reads one number. evaluateAge() and fetchReleases() being right
// proves nothing if main() maps their verdict to the wrong exit code, so these
// drive main() itself with an injected fetch and clock.
//
// Why pin 2.335.0 and not 2.328.0 for the FAIL case: 2.328.0 is below the
// offline floor, so main() returns 1 BEFORE it reaches the online branch -- a
// fixture on 2.328.0 would stay red with the online fail branch mutated to
// `return 0`. 2.335.0 clears the floor and is 112 days superseded at the
// outage clock, so only the online fail branch can produce its exit 1.

function repoFixture(version, scriptText = 'RUNNER_VERSION="${RUNNER_VERSION:-}"\n') {
  const root = mkdtempSync(join(tmpdir(), 'rvp0-main-'));
  mkdirSync(join(root, 'platform', 'runners', 'github-actions'), { recursive: true });
  mkdirSync(join(root, 'scripts', 'csa-loom'), { recursive: true });
  writeFileSync(join(root, DOCKERFILE_REL), dockerfile(version));
  writeFileSync(join(root, PROVISION_REL), scriptText);
  return root;
}

async function runMain({ version, fetchImpl, now = OUTAGE, online = true, scriptText, timeoutMs }) {
  const root = repoFixture(version, scriptText);
  const failureJson = join(root, 'failure.json');
  const out = [];
  const argv = online ? ['--online', '--failure-json', failureJson] : ['--failure-json', failureJson];
  const code = await main({
    argv,
    repoRoot: root,
    fetchImpl,
    now: () => now,
    backoffMs: 1,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    log: (s) => out.push(`OUT ${s}`),
    error: (s) => out.push(`ERR ${s}`),
  });
  let failure = null;
  try {
    failure = JSON.parse(readFileSync(failureJson, 'utf8'));
  } catch {
    failure = null;
  }
  return { code, out: out.join('\n'), failure };
}

const okFetch = async () => ({ ok: true, status: 200, json: async () => RELEASES });

test('main --online: an unreadable releases API exits 1 and says nothing was established', async () => {
  let calls = 0;
  const r = await runMain({
    version: '2.337.0',
    fetchImpl: async () => {
      calls += 1;
      throw new Error('getaddrinfo ENOTFOUND api.github.com');
    },
  });
  // RED if the fetch-error branch returns 0 (review X2): an outage of the API
  // would read as a healthy pin.
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /ERR ::error::runner-version-pin: could not read .*after 3 attempt\(s\).*NOT established/);
  // The notifier gets a TRANSIENT record, not a stale-pin one. RED if the two
  // kinds were swapped: the tracking issue would tell someone to bump a pin
  // that may be fine.
  assert.equal(r.failure?.class, 'transient');
  assert.equal(r.failure?.signalId, 'runner-version-pin.releases-unreadable');
  assert.equal(r.failure?.retryable, true);
  // A's nit #3: the record said ONE attempt after three were made. The network
  // error is retried, so calls is 3 -- and the record must say 3 too. RED if
  // the record's attempts were hard-coded to 1 (length 1), or if the retry loop
  // were removed (calls 1, and the message says "after 1 attempt(s)").
  assert.equal(calls, FETCH_ATTEMPTS);
  assert.equal(FETCH_ATTEMPTS, 3);
  assert.deepEqual(
    r.failure?.attempts.map((a) => a.attempt),
    [1, 2, 3],
  );
});

test('main --online: a pin superseded past 60 days exits 1 with ::error', async () => {
  const r = await runMain({ version: '2.335.0', fetchImpl: okFetch });
  // RED if the fail-verdict branch returns 0 (review X3). That is the alarm.
  assert.equal(r.code, 1, r.out);
  assert.match(
    r.out,
    /ERR ::error file=platform\/runners\/github-actions\/Dockerfile::runner-version-pin: pin 2\.335\.0 has been superseded for 112 day/,
  );
  assert.equal(r.failure?.class, 'defect');
  assert.match(r.failure?.remediation ?? '', /RUNNER_VERSION and ARG RUNNER_SHA256/);
  // The ONE kind allowed to say "past the alarm threshold". RED if the
  // superseded verdict were filed under any other kind.
  assert.equal(r.failure?.signalId, 'runner-version-pin.pin-superseded');
  assert.match(r.failure?.whyStopped ?? '', /past the alarm threshold/);
  // One read, one attempt. RED if attempts were taken from FETCH_ATTEMPTS
  // rather than from the reads actually made (length 3).
  assert.equal(r.failure?.attempts.length, 1);
});

test('main --online: a pin 45 days superseded exits 0 with ::warning, and writes no failure', async () => {
  // v2.337.0 published 2026-08-26T14:33:29Z; +45 days. Pin 2.336.0.
  const now = Date.parse('2026-08-26T14:33:29Z') + 45 * DAY + 1000;
  const r = await runMain({ version: '2.336.0', fetchImpl: okFetch, now });
  // RED if warn were mapped to 1 (every warn day would fire the tracking
  // issue) or if the warning line were dropped (the 30-day breach goes silent).
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /OUT ::warning file=.*superseded for 45 day/);
  assert.equal(r.failure, null, 'a warn must not produce a failure record');
});

test('main --online: the latest release exits 0 with OK (positive control)', async () => {
  const r = await runMain({ version: '2.337.0', fetchImpl: okFetch });
  // RED if main() returned 1 unconditionally -- which would satisfy both
  // exit-1 tests above while being useless.
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /OUT \[runner-version-pin\] OK \(online\): pin 2\.337\.0 is the latest release/);
});

test('main: the offline floor fails before any network read', async () => {
  let fetched = false;
  const r = await runMain({
    version: '2.328.0',
    fetchImpl: async () => {
      fetched = true;
      return okFetch();
    },
  });
  assert.equal(r.code, 1, r.out);
  // RED if the offline errors were checked AFTER the fetch.
  assert.equal(fetched, false);
  assert.equal(r.failure?.class, 'defect');
  // A's nit #2: this used to be filed as "superseded". RED if the offline
  // branch wrote any kind other than the Dockerfile one.
  assert.equal(r.failure?.signalId, 'runner-version-pin.dockerfile-pin-invalid');
  assert.doesNotMatch(r.failure?.whyStopped ?? '', /alarm threshold/);
  assert.match(r.failure?.whyStopped ?? '', /below the known registration floor/);
});

test('R7: a MALFORMED Dockerfile pin is dockerfile-pin-invalid, before any network read', async () => {
  // 'v2.x' fails parseSemver, so readPin reports it through pin.errors and the
  // floor comparison never runs. This is the pin.errors site, which the floor
  // test above does not reach (2.328.0 parses; only the floor push fires).
  // RED if pin.errors were mapped to any kind but dockerfile-pin-invalid --
  // measured: that mutation survived every other test in this file.
  let fetched = false;
  const r = await runMain({
    version: 'v2.x',
    fetchImpl: async () => {
      fetched = true;
      return okFetch();
    },
  });
  assert.equal(r.code, 1, r.out);
  assert.equal(fetched, false);
  assert.equal(r.failure?.signalId, 'runner-version-pin.dockerfile-pin-invalid');
  assert.deepEqual(
    r.failure?.established.map((e) => e.signal),
    ['dockerfile-pin-invalid'],
  );
  assert.match(r.failure?.established[0].line ?? '', /RUNNER_VERSION 'v2\.x' is not a plain x\.y\.z version/);
  assertNotTheAlarm(r.failure, /missing, duplicated, malformed/);
});

test('the failure record renders a CLASSIFIED tracking-issue body through the real notifier', async () => {
  // Contract with .github/scripts/deploy-notify-failure.mjs, which the
  // runner-version-pin workflow calls with --failure-json. Imported, not
  // transcribed, so a field rename on either side shows here.
  const { buildIssueBody, buildIssueTitle } = await import('../../../.github/scripts/deploy-notify-failure.mjs');
  const r = await runMain({ version: '2.335.0', fetchImpl: okFetch });
  const body = buildIssueBody({ workflow: 'runner-version-pin', runId: '1', runUrl: 'u', sha: 's', failure: r.failure });
  // RED if the record were not written (failure null -> "No classification was
  // captured"), or if its class / remediation fields stopped matching what the
  // notifier reads.
  assert.match(body, /\*\*Classification: defect\*\*/);
  assert.match(body, /Remediation \(operator-action\):\*\* Bump ARG RUNNER_VERSION/);
  assert.doesNotMatch(body, /No classification was captured/);
  assert.equal(buildIssueTitle('runner-version-pin'), 'deploy: runner-version-pin is failing');
});

// ---------------------------------------------------------------------------
// Round 3, R7: each failure is filed under its OWN kind (review B-2, A-2)
// ---------------------------------------------------------------------------
//
// Before this, every non-transient failure was filed as
// `runner-version-pin.superseded` / "past the alarm threshold". Each test below
// names the kind it pins; the value that breaks it is that kind being swapped
// for any other -- in particular for 'pin-superseded', the old catch-all.

const payloadFetch = (payload) => async () => ({ ok: true, status: 200, json: async () => payload });

/** Every record that is NOT the alarm must not claim the alarm. Paired with a positive match. */
function assertNotTheAlarm(failure, positive) {
  assert.doesNotMatch(failure?.whyStopped ?? '', /alarm threshold/, `${failure?.signalId} must not claim the alarm`);
  assert.match(failure?.whyStopped ?? '', positive, `${failure?.signalId} whyStopped must say what happened`);
}

test('R7: a 200 with an EMPTY list is releases-unusable (transient), not a superseded pin', async () => {
  const r = await runMain({ version: '2.337.0', fetchImpl: payloadFetch([]) });
  assert.equal(r.code, 1, r.out);
  // RED if evaluateAge's "no stable releases" branch lost its kind or took 'pin-superseded'.
  assert.equal(r.failure?.signalId, 'runner-version-pin.releases-unusable');
  assert.equal(r.failure?.class, 'transient');
  assert.match(r.failure?.established[0].line ?? '', /no stable releases -- nothing was established/);
  assertNotTheAlarm(r.failure, /pin age was NOT established/);
});

test('R7: a 200 that is not a list is releases-unusable, and says what it got', async () => {
  // An error-object payload, e.g. a proxy's {message:...}. RED if the non-array
  // branch were filed as superseded, or if the message stopped naming the type.
  const obj = await runMain({ version: '2.337.0', fetchImpl: payloadFetch({ message: 'x' }) });
  assert.equal(obj.code, 1, obj.out);
  assert.equal(obj.failure?.signalId, 'runner-version-pin.releases-unusable');
  assert.match(obj.failure?.established[0].line ?? '', /not a list \(got object\)/);
  assertNotTheAlarm(obj.failure, /answered, but not with a usable release list/);
  // null: RED if `typeof null` ("object") were reported instead of "null".
  const nul = await runMain({ version: '2.337.0', fetchImpl: payloadFetch(null) });
  assert.match(nul.failure?.established[0].line ?? '', /not a list \(got null\)/);
});

test('R7: a pin newer than every release, or never published, is pin-not-released (defect)', async () => {
  // 2.338.0: newer than the latest real release (2.337.0) at the outage clock.
  const future = await runMain({ version: '2.338.0', fetchImpl: okFetch });
  assert.equal(future.code, 1, future.out);
  assert.equal(future.failure?.signalId, 'runner-version-pin.pin-not-released');
  assert.equal(future.failure?.class, 'defect');
  assert.match(future.failure?.established[0].line ?? '', /NEWER than the latest published release 2\.337\.0/);
  assertNotTheAlarm(future.failure, /not a published release/);
  // 2.330.5: inside the range, never published. RED if the ghost branch took another kind.
  const ghost = await runMain({ version: '2.330.5', fetchImpl: okFetch });
  assert.equal(ghost.failure?.signalId, 'runner-version-pin.pin-not-released');
  assert.match(ghost.failure?.established[0].line ?? '', /not a published actions\/runner release/);
});

test('R7: a provision-script default that disagrees is provision-default-disagrees, with no network read', async () => {
  let fetched = false;
  const r = await runMain({
    version: '2.337.0',
    scriptText: 'RUNNER_VERSION="${RUNNER_VERSION:-2.328.0}"\n',
    fetchImpl: async () => {
      fetched = true;
      return okFetch();
    },
  });
  assert.equal(r.code, 1, r.out);
  assert.equal(fetched, false);
  // RED if the script mismatch were filed under the Dockerfile kind or the alarm.
  assert.equal(r.failure?.signalId, 'runner-version-pin.provision-default-disagrees');
  assert.equal(r.failure?.class, 'defect');
  assert.deepEqual(
    r.failure?.established.map((e) => e.signal),
    ['provision-default-disagrees'],
  );
  assertNotTheAlarm(r.failure, /sets a literal RUNNER_VERSION that the Dockerfile does not pin/);
});

test('R7: two offline faults keep one signal each; the Dockerfile one decides the record', async () => {
  // Pin 2.328.0 (below floor) AND a script default 2.337.0 (disagrees with it).
  const r = await runMain({
    version: '2.328.0',
    scriptText: 'RUNNER_VERSION="${RUNNER_VERSION:-2.337.0}"\n',
    fetchImpl: okFetch,
  });
  assert.equal(r.code, 1, r.out);
  assert.equal(r.failure?.signalId, 'runner-version-pin.dockerfile-pin-invalid');
  // RED if either fault were dropped from `established`, or both were relabelled.
  assert.deepEqual(
    r.failure?.established.map((e) => e.signal),
    ['dockerfile-pin-invalid', 'provision-default-disagrees'],
  );
});

test('R7: every FAILURE_KINDS class and remediationKind exists in the failure taxonomy', () => {
  // Read, not transcribed: the notifier renders `class` against this table.
  const taxonomy = JSON.parse(
    readFileSync(join(REPO_ROOT, 'apps', 'fiab-console', 'lib', 'deploy', 'failure-taxonomy.json'), 'utf8'),
  );
  const kinds = Object.keys(FAILURE_KINDS);
  // Positive control on the table itself: RED if a kind were deleted.
  assert.deepEqual(kinds.sort(), [
    'dockerfile-pin-invalid',
    'pin-not-released',
    'pin-superseded',
    'provision-default-disagrees',
    'releases-rejected',
    'releases-unreadable',
    'releases-unusable',
  ]);
  for (const kind of kinds) {
    const row = FAILURE_KINDS[kind];
    // RED on an invented class such as 'stale', or 'unknown' (which the
    // notifier renders as a taxonomy gap).
    assert.ok(Object.hasOwn(taxonomy.classes, row.class), `${kind}: class '${row.class}' is not in the taxonomy`);
    assert.notEqual(row.class, 'unknown', `${kind}: 'unknown' renders as a taxonomy gap`);
    assert.ok(
      Object.hasOwn(taxonomy.remediationKinds, row.remediationKind),
      `${kind}: remediationKind '${row.remediationKind}' is not in the taxonomy`,
    );
    // retryable must agree with the class. RED if releases-rejected (a 404)
    // claimed retryable:true, or a defect claimed a re-run could fix it.
    assert.equal(row.retryable, row.class === 'transient', `${kind}: retryable disagrees with class ${row.class}`);
  }
  // Exactly one kind claims the alarm. RED if any other row's whyStopped says it.
  assert.deepEqual(
    kinds.filter((k) => /alarm threshold/.test(FAILURE_KINDS[k].whyStopped)),
    ['pin-superseded'],
  );
});

test('buildFailureRecord refuses an unknown kind and an empty finding list', () => {
  // RED if an unknown kind fell back to a default row -- a guessed class.
  assert.throws(() => buildFailureRecord({ findings: [{ kind: 'stale', message: 'm' }] }), /unknown failure kind 'stale'/);
  assert.throws(() => buildFailureRecord({ findings: [] }), /no findings/);
  // Positive: a known kind builds, and attempts has one entry per attempt made.
  const rec = buildFailureRecord({ findings: [{ kind: 'releases-unreadable', message: 'm' }], attempts: 2 });
  assert.equal(rec.signalId, 'runner-version-pin.releases-unreadable');
  assert.deepEqual(
    rec.attempts.map((a) => a.attempt),
    [1, 2],
  );
});

// ---------------------------------------------------------------------------
// Round 3: attempts count and the per-attempt timeout (review A-3, B-3)
// ---------------------------------------------------------------------------

test('attempts: a 404 is ONE attempt, filed releases-rejected (config, not retryable)', async () => {
  let calls = 0;
  const r = await runMain({
    version: '2.337.0',
    fetchImpl: async () => {
      calls += 1;
      return { ok: false, status: 404 };
    },
  });
  assert.equal(r.code, 1, r.out);
  assert.equal(calls, 1);
  // RED if the non-retried 4xx were filed as releases-unreadable: that record
  // says retryable:true about a response a re-run cannot change.
  assert.equal(r.failure?.signalId, 'runner-version-pin.releases-rejected');
  assert.equal(r.failure?.class, 'config');
  assert.equal(r.failure?.retryable, false);
  assert.equal(r.failure?.attempts.length, 1);
  // The message counts the reads MADE, like the record. RED if it counted the
  // reads ALLOWED instead ("after 3 attempt(s)" with calls 1): the body and the
  // attempts list would then disagree, which is A's nit #3 in another place.
  assert.match(r.failure?.established[0].line ?? '', /after 1 attempt\(s\): HTTP 404/);
  assertNotTheAlarm(r.failure, /refused the read with a 4xx/);
});

test('attempts: 429 three times is three attempts, filed releases-unreadable', async () => {
  let calls = 0;
  const r = await runMain({
    version: '2.337.0',
    fetchImpl: async () => {
      calls += 1;
      return { ok: false, status: 429 };
    },
  });
  assert.equal(calls, 3);
  // RED if a rate-limit exhaustion took the releases-rejected kind (it WAS retried).
  assert.equal(r.failure?.signalId, 'runner-version-pin.releases-unreadable');
  assert.equal(r.failure?.attempts.length, 3);
});

test('attempts: a 429 then a 200 [] records the TWO reads made', async () => {
  let n = 0;
  const r = await runMain({
    version: '2.337.0',
    fetchImpl: async () => (++n === 1 ? { ok: false, status: 429 } : { ok: true, status: 200, json: async () => [] }),
  });
  assert.equal(n, 2);
  assert.equal(r.failure?.signalId, 'runner-version-pin.releases-unusable');
  // RED if the success path reported attempts 1 (meta.attempts not carried
  // through) or FETCH_ATTEMPTS (3).
  assert.equal(r.failure?.attempts.length, 2);
});

/**
 * A fetch that never answers: it settles ONLY when the caller's signal aborts.
 *
 * It holds a REF'D timer while pending, as a real in-flight request holds its
 * socket. AbortSignal.timeout's own timer is unref'd, so without this the event
 * loop has nothing keeping it alive; on Node 20 the runner then cancels the
 * file with "Promise resolution is still pending but the event loop has already
 * resolved" (measured in CI at 1cf3079b2; Node 24 happened to pass).
 */
function blackHole(seen) {
  return (url, init) => {
    seen.push(init?.signal);
    return new Promise((_, reject) => {
      const keepAlive = setInterval(() => {}, 1000);
      // No signal -> TypeError here -> the attempt fails with a message the
      // assertions below do not accept. That is how a removed signal goes RED
      // rather than hanging.
      try {
        init.signal.addEventListener(
          'abort',
          () => {
            clearInterval(keepAlive);
            reject(init.signal.reason);
          },
          { once: true },
        );
      } catch (e) {
        clearInterval(keepAlive);
        throw e;
      }
    });
  };
}

test('timeout: each attempt is bounded by its own signal, and a timeout is retried', { timeout: 10_000 }, async () => {
  const seen = [];
  const err = await fetchReleases({ fetchImpl: blackHole(seen), backoffMs: 1, timeoutMs: 20 }).then(
    () => null,
    (e) => e,
  );
  // RED if no signal is passed (TypeError message), or if the timeout were
  // ignored (the 10 s node:test timeout fires first).
  assert.ok(err, 'a black-holed API must reject, never resolve');
  assert.match(err.message, /after 3 attempt\(s\): no response within 20 ms \(TimeoutError\)/);
  // RED if a timeout were treated as final (3 -> 1).
  assert.equal(seen.length, 3);
  assert.equal(err.attempts, 3);
  // RED if one signal were shared across attempts: the 2nd and 3rd would
  // start already aborted.
  assert.equal(new Set(seen).size, 3);
  assert.ok(seen.every((s) => s instanceof AbortSignal));
});

test('timeout: an immediate AbortError is retried and named', async () => {
  let calls = 0;
  const err = await fetchReleases({
    fetchImpl: async () => {
      calls += 1;
      throw new DOMException('aborted', 'AbortError');
    },
    backoffMs: 1,
    timeoutMs: 20,
  }).then(
    () => null,
    (e) => e,
  );
  assert.equal(calls, 3);
  // RED if the name mapping were dropped: the message would be the bare "aborted".
  assert.match(err.message, /no response within 20 ms \(AbortError\)/);
});

test('timeout: main() files a black-holed API as releases-unreadable with 3 attempts', { timeout: 10_000 }, async () => {
  const r = await runMain({ version: '2.337.0', fetchImpl: blackHole([]), timeoutMs: 20 });
  assert.equal(r.code, 1, r.out);
  // RED if main() did not pass its timeoutMs through (30 s default -> the
  // node:test timeout fires), or if the record lost its attempts.
  assert.equal(r.failure?.signalId, 'runner-version-pin.releases-unreadable');
  assert.equal(r.failure?.class, 'transient');
  assert.equal(r.failure?.attempts.length, 3);
  assert.match(r.failure?.established[0].line ?? '', /no response within 20 ms \(TimeoutError\)/);
});

// ---------------------------------------------------------------------------
// Round 3: logical-line reading and the split-token seam (review A-1 caveat)
// ---------------------------------------------------------------------------

test('seam: RUNNER_VERSION=\\ + value is seen, as bash joins it', () => {
  // RED if the SPLIT_TOKEN_SEAM splice is removed: readLogicalLines joins with
  // a space, the value reads '' and is skipped -> [].
  assert.deepEqual(scriptVersionDefaults('RUNNER_VERSION=\\\n2.328.0\n'), ['2.328.0']);
  // Same seam in an expansion. RED without the splice: the value reads ' 2.328.0'.
  assert.deepEqual(scriptVersionDefaults('V="${RUNNER_VERSION:-\\\n2.328.0}"\n'), ['2.328.0']);
});

test('seam: an indented continuation reads EMPTY, as bash sets it', () => {
  // bash: `RUNNER_VERSION=\` + `  2.328.0` sets RUNNER_VERSION='' and runs
  // `2.328.0` as a command. NOT a witness for the splice (with or without it
  // the answer is []). It is a guard against a splice that also eats the next
  // line's indentation, which would report '2.328.0' -- a pin bash never set.
  assert.deepEqual(scriptVersionDefaults('RUNNER_VERSION=\\\n  2.328.0\n'), []);
});

test('seam: a comment ending in RUNNER_VERSION=\\ is not spliced into the next line', () => {
  const text = '# x RUNNER_VERSION=\\\nRUNNER_VERSION=2.1.0\n';
  // RED if the seam's not-a-comment lookahead is dropped: the live setter is
  // swallowed into the comment -> [].
  assert.deepEqual(scriptVersionDefaults(text), ['2.1.0']);
  // The pattern itself, lifted from the source, leaves a comment seam alone.
  assert.equal(text.replace(SPLIT_TOKEN_SEAM, '$1'), text);
});

test('logical lines: the script scan joins a continuation (and over-reports the # shape, disclosed)', () => {
  // `cmd \` + `# RUNNER_VERSION=2.1.0`: bash treats the second half as a
  // comment; the logical read does not, and reports '2.1.0'. This PINS the
  // over-report the header discloses (it fails closed). It is also the one
  // input on which the logical read differs from a physical one: RED if
  // scriptVersionDefaults reverted to `.split(/\r?\n/)`, which skips the line
  // as a comment -> []. A future comment-aware scan should flip this on purpose.
  assert.deepEqual(scriptVersionDefaults('echo x \\\n# RUNNER_VERSION=2.1.0\n'), ['2.1.0']);
});

test('logical lines: readPin sees ARG \\ + RUNNER_VERSION=, and a split VALUE fails closed', () => {
  const tail = `\nARG RUNNER_SHA256=${SHA}\n`;
  // RED if readPin reverted to physical lines: `ARG \` has no RUNNER_VERSION and
  // the next line has no ARG -> 0 pins, an error, version null.
  const split = readPin(`ARG \\\n  RUNNER_VERSION=2.337.0${tail}`);
  assert.equal(split.version, '2.337.0');
  assert.deepEqual(split.errors, []);
  // `ARG RUNNER_VERSION=\` + `2.337.0` reads as `RUNNER_VERSION=  2.337.0`,
  // which the ARG regex does not accept: ZERO pins and an error, not a pass.
  // RED if a splice were added to the Dockerfile read without also checking
  // what Docker does with that seam.
  const value = readPin(`ARG RUNNER_VERSION=\\\n2.337.0${tail}`);
  assert.equal(value.version, null);
  assert.match(value.errors.join('|'), /found 0/);
});

// ---------------------------------------------------------------------------
// Round 3: the workflow contract (review B-4 arms A2/A3/A5, B-5, A-4)
// ---------------------------------------------------------------------------
//
// These pin runner-version-pin.yml as PARSED (scripts/ci/_workflow-yaml.mjs),
// not as a grep, so a comment that quotes the right text cannot satisfy them.

const WORKFLOW_REL = '.github/workflows/runner-version-pin.yml';
const wf = () => parseWorkflow(readFileSync(join(REPO_ROOT, WORKFLOW_REL), 'utf8'));
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

test('workflow: notify runs only on a failure, and never on pull_request', () => {
  const { jobs } = wf();
  // RED on A2 (`if: failure()` -- a PR run would file an issue) and A3 (the
  // comparison inverted to == -- ONLY a PR run would file).
  assert.equal(norm(jobs.notify.if?.v), "failure() && github.event_name != 'pull_request'");
  // RED if notify stopped depending on pin-age: failure() would then see nothing.
  assert.equal(jobs.notify.needs?.v, 'pin-age');
});

test('workflow: the check step re-raises the measured exit code', () => {
  const { jobs } = wf();
  const check = jobs['pin-age'].steps.find((s) => s.id?.v === 'check');
  assert.ok(check, 'the pin-age job must keep a step with id: check');
  const lines = check.run.v.split('\n').map((l) => l.trim()).filter(Boolean);
  // RED on A5 (`exit 0` -- the job goes green whatever the checker said, and
  // failure() never fires), or on any line added after the re-raise.
  assert.equal(lines.at(-1), 'exit "$rc"');
  // And rc is the checker's own exit, measured with -e off. RED if `rc=$?` moved
  // or `set +e` were dropped (bash -e would exit before rc is read).
  const iNode = lines.findIndex((l) => l.startsWith('node scripts/ci/check-runner-version-pin.mjs'));
  assert.ok(iNode > 0 && lines[iNode - 1] === 'set +e', 'set +e must directly precede the checker');
  assert.ok(lines.indexOf('rc=$?') > iNode, 'rc=$? must follow the checker');
});

test('workflow: issues:write is held ONLY by the notify job', () => {
  const w = wf();
  // RED if issues:write moved back to workflow level (A-4 / B-5): the pin-age
  // job, which runs PR-modifiable checker code, would hold it again.
  assert.deepEqual(Object.keys(w.permissions).sort(), ['contents']);
  assert.equal(w.permissions.contents.v, 'read');
  assert.equal(w.jobs['pin-age'].permissions, undefined, 'pin-age must inherit the read-only workflow token');
  // Positive: notify still has what the notifier needs. RED if it were dropped
  // (the notifier could not file) or widened.
  assert.deepEqual(
    Object.fromEntries(Object.entries(w.jobs.notify.permissions).map(([k, v]) => [k, v.v])),
    { contents: 'read', issues: 'write' },
  );
});

test('workflow: every checkout sets persist-credentials: false', () => {
  const { jobs } = wf();
  const checkouts = Object.values(jobs).flatMap((j) => j.steps.filter((s) => /^actions\/checkout@/.test(s.uses?.v ?? '')));
  // Positive: both jobs check out. RED if a job lost its checkout (the loop below
  // would then pass over nothing).
  assert.equal(checkouts.length, 2);
  // RED if either checkout drops the setting (B-5): the token lands in .git/config.
  for (const c of checkouts) assert.equal(c.with?.['persist-credentials']?.v, 'false');
});

test('workflow: the record and the result reach the notifier', () => {
  const { jobs } = wf();
  // The record travels pin-age step -> job output -> notify env.
  assert.equal(jobs['pin-age'].outputs?.failure_b64?.v, '${{ steps.check.outputs.failure_b64 }}');
  const check = jobs['pin-age'].steps.find((s) => s.id?.v === 'check');
  assert.match(check.run.v, /echo "failure_b64=\$\(base64 -w0 "\$RUNNER_TEMP\/runner-version-pin-failure\.json"\)" >> "\$GITHUB_OUTPUT"/);
  const step = jobs.notify.steps.find((s) => /deploy-notify-failure\.mjs/.test(s.run?.v ?? ''));
  assert.ok(step, 'notify must call the shared notifier');
  assert.equal(step.env?.FAILURE_B64?.v, '${{ needs.pin-age.outputs.failure_b64 }}');
  // `--result` must be pin-age's result. RED if it were `job.status` of the
  // notify job (which is "success" while it runs, so shouldFile would skip).
  // Inline expression, never a shell variable: RED on `--result "$X"` (the
  // #3844 ratchet's bare-variable shape) and on `${{ job.status }}`.
  assert.match(norm(step.run.v), /--result "\$\{\{ needs\.pin-age\.result \}\}"/);
  // Never on the self-hosted runner this alarm is about.
  for (const [name, job] of Object.entries(jobs)) assert.equal(job['runs-on']?.v, 'ubuntu-latest', name);
});
